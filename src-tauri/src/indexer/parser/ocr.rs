/// OCR 模块：将图片识别为文字
///
/// 平台支持：
///   macOS  → Apple Vision（VNRecognizeTextRequest），系统内置，支持中英文
///   Windows → Windows.Media.Ocr，系统内置（Win10+），支持中英文
///   其他   → 返回空字符串（不报错，上层静默跳过）

use image::DynamicImage;
use std::path::Path;
use anyhow::Result;

/// 识别单张图片(in-memory `DynamicImage`),返回识别文字。
/// 主要用于 PDF 渲染出来的页面图(已经无 EXIF orientation,无需特殊处理)。
pub fn ocr_image(img: &DynamicImage) -> Result<String> {
    imp::recognize_image(img)
}

/// 直接把磁盘上 JPG/PNG/HEIC/...的原始字节交给系统 OCR 引擎。
///
/// 比 `ocr_image` 多了一个关键好处:Apple Vision / Windows OCR 都会自己
/// 解析 EXIF orientation,把"标着旋转 90°"的手机照片正过来再识别。手机
/// 拍的身份证照、微信图片大量是这种情形,如果走 image crate 解码 + PNG
/// re-encode 那条路,Vision 拿到的是侧着的像素 → 识别全错。
pub fn ocr_image_bytes(bytes: &[u8]) -> Result<String> {
    imp::recognize_image_bytes(bytes)
}

/// macOS 路径直读: 让 Vision 通过 NSURL → CGImageSource 拿图,等价于
/// Swift 的 `NSImage(contentsOf:)`。当 in-memory bytes 路径返回乱码时
/// (msg_send NSData 在某些情形下与 Swift `Data(contentsOf:)` 行为不一致)
/// 用这条路径作为可靠 fallback。
pub fn ocr_image_from_path(path: &std::path::Path) -> Result<String> {
    imp::recognize_image_from_path(path)
}

/// 将 PDF 逐页渲染为图片后 OCR，返回全部页面的合并文字。
pub fn ocr_pdf(path: &Path) -> Result<String> {
    use pdfium_render::prelude::*;

    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
            .or_else(|_| Pdfium::bind_to_system_library())?,
    );

    let doc = pdfium.load_pdf_from_file(path, None)?;
    let config = PdfRenderConfig::new()
        .set_target_width(2000)
        .set_maximum_height(3000);

    let mut all_text = String::new();
    const MAX_CHARS: usize = 100_000;

    for page in doc.pages().iter() {
        if all_text.chars().count() >= MAX_CHARS {
            break;
        }
        let bitmap = match page.render_with_config(&config) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let img = bitmap.as_image();
        if let Ok(text) = imp::recognize_image(&img) {
            if !text.trim().is_empty() {
                if !all_text.is_empty() {
                    all_text.push('\n');
                }
                let remaining = MAX_CHARS.saturating_sub(all_text.chars().count());
                let truncated: String = text.chars().take(remaining).collect();
                all_text.push_str(&truncated);
            }
        }
    }

    if all_text.trim().is_empty() {
        Err(anyhow::anyhow!("OCR produced no text"))
    } else {
        Ok(all_text)
    }
}

// ── 平台实现 ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod imp {
    use image::DynamicImage;
    use anyhow::Result;

    /// In-memory `DynamicImage` → PNG → Vision (loses EXIF, used by PDF page render).
    pub fn recognize_image(img: &DynamicImage) -> Result<String> {
        use objc2::rc::autoreleasepool;
        let mut png = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut png),
            image::ImageFormat::Png,
        )?;
        autoreleasepool(|_| unsafe { vision_ocr(&png) })
    }

    /// Raw file bytes → Vision (preserves EXIF orientation; preferred for
    /// disk-backed JPG/PNG/HEIC/...). Vision parses the format itself.
    pub fn recognize_image_bytes(bytes: &[u8]) -> Result<String> {
        use objc2::rc::autoreleasepool;
        autoreleasepool(|_| unsafe { vision_ocr(bytes) })
    }

    /// File path → CGImageSource → Vision. Bypasses our NSData/init(data:)
    /// path which empirically returns garbage for some EXIF-tagged JPGs
    /// even though Swift's `Data(contentsOf:)` + same Vision API works
    /// correctly. Going through ImageIO's CGImageSource lets us hand
    /// Vision a fully-decoded `CGImage` plus the orientation hint
    /// extracted from the file's metadata, which matches what NSImage
    /// does under the hood.
    pub fn recognize_image_from_path(path: &std::path::Path) -> Result<String> {
        use objc2::rc::autoreleasepool;
        let path_str = path.to_string_lossy().into_owned();
        autoreleasepool(|_| unsafe { vision_ocr_from_path(&path_str) })
    }

    unsafe fn vision_ocr(png: &[u8]) -> Result<String> {
        use objc2::{class, msg_send};
        use objc2::runtime::AnyObject;
        use std::ffi::CStr;

        // NSData
        let data: *mut AnyObject = msg_send![
            class!(NSData),
            dataWithBytes: png.as_ptr() as *const std::ffi::c_void,
            length: png.len()
        ];
        if data.is_null() {
            return Err(anyhow::anyhow!("NSData creation failed"));
        }

        // 空 NSDictionary（options）
        let options: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];

        // VNImageRequestHandler
        let handler_alloc: *mut AnyObject = msg_send![class!(VNImageRequestHandler), alloc];
        let handler: *mut AnyObject = msg_send![
            handler_alloc,
            initWithData: data,
            options: options
        ];
        if handler.is_null() {
            return Err(anyhow::anyhow!("VNImageRequestHandler creation failed"));
        }

        // VNRecognizeTextRequest
        let request: *mut AnyObject = msg_send![class!(VNRecognizeTextRequest), new];
        if request.is_null() {
            return Err(anyhow::anyhow!("VNRecognizeTextRequest creation failed"));
        }
        // setRecognitionLevel: 0 = Accurate, 1 = Fast (Apple's enum is
        // backwards from intuition — accurate is the default and the
        // smaller integer). This was previously misset to 1 (Fast), which
        // mangled Chinese OCR on EXIF-rotated phone photos.
        let _: () = msg_send![request, setRecognitionLevel: 0_i64];
        let _: () = msg_send![request, setUsesLanguageCorrection: true];

        // Explicitly tell Vision the languages we expect. Auto-detect
        // (`automaticallyDetectsLanguage`) is unreliable for mixed CJK +
        // Latin content — left to its own devices it tries to read 中文
        // strokes as English letters and produces garbage like "¥,niru$*".
        // Chinese first because most users on this app are Chinese; the
        // model still recognises pure-English images correctly thanks to
        // the trailing en-US entry. Fonts of zh-Hans cover Hant too in
        // practice, but listing both is cheap insurance.
        let zh_hans: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: b"zh-Hans\0".as_ptr() as *const i8
        ];
        let zh_hant: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: b"zh-Hant\0".as_ptr() as *const i8
        ];
        let en_us: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: b"en-US\0".as_ptr() as *const i8
        ];
        let langs: *mut AnyObject = msg_send![
            class!(NSArray),
            arrayWithObjects: [zh_hans, zh_hant, en_us].as_ptr(),
            count: 3_usize
        ];
        let _: () = msg_send![request, setRecognitionLanguages: langs];
        // Disable auto-detect since we've now told Vision exactly what to
        // look for — letting both run can re-introduce the auto-detect
        // garbage on borderline images.
        let _: () = msg_send![request, setAutomaticallyDetectsLanguage: false];

        // NSArray<VNRequest*> = [request]
        let requests: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: request];

        // performRequests:error:
        let mut error: *mut AnyObject = std::ptr::null_mut();
        let _ok: bool = msg_send![handler, performRequests: requests, error: &mut error];

        // 提取文字
        let results: *mut AnyObject = msg_send![request, results];
        if results.is_null() {
            return Ok(String::new());
        }

        let mut text = String::new();
        let count: usize = msg_send![results, count];
        for i in 0..count {
            let obs: *mut AnyObject = msg_send![results, objectAtIndex: i];
            let candidates: *mut AnyObject = msg_send![obs, topCandidates: 1_usize];
            let cand_count: usize = msg_send![candidates, count];
            if cand_count > 0 {
                let candidate: *mut AnyObject = msg_send![candidates, firstObject];
                let ns_str: *mut AnyObject = msg_send![candidate, string];
                let c_str: *const i8 = msg_send![ns_str, UTF8String];
                if !c_str.is_null() {
                    let s = CStr::from_ptr(c_str).to_string_lossy();
                    if !s.trim().is_empty() {
                        text.push_str(&s);
                        text.push('\n');
                    }
                }
            }
        }

        Ok(text)
    }

    /// Same Vision flow but the handler is built from an NSURL via
    /// `initWithURL:options:`. NSURL → CGImageSource (ImageIO) →
    /// VNImageRequestHandler — Vision pulls the image AND its EXIF
    /// orientation from the file metadata, so phone-photo JPGs that
    /// carry "rotate 90°" tags decode correctly.
    unsafe fn vision_ocr_from_path(path: &str) -> Result<String> {
        use objc2::{class, msg_send};
        use objc2::runtime::AnyObject;
        use std::ffi::CStr;

        let path_c = std::ffi::CString::new(path)?;
        let ns_path: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: path_c.as_ptr()
        ];
        if ns_path.is_null() {
            return Err(anyhow::anyhow!("NSString creation failed"));
        }
        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: ns_path];
        if url.is_null() {
            return Err(anyhow::anyhow!("NSURL creation failed"));
        }

        let options: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
        let handler_alloc: *mut AnyObject = msg_send![class!(VNImageRequestHandler), alloc];
        let handler: *mut AnyObject = msg_send![
            handler_alloc,
            initWithURL: url,
            options: options
        ];
        if handler.is_null() {
            return Err(anyhow::anyhow!("VNImageRequestHandler initWithURL failed"));
        }

        let request: *mut AnyObject = msg_send![class!(VNRecognizeTextRequest), new];
        let _: () = msg_send![request, setRecognitionLevel: 1_i64];
        let _: () = msg_send![request, setUsesLanguageCorrection: true];
        let zh_hans: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: b"zh-Hans\0".as_ptr() as *const i8
        ];
        let zh_hant: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: b"zh-Hant\0".as_ptr() as *const i8
        ];
        let en_us: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: b"en-US\0".as_ptr() as *const i8
        ];
        let langs: *mut AnyObject = msg_send![
            class!(NSArray),
            arrayWithObjects: [zh_hans, zh_hant, en_us].as_ptr(),
            count: 3_usize
        ];
        let _: () = msg_send![request, setRecognitionLanguages: langs];
        let _: () = msg_send![request, setAutomaticallyDetectsLanguage: false];

        let requests: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: request];
        let mut error: *mut AnyObject = std::ptr::null_mut();
        let _: bool = msg_send![handler, performRequests: requests, error: &mut error];

        let results: *mut AnyObject = msg_send![request, results];
        if results.is_null() {
            return Ok(String::new());
        }
        let mut text = String::new();
        let count: usize = msg_send![results, count];
        for i in 0..count {
            let obs: *mut AnyObject = msg_send![results, objectAtIndex: i];
            let candidates: *mut AnyObject = msg_send![obs, topCandidates: 1_usize];
            let cand_count: usize = msg_send![candidates, count];
            if cand_count > 0 {
                let candidate: *mut AnyObject = msg_send![candidates, firstObject];
                let ns_str: *mut AnyObject = msg_send![candidate, string];
                let c_str: *const i8 = msg_send![ns_str, UTF8String];
                if !c_str.is_null() {
                    let s = CStr::from_ptr(c_str).to_string_lossy();
                    if !s.trim().is_empty() {
                        text.push_str(&s);
                        text.push('\n');
                    }
                }
            }
        }
        Ok(text)
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use image::DynamicImage;
    use anyhow::Result;

    pub fn recognize_image(img: &DynamicImage) -> Result<String> {
        let mut png = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut png),
            image::ImageFormat::Png,
        )?;
        recognize_image_bytes(&png)
    }

    pub fn recognize_image_from_path(path: &std::path::Path) -> Result<String> {
        // Windows OCR doesn't have a path-based init; just read + delegate.
        let bytes = std::fs::read(path)?;
        recognize_image_bytes(&bytes)
    }

    pub fn recognize_image_bytes(bytes: &[u8]) -> Result<String> {
        use windows::{
            core::HSTRING,
            Globalization::Language,
            Graphics::Imaging::BitmapDecoder,
            Media::Ocr::OcrEngine,
            Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
        };

        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(bytes)?;
        writer.StoreAsync()?.get()?;
        writer.FlushAsync()?.get()?;
        drop(writer);
        stream.Seek(0)?;

        // Windows.Graphics.Imaging.BitmapDecoder honors EXIF orientation
        // automatically when fed the raw container bytes.
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;

        let mut all_text = String::new();
        for tag in ["zh-CN", "en-US"] {
            let lang = Language::CreateLanguage(&HSTRING::from(tag))?;
            if !OcrEngine::IsLanguageSupported(&lang)? {
                continue;
            }
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                if let Ok(result) = engine.RecognizeAsync(&bitmap)?.get() {
                    if let Ok(lines) = result.Lines() {
                        let count = lines.Size().unwrap_or(0);
                        for i in 0..count {
                            if let Ok(line) = lines.GetAt(i) {
                                if let Ok(t) = line.Text() {
                                    all_text.push_str(&t.to_string());
                                    all_text.push('\n');
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(all_text)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use image::DynamicImage;
    use anyhow::Result;

    pub fn recognize_image(_img: &DynamicImage) -> Result<String> {
        Err(anyhow::anyhow!("OCR not supported on this platform"))
    }
    pub fn recognize_image_bytes(_bytes: &[u8]) -> Result<String> {
        Err(anyhow::anyhow!("OCR not supported on this platform"))
    }
    pub fn recognize_image_from_path(_path: &std::path::Path) -> Result<String> {
        Err(anyhow::anyhow!("OCR not supported on this platform"))
    }
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 测试图片 OCR：识别含英文 + 中文文字的 PNG。
    /// 图片位于 tests/fixtures/ocr_test.png，由 Python PIL 生成。
    #[test]
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn test_ocr_image_with_text() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ocr_test.png");

        assert!(fixture.exists(), "测试图片不存在: {}", fixture.display());

        let img = image::open(&fixture).expect("无法打开测试图片");
        let result = ocr_image(&img).expect("OCR 调用失败");

        println!("[OCR 结果]\n{}", result);

        // 验证识别到关键词（Apple Vision 识别结果可能有轻微差异，用宽松匹配）
        let lower = result.to_lowercase();
        assert!(
            lower.contains("hello") || lower.contains("ocr") || lower.contains("123"),
            "OCR 未识别到英文内容，实际结果: {:?}",
            result
        );
    }

    /// 测试 OCR 对全白空图片（无文字）的处理：应返回空字符串。
    #[test]
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn test_ocr_blank_image_returns_empty() {
        let blank = image::DynamicImage::ImageRgb8(
            image::RgbImage::new(100, 100),
        );
        // 白色空图片，OCR 应返回空字符串（不报错）
        match ocr_image(&blank) {
            Ok(text) => assert!(
                text.trim().is_empty(),
                "空图片 OCR 应返回空字符串，实际: {:?}",
                text
            ),
            Err(_) => {} // 部分平台对全白图片可能直接返回 Err，也可接受
        }
    }

    /// 测试 parse_image 集成：通过文件路径调用完整解析流程。
    #[test]
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn test_parse_image_integration() {
        use crate::indexer::parser::image::parse_image;
        use crate::indexer::parser::ParseStatus;

        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ocr_test.png");

        if !fixture.exists() {
            println!("跳过集成测试：测试图片不存在");
            return;
        }

        let result = parse_image(&fixture);
        println!("[parse_image 结果] status={:?}, content={:?}", result.status, result.content);

        assert_eq!(result.status, ParseStatus::Ok, "parse_image 应返回 Ok 状态");
        assert!(!result.content.trim().is_empty(), "parse_image content 不应为空");
    }
}

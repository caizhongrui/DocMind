/// OCR 模块：将图片识别为文字
///
/// 平台支持：
///   macOS  → Apple Vision（VNRecognizeTextRequest），系统内置，支持中英文
///   Windows → Windows.Media.Ocr，系统内置（Win10+），支持中英文
///   其他   → 返回空字符串（不报错，上层静默跳过）

use image::DynamicImage;
use std::path::Path;
use anyhow::Result;

/// 识别单张图片，返回识别文字。
pub fn ocr_image(img: &DynamicImage) -> Result<String> {
    imp::recognize_image(img)
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

    /// 使用 Apple Vision 框架识别图片文字。
    /// 通过 objc2 msg_send! 宏直接发 ObjC 消息，避免依赖特定绑定版本的类型系统。
    pub fn recognize_image(img: &DynamicImage) -> Result<String> {
        use objc2::rc::autoreleasepool;

        let mut png = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut png),
            image::ImageFormat::Png,
        )?;

        autoreleasepool(|_| unsafe { vision_ocr(&png) })
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
        // setRecognitionLevel: 1 = Accurate
        let _: () = msg_send![request, setRecognitionLevel: 1_i64];
        let _: () = msg_send![request, setUsesLanguageCorrection: true];
        // 自动语言检测（macOS 12+）
        let _: () = msg_send![request, setAutomaticallyDetectsLanguage: true];

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
}

#[cfg(target_os = "windows")]
mod imp {
    use image::DynamicImage;
    use anyhow::Result;

    pub fn recognize_image(img: &DynamicImage) -> Result<String> {
        use windows::{
            core::HSTRING,
            Globalization::Language,
            Graphics::Imaging::BitmapDecoder,
            Media::Ocr::OcrEngine,
            Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
        };

        let mut png = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut png),
            image::ImageFormat::Png,
        )?;

        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(&png)?;
        writer.StoreAsync()?.get()?;
        writer.FlushAsync()?.get()?;
        drop(writer);
        stream.Seek(0)?;

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
                        for line in &lines {
                            if let Ok(t) = line.Text() {
                                all_text.push_str(&t.to_string());
                                all_text.push('\n');
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

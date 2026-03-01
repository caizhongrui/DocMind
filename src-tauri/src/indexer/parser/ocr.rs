/// OCR 模块：将图片识别为文字
///
/// 平台支持：
///   macOS  → Apple Vision（VNRecognizeTextRequest），系统内置，支持中英文
///   Windows → Windows.Media.Ocr，系统内置（Win10+），支持中英文
///   其他   → 返回空字符串（不报错，上层静默跳过）
///
/// 主要入口：
///   ocr_image(img)  — 识别单张 DynamicImage
///   ocr_pdf(path)   — 逐页渲染 PDF 后识别（仅在 lopdf/pdf-extract 均无结果时调用）

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

    pub fn recognize_image(img: &DynamicImage) -> Result<String> {
        use objc2::AnyThread;
        use objc2::rc::{autoreleasepool, Retained};
        use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
        use objc2_vision::{
            VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
            VNRequestTextRecognitionLevel,
        };

        // 编码为 PNG
        let mut png = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut png),
            image::ImageFormat::Png,
        )?;

        autoreleasepool(|_| unsafe {
            let data = NSData::with_bytes(&png);

            // 空 options 字典。Vision 要求 NSDictionary<VNImageOption, AnyObject>（= NSString, AnyObject）。
            // 运行时 ObjC 泛型擦除，AnyObject 键类型的空字典与 NSString 键类型完全等价，
            // 用指针转型规避 Rust 编译期类型检查。
            let empty_dict = NSDictionary::new();
            let options_ptr = Retained::as_ptr(&empty_dict)
                as *const NSDictionary<NSString, objc2::runtime::AnyObject>;
            let options = &*options_ptr;

            let handler = VNImageRequestHandler::initWithData_options(
                VNImageRequestHandler::alloc(),
                &data,
                options,
            );

            let request = VNRecognizeTextRequest::new();
            request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
            request.setUsesLanguageCorrection(true);
            // 自动语言检测：运行时决定中英文模型
            request.setAutomaticallyDetectsLanguage(true);

            // NSArray<VNRequest> — 运行时与 NSArray<VNRecognizeTextRequest> 相同
            let req_arr = NSArray::from_slice(&[request.as_ref()]);
            let requests_ptr =
                Retained::as_ptr(&req_arr) as *const NSArray<VNRequest>;
            let requests = &*requests_ptr;

            handler
                .performRequests_error(requests)
                .map_err(|e| anyhow::anyhow!("Vision error: {}", e.localizedDescription()))?;

            let mut text = String::new();
            if let Some(results) = request.results() {
                for obs in results.iter() {
                    let candidates = obs.topCandidates(1);
                    if let Some(candidate) = candidates.firstObject() {
                        text.push_str(&candidate.string().to_string());
                        text.push('\n');
                    }
                }
            }

            Ok::<String, anyhow::Error>(text)
        })
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

        // 编码为 PNG 写入内存流
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
        // DetachStream 防止 writer drop 时关闭 stream
        writer.DetachStream()?;
        stream.Seek(0)?;

        // 从内存流解码为 SoftwareBitmap
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;

        // 依次尝试中文、英文 OCR
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

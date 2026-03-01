use std::path::Path;
use super::{ParseResult, ParseStatus};

/// 图片文件 OCR 解析
///
/// 支持格式：jpg/jpeg/png/bmp/tiff/tif/webp
/// 调用平台原生 OCR 引擎（macOS Vision / Windows.Media.Ocr）。
/// 不支持 OCR 的平台返回 Failed（静默跳过，不影响文件名搜索）。
pub fn parse_image(path: &Path) -> ParseResult {
    let img = match image::open(path) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[parser/image] Failed to open {}: {e}", path.display());
            return ParseResult::failed();
        }
    };

    match super::ocr::ocr_image(&img) {
        Ok(text) if !text.trim().is_empty() => {
            ParseResult { content: text, status: ParseStatus::Ok }
        }
        Ok(_) => ParseResult::failed(), // OCR 成功但无文字（空白图片等）
        Err(e) => {
            eprintln!("[parser/image] OCR failed for {}: {e}", path.display());
            ParseResult::failed()
        }
    }
}

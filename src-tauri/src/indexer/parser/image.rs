use std::path::Path;
use super::{ParseResult, ParseStatus};

/// 图片文件 OCR 解析
///
/// 支持格式：jpg/jpeg/png/bmp/tiff/tif/webp
/// 调用平台原生 OCR 引擎（macOS Vision / Windows.Media.Ocr）。
/// 不支持 OCR 的平台返回 Failed（静默跳过，不影响文件名搜索）。
///
/// 实现细节:把**原始文件字节**直接交给系统 OCR 引擎,而不是先用 image
/// crate 解码再 re-encode 到 PNG。原因:许多手机/微信导出的 JPG 通过
/// EXIF orientation 标 "顺时针 90°",而 image crate 不会自动旋转,re-encode
/// 后 Vision 看到的是侧着的图,识别完全错乱。Apple Vision 和 Windows OCR
/// 都能直接接受 JPG/PNG 字节并自动处理 EXIF。
pub fn parse_image(path: &Path) -> ParseResult {
    // 文件大小限制（避免单张超大图占内存）
    const MAX_BYTES: u64 = 50 * 1024 * 1024;
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[parser/image] metadata failed for {}: {e}", path.display());
            return ParseResult::failed();
        }
    };
    if meta.len() > MAX_BYTES {
        eprintln!(
            "[parser/image] skipping oversized image {} ({} bytes)",
            path.display(),
            meta.len()
        );
        return ParseResult::failed();
    }

    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[parser/image] read failed for {}: {e}", path.display());
            return ParseResult::failed();
        }
    };

    match super::ocr::ocr_image_bytes(&bytes) {
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

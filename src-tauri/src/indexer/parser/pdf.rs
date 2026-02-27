use super::{ParseResult, ParseStatus};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

/// 单个 PDF 解析的最长等待时间。
/// 纯图片 PDF（扫描件）没有文本层，lopdf / pdf-extract 会耗费大量时间处理嵌入图片，
/// 超时后直接返回 Failed，避免整个索引线程卡死。
const PDF_PARSE_TIMEOUT: Duration = Duration::from_secs(30);

/// pdf-extract 会把整个文件读入内存，超过此大小的 PDF 跳过以防 OOM。
/// lopdf 采用惰性加载，大文件仍可尝试；但 extract_text 处理大量图片页会超时。
const PDF_MAX_SIZE_FOR_EXTRACT: u64 = 100 * 1024 * 1024; // 100 MB

pub fn parse(path: &Path) -> ParseResult {
    let path_buf = path.to_path_buf();

    // 在独立线程中执行解析，避免 lopdf / pdf-extract 卡死主索引线程
    let (tx, rx) = mpsc::channel::<ParseResult>();
    std::thread::spawn(move || {
        let result = parse_inner(&path_buf);
        let _ = tx.send(result);
    });

    match rx.recv_timeout(PDF_PARSE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            // 超时（通常是纯图片扫描 PDF，库无法提取文字）或线程 panic
            eprintln!("[pdf] parse timeout (image-only PDF?): {}", path.display());
            ParseResult::failed()
        }
    }
}

fn parse_inner(path: &Path) -> ParseResult {
    // 第一级：lopdf（惰性加载，适合带文本层的 PDF）
    if let Ok(text) = try_lopdf(path) {
        if !text.trim().is_empty() {
            return ParseResult { content: text, status: ParseStatus::Ok };
        }
    }

    // 第二级：pdf-extract（全量读入内存，仅对小文件启用）
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX);
    if file_size <= PDF_MAX_SIZE_FOR_EXTRACT {
        if let Ok(text) = try_pdf_extract(path) {
            if !text.trim().is_empty() {
                return ParseResult { content: text, status: ParseStatus::Partial };
            }
        }
    } else {
        eprintln!(
            "[pdf] skipping pdf-extract for large file ({:.1} MB): {}",
            file_size as f64 / 1024.0 / 1024.0,
            path.display()
        );
    }

    // 第三级：标记失败（专业版由上层触发 OCR）
    ParseResult::failed()
}

fn try_lopdf(path: &Path) -> anyhow::Result<String> {
    let doc = lopdf::Document::load(path)?;
    let pages: Vec<u32> = (1..=doc.get_pages().len() as u32).collect();
    let text = doc.extract_text(&pages).unwrap_or_default();
    Ok(text)
}

fn try_pdf_extract(path: &Path) -> anyhow::Result<String> {
    let bytes = std::fs::read(path)?;
    let text = pdf_extract::extract_text_from_mem(&bytes)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nonexistent_pdf_returns_failed() {
        let r = parse(Path::new("/no_such_file.pdf"));
        assert_eq!(r.status, ParseStatus::Failed);
        assert!(r.content.is_empty());
    }
}

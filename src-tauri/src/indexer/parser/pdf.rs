use super::{ParseResult, ParseStatus};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

/// Text-layer extraction (lopdf + pdf-extract) timeout. Both libraries
/// are fast on text-only PDFs (<1s typically) but can stall indefinitely
/// on malformed / heavily image-laden files — this kills runaways.
const TEXT_EXTRACT_TIMEOUT: Duration = Duration::from_secs(20);

/// OCR fallback timeout. Scanned PDFs go page-by-page through Vision /
/// Windows OCR; ~3s per page on M-series, so 5 min covers ~100 pages.
/// Anything beyond that is ridiculous to index synchronously anyway.
const OCR_FALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// pdf-extract 会把整个文件读入内存，超过此大小的 PDF 跳过以防 OOM。
/// lopdf 采用惰性加载，大文件仍可尝试；但 extract_text 处理大量图片页会超时。
const PDF_MAX_SIZE_FOR_EXTRACT: u64 = 100 * 1024 * 1024; // 100 MB

pub fn parse(path: &Path) -> ParseResult {
    // ── 第一级 + 第二级:文本层提取(快速,短超时) ────────────────────
    let path_buf = path.to_path_buf();
    let (tx, rx) = mpsc::channel::<Option<ParseResult>>();
    std::thread::spawn(move || {
        let result = try_text_layers(&path_buf);
        let _ = tx.send(result);
    });
    match rx.recv_timeout(TEXT_EXTRACT_TIMEOUT) {
        Ok(Some(r)) => return r,
        Ok(None) => {} // text layers empty → fall through to OCR
        Err(_) => {
            eprintln!(
                "[pdf] text-layer extraction timed out (>{}s), trying OCR: {}",
                TEXT_EXTRACT_TIMEOUT.as_secs(),
                path.display()
            );
        }
    }

    // ── 第三级:OCR(慢,长超时,可能是几十页扫描合同) ─────────────────
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let path_buf = path.to_path_buf();
        let (tx, rx) = mpsc::channel::<ParseResult>();
        std::thread::spawn(move || {
            let result = match super::ocr::ocr_pdf(&path_buf) {
                Ok(text) if !text.trim().is_empty() => {
                    eprintln!("[pdf] OCR fallback succeeded: {}", path_buf.display());
                    ParseResult { content: text, status: ParseStatus::Partial }
                }
                Ok(_) => ParseResult::failed(),
                Err(e) => {
                    eprintln!("[pdf] OCR fallback failed ({}): {}", path_buf.display(), e);
                    ParseResult::failed()
                }
            };
            let _ = tx.send(result);
        });
        match rx.recv_timeout(OCR_FALLBACK_TIMEOUT) {
            Ok(r) => return r,
            Err(_) => {
                eprintln!(
                    "[pdf] OCR fallback timed out (>{}s, very large scanned PDF?): {}",
                    OCR_FALLBACK_TIMEOUT.as_secs(),
                    path.display()
                );
            }
        }
    }

    ParseResult::failed()
}

/// Returns:
///   Some(Ok)     — lopdf 抽到非空文字
///   Some(Partial)— pdf-extract 抽到非空文字(质量略低)
///   None         — 两条路都返回空(纯扫描件,需走 OCR)
fn try_text_layers(path: &Path) -> Option<ParseResult> {
    if let Ok(text) = try_lopdf(path) {
        if !text.trim().is_empty() {
            return Some(ParseResult { content: text, status: ParseStatus::Ok });
        }
    }
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX);
    if file_size <= PDF_MAX_SIZE_FOR_EXTRACT {
        if let Ok(text) = try_pdf_extract(path) {
            if !text.trim().is_empty() {
                return Some(ParseResult { content: text, status: ParseStatus::Partial });
            }
        }
    } else {
        eprintln!(
            "[pdf] skipping pdf-extract for large file ({:.1} MB): {}",
            file_size as f64 / 1024.0 / 1024.0,
            path.display()
        );
    }
    None
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

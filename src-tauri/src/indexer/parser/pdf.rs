use super::{ParseResult, ParseStatus};
use std::path::Path;

pub fn parse(path: &Path) -> ParseResult {
    // 第一级：lopdf
    if let Ok(text) = try_lopdf(path) {
        if !text.trim().is_empty() {
            return ParseResult { content: text, status: ParseStatus::Ok };
        }
    }
    // 第二级：pdf-extract
    if let Ok(text) = try_pdf_extract(path) {
        if !text.trim().is_empty() {
            return ParseResult { content: text, status: ParseStatus::Partial };
        }
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

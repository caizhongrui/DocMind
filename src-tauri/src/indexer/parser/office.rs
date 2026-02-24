use super::{ParseResult, ParseStatus};
use std::io::Read;
use std::path::Path;

/// 解析 docx / pptx（ZIP 包含 XML）
pub fn parse_xml(path: &Path) -> ParseResult {
    match extract_xml_text(path) {
        Ok(text) if !text.trim().is_empty() => {
            ParseResult { content: text, status: ParseStatus::Ok }
        }
        _ => ParseResult::failed(),
    }
}

fn extract_xml_text(path: &Path) -> anyhow::Result<String> {
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut result = String::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        // docx: word/document.xml; pptx: ppt/slides/slide*.xml
        let is_content = (name.contains("word/document") || name.contains("ppt/slides/slide"))
            && name.ends_with(".xml");
        if is_content {
            let mut raw = String::new();
            entry.read_to_string(&mut raw)?;
            result.push_str(&strip_xml_tags(&raw));
            result.push('\n');
        }
    }
    Ok(result)
}

fn strip_xml_tags(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 2);
    let mut in_tag = false;
    for ch in xml.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    // 合并多余空白
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 解析 xlsx
pub fn parse_xlsx(path: &Path) -> ParseResult {
    use calamine::{open_workbook_auto, Reader};
    match open_workbook_auto(path) {
        Ok(mut wb) => {
            let mut text = String::new();
            for name in wb.sheet_names().to_vec() {
                if let Ok(range) = wb.worksheet_range(&name) {
                    for row in range.rows() {
                        let line: Vec<String> = row
                            .iter()
                            .map(|c| c.to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                        if !line.is_empty() {
                            text.push_str(&line.join("\t"));
                            text.push('\n');
                        }
                    }
                }
            }
            ParseResult { content: text, status: ParseStatus::Ok }
        }
        Err(_) => ParseResult::failed(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_nonexistent_docx() {
        let r = parse_xml(Path::new("/no_such.docx"));
        assert_eq!(r.status, ParseStatus::Failed);
    }

    #[test]
    fn test_parse_nonexistent_xlsx() {
        let r = parse_xlsx(Path::new("/no_such.xlsx"));
        assert_eq!(r.status, ParseStatus::Failed);
    }

    #[test]
    fn test_strip_xml_tags() {
        let xml = "<w:p><w:t>Hello World</w:t></w:p>";
        let result = super::strip_xml_tags(xml);
        assert!(result.contains("Hello World"), "应保留文本内容");
        assert!(!result.contains('<'), "不应含有 XML 标签");
    }
}

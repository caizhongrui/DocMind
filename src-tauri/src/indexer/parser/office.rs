use super::{ParseResult, ParseStatus};
use std::io::Read;
use std::path::Path;

/// docx/pptx：每个 XML entry 最多读取的字节数
const MAX_XML_ENTRY_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// docx/pptx：全文提取总字符上限（超出则停止继续处理后续 entry）
const MAX_XML_TOTAL_CHARS: usize = 300_000;

/// .doc：最多从文件读取的字节数（full-read 方案，限制防 OOM）
const MAX_DOC_READ_BYTES: u64 = 50 * 1024 * 1024; // 50 MB

/// xlsx：最多处理的行数（防止百万行 Excel OOM）
const MAX_XLSX_ROWS: usize = 50_000;
/// xlsx：全文提取总字符上限
const MAX_XLSX_CONTENT_CHARS: usize = 300_000;

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
        let entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        let is_content = (name.contains("word/document") || name.contains("ppt/slides/slide"))
            && name.ends_with(".xml");
        if !is_content {
            continue;
        }

        let mut raw = String::new();
        // 限制单个 XML entry 读取量，防止异常大的嵌入内容 OOM
        entry.take(MAX_XML_ENTRY_BYTES).read_to_string(&mut raw)?;
        result.push_str(&strip_xml_tags(&raw));
        result.push('\n');

        // 提前终止：总内容已足够
        if result.chars().count() >= MAX_XML_TOTAL_CHARS {
            break;
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

/// 解析旧版 Word (.doc) 文件（Word 97-2003 CFB 二进制格式）
///
/// .doc 文件是 Compound File Binary（CFB）格式，中文内容通常以 UTF-16 LE 编码存储。
/// 这里采用"字节扫描"方式提取可读文本，属于 best-effort 方案：
///   1. 扫描字节对，识别 UTF-16 LE 编码的汉字（U+4E00..U+9FFF）及 ASCII 可打印字符
///   2. 连续可读字符段长度 >= 3 则保留
///
/// 对绝大多数包含纯文字的合同/方案 .doc 文件有效；对内嵌图片/复杂排版可能提取不完整。
pub fn parse_doc(path: &Path) -> ParseResult {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return ParseResult::failed(),
    };

    // 限制读取量，防止超大 .doc 文件 OOM（only first 50MB for byte-scanning）
    let mut bytes = Vec::new();
    if std::io::BufReader::new(file.take(MAX_DOC_READ_BYTES))
        .read_to_end(&mut bytes)
        .is_err()
    {
        return ParseResult::failed();
    }

    // 先尝试 UTF-16 LE 扫描（Word 存储中文的主要编码）
    let text = extract_utf16le_text(&bytes);
    let char_count = text.chars().filter(|c| !c.is_whitespace()).count();
    if char_count >= 20 {
        let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
        return ParseResult { content: cleaned, status: ParseStatus::Partial };
    }

    // 降级：尝试当作 UTF-8 / Latin1 读取（部分较新的 .doc 实际是伪装的 docx）
    let raw = String::from_utf8_lossy(&bytes);
    let fallback: String = raw.chars()
        .filter(|c| {
            c.is_alphanumeric() || c.is_whitespace() ||
            "，。！？、；：（）【】《》——…·「」".contains(*c)
        })
        .collect();
    let cleaned = fallback.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() >= 20 {
        ParseResult { content: cleaned, status: ParseStatus::Partial }
    } else {
        ParseResult::failed()
    }
}

/// 从字节流中扫描 UTF-16 LE 编码的可读字符（汉字 + ASCII 可打印字符）
fn extract_utf16le_text(bytes: &[u8]) -> String {
    let mut result = String::new();
    let mut segment = String::new();
    let mut i = 0;

    while i + 1 < bytes.len() {
        let lo = bytes[i];
        let hi = bytes[i + 1];
        let cp = u16::from_le_bytes([lo, hi]) as u32;

        let ch = match cp {
            // 常用汉字区
            0x4E00..=0x9FFF => char::from_u32(cp),
            // 扩展汉字区
            0x3400..=0x4DBF => char::from_u32(cp),
            // CJK 符号与标点
            0x3000..=0x303F => char::from_u32(cp),
            // 全角标点
            0xFF00..=0xFFEF => char::from_u32(cp),
            // ASCII 可打印字符（高字节必须为 0x00）
            0x0020..=0x007E if hi == 0x00 => char::from_u32(cp),
            _ => None,
        };

        if let Some(c) = ch {
            segment.push(c);
            i += 2;
        } else {
            if segment.chars().count() >= 12 {
                result.push_str(&segment);
                result.push(' ');
            }
            segment.clear();
            i += 1;
        }
    }
    if segment.chars().count() >= 12 {
        result.push_str(&segment);
    }
    result
}

/// 解析 xlsx
pub fn parse_xlsx(path: &Path) -> ParseResult {
    use calamine::{open_workbook_auto, Reader};
    match open_workbook_auto(path) {
        Ok(mut wb) => {
            let mut text = String::new();
            'outer: for name in wb.sheet_names().to_vec() {
                if let Ok(range) = wb.worksheet_range(&name) {
                    let mut row_count = 0usize;
                    for row in range.rows() {
                        row_count += 1;
                        if row_count > MAX_XLSX_ROWS {
                            break;
                        }
                        let line: Vec<String> = row
                            .iter()
                            .map(|c| c.to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                        if !line.is_empty() {
                            text.push_str(&line.join("\t"));
                            text.push('\n');
                        }
                        // 提前终止：总内容已足够
                        if text.len() >= MAX_XLSX_CONTENT_CHARS {
                            break 'outer;
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

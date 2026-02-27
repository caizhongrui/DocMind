use super::{ParseResult, ParseStatus};
use std::io::Read;
use std::path::Path;

/// 单次最多从文本文件读取的字节数。
/// 超大日志文件、数据 dump 等只会读取开头部分，避免 OOM。
const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB

/// 解析纯文本文件（txt / md / csv / rst），自动尝试 UTF-8 和 GBK 编码。
pub fn parse(path: &Path) -> ParseResult {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return ParseResult::failed(),
    };

    let mut bytes = Vec::new();
    if std::io::BufReader::new(file.take(MAX_READ_BYTES))
        .read_to_end(&mut bytes)
        .is_err()
    {
        return ParseResult::failed();
    }

    // 先尝试 UTF-8
    match String::from_utf8(bytes.clone()) {
        Ok(content) => ParseResult { content, status: ParseStatus::Ok },
        Err(_) => {
            // fallback: GBK（中文 Windows 常见编码）
            let (content, _, _) = encoding_rs::GBK.decode(&bytes);
            ParseResult { content: content.into_owned(), status: ParseStatus::Ok }
        }
    }
}

/// 解析 RTF（Rich Text Format）文件。
///
/// 采用 best-effort 方式：剥离 RTF 控制字和分组标记，提取可读文字。
/// 对标准 Word / LibreOffice 导出的 RTF 文件效果良好；
/// 对含大量嵌入图片或复杂宏的 RTF 提取可能不完整。
pub fn parse_rtf(path: &Path) -> ParseResult {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return ParseResult::failed(),
    };

    let mut bytes = Vec::new();
    if std::io::BufReader::new(file.take(MAX_READ_BYTES))
        .read_to_end(&mut bytes)
        .is_err()
    {
        return ParseResult::failed();
    }

    // RTF 通常为 ASCII / Latin-1 编码，用 lossy UTF-8 处理非 ASCII 字节
    let raw = match String::from_utf8(bytes.clone()) {
        Ok(s) => s,
        Err(_) => String::from_utf8_lossy(&bytes).into_owned(),
    };

    let text = strip_rtf_controls(&raw);
    if text.split_whitespace().count() >= 5 {
        ParseResult { content: text, status: ParseStatus::Partial }
    } else {
        ParseResult::failed()
    }
}

/// 从 RTF 字符串中剥离控制字，提取可读文本。
fn strip_rtf_controls(rtf: &str) -> String {
    let mut out = String::with_capacity(rtf.len() / 2);
    let mut chars = rtf.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                match chars.peek() {
                    // \'xx 十六进制字符转义 → 尽量还原字符
                    Some('\'') => {
                        chars.next(); // consume '
                        let h1 = chars.next().unwrap_or('0');
                        let h2 = chars.next().unwrap_or('0');
                        if let Ok(byte) = u8::from_str_radix(&format!("{h1}{h2}"), 16) {
                            if byte >= 0x20 {
                                out.push(byte as char);
                            }
                        }
                    }
                    // \* 目标标记：跳过
                    Some('*') => { chars.next(); }
                    // \n \r → 换行
                    Some('\n') | Some('\r') => { chars.next(); out.push('\n'); }
                    // \\ → 字面反斜杠
                    Some('\\') => { chars.next(); out.push('\\'); }
                    // \{ \} → 字面花括号
                    Some('{') => { chars.next(); out.push('{'); }
                    Some('}') => { chars.next(); out.push('}'); }
                    // \uN? → Unicode 字符（N 是十进制码点，? 是 ANSI 替代字符）
                    Some('u') => {
                        chars.next(); // consume 'u'
                        let mut num_str = String::new();
                        if chars.peek() == Some(&'-') {
                            num_str.push('-');
                            chars.next();
                        }
                        while chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                            num_str.push(chars.next().unwrap());
                        }
                        // 跳过 ANSI 替代字符（下一个 \' 或普通字符）
                        if chars.peek() == Some(&' ') { chars.next(); }
                        if let Ok(n) = num_str.parse::<i32>() {
                            let cp = if n < 0 { (n + 65536) as u32 } else { n as u32 };
                            if let Some(c) = char::from_u32(cp) {
                                out.push(c);
                            }
                        }
                    }
                    // 其他控制字：\word 或 \word123，跳过
                    _ => {
                        while chars.peek().map(|c| c.is_alphabetic()).unwrap_or(false) {
                            chars.next();
                        }
                        // 跳过控制字后的可选数字参数
                        while chars.peek().map(|c| c.is_ascii_digit() || *c == '-').unwrap_or(false) {
                            chars.next();
                        }
                        // 控制字后紧跟的空格是分隔符，跳过
                        if chars.peek() == Some(&' ') {
                            chars.next();
                        }
                    }
                }
            }
            '{' | '}' => {} // 跳过分组标记
            '\n' | '\r' => out.push(' '),
            c => out.push(c),
        }
    }

    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_parse_utf8() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        write!(f, "你好世界\nHello DocMind").unwrap();
        let r = parse(f.path());
        assert_eq!(r.status, ParseStatus::Ok);
        assert!(r.content.contains("你好世界"));
    }

    #[test]
    fn test_parse_missing_file() {
        let r = parse(Path::new("/nonexistent_abc.txt"));
        assert_eq!(r.status, ParseStatus::Failed);
    }

    #[test]
    fn test_parse_empty_file() {
        let f = tempfile::NamedTempFile::new().unwrap();
        let r = parse(f.path());
        assert_eq!(r.status, ParseStatus::Ok);
        assert!(r.content.is_empty());
    }

    #[test]
    fn test_strip_rtf_basic() {
        let rtf = r#"{\rtf1\ansi\deff0 {\fonttbl{\f0 Arial;}} \f0\fs24 Hello World }"#;
        let result = strip_rtf_controls(rtf);
        assert!(result.contains("Hello World"), "应提取到文本: {result}");
    }

    #[test]
    fn test_strip_rtf_unicode() {
        // \u20013? 是 Unicode 码点 20013（"中"），? 为替代字符
        let rtf = r#"{\rtf1 \u20013?}"#;
        let result = strip_rtf_controls(rtf);
        assert!(result.contains('中'), "应还原 Unicode 字符: {result}");
    }
}

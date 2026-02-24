use super::{ParseResult, ParseStatus};
use std::path::Path;

pub fn parse(path: &Path) -> ParseResult {
    // 先尝试 UTF-8
    if let Ok(content) = std::fs::read_to_string(path) {
        return ParseResult { content, status: ParseStatus::Ok };
    }
    // fallback: GBK（中文 Windows 常见编码）
    match std::fs::read(path) {
        Ok(bytes) => {
            let (content, _, _) = encoding_rs::GBK.decode(&bytes);
            ParseResult { content: content.into_owned(), status: ParseStatus::Ok }
        }
        Err(_) => ParseResult::failed(),
    }
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
}

use std::io::Read;
use std::path::Path;
use super::{ParseResult, ParseStatus};

/// 提取 ZIP 文件中所有文本文件的内容（.txt, .md, .csv）
pub fn parse_zip(path: &Path) -> ParseResult {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[parser/zip] Failed to open {}: {e}", path.display());
            return ParseResult::failed();
        }
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[parser/zip] Failed to read ZIP {}: {e}", path.display());
            return ParseResult::failed();
        }
    };

    let mut all_text = String::new();
    let mut had_content = false;

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_lowercase();
        // 只处理文本类文件，跳过目录和二进制
        let is_text = name.ends_with(".txt") || name.ends_with(".md") || name.ends_with(".csv");
        if !is_text || entry.is_dir() {
            continue;
        }
        let mut buf = String::new();
        if entry.read_to_string(&mut buf).is_ok() && !buf.is_empty() {
            if !all_text.is_empty() {
                all_text.push_str("\n\n--- ");
                all_text.push_str(entry.name());
                all_text.push_str(" ---\n");
            }
            all_text.push_str(&buf);
            had_content = true;
        }
    }

    if had_content {
        ParseResult { content: all_text, status: ParseStatus::Ok }
    } else {
        ParseResult::failed()
    }
}

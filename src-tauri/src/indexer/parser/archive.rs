use std::io::Read;
use std::path::Path;
use super::{ParseResult, ParseStatus};

/// 每个文本 entry 最多读取的字节数
const MAX_ENTRY_BYTES: u64 = 5 * 1024 * 1024; // 5 MB
/// 所有 entry 合并后的总字符上限
const MAX_TOTAL_CHARS: usize = 200_000;

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
        let entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let entry_name = entry.name().to_string(); // 提前保存，take() 会转移所有权
        let name_lower = entry_name.to_lowercase();
        let is_text = name_lower.ends_with(".txt") || name_lower.ends_with(".md") || name_lower.ends_with(".csv");
        if !is_text || entry.is_dir() {
            continue;
        }

        let mut buf = String::new();
        // 每个 entry 限制读取量，防止单个超大文本文件 OOM
        if entry.take(MAX_ENTRY_BYTES).read_to_string(&mut buf).is_ok() && !buf.is_empty() {
            if !all_text.is_empty() {
                all_text.push_str("\n\n--- ");
                all_text.push_str(&entry_name);
                all_text.push_str(" ---\n");
            }

            // 检查追加后是否超出总字符上限
            let remaining = MAX_TOTAL_CHARS.saturating_sub(all_text.chars().count());
            if remaining == 0 {
                had_content = true;
                break;
            }
            if buf.chars().count() > remaining {
                // 截断到上限
                let truncated: String = buf.chars().take(remaining).collect();
                all_text.push_str(&truncated);
                had_content = true;
                break;
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

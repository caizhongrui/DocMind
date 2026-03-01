use std::io::{Read, Write};
use std::path::Path;
use super::{ParseResult, ParseStatus};
use super::{pdf, office, text};

/// 每个 ZIP entry 最多读取的字节数（二进制格式用此上限提取到临时文件）
const MAX_ENTRY_BYTES: u64 = 20 * 1024 * 1024; // 20 MB
/// 所有 entry 合并后的总字符上限
const MAX_TOTAL_CHARS: usize = 200_000;

/// 提取 ZIP 文件中所有受支持格式的内容
///
/// 文本格式（txt / md / csv / rst）：直接从流中读取，无需落盘。
/// 二进制格式（pdf / docx / pptx / xls / xlsx / doc / ppt / rtf）：
///   提取到带正确扩展名的临时文件，复用现有 parser，解析后自动删除。
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

    // 先收集 entry 信息（名称、是否目录），避免借用冲突
    let entries: Vec<(String, bool)> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|e| (e.name().to_string(), e.is_dir())))
        .collect();

    for (idx, (entry_name, is_dir)) in entries.iter().enumerate() {
        if all_text.chars().count() >= MAX_TOTAL_CHARS {
            break;
        }
        if *is_dir {
            continue;
        }

        let name_lower = entry_name.to_lowercase();
        let ext = Path::new(&name_lower)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let content: Option<String> = match ext {
            // ── 纯文本：直接从 ZIP 流读取，无需落盘 ──────────────────────
            "txt" | "md" | "csv" | "rst" => {
                let entry = match archive.by_index(idx) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let mut buf = String::new();
                if entry.take(MAX_ENTRY_BYTES).read_to_string(&mut buf).is_ok() && !buf.is_empty() {
                    Some(buf)
                } else {
                    None
                }
            }
            // ── 二进制格式：提取到临时文件后复用现有 parser ───────────────
            "rtf" | "pdf" | "docx" | "pptx" | "xls" | "xlsx" | "doc" | "ppt" => {
                let entry = match archive.by_index(idx) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                // 创建带正确扩展名的临时文件（解析完毕后自动删除）
                let mut tmp: tempfile::NamedTempFile = match tempfile::Builder::new()
                    .suffix(&format!(".{ext}"))
                    .tempfile()
                {
                    Ok(f) => f,
                    Err(e) => {
                        eprintln!("[parser/zip] tempfile create failed for {entry_name}: {e}");
                        continue;
                    }
                };
                // 流式写入，限制单 entry 大小防 OOM
                if std::io::copy(&mut entry.take(MAX_ENTRY_BYTES), tmp.as_file_mut()).is_err() {
                    continue;
                }
                // 确保写入完成
                let _ = tmp.as_file_mut().flush();

                let tmp_path = tmp.path().to_path_buf();
                let result = match ext {
                    "rtf"           => text::parse_rtf(&tmp_path),
                    "pdf"           => pdf::parse(&tmp_path),
                    "docx" | "pptx" => office::parse_xml(&tmp_path),
                    "xls"  | "xlsx" => office::parse_xlsx(&tmp_path),
                    "doc"  | "ppt"  => office::parse_doc(&tmp_path),
                    _               => ParseResult::failed(),
                };
                // tmp 在此 drop，临时文件自动删除
                if !result.content.is_empty() { Some(result.content) } else { None }
            }
            _ => None,
        };

        if let Some(text) = content {
            if text.is_empty() {
                continue;
            }
            if !all_text.is_empty() {
                all_text.push_str("\n\n--- ");
                all_text.push_str(entry_name);
                all_text.push_str(" ---\n");
            }

            let remaining = MAX_TOTAL_CHARS.saturating_sub(all_text.chars().count());
            if remaining == 0 {
                had_content = true;
                break;
            }
            if text.chars().count() > remaining {
                let truncated: String = text.chars().take(remaining).collect();
                all_text.push_str(&truncated);
                had_content = true;
                break;
            }

            all_text.push_str(&text);
            had_content = true;
        }
    }

    if had_content {
        ParseResult { content: all_text, status: ParseStatus::Ok }
    } else {
        ParseResult::failed()
    }
}

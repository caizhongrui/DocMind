use crate::{search, state::AppState};
use tauri::State;

#[tauri::command]
pub fn search_files(
    query: String,
    mode: String, // "filename" | "fulltext" | "semantic"
    limit: Option<usize>,
    sort_by: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<search::SearchResult>, String> {
    let limit = limit.unwrap_or(50);
    // Semantic search counts against the same monthly AI quota as Q&A.
    if mode == "semantic" {
        crate::commands::license::consume_ai_quota(&state)?;
    }
    let mut results = match mode.as_str() {
        "filename" => search::search_filename(&query, &state, limit),
        "semantic" => search::search_semantic(&query, &state, limit),
        _ => search::search_fulltext(&query, &state, limit),
    }
    .map_err(|e| e.to_string())?;

    // 过滤掉磁盘上已不存在的文件（Tantivy/SQLite 删除延迟或失败时的兜底保障）
    results.retain(|r| std::path::Path::new(&r.path).exists());

    // 按 file_id 去重：同一文件只保留得分最高的那条（结果已按 score 降序排列）
    let mut seen = std::collections::HashSet::new();
    results.retain(|r| seen.insert(r.file_id));

    // 按指定字段排序（relevance 为默认，保持当前 score 降序）
    match sort_by.as_deref() {
        Some("modified") => {
            results.sort_by(|a, b| {
                let ta = std::fs::metadata(&a.path).ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                    .unwrap_or(0);
                let tb = std::fs::metadata(&b.path).ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                    .unwrap_or(0);
                tb.cmp(&ta) // 最新修改在前
            });
        }
        Some("size") => {
            results.sort_by(|a, b| {
                let sa = std::fs::metadata(&a.path).ok().map(|m| m.len()).unwrap_or(0);
                let sb = std::fs::metadata(&b.path).ok().map(|m| m.len()).unwrap_or(0);
                sb.cmp(&sa) // 最大文件在前
            });
        }
        _ => {} // "relevance" 或 None：保持原来 score 降序，不用重排
    }

    Ok(results)
}

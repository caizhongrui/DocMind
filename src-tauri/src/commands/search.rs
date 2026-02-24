use crate::{search, state::AppState};
use tauri::State;

#[tauri::command]
pub fn search_files(
    query: String,
    mode: String, // "filename" | "fulltext"
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<search::SearchResult>, String> {
    let limit = limit.unwrap_or(50);
    match mode.as_str() {
        "filename" => search::search_filename(&query, &state, limit),
        _ => search::search_fulltext(&query, &state, limit),
    }
    .map_err(|e| e.to_string())
}

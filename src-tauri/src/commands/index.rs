use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn start_index(
    folder: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let path = std::path::Path::new(&folder);
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT OR IGNORE INTO watched_folders (path) VALUES (?1)",
            [&folder],
        )
        .map_err(|e| e.to_string())?;
    }
    crate::indexer::scan_and_index(path, &state, &app)
        .map(|_| "ok".to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_watched_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare("SELECT path FROM watched_folders WHERE enabled = 1")
        .map_err(|e| e.to_string())?;
    let folders: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(folders)
}

#[tauri::command]
pub fn remove_folder(folder: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM watched_folders WHERE path = ?1", [&folder])
        .map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM files WHERE path LIKE ?1",
        [format!("{}%", folder)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

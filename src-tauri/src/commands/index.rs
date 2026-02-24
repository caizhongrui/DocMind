use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn start_index(
    folder: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    // 立即将文件夹写入 DB
    {
        let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
        db.execute(
            "INSERT OR IGNORE INTO watched_folders (path) VALUES (?1)",
            [&folder],
        )
        .map_err(|e| e.to_string())?;
    }

    // 后台线程执行索引，立即返回，不阻塞 IPC
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let path = std::path::Path::new(&folder);
        match crate::indexer::scan_and_index(path, &state, &app) {
            Ok(_) => {
                let _ = app.emit("index-complete", &folder);
            }
            Err(e) => {
                eprintln!("[index] scan error for {folder}: {e}");
                let _ = app.emit(
                    "index-error",
                    serde_json::json!({ "folder": folder, "error": e.to_string() }),
                );
            }
        }
    });

    Ok("started".to_string())
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
    let fts = state.fts.lock().unwrap();

    // 转义 LIKE 特殊字符
    let escaped = folder
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let like_pattern = format!("{}%", escaped);

    // 1. 查询要删除的文件 ID
    let mut stmt = db
        .prepare("SELECT id FROM files WHERE path LIKE ?1 ESCAPE '\\'")
        .map_err(|e| e.to_string())?;
    let file_ids: Vec<i64> = stmt
        .query_map([&like_pattern], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    // 2. 从 Tantivy 删除对应文档
    if !file_ids.is_empty() {
        let mut writer = fts.writer().map_err(|e| e.to_string())?;
        for file_id in &file_ids {
            fts.delete_document(&writer, *file_id as u64)
                .map_err(|e| e.to_string())?;
        }
        writer.commit().map_err(|e| e.to_string())?;
    }

    // 3. 从 SQLite 删除记录
    db.execute("DELETE FROM watched_folders WHERE path = ?1", [&folder])
        .map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM files WHERE path LIKE ?1 ESCAPE '\\'",
        [&like_pattern],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

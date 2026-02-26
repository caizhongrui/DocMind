use crate::state::AppState;
use std::path::PathBuf;
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

    // 动态添加到文件系统监听器（此后该目录的文件变化会被自动重索引）
    {
        let watcher_state = app.state::<crate::watcher::WatcherState>();
        crate::watcher::add_watch_path(&watcher_state, &folder);
    }

    // 后台线程执行索引，立即返回，不阻塞 IPC
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let path = std::path::Path::new(&folder);

        // Phase 1：全文索引，完成后立即通知前端（用户可开始使用全文搜索）
        match crate::indexer::scan_and_index(path, &state, &app) {
            Ok(to_embed) => {
                let _ = app.emit("index-complete", &folder);

                // Phase 2：embedding 生成，静默后台运行，不再阻塞也不再通知
                if !to_embed.is_empty() {
                    crate::indexer::generate_embeddings(to_embed, &state, &app);
                }
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

/// 获取索引统计信息
#[tauri::command]
pub fn get_index_stats(state: State<'_, AppState>) -> Result<IndexStats, String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    let file_count: i64 = db
        .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
        .unwrap_or(0);
    let chunk_count: i64 = db
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap_or(0);
    // 获取 DB 文件大小
    let db_path: String = db
        .query_row("PRAGMA database_list", [], |r| r.get::<_, String>(2))
        .unwrap_or_default();
    let db_size_mb = std::fs::metadata(&db_path)
        .map(|m| m.len() as f64 / 1024.0 / 1024.0)
        .unwrap_or(0.0);
    Ok(IndexStats { file_count, chunk_count, db_size_mb })
}

#[derive(serde::Serialize)]
pub struct IndexStats {
    pub file_count: i64,
    pub chunk_count: i64,
    pub db_size_mb: f64,
}

/// 一键清除所有索引（文件记录、全文索引、向量索引）
#[tauri::command]
pub fn clear_all_index(state: State<'_, AppState>) -> Result<(), String> {
    // 1. 清空 SQLite 数据（watched_folders、files、chunks、embeddings 级联删除）
    {
        let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
        db.execute("DELETE FROM watched_folders", []).map_err(|e| e.to_string())?;
        db.execute("DELETE FROM files", []).map_err(|e| e.to_string())?;
        db.execute("DELETE FROM chunks", []).map_err(|e| e.to_string())?;
        db.execute("DELETE FROM embeddings", []).map_err(|e| e.to_string())?;
    }
    // 2. 重置全文索引
    {
        let fts = state.fts.lock().map_err(|_| "fts lock poisoned".to_string())?;
        if let Err(e) = fts.clear_all() {
            eprintln!("[clear_all_index] fts clear error: {e}");
        }
    }
    // 3. 重置向量索引
    {
        let mut vi_guard = state.vector_index.lock().map_err(|_| "vi lock poisoned".to_string())?;
        if let Some(vi) = vi_guard.as_mut() {
            if let Err(e) = vi.reset() {
                eprintln!("[clear_all_index] vector index reset error: {e}");
            }
        }
    }
    Ok(())
}

/// 强制重建语义向量索引：清空旧的 chunk/embedding 数据，重置向量索引，
/// 对所有已索引文件重新生成 embedding。
///
/// 适用场景：
/// - 首次添加 embedding 模型后需要对已有文件生成向量
/// - chunk 参数变更（chunk_size、overlap）后需要重新分块
/// - 向量索引与 DB 不一致（版本升级、意外崩溃等）
#[tauri::command]
pub fn rebuild_vector_index(state: State<'_, AppState>, app: AppHandle) -> Result<String, String> {
    // 前置检查：embedder 必须已加载
    {
        let eg = state.embedder.lock().map_err(|_| "embedder lock poisoned".to_string())?;
        if eg.is_none() {
            return Err("embedding 模型未加载，无法重建语义索引".to_string());
        }
    }

    std::thread::spawn(move || {
        let state = app.state::<AppState>();

        // 1. 读取所有已成功索引的文件路径
        let files: Vec<(i64, PathBuf)> = {
            let db = match state.db.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let mut stmt = match db.prepare(
                "SELECT id, path FROM files WHERE parse_status != 'failed'",
            ) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[rebuild] db prepare error: {e}");
                    return;
                }
            };
            stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map(|rows| {
                    rows.flatten()
                        .map(|(id, path)| (id, PathBuf::from(path)))
                        .collect()
                })
                .unwrap_or_default()
        };

        if files.is_empty() {
            let _ = app.emit("embed-rebuild-complete", serde_json::json!({"status": "no_files"}));
            return;
        }

        // 2. 清空 DB 中的 chunks 和 embeddings（级联删除）
        {
            let db = match state.db.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let _ = db.execute("DELETE FROM embeddings", []);
            let _ = db.execute("DELETE FROM chunks", []);
        }

        // 3. 重置向量索引（清空旧条目，从零开始）
        {
            let mut vi_guard = match state.vector_index.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if let Some(vi) = vi_guard.as_mut() {
                if let Err(e) = vi.reset() {
                    eprintln!("[rebuild] vector index reset error: {e}");
                    return;
                }
            }
        }

        // 4. 重新生成所有文件的 embedding
        crate::indexer::generate_embeddings(files, &state, &app);

        let _ = app.emit("embed-rebuild-complete", serde_json::json!({"status": "done"}));
    });

    Ok("started".to_string())
}

use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_setting(key: String, state: State<'_, AppState>) -> Option<String> {
    let db = state.db.lock().map_err(|e| e.to_string()).ok()?;
    db.query_row("SELECT value FROM settings WHERE key = ?1", [&key], |r| r.get(0)).ok()
}

#[tauri::command]
pub fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        [&key, &value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        use std::process::Command;
        Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .args(["/select,", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux 上没有 reveal in finder，打开父文件夹作为降级
        use std::process::Command;
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        Command::new("xdg-open").arg(&parent).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 读取文件的原始字节并 base64 编码，供前端渲染 PDF / 图片等二进制格式
/// 限制：最多读取 50MB（避免超大文件撑爆 IPC）
#[tauri::command]
pub async fn read_binary_preview(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        use std::io::Read;

        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let max_bytes = (meta.len() as usize).min(50 * 1024 * 1024);

        let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; max_bytes];
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);

        Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取文件文字预览（在 spawn_blocking 内执行，避免阻塞 Tauri 命令线程）
/// - `hint`: 可选的提示文本（搜索结果的 snippet），若提供则定位到该文本所在位置展示上下文
#[tauri::command]
pub async fn read_file_preview(path: String, hint: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use crate::indexer::parser::parse_file;
        use std::path::Path;

        let result = parse_file(Path::new(&path));
        let content = result.content;
        let chars: Vec<char> = content.chars().collect();
        let total_chars = chars.len();

        if total_chars == 0 {
            return Err("无法读取文件内容".to_string());
        }

        // 若有 hint，尝试定位到 hint 所在位置，以该位置为中心展示上下文
        if let Some(ref hint_text) = hint {
            // 用前 60 个字符匹配，避免截断后的 snippet 找不到
            let search_key: String = hint_text.chars().take(60).collect();
            if !search_key.is_empty() {
                let content_lower = content.to_lowercase();
                let key_lower = search_key.to_lowercase();
                // 先精确匹配，再尝试更短的片段（兼容语义 snippet 与原文略有出入的情况）
                let byte_pos_opt = content_lower.find(&key_lower)
                    .or_else(|| {
                        let shorter: String = key_lower.chars().take(30).collect();
                        content_lower.find(&shorter)
                    });
                if let Some(byte_pos) = byte_pos_opt {
                    let char_pos = content[..byte_pos].chars().count();
                    // 在匹配位置前后各展示足够的上下文
                    let start_char = char_pos.saturating_sub(300);
                    let end_char = (char_pos + 4000).min(total_chars);
                    let snippet: String = chars[start_char..end_char].iter().collect();
                    let prefix = if start_char > 0 { "......\n\n" } else { "" };
                    let suffix = if end_char < total_chars {
                        format!("\n\n......（仅展示匹配位置附近内容，文件共 {} 字符）", total_chars)
                    } else {
                        String::new()
                    };
                    return Ok(format!("{}{}{}", prefix, snippet, suffix));
                }
            }
        }

        // 无 hint 或未找到：展示文件开头内容
        const PREVIEW_CHARS: usize = 5000;
        let preview_chars: String = chars.iter().take(PREVIEW_CHARS).collect();
        let preview = if total_chars > PREVIEW_CHARS {
            format!("{}\n\n......（内容已截断，文件共 {} 字符）", preview_chars, total_chars)
        } else {
            preview_chars
        };

        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 将文本写入指定路径的文件（供前端导出功能使用）
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// 读取已保存的全局快捷键（None = 未设置）
#[tauri::command]
pub fn get_global_shortcut(state: State<'_, AppState>) -> Option<String> {
    let db = state.db.lock().ok()?;
    db.query_row(
        "SELECT value FROM settings WHERE key = 'global_shortcut'",
        [],
        |r| r.get(0),
    )
    .ok()
}

/// 设置（注册）或清除全局快捷键
///
/// shortcut = None 或空字符串时取消注册。
#[tauri::command]
pub fn set_global_shortcut(
    shortcut: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // 先取消所有已注册的快捷键
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;

    // 注册新快捷键（若提供）
    if let Some(ref s) = shortcut {
        if !s.is_empty() {
            app.global_shortcut()
                .register(s.as_str())
                .map_err(|e| {
                    let msg = e.to_string();
                    if msg.contains("already") || msg.contains("registered") || msg.contains("conflict") {
                        format!("快捷键 {s} 已被其他应用占用，请选择其他组合")
                    } else {
                        format!("注册快捷键失败：{e}")
                    }
                })?;
        }
    }

    // 持久化到 settings 表
    let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    match shortcut.as_deref() {
        Some(s) if !s.is_empty() => {
            db.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('global_shortcut', ?1)",
                [s],
            )
            .map_err(|e| e.to_string())?;
        }
        _ => {
            let _ = db.execute("DELETE FROM settings WHERE key = 'global_shortcut'", []);
        }
    }

    Ok(())
}

/// 检测全局快捷键是否可用（不实际注册保存）
/// 返回 true = 可用，false = 已被占用
#[tauri::command]
pub fn check_shortcut_conflict(
    shortcut: String,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    // 先取消所有注册，避免自冲突
    let _ = app.global_shortcut().unregister_all();
    match app.global_shortcut().register(shortcut.as_str()) {
        Ok(_) => {
            // 测试通过，立即取消注册
            let _ = app.global_shortcut().unregister(shortcut.as_str());
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

/// 获取定时重索引间隔（分钟，0 = 禁用）
#[tauri::command]
pub fn get_reindex_interval(state: State<'_, AppState>) -> u64 {
    let db = match state.db.lock().ok() {
        Some(db) => db,
        None => return 0,
    };
    db.query_row::<String, _, _>(
        "SELECT value FROM settings WHERE key = 'reindex_interval_min'",
        [],
        |r| r.get(0),
    )
    .ok()
    .and_then(|s| s.parse().ok())
    .unwrap_or(0)
}

/// 设置定时重索引间隔（分钟，0 = 禁用）
#[tauri::command]
pub fn set_reindex_interval(minutes: u64, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('reindex_interval_min', ?1)",
        rusqlite::params![minutes.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取用户配置的可索引文件扩展名列表。
/// settings 表中 key = "indexed_file_types"，value = 逗号分隔字符串。
/// key 不存在时返回全量默认列表（向后兼容）。
#[tauri::command]
pub fn get_indexed_types(state: State<'_, AppState>) -> Vec<String> {
    use crate::indexer::SUPPORTED_EXTS;

    let db = match state.db.lock().ok() {
        Some(d) => d,
        None => return SUPPORTED_EXTS.iter().map(|s| s.to_string()).collect(),
    };

    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key = 'indexed_file_types'",
            [],
            |r| r.get(0),
        )
        .ok();

    match raw {
        Some(s) if !s.is_empty() => {
            s.split(',').map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect()
        }
        _ => SUPPORTED_EXTS.iter().map(|s| s.to_string()).collect(),
    }
}

/// 保存可索引文件扩展名配置。
///
/// `types`: 新的启用扩展名列表
/// `cleanup_removed`: true = 同时从索引中删除已不再启用类型的文件记录
#[tauri::command]
pub fn set_indexed_types(
    types: Vec<String>,
    cleanup_removed: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::indexer::SUPPORTED_EXTS;

    // 1. 读取旧配置（用于计算被移除的类型）
    let old_types: Vec<String> = {
        let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
        db.query_row(
            "SELECT value FROM settings WHERE key = 'indexed_file_types'",
            [],
            |r: &rusqlite::Row| r.get::<_, String>(0),
        )
        .ok()
        .map(|s| s.split(',').map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect())
        .unwrap_or_else(|| SUPPORTED_EXTS.iter().map(|s| s.to_string()).collect())
    };

    // 2. 保存新配置
    {
        let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
        db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('indexed_file_types', ?1)",
            rusqlite::params![types.join(",")],
        )
        .map_err(|e| e.to_string())?;
    }

    // 3. 可选：清理被移除类型的索引记录
    if cleanup_removed {
        let new_set: std::collections::HashSet<String> = types.iter().cloned().collect();
        let removed: Vec<String> = old_types.into_iter().filter(|t| !new_set.contains(t)).collect();

        if !removed.is_empty() {
            // 3a. 查出要删除的 file_id 列表
            let file_ids: Vec<i64> = {
                let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
                let placeholders = removed.iter().enumerate()
                    .map(|(i, _)| format!("?{}", i + 1))
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!("SELECT id FROM files WHERE file_type IN ({})", placeholders);
                let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
                let params: Vec<&dyn rusqlite::types::ToSql> =
                    removed.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
                let result: Vec<i64> = stmt.query_map(params.as_slice(), |r| r.get(0))
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .collect();
                result
            };

            // 3b. 从 Tantivy FTS 删除对应文档
            if !file_ids.is_empty() {
                let fts = state.fts.lock().map_err(|_| "fts lock poisoned".to_string())?;
                let mut writer = fts.writer().map_err(|e| e.to_string())?;
                for fid in &file_ids {
                    let _ = fts.delete_document(&writer, *fid as u64);
                }
                writer.commit().map_err(|e| e.to_string())?;
            }

            // 3c. 从 SQLite 删除记录（CASCADE → chunks → embeddings）
            {
                let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
                let placeholders = removed.iter().enumerate()
                    .map(|(i, _)| format!("?{}", i + 1))
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!("DELETE FROM files WHERE file_type IN ({})", placeholders);
                let params: Vec<&dyn rusqlite::types::ToSql> =
                    removed.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
                db.execute(&sql, params.as_slice()).map_err(|e| e.to_string())?;
            }

            println!("[settings] cleaned {} file type(s): {:?}", removed.len(), removed);
        }
    }

    Ok(())
}

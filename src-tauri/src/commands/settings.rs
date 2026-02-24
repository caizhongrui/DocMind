use crate::state::AppState;
use tauri::State;

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

#[tauri::command]
pub fn read_file_preview(path: String) -> Result<String, String> {
    use crate::indexer::parser::parse_file;
    use std::path::Path;

    let result = parse_file(Path::new(&path));

    // 安全截取 UTF-8 字符串前 3000 个字符（不是字节）
    let chars: String = result.content.chars().take(3000).collect();
    let preview = if result.content.chars().count() > 3000 {
        format!("{}\n\n...(内容已截断，共 {} 字符)", chars, result.content.chars().count())
    } else {
        chars
    };

    if preview.is_empty() {
        Err("无法读取文件内容".to_string())
    } else {
        Ok(preview)
    }
}

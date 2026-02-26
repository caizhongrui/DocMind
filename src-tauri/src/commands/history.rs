use crate::state::AppState;
use tauri::State;

#[derive(serde::Serialize)]
pub struct SearchHistoryItem {
    pub id: i64,
    pub query: String,
    pub mode: String,
    pub used_at: String,
}

/// 获取搜索历史（最近 limit 条，默认 30）
#[tauri::command]
pub fn get_search_history(
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<SearchHistoryItem>, String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    let limit = limit.unwrap_or(30).min(50);
    let mut stmt = db
        .prepare(
            "SELECT id, query, mode, used_at FROM search_history \
             ORDER BY used_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map([limit], |r| {
            Ok(SearchHistoryItem {
                id: r.get(0)?,
                query: r.get(1)?,
                mode: r.get(2)?,
                used_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(items)
}

/// 记录搜索（upsert，相同 query+mode 更新时间）
#[tauri::command]
pub fn add_search_history(
    query: String,
    mode: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if query.trim().is_empty() {
        return Ok(());
    }
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    // 先 upsert：相同 query+mode 则更新时间，否则插入新行
    db.execute(
        "INSERT INTO search_history (query, mode, used_at) VALUES (?1, ?2, datetime('now','localtime')) \
         ON CONFLICT(query, mode) DO UPDATE SET used_at = excluded.used_at",
        rusqlite::params![query.trim(), mode],
    )
    .map_err(|e| e.to_string())?;
    // upsert 后再检查数量，超出 50 条则删最旧的
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM search_history", [], |r| r.get(0))
        .unwrap_or(0);
    if count > 50 {
        let _ = db.execute(
            "DELETE FROM search_history WHERE id IN \
             (SELECT id FROM search_history ORDER BY used_at ASC LIMIT ?1)",
            rusqlite::params![count - 50],
        );
    }
    Ok(())
}

/// 删除单条搜索历史
#[tauri::command]
pub fn delete_search_history_item(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    db.execute("DELETE FROM search_history WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空搜索历史
#[tauri::command]
pub fn clear_search_history(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    db.execute("DELETE FROM search_history", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

use crate::state::AppState;
use tauri::State;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ConversationInfo {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(serde::Serialize, Clone)]
pub struct MessageInfo {
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub sources_json: Option<String>,
    pub created_at: String,
}

/// 创建新对话，返回 id
#[tauri::command]
pub fn create_conversation(
    title: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    let title = title.unwrap_or_else(|| "新对话".to_string());
    db.execute(
        "INSERT INTO conversations (title) VALUES (?1)",
        rusqlite::params![title],
    )
    .map_err(|e| e.to_string())?;
    Ok(db.last_insert_rowid())
}

/// 列出所有对话（最新在前）
#[tauri::command]
pub fn list_conversations(state: State<'_, AppState>) -> Result<Vec<ConversationInfo>, String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    let mut stmt = db
        .prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map([], |r| {
            Ok(ConversationInfo {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(items)
}

/// 获取对话的所有消息
#[tauri::command]
pub fn get_conversation_messages(
    conversation_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<MessageInfo>, String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    let mut stmt = db
        .prepare(
            "SELECT id, conversation_id, role, content, sources_json, created_at \
             FROM messages WHERE conversation_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(rusqlite::params![conversation_id], |r| {
            Ok(MessageInfo {
                id: r.get(0)?,
                conversation_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                sources_json: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(items)
}

/// 保存一条消息，返回 message id
#[tauri::command]
pub fn save_message(
    conversation_id: i64,
    role: String,
    content: String,
    sources_json: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    db.execute(
        "INSERT INTO messages (conversation_id, role, content, sources_json) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![conversation_id, role, content, sources_json],
    )
    .map_err(|e| e.to_string())?;
    let id = db.last_insert_rowid();
    // 更新对话的 updated_at 和自动生成标题（首条 user 消息的前 20 字）
    if role == "user" {
        let title_preview: String = content.chars().take(20).collect();
        let _ = db.execute(
            "UPDATE conversations SET updated_at = datetime('now','localtime'), \
             title = CASE WHEN title = '新对话' THEN ?1 ELSE title END \
             WHERE id = ?2",
            rusqlite::params![title_preview, conversation_id],
        );
    } else {
        let _ = db.execute(
            "UPDATE conversations SET updated_at = datetime('now','localtime') WHERE id = ?1",
            rusqlite::params![conversation_id],
        );
    }
    Ok(id)
}

/// 删除对话（级联删除消息）
#[tauri::command]
pub fn delete_conversation(
    conversation_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    db.execute("DELETE FROM conversations WHERE id = ?1", rusqlite::params![conversation_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 重命名对话
#[tauri::command]
pub fn rename_conversation(
    conversation_id: i64,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "db lock poisoned")?;
    db.execute(
        "UPDATE conversations SET title = ?1 WHERE id = ?2",
        rusqlite::params![title, conversation_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

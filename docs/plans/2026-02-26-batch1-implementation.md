# Batch 1 — Core UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现五项核心 UX 功能：Stop 生成、对话历史持久化、搜索历史、拖拽文件夹、右键菜单

**Architecture:** 后端新增 DB 表（search_history / conversations / messages）和对应 Tauri 命令；LLM 生成链路引入 `Arc<AtomicBool>` 取消机制；前端组件在现有 QAPanel / SearchBar / ResultList / SettingsDrawer 上扩展。

**Tech Stack:** Rust (Tauri 2, rusqlite, llama-cpp-2), React 19, Antd 6, Zustand, @tauri-apps/plugin-drag-drop

---

## Task 1: DB Migrations — 新增三张表

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`

**Step 1: 在 MIGRATIONS 数组末尾追加第二个 migration 字符串**

```rust
pub const MIGRATIONS: &[&str] = &[
    // migration 0 (已有，保持不变)
    r#"
    CREATE TABLE IF NOT EXISTS files ( ... );
    ...
    "#,
    // migration 1 (新增)
    r#"
    CREATE TABLE IF NOT EXISTS search_history (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        query   TEXT NOT NULL,
        mode    TEXT NOT NULL DEFAULT 'fulltext',
        used_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(query, mode)
    );
    CREATE TABLE IF NOT EXISTS conversations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL DEFAULT '新对话',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content         TEXT NOT NULL,
        sources_json    TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    "#,
];
```

**Step 2: 验证 db/mod.rs 的 migration 执行逻辑支持多条目**

打开 `src-tauri/src/db/mod.rs`，确认 migrations 是用索引 version 机制执行的（user_version pragma）。若当前逻辑只跑第一条，需要修改为遍历所有条目。

查看当前实现：

```bash
cat src-tauri/src/db/mod.rs
```

若逻辑是：
```rust
for (i, sql) in MIGRATIONS.iter().enumerate() {
    if current_version <= i as u32 { conn.execute_batch(sql)?; }
}
conn.execute_batch("PRAGMA user_version = N")?;
```
则直接把 N 改为 `MIGRATIONS.len()`。

**Step 3: 确认编译通过**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```
Expected: `Finished` 无 error

---

## Task 2: AppState — 新增 llm_cancel 字段

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 修改 state.rs，添加 llm_cancel 字段**

```rust
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub fts: Mutex<crate::indexer::tantivy_index::FtsIndex>,
    pub vector_index: Mutex<Option<crate::vector_index::VectorIndex>>,
    pub embedder: Mutex<Option<crate::embedder::Embedder>>,
    pub llm: Mutex<Option<crate::llm::Llm>>,
    pub model_dir: std::path::PathBuf,
    pub vi_stamp_path: std::path::PathBuf,
    /// LLM 生成取消标志：true = 请求中止当前生成
    pub llm_cancel: Arc<AtomicBool>,
}
```

**Step 2: 修改 lib.rs，初始化 llm_cancel**

在 `app.manage(AppState { ... })` 处添加：

```rust
app.manage(AppState {
    db: Mutex::new(conn),
    fts: Mutex::new(fts),
    vector_index: Mutex::new(vector_index),
    embedder: Mutex::new(embedder),
    llm: Mutex::new(None),
    model_dir,
    vi_stamp_path,
    llm_cancel: Arc::new(AtomicBool::new(false)),
});
```

**Step 3: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```
Expected: 无 error（可能有 unused import warning，忽略即可）

---

## Task 3: llm/mod.rs — generate_stream 支持取消

**Files:**
- Modify: `src-tauri/src/llm/mod.rs`

**Step 1: 修改 generate_stream 签名，接受 cancel 参数**

将函数签名从：
```rust
pub fn generate_stream<F>(&self, prompt: &str, max_new_tokens: usize, mut on_token: F) -> Result<()>
where F: FnMut(&str),
```
改为：
```rust
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};

pub fn generate_stream<F>(
    &self,
    prompt: &str,
    max_new_tokens: usize,
    cancel: Arc<AtomicBool>,
    mut on_token: F,
) -> Result<()>
where F: FnMut(&str),
```

**Step 2: 在生成循环内检测取消标志**

在 `loop { ... }` 顶部添加取消检测：

```rust
loop {
    // 检测取消请求
    if cancel.load(Ordering::Relaxed) {
        break;
    }
    if token == eos || n_cur >= n_prompt + max_new_tokens {
        break;
    }
    // ... 其余代码不变
}
```

**Step 3: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```
Expected: 可能报 `generate_stream` 调用处参数数量不匹配，下一 Task 修复。

---

## Task 4: commands/llm.rs — 更新调用 + 新增 stop_generation

**Files:**
- Modify: `src-tauri/src/commands/llm.rs`

**Step 1: 更新 ask_question_stream 中的 generate_stream 调用**

在 `ask_question_stream` 函数开头（检索之前）重置取消标志：

```rust
// 重置取消标志（确保新请求不会被上次残留的 true 阻断）
state.llm_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
```

在后台线程中传入 cancel：

```rust
std::thread::spawn(move || {
    let state = app.state::<AppState>();
    let cancel = Arc::clone(&state.llm_cancel);   // ← 新增
    let guard = match state.llm.lock() { ... };
    match guard.as_ref() {
        Some(llm) => {
            let result = llm.generate_stream(&prompt, 2048, cancel, |piece| {  // ← 加入 cancel
                let _ = app.emit("ask-token", piece);
            });
            ...
        }
    }
});
```

**Step 2: 新增 stop_generation 命令**

在文件末尾追加：

```rust
/// 中止当前 LLM 流式生成
#[tauri::command]
pub fn stop_generation(state: State<'_, AppState>) {
    state.llm_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
}
```

**Step 3: 在 lib.rs 注册新命令**

在 `tauri::generate_handler![...]` 中添加：
```rust
commands::llm::stop_generation,
```

**Step 4: 编译通过**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -20
```
Expected: 无 error

---

## Task 5: 前端 — QAPanel 添加 Stop 按钮

**Files:**
- Modify: `src/components/QAPanel.tsx`

**Step 1: 导入 StopOutlined 图标**

在 imports 中添加：
```typescript
import { StopOutlined, ... } from "@ant-design/icons";
```

**Step 2: 将发送按钮区域改为条件渲染**

找到发送按钮的 JSX（通常是 `<Button ... onClick={handleAsk}>`），改为：

```tsx
{asking ? (
  <Button
    danger
    icon={<StopOutlined />}
    onClick={() => invoke("stop_generation")}
    style={{ borderRadius: 8, height: 34 }}
  >
    停止
  </Button>
) : (
  <Button
    type="primary"
    icon={<SendOutlined />}
    onClick={handleAsk}
    disabled={!input.trim() || !loadedModel}
    style={{ borderRadius: 8, height: 34 }}
  >
    发送
  </Button>
)}
```

**Step 3: 验证开发服务器无报错**

```bash
npm run dev 2>&1 | grep -i error | head -10
```

---

## Task 6: 后端 — 搜索历史命令

**Files:**
- Create: `src-tauri/src/commands/history.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 创建 history.rs**

```rust
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
    // 超出 50 条时，删除最旧的
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM search_history", [], |r| r.get(0))
        .unwrap_or(0);
    if count >= 50 {
        let _ = db.execute(
            "DELETE FROM search_history WHERE id IN \
             (SELECT id FROM search_history ORDER BY used_at ASC LIMIT ?1)",
            rusqlite::params![count - 49],
        );
    }
    db.execute(
        "INSERT INTO search_history (query, mode, used_at) VALUES (?1, ?2, datetime('now','localtime')) \
         ON CONFLICT(query, mode) DO UPDATE SET used_at = excluded.used_at",
        rusqlite::params![query.trim(), mode],
    )
    .map_err(|e| e.to_string())?;
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
```

**Step 2: 在 commands/mod.rs 中声明模块**

```rust
pub mod history;
```

**Step 3: 在 lib.rs 的 generate_handler! 中注册**

```rust
commands::history::get_search_history,
commands::history::add_search_history,
commands::history::delete_search_history_item,
commands::history::clear_search_history,
```

**Step 4: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

---

## Task 7: 前端 — SearchBar 搜索历史 Dropdown

**Files:**
- Modify: `src/components/SearchBar.tsx`
- Modify: `src/stores/searchStore.ts`

**Step 1: 在 searchStore.ts 中添加历史相关 action**

在 SearchStore interface 中添加：
```typescript
searchHistory: SearchHistoryItem[];
loadSearchHistory: () => Promise<void>;
addToHistory: (query: string, mode: string) => Promise<void>;
deleteHistoryItem: (id: number) => Promise<void>;
```

其中 `SearchHistoryItem`:
```typescript
interface SearchHistoryItem {
  id: number;
  query: string;
  mode: string;
  used_at: string;
}
```

在 `doSearch` 成功后调用 `addToHistory`：
```typescript
doSearch: async () => {
  const { query, mode } = get();
  if (!query.trim()) return set({ results: [] });
  set({ loading: true });
  try {
    const results = await invoke<SearchResult[]>("search_files", { query, mode });
    set({ results, error: null });
    // 记录历史
    await invoke("add_search_history", { query: query.trim(), mode });
    get().loadSearchHistory();
  } catch (e) { ... }
},
```

**Step 2: 修改 SearchBar.tsx，添加历史 Dropdown**

整体结构改为 `AutoComplete` 或带 Dropdown 的 Input：

```tsx
import { Input, Segmented, Tooltip, message, Dropdown } from "antd";
import { ClockCircleOutlined, DeleteOutlined } from "@ant-design/icons";
import { useSearchStore } from "../stores/searchStore";
import { useState } from "react";

export default function SearchBar({ modelAvailable }: { modelAvailable: boolean }) {
  const { query, mode, setQuery, setMode, doSearch, searchHistory, loadSearchHistory,
          deleteHistoryItem } = useSearchStore();
  const [historyOpen, setHistoryOpen] = useState(false);

  const historyItems = searchHistory
    .filter(h => h.mode === mode)  // 只显示当前模式的历史
    .map(h => ({
      key: String(h.id),
      label: (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minWidth: 200 }}>
          <span style={{ fontSize: 13 }}>{h.query}</span>
          <DeleteOutlined
            style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}
            onClick={(e) => {
              e.stopPropagation();
              deleteHistoryItem(h.id);
            }}
          />
        </div>
      ),
      onClick: () => {
        setQuery(h.query);
        setHistoryOpen(false);
        setTimeout(() => doSearch(), 0);
      },
    }));

  return (
    <div style={{ display: "flex", gap: 8, flex: 1, alignItems: "center" }}>
      <Dropdown
        open={historyOpen && historyItems.length > 0}
        menu={{ items: historyItems }}
        trigger={[]}
        style={{ flex: 1 }}
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { loadSearchHistory(); setHistoryOpen(true); }}
          onBlur={() => setTimeout(() => setHistoryOpen(false), 150)}
          onPressEnter={async () => { setHistoryOpen(false); await doSearch(); }}
          placeholder={placeholder}
          allowClear
          prefix={<SearchOutlined style={{ color: "#94a3b8", fontSize: 14 }} />}
          suffix={searchHistory.length > 0 && !query
            ? <ClockCircleOutlined style={{ fontSize: 12, color: "#94a3b8" }} />
            : null}
          style={{ flex: 1, borderRadius: 8, background: "var(--color-bg)",
                   borderColor: "var(--color-border)", fontSize: 13, height: 34 }}
        />
      </Dropdown>
      {/* Segmented 部分保持不变 */}
    </div>
  );
}
```

**Step 3: 应用启动时加载历史**

在 `App.tsx` 的 `useEffect` 中调用 `loadSearchHistory()`（或在 SearchBar mount 时加载）。

---

## Task 8: 后端 — 对话历史命令

**Files:**
- Create: `src-tauri/src/commands/conversation.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 创建 conversation.rs**

```rust
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
```

**Step 2: 注册模块和命令（同 Task 6 Step 2-3 方式）**

在 `commands/mod.rs` 添加 `pub mod conversation;`

在 `lib.rs` 的 `generate_handler!` 中添加：
```rust
commands::conversation::create_conversation,
commands::conversation::list_conversations,
commands::conversation::get_conversation_messages,
commands::conversation::save_message,
commands::conversation::delete_conversation,
commands::conversation::rename_conversation,
```

**Step 3: 编译通过**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -20
```

---

## Task 9: 前端 — QAPanel 对话历史侧边栏

**Files:**
- Modify: `src/components/QAPanel.tsx`

**Step 1: 添加对话相关 state**

```tsx
const [conversations, setConversations] = useState<ConversationInfo[]>([]);
const [currentConvId, setCurrentConvId] = useState<number | null>(null);
const [sidebarOpen, setSidebarOpen] = useState(false);
```

**Step 2: 添加类型定义**

```tsx
interface ConversationInfo {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}
```

**Step 3: 加载对话列表 + 自动创建/恢复**

```tsx
// QAPanel mount 时
useEffect(() => {
  loadConversations();
}, []);

const loadConversations = async () => {
  const list = await invoke<ConversationInfo[]>("list_conversations");
  setConversations(list);
  if (list.length > 0 && currentConvId === null) {
    // 恢复最近一条对话
    await selectConversation(list[0].id);
  } else if (list.length === 0) {
    // 自动创建第一条对话
    await createNewConversation();
  }
};

const createNewConversation = async () => {
  const id = await invoke<number>("create_conversation");
  setCurrentConvId(id);
  setMessages([]);
  await loadConversations();
};

const selectConversation = async (id: number) => {
  setCurrentConvId(id);
  const msgs = await invoke<MessageInfo[]>("get_conversation_messages", { conversation_id: id });
  // 将 MessageInfo 转为 Message 格式（sources_json 解析）
  setMessages(msgs.map(m => ({
    role: m.role as "user" | "assistant",
    content: m.content,
    sources: m.sources_json ? JSON.parse(m.sources_json) : undefined,
  })));
};
```

**Step 4: 发送消息时保存到 DB**

在 `handleAsk` 中，用户提问后立即保存 user 消息；`ask-done` 事件中保存 assistant 消息：

```tsx
// 发送后保存用户消息
if (currentConvId) {
  await invoke("save_message", {
    conversation_id: currentConvId,
    role: "user",
    content: userMessage,
    sources_json: null,
  });
}

// ask-done 事件回调中保存 assistant 回复
if (currentConvId && assistantContent) {
  await invoke("save_message", {
    conversation_id: currentConvId,
    role: "assistant",
    content: assistantContent,
    sources_json: JSON.stringify(currentSources),
  });
  loadConversations(); // 刷新标题
}
```

**Step 5: 添加侧边栏 JSX**

在 QAPanel 最外层 div 内，左侧加入可折叠侧边栏：

```tsx
<div style={{ display: "flex", height: "100%" }}>
  {/* 对话历史侧边栏 */}
  {sidebarOpen && (
    <div style={{
      width: 200, borderRight: "1px solid var(--color-border)",
      display: "flex", flexDirection: "column", padding: "8px 0",
    }}>
      <Button
        type="primary" size="small" style={{ margin: "0 8px 8px" }}
        onClick={createNewConversation}
        icon={<PlusOutlined />}
      >新对话</Button>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {conversations.map(conv => (
          <div
            key={conv.id}
            onClick={() => selectConversation(conv.id)}
            style={{
              padding: "6px 12px", cursor: "pointer", fontSize: 12,
              background: currentConvId === conv.id ? "var(--color-bg-hover)" : "transparent",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {conv.title}
            </span>
            <DeleteOutlined
              style={{ fontSize: 10, color: "#94a3b8", flexShrink: 0 }}
              onClick={async (e) => {
                e.stopPropagation();
                await invoke("delete_conversation", { conversation_id: conv.id });
                if (currentConvId === conv.id) createNewConversation();
                else loadConversations();
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )}

  {/* 主对话区域（保持原有 JSX 结构） */}
  <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
    {/* 顶部工具栏加入 HistoryOutlined 按钮切换侧边栏 */}
    ...
  </div>
</div>
```

**Step 6: 顶部工具栏加入历史按钮**

找到现有 `handleClear` 按钮旁，添加：
```tsx
<Button
  size="small"
  icon={<HistoryOutlined />}
  onClick={() => setSidebarOpen(v => !v)}
  title="对话历史"
/>
```

---

## Task 10: 前端 — SettingsDrawer 拖拽文件夹

**Files:**
- Modify: `src/components/SettingsDrawer.tsx`
- Modify: `package.json` + `src-tauri/Cargo.toml` + `src-tauri/tauri.conf.json`

**Step 1: 安装 drag-drop 插件**

```bash
npm install @tauri-apps/plugin-drag-drop
```

在 `src-tauri/Cargo.toml` 添加：
```toml
tauri-plugin-drag-drop = "2"
```

在 `src-tauri/src/lib.rs` 的 `.setup()` 前添加：
```rust
.plugin(tauri_plugin_drag_drop::init())
```

**Step 2: 在 SettingsDrawer 中找到文件夹列表区域，添加拖拽处理**

```tsx
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";

// 在组件内
const [isDragOver, setIsDragOver] = useState(false);
const dropZoneRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  let unlisten: (() => void) | undefined;
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "over") {
      setIsDragOver(true);
    } else if (event.payload.type === "drop") {
      setIsDragOver(false);
      const paths = event.payload.paths ?? [];
      paths.forEach(async (p) => {
        // 尝试添加（start_index 会验证是否为文件夹）
        try {
          await invoke("start_index", { folder: p });
          message.success(`已添加文件夹: ${p}`);
          loadFolders();
        } catch (e) {
          message.error(`添加失败: ${e}`);
        }
      });
    } else {
      setIsDragOver(false);
    }
  }).then(fn => { unlisten = fn; });
  return () => { unlisten?.(); };
}, []);
```

**Step 3: 给文件夹列表容器加上视觉反馈样式**

```tsx
<div
  ref={dropZoneRef}
  style={{
    border: isDragOver
      ? "2px dashed #1677ff"
      : "2px dashed transparent",
    borderRadius: 8,
    padding: 4,
    transition: "border-color 0.2s",
    minHeight: 60,
    position: "relative",
  }}
>
  {isDragOver && (
    <div style={{
      position: "absolute", inset: 0, display: "flex",
      alignItems: "center", justifyContent: "center",
      background: "rgba(22,119,255,0.05)", borderRadius: 8,
      fontSize: 12, color: "#1677ff", pointerEvents: "none",
    }}>
      松开以添加文件夹
    </div>
  )}
  {/* 原有文件夹列表 */}
</div>
```

**Step 4: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -10
```

---

## Task 11: 前端 — ResultList 右键菜单

**Files:**
- Modify: `src/components/ResultList.tsx`

**Step 1: 添加右键菜单 state**

```tsx
import { List, Typography, Dropdown } from "antd";
import { CopyOutlined, FolderOpenOutlined, FileOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

// 在组件内添加
const [contextMenu, setContextMenu] = useState<{
  x: number; y: number; item: SearchResult
} | null>(null);
```

**Step 2: 定义菜单项**

```tsx
const getContextMenuItems = (item: SearchResult) => [
  {
    key: "reveal",
    icon: <FolderOpenOutlined />,
    label: "在 Finder 中显示",
    onClick: () => invoke("reveal_in_finder", { path: item.path }),
  },
  {
    key: "copy-path",
    icon: <CopyOutlined />,
    label: "复制完整路径",
    onClick: () => navigator.clipboard.writeText(item.path),
  },
  {
    key: "copy-name",
    icon: <FileOutlined />,
    label: "复制文件名",
    onClick: () => navigator.clipboard.writeText(item.name),
  },
  { type: "divider" as const },
  {
    key: "open",
    label: "用默认应用打开",
    onClick: () => invoke("open_file", { path: item.path }),
  },
];
```

**Step 3: 在 List.Item 上绑定 onContextMenu**

找到 `<List.Item ...>` 处，添加：

```tsx
<List.Item
  key={item.file_id}
  onContextMenu={(e) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  }}
  onClick={() => setSelected(item)}
  // 其余 props 不变
>
```

**Step 4: 在组件返回 JSX 末尾添加 Dropdown 渲染**

```tsx
{/* 全局右键菜单（absolute 定位） */}
{contextMenu && (
  <Dropdown
    open={true}
    onOpenChange={(open) => { if (!open) setContextMenu(null); }}
    menu={{ items: getContextMenuItems(contextMenu.item) }}
    trigger={[]}
  >
    <div style={{
      position: "fixed",
      left: contextMenu.x,
      top: contextMenu.y,
      width: 1, height: 1,
      zIndex: 9999,
    }} />
  </Dropdown>
)}
```

**Step 5: 点击其他地方关闭菜单**

```tsx
useEffect(() => {
  const close = () => setContextMenu(null);
  window.addEventListener("click", close);
  return () => window.removeEventListener("click", close);
}, []);
```

---

## Task 12: 最终验证

**Step 1: 完整编译**

```bash
cd /Users/caizhongrui/Documents/workspace/production/DocMind
cargo tauri build --debug 2>&1 | tail -20
```

Expected: `Finished` 无 error

**Step 2: 启动开发服务器验证**

```bash
cargo tauri dev
```

逐项验证：
- [ ] 搜索后下次聚焦搜索框能看到历史记录
- [ ] 删除历史条目正常
- [ ] QAPanel 侧边栏显示对话历史
- [ ] 创建新对话 / 切换对话 / 删除对话正常
- [ ] 对话内容关闭重开后能恢复
- [ ] LLM 生成中点击 Stop，生成停止
- [ ] 拖拽文件夹到设置面板能添加
- [ ] 右键结果条目显示菜单，各操作正常

**Step 3: 记录测试结果，如有 bug 修复后重新验证**

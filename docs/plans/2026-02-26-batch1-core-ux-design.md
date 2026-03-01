# Batch 1 — Core UX 设计文档

**日期**: 2026-02-26
**状态**: 已批准

---

## 目标

提升 DocMind 核心交互体验，补全以下五项功能：

1. Stop 生成按钮（LLM 流式生成可中断）
2. 对话历史持久化
3. 搜索历史
4. 拖拽添加文件夹
5. 右键菜单

---

## 1. Stop 生成按钮

### 架构

- `AppState` 新增字段 `llm_cancel: Arc<AtomicBool>`
- `Llm::generate_stream` 接受 `cancel: Arc<AtomicBool>` 参数，每个 token 循环检测
- 新增 Tauri 命令 `stop_generation`：将 cancel 标志置 true
- 每次调用 `ask_question_stream` 前自动重置为 false

### 前端

- QAPanel 生成中显示 Stop 按钮（替换 loading 指示器）
- 点击后 invoke `stop_generation`，等待 `ask-done` 或 `ask-error` 事件

### 数据流

```
用户点击 Stop
  → invoke("stop_generation")
  → AppState.llm_cancel.store(true)
  → generate_stream 检测到 cancel=true，退出循环
  → emit("ask-done")
  → 前端隐藏 Stop 按钮
```

---

## 2. 对话历史持久化

### 数据库表

```sql
CREATE TABLE IF NOT EXISTS conversations (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    title    TEXT NOT NULL DEFAULT '新对话',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content         TEXT NOT NULL,
    sources_json    TEXT,   -- JSON array of source file paths
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

### Tauri 命令

| 命令 | 参数 | 返回 |
|------|------|------|
| `create_conversation` | `title?` | conversation_id |
| `list_conversations` | — | Vec<Conversation> |
| `get_conversation_messages` | `conversation_id` | Vec<Message> |
| `delete_conversation` | `conversation_id` | — |
| `rename_conversation` | `conversation_id, title` | — |
| `save_message` | `conversation_id, role, content, sources?` | message_id |

### 前端

- QAPanel 左侧新增会话列表侧边栏（可折叠）
- 顶部「新建对话」按钮
- 选中会话自动加载历史消息
- 发送消息自动保存，助手回复完成后保存
- 会话标题默认取第一条用户消息的前 20 字

---

## 3. 搜索历史

### 数据库表

```sql
CREATE TABLE IF NOT EXISTS search_history (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    query   TEXT NOT NULL,
    mode    TEXT NOT NULL DEFAULT 'fulltext',
    used_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(query, mode)
);
```

最多保留 50 条，按 `used_at` DESC 排序，超出时删除最旧记录。

### Tauri 命令

| 命令 | 参数 | 返回 |
|------|------|------|
| `get_search_history` | `limit?` | Vec<SearchHistoryItem> |
| `delete_search_history_item` | `id` | — |
| `clear_search_history` | — | — |

### 前端

- SearchBar 聚焦时下方显示 Dropdown（Antd）
- 条目包含：搜索模式图标、查询文本、删除按钮
- 点击条目填入搜索框并立即搜索
- 每次成功搜索后自动写入历史（upsert）

---

## 4. 拖拽添加文件夹

### 依赖

```json
"@tauri-apps/plugin-drag-drop": "^2"
```

```toml
tauri-plugin-drag-drop = "2"
```

### 实现

- SettingsDrawer 的文件夹列表区域注册 `onDragOver` + `onDrop`
- 使用 `getCurrentWebview().onDragDropEvent` 监听 Tauri drag-drop 事件
- 过滤出路径为文件夹的项（前端用 `invoke("is_directory", {path})` 或后端在 `start_index` 内验证）
- 拖入后直接调用 `start_index`，添加到监听列表

### 视觉反馈

- 拖拽悬停时文件夹区域显示蓝色虚线边框 + 「松开以添加文件夹」提示
- 非文件夹文件拖入时显示「仅支持文件夹」错误提示

---

## 5. 右键菜单

### 前端实现

ResultList 每条结果绑定 `onContextMenu`：

```typescript
onContextMenu={(e) => {
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, item);
}}
```

使用 Antd Dropdown 的 `open` 受控模式，定位到鼠标坐标。

### 菜单项

| 菜单项 | 操作 |
|--------|------|
| 在 Finder 中显示 | `invoke("reveal_in_finder", {path})` |
| 复制完整路径 | `navigator.clipboard.writeText(path)` |
| 复制文件名 | `navigator.clipboard.writeText(basename)` |
| 用默认应用打开 | `invoke("open_file", {path})` |

---

## 数据库迁移

所有新表通过现有 `db/migrations.rs` 的版本机制添加（version bump）：

- `search_history`：migration version 2
- `conversations` + `messages`：migration version 2（同批次）

---

## 实现顺序

1. DB migrations（新表）
2. Stop 生成（后端 + 前端）
3. 搜索历史（后端命令 + SearchBar）
4. 对话历史（后端命令 + QAPanel 重构）
5. 拖拽文件夹（前端）
6. 右键菜单（前端）

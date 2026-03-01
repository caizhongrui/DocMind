# Batch 5 — 全面改进实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 完成虚拟滚动、搜索高亮、ZIP 支持、批量操作、定时重索引、多文档摘要、i18n 集成、系统托盘完善、快捷键冲突检测、代码去重等全面改进。

**Architecture:** 前后端分离改进，Rust 后端新增 ZIP 解析、定时任务、多文档摘要命令；React 前端新增虚拟滚动、搜索高亮、批量操作、i18n；公共 types.ts 统一类型定义。

**Tech Stack:** react-window（虚拟滚动）、i18next/react-i18next（已安装）、zip crate（已在 Cargo.toml）、llama-cpp-2（多文档摘要复用现有 LLM）

---

## 前置说明（已确认无需修改）

- **WAL 模式**：已在 `db/mod.rs:9` 启用，跳过
- **递归文件监听**：已用 `RecursiveMode::Recursive`，跳过
- **文件解析错误处理**：已有 `ParseStatus::Failed`，单文件失败不 crash，跳过

---

## Task 1: 虚拟滚动（ResultList）

**Files:**
- Modify: `src/components/ResultList.tsx`
- Install: `react-window`, `@types/react-window`

**Step 1: 安装依赖**

```bash
cd /Users/caizhongrui/Documents/workspace/production/DocMind
npm install react-window
npm install -D @types/react-window
```

**Step 2: 修改 ResultList.tsx**

将 antd `<List>` 替换为 react-window `FixedSizeList`。由于每个 item 高度不固定（有 snippet 时更高），使用 `VariableSizeList` 并预估高度：

移除：
```typescript
import { List, Typography, Dropdown, Select } from "antd";
```

添加：
```typescript
import { Typography, Dropdown, Select, Tooltip, Button, message } from "antd";
import { FixedSizeList } from "react-window";
```

在组件内添加 `ITEM_HEIGHT = 76`（无 snippet 时约 76px，有 snippet 约 110px，用平均值 88px）：
```typescript
const ITEM_HEIGHT = 88;
```

找到：
```tsx
    <List
      loading={loading}
      dataSource={filtered}
      locale={{ emptyText }}
      renderItem={(item, index) => {
        ...
      }}
    />
```

改为（保持 List 仅用于 loading/empty 状态展示）：
```tsx
    {loading && (
      <div style={{ textAlign: "center", padding: 40 }}>
        <span style={{ color: "#94a3b8" }}>搜索中…</span>
      </div>
    )}
    {!loading && filtered.length === 0 && emptyText}
    {!loading && filtered.length > 0 && (
      <FixedSizeList
        height={window.innerHeight - 160}
        itemCount={filtered.length}
        itemSize={ITEM_HEIGHT}
        width="100%"
        overscanCount={5}
      >
        {({ index, style }) => {
          const item = filtered[index];
          const isSelected = selected?.file_id === item.file_id;
          return (
            <div
              key={item.file_id}
              style={{
                ...style,
                cursor: "pointer",
                padding: "10px 14px",
                borderLeft: isSelected ? "3px solid var(--color-primary)" : focusedIndex === index ? "3px solid #93c5fd" : "3px solid transparent",
                background: isSelected ? "var(--color-selected)" : focusedIndex === index ? "var(--color-bg-hover, rgba(0,0,0,0.03))" : undefined,
                boxSizing: "border-box",
                display: "flex",
                alignItems: "flex-start",
              }}
              data-result-index={index}
              onClick={() => { setSelected(item); setFocusedIndex(index); }}
              onDoubleClick={() => invoke("open_file", { path: item.path })}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, item });
              }}
            >
              {/* checkbox（批量模式下显示） */}
              {batchMode && (
                <input
                  type="checkbox"
                  checked={selectedItems.has(item.file_id)}
                  onChange={() => toggleItemSelect(item.file_id)}
                  style={{ marginRight: 8, marginTop: 6, flexShrink: 0 }}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <div style={{ display: "flex", gap: 10, width: "100%", minWidth: 0 }}>
                <FileTypeIcon type={item.file_type} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text)", wordBreak: "break-all", lineHeight: 1.4 }}>
                      <HighlightText text={item.name} query={query} />
                    </span>
                    {isSemantic && (
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 10, background: "#ede9fe", color: "#7c3aed", fontWeight: 500 }}>
                        语义
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: item.snippet ? 6 : 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.path}
                  </div>
                  {item.snippet && (
                    <div style={{
                      fontSize: 12, lineHeight: 1.55, color: "#4b5563",
                      borderLeft: `2px solid ${isSemantic ? "#a78bfa" : "#fbbf24"}`,
                      background: isSemantic ? "var(--color-bg-purple)" : "var(--color-bg-amber)",
                      borderRadius: "0 4px 4px 0",
                      padding: "4px 8px",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}>
                      {isSemantic ? item.snippet : <HighlightText text={item.snippet} query={query} />}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        }}
      </FixedSizeList>
    )}
```

注意：批量操作（batchMode, selectedItems, toggleItemSelect）在 Task 3 中添加，此处先留 placeholder（`const batchMode = false; const selectedItems = new Set(); const toggleItemSelect = (_: number) => {};`）。

**Step 3: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

---

## Task 2: 搜索结果高亮（PreviewPanel）

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

**Step 1: 读取 PreviewPanel.tsx 当前内容**

PreviewPanel 展示文件内容文字预览。需要将 query 中的关键词在预览文本中高亮。

**Step 2: 从 searchStore 读取 query，高亮预览文本**

在 PreviewPanel.tsx 顶部添加：
```typescript
import { useSearchStore } from "../stores/searchStore";
```

在组件内部（preview text 展示处）：
```typescript
const { query } = useSearchStore();
```

找到展示 `preview` 文本的 `<pre>` 或 `<div>` 元素，用 `HighlightText` 组件替换。

如果是 `<pre style={{...}}>{preview}</pre>` 形式，改为：
```tsx
<pre style={{ ... }}>
  <HighlightText text={preview} query={query} />
</pre>
```

注意：`src/utils/highlight.tsx`（`HighlightText` 组件）已存在，直接 import 使用。

**Step 3: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

---

## Task 3: 批量操作（ResultList）

**Files:**
- Modify: `src/components/ResultList.tsx`

**Step 1: 添加批量模式状态**

在已有 `const [focusedIndex, setFocusedIndex] = useState(-1);` 之后添加：
```typescript
const [batchMode, setBatchMode] = useState(false);
const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());

const toggleItemSelect = (fileId: number) => {
  setSelectedItems(prev => {
    const next = new Set(prev);
    if (next.has(fileId)) next.delete(fileId);
    else next.add(fileId);
    return next;
  });
};

const selectAll = () => setSelectedItems(new Set(filtered.map(r => r.file_id)));
const clearSelection = () => setSelectedItems(new Set());
```

**Step 2: 批量操作工具栏**

在排序控制栏（`results.length > 0` 条件块）同层，添加批量工具栏：

```tsx
{batchMode && selectedItems.size > 0 && (
  <div style={{
    padding: "6px 12px",
    display: "flex", alignItems: "center", gap: 8,
    background: "#eff6ff",
    borderBottom: "1px solid #bfdbfe",
    fontSize: 12,
  }}>
    <span style={{ color: "#1677ff" }}>已选 {selectedItems.size} 个文件</span>
    <Button size="small" onClick={selectAll}>全选</Button>
    <Button size="small" onClick={clearSelection}>取消</Button>
    <Button
      size="small"
      icon={<ExportOutlined />}
      onClick={async () => {
        const paths = filtered.filter(r => selectedItems.has(r.file_id)).map(r => r.path);
        const content = "\uFEFF文件名,路径\n" + paths.map(p => {
          const name = p.split("/").pop() ?? p;
          return `"${name}","${p}"`;
        }).join("\n");
        const savePath = await saveDialog({ defaultPath: "selected-files.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
        if (savePath) {
          await invoke("write_text_file", { path: savePath, content });
          message.success(`已导出 ${paths.length} 个文件`);
        }
      }}
    >
      导出选中
    </Button>
    <Button
      size="small"
      onClick={async () => {
        for (const item of filtered.filter(r => selectedItems.has(r.file_id))) {
          await invoke("open_file", { path: item.path });
        }
      }}
    >
      批量打开
    </Button>
  </div>
)}
```

**Step 3: 在排序栏添加批量模式切换按钮**

在已有排序控制栏的 Export CSV 按钮旁添加：
```tsx
<Tooltip title={batchMode ? "退出批量模式" : "批量操作"}>
  <Button
    size="small"
    type={batchMode ? "primary" : "text"}
    icon={<CheckSquareOutlined />}
    onClick={() => { setBatchMode(v => !v); clearSelection(); }}
    style={{ color: batchMode ? undefined : "#94a3b8" }}
  />
</Tooltip>
```

需要添加 `CheckSquareOutlined` 到 icon imports。

**Step 4: 移除 Task 1 中的 placeholder**

将 Task 1 中留的 placeholder 替换为真实状态。

**Step 5: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

---

## Task 4: ZIP 文件支持（后端 parser）

**Files:**
- Modify: `src-tauri/src/indexer/parser/mod.rs`（添加 zip 扩展名分发）
- Create: `src-tauri/src/indexer/parser/archive.rs`（ZIP 解析）
- Modify: `src-tauri/src/indexer/mod.rs`（添加 zip 到 SUPPORTED_EXTS）

**Step 1: 添加 zip 扩展名到 SUPPORTED_EXTS**

在 `indexer/mod.rs` 中找到：
```rust
const SUPPORTED_EXTS: &[&str] = &["txt", "md", "csv", "pdf", "doc", "docx", "xlsx", "pptx"];
```

改为：
```rust
const SUPPORTED_EXTS: &[&str] = &["txt", "md", "csv", "pdf", "doc", "docx", "xlsx", "pptx", "zip"];
```

**Step 2: 创建 archive.rs**

创建 `src-tauri/src/indexer/parser/archive.rs`：

```rust
use std::io::Read;
use std::path::Path;
use super::ParseResult;

/// 提取 ZIP 文件中所有文本文件的内容（.txt, .md, .csv）
pub fn parse_zip(path: &Path) -> ParseResult {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[parser/zip] Failed to open {}: {e}", path.display());
            return ParseResult::failed();
        }
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[parser/zip] Failed to read ZIP {}: {e}", path.display());
            return ParseResult::failed();
        }
    };

    let mut all_text = String::new();
    let mut had_content = false;

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_lowercase();
        // 只处理文本类文件，跳过目录和二进制
        let is_text = name.ends_with(".txt") || name.ends_with(".md") || name.ends_with(".csv");
        if !is_text || entry.is_dir() {
            continue;
        }
        let mut buf = String::new();
        if entry.read_to_string(&mut buf).is_ok() && !buf.is_empty() {
            if !all_text.is_empty() {
                all_text.push_str("\n\n--- ");
                all_text.push_str(entry.name());
                all_text.push_str(" ---\n");
            }
            all_text.push_str(&buf);
            had_content = true;
        }
    }

    if had_content {
        ParseResult { content: all_text, status: super::ParseStatus::Ok }
    } else {
        ParseResult::failed()
    }
}
```

**Step 3: 在 parser/mod.rs 注册 archive 模块**

在 `parser/mod.rs` 顶部添加：
```rust
pub mod archive;
```

在 `parse_file` 函数的 match 中添加 zip 分支：
```rust
"zip" => archive::parse_zip(path),
```

**Step 4: 验证**
```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

---

## Task 5: 定时重索引（后端 + 前端）

**Files:**
- Modify: `src-tauri/src/lib.rs`（启动定时任务）
- Modify: `src-tauri/src/commands/settings.rs`（添加 get/set_reindex_interval 命令）
- Modify: `src-tauri/src/lib.rs`（注册命令）
- Modify: `src/components/SettingsDrawer.tsx`（间隔配置 UI）

**Step 1: 添加 get/set_reindex_interval 命令**

在 `commands/settings.rs` 末尾添加：
```rust
/// 获取定时重索引间隔（分钟，0 = 禁用）
#[tauri::command]
pub fn get_reindex_interval(state: State<'_, AppState>) -> u64 {
    let db = state.db.lock().ok();
    db.and_then(|db| {
        db.query_row::<String, _, _>(
            "SELECT value FROM settings WHERE key = 'reindex_interval_min'",
            [],
            |r| r.get(0),
        ).ok()
    })
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
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

**Step 2: 在 lib.rs 的 setup 中启动定时任务**

在 `app.manage(watcher_state);` 之后添加：

```rust
// 定时重索引任务
{
    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        loop {
            // 每 60 秒检查一次是否需要重索引
            std::thread::sleep(std::time::Duration::from_secs(60));
            let state = app_handle.state::<AppState>();
            let interval_min: u64 = state.db.lock().ok()
                .and_then(|db| {
                    db.query_row::<String, _, _>(
                        "SELECT value FROM settings WHERE key = 'reindex_interval_min'",
                        [], |r| r.get(0),
                    ).ok()
                })
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            if interval_min == 0 { continue; }

            let last_reindex: i64 = state.db.lock().ok()
                .and_then(|db| {
                    db.query_row::<i64, _, _>(
                        "SELECT COALESCE(MAX(indexed_at), 0) FROM files",
                        [], |r| r.get(0),
                    ).ok()
                })
                .unwrap_or(0);

            let now = chrono::Utc::now().timestamp();
            let elapsed_min = (now - last_reindex) / 60;
            if elapsed_min >= interval_min as i64 {
                // 触发对所有 watched_folders 重新索引
                let folders: Vec<String> = state.db.lock().ok()
                    .map(|db| {
                        let mut stmt = db.prepare("SELECT path FROM watched_folders WHERE enabled = 1")
                            .unwrap_or_else(|_| db.prepare("SELECT ''").unwrap());
                        stmt.query_map([], |r| r.get(0))
                            .map(|rows| rows.flatten().collect::<Vec<String>>())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                for folder in folders {
                    let app_handle2 = app_handle.clone();
                    let folder_clone = folder.clone();
                    std::thread::spawn(move || {
                        let state = app_handle2.state::<AppState>();
                        let _ = crate::indexer::scan_and_index(
                            std::path::Path::new(&folder_clone), &state, &app_handle2
                        );
                    });
                }
                println!("[reindex] Triggered scheduled reindex for {} folders", folders.len());
            }
        }
    });
}
```

**Step 3: 注册命令**

在 `lib.rs` invoke_handler 中添加：
```rust
commands::settings::get_reindex_interval,
commands::settings::set_reindex_interval,
```

**Step 4: 前端 SettingsDrawer 添加定时重索引 UI**

在"数据管理"区段之前（或之后）添加一个新的"定时重索引"区段：

```tsx
{/* ── 定时重索引 ── */}
<div style={{ ... }}>
  <div style={{ /* header */ }}>
    <ReloadOutlined />
    <Typography.Text strong>定时重索引</Typography.Text>
  </div>
  <div style={{ padding: "14px 16px" }}>
    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
      自动定期重新扫描并更新文件索引。0 分钟 = 禁用。
    </Typography.Text>
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <InputNumber
        min={0} max={10080} step={60}
        value={reindexInterval}
        onChange={(v) => v !== null && setReindexInterval(v)}
        style={{ width: 100 }}
        addonAfter="分钟"
      />
      <Button
        size="small"
        type="primary"
        onClick={async () => {
          await invoke("set_reindex_interval", { minutes: reindexInterval });
          message.success(reindexInterval === 0 ? "已禁用定时重索引" : `已设置每 ${reindexInterval} 分钟重索引`);
        }}
      >
        保存
      </Button>
    </div>
  </div>
</div>
```

需要在 SettingsDrawer 中添加 `reindexInterval` 状态，并在 `drawerOpen` useEffect 中调用 `get_reindex_interval` 初始化。

**Step 5: 验证**
```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

---

## Task 6: 多文档摘要（后端 + 前端）

**Files:**
- Modify: `src-tauri/src/commands/llm.rs`（添加 summarize_documents 命令）
- Modify: `src-tauri/src/lib.rs`（注册命令）
- Modify: `src/components/ResultList.tsx`（批量模式下添加"摘要"按钮）

**Step 1: 添加 summarize_documents 命令**

在 `commands/llm.rs` 末尾添加：

```rust
/// 对多个文件路径生成联合摘要（流式输出，事件：ask-token / ask-done / ask-error）
#[tauri::command]
pub fn summarize_documents(
    paths: Vec<String>,
    state: tauri::State<'_, crate::state::AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use crate::indexer::parser::parse_file;

    let mut context_parts: Vec<String> = Vec::new();
    for path in &paths {
        let p = std::path::Path::new(path);
        if !p.exists() { continue; }
        let result = parse_file(p);
        if result.content.is_empty() { continue; }
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        let snippet: String = result.content.chars().take(1500).collect();
        context_parts.push(format!("【文件：{name}】\n{snippet}"));
    }

    if context_parts.is_empty() {
        return Err("无法读取所选文件内容".to_string());
    }

    let context = context_parts.join("\n\n---\n\n");
    let prompt = format!(
        "<|im_start|>system\n你是文档摘要助手，请对以下多个文件的内容进行简洁的综合摘要，指出各文件的主要内容和相互关系。<|im_end|>\n\
         <|im_start|>user\n以下是需要摘要的文件内容：\n\n{context}\n\n请生成综合摘要。 /no_think<|im_end|>\n\
         <|im_start|>assistant\n<think>\n\n</think>\n\n"
    );

    state.llm_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel = std::sync::Arc::clone(&state.llm_cancel);

    std::thread::spawn(move || {
        let state = app.state::<crate::state::AppState>();
        let guard = match state.llm.lock() {
            Ok(g) => g,
            Err(_) => { let _ = app.emit("ask-error", "llm lock poisoned"); return; }
        };
        match guard.as_ref() {
            Some(llm) => {
                let result = llm.generate_stream(&prompt, 2048, cancel, |piece| {
                    let _ = app.emit("ask-token", piece);
                });
                match result {
                    Ok(_) => { let _ = app.emit("ask-done", ()); }
                    Err(e) => { let _ = app.emit("ask-error", e.to_string()); }
                }
            }
            None => { let _ = app.emit("ask-error", "LLM 未加载，请先加载模型"); }
        }
    });

    Ok(())
}
```

**Step 2: 注册命令**

在 `lib.rs` invoke_handler 添加：
```rust
commands::llm::summarize_documents,
```

**Step 3: 前端 ResultList 批量摘要按钮**

在批量操作工具栏（Task 3 添加的）中，添加摘要按钮：

```tsx
<Button
  size="small"
  icon={<RobotOutlined />}
  disabled={selectedItems.size === 0 || selectedItems.size > 10}
  onClick={async () => {
    const paths = filtered.filter(r => selectedItems.has(r.file_id)).map(r => r.path);
    await invoke("summarize_documents", { paths });
    // 触发打开 QA 面板，结果通过 ask-token/ask-done 事件显示
    message.info("摘要生成中，请打开对话面板查看结果");
  }}
>
  生成摘要
</Button>
```

需要导入 `RobotOutlined`（ResultList 中可能已有，检查现有 imports）。

**Step 4: 验证**
```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

---

## Task 7: 语义搜索帮助提示（SearchBar）

**Files:**
- Modify: `src/components/SearchBar.tsx`

**Step 1: 找到语义搜索 label 的渲染位置**

在 `SearchBar.tsx` 中找到 `semanticLabel`：

```tsx
  const semanticLabel = (
    <Tooltip
      title={
        modelAvailable
          ? "AI 语义搜索，理解自然语言含义"
          : "需先下载 AI 模型（点击顶栏机器人按钮）"
      }
    >
```

**Step 2: 为语义模式添加搜索帮助提示（与全文搜索的 ? 图标类似）**

在 `SearchBar` 组件的 JSX 中，找到全文搜索的 `QuestionCircleOutlined` 条件块：

```tsx
      {mode === "fulltext" && (
        <Tooltip title={...}>
          <QuestionCircleOutlined ... />
        </Tooltip>
      )}
```

在其后添加语义搜索帮助：
```tsx
      {mode === "semantic" && modelAvailable && (
        <Tooltip
          title={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>语义搜索技巧</div>
              <div>用自然语言描述你要找的内容</div>
              <div>例如：<code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>关于项目进度的报告</code></div>
              <div>例如：<code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同违约相关条款</code></div>
              <div style={{ marginTop: 4, color: "#fbbf24" }}>💡 语义搜索理解含义，不需要精确关键词</div>
            </div>
          }
          placement="bottomRight"
        >
          <QuestionCircleOutlined style={{ fontSize: 13, color: "#94a3b8", cursor: "pointer", flexShrink: 0 }} />
        </Tooltip>
      )}
```

**Step 3: 验证**
```bash
npx tsc --noEmit 2>&1 | head -10
```

---

## Task 8: 系统托盘完善（lib.rs）

**Files:**
- Modify: `src-tauri/src/lib.rs`（build_tray 函数）

**Step 1: 找到 build_tray 函数**

在 `lib.rs` 中找到：
```rust
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    };
    let show = MenuItem::with_id(app, "show", "显示 DocMind", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
```

**Step 2: 添加更多菜单项**

改为：
```rust
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    };
    let show = MenuItem::with_id(app, "show", "显示 DocMind", true, None::<&str>)?;
    let search = MenuItem::with_id(app, "search", "快速搜索 (Ctrl+K)", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &search, &sep, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "search" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    // 前端监听该事件聚焦搜索框
                    let _ = w.emit("tray-focus-search", ());
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        // ... on_tray_icon_event 保持不变
```

**Step 3: 前端 App.tsx 监听 tray-focus-search 事件**

在 `App.tsx` 的 useEffect 中（监听 keydown 的那个 effect 之后）添加：
```typescript
useEffect(() => {
  const unlisten = listen("tray-focus-search", () => {
    window.dispatchEvent(new CustomEvent("docmind-focus-search"));
  });
  return () => { unlisten.then(fn => fn()); };
}, []);
```

**Step 4: 验证**
```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

---

## Task 9: 快捷键冲突检测（settings.rs）

**Files:**
- Modify: `src-tauri/src/commands/settings.rs`（set_global_shortcut 函数）

**Step 1: 在 set_global_shortcut 中增加冲突检测**

找到 `set_global_shortcut` 函数，在实际注册之前，先 unregister_all，然后尝试注册，如果失败给出友好错误提示（现有代码已经用 `map_err` 传递错误，但错误信息不够友好）。

在注册失败时改善错误消息：
```rust
            app.global_shortcut()
                .register(s.as_str())
                .map_err(|e| {
                    if e.to_string().contains("already") || e.to_string().contains("registered") {
                        format!("快捷键 {s} 已被其他应用占用，请选择其他组合")
                    } else {
                        format!("注册快捷键失败：{e}")
                    }
                })?;
```

**Step 2: 新增 check_shortcut_conflict 命令（只测试不保存）**

在 `commands/settings.rs` 末尾添加：
```rust
/// 检测全局快捷键是否可用（不实际注册保存）
#[tauri::command]
pub fn check_shortcut_conflict(
    shortcut: String,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    // 先 unregister 当前快捷键，避免自冲突
    let _ = app.global_shortcut().unregister_all();
    match app.global_shortcut().register(shortcut.as_str()) {
        Ok(_) => {
            // 测试通过，立即取消注册（不保存）
            let _ = app.global_shortcut().unregister(shortcut.as_str());
            // 恢复之前注册的快捷键
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}
```

在 `lib.rs` 注册：
```rust
commands::settings::check_shortcut_conflict,
```

**Step 3: 前端 SettingsDrawer 在保存前检测冲突**

在 `saveShortcut` 函数中，保存前先调用 `check_shortcut_conflict`：
```typescript
  const saveShortcut = async () => {
    if (shortcut) {
      const available = await invoke<boolean>("check_shortcut_conflict", { shortcut });
      if (!available) {
        message.error(`快捷键 ${shortcut} 已被其他应用占用，请选择其他组合`);
        return;
      }
    }
    setSavingShortcut(true);
    // ... 原有保存逻辑
  };
```

注意：check_shortcut_conflict 会先 unregister_all，调用后需要恢复当前已注册的快捷键。可在前端调用 `set_global_shortcut` 重新注册来恢复。

**Step 4: 验证**
```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

---

## Task 10: i18n 集成（全组件中文/英文切换）

**Files:**
- Modify: `src/i18n/zh.json`（补全所有 key）
- Modify: `src/i18n/en.json`（补全所有 key）
- Modify: `src/main.tsx`（import i18n 确保初始化）
- Modify: `src/components/SearchBar.tsx`（使用 useTranslation）
- Modify: `src/components/SettingsDrawer.tsx`（使用 useTranslation + 添加语言切换）
- Modify: `src/components/ResultList.tsx`（使用 useTranslation）
- Modify: `src/components/QAPanel.tsx`（使用 useTranslation，关键文本）
- Modify: `src/App.tsx`（使用 useTranslation）

**Step 1: 完善翻译文件**

更新 `src/i18n/zh.json`（完整版）：
```json
{
  "search": {
    "placeholder_fulltext": "搜索文件内容、关键词...",
    "placeholder_filename": "按文件名搜索...",
    "placeholder_semantic": "用自然语言描述要找的内容...",
    "fulltext": "全文",
    "filename": "文件名",
    "semantic": "语义",
    "error": "搜索失败：{{error}}",
    "empty_query": "开始搜索文件",
    "empty_query_desc": "输入关键词搜索文件内容、文件名",
    "no_results": "未找到相关文件",
    "no_results_desc": "没有找到与\"{{query}}\"匹配的内容",
    "sort_relevance": "相关度",
    "sort_modified": "修改时间",
    "sort_size": "文件大小",
    "export_csv": "导出 CSV",
    "batch_mode": "批量操作",
    "batch_selected": "已选 {{count}} 个文件",
    "batch_select_all": "全选",
    "batch_cancel": "取消",
    "batch_export": "导出选中",
    "batch_open": "批量打开",
    "batch_summarize": "生成摘要"
  },
  "preview": {
    "empty": "单击文件预览内容",
    "loading": "（预览内容加载中）"
  },
  "settings": {
    "title": "设置",
    "folders": "已监听的文件夹",
    "add_folder": "添加文件夹",
    "reindex": "重新索引",
    "remove": "移除",
    "semantic_index": "语义索引",
    "rebuild_vector": "重建语义索引",
    "appearance": "外观",
    "theme_system": "跟随系统",
    "theme_light": "浅色",
    "theme_dark": "深色",
    "language": "语言",
    "shortcut": "全局快捷键",
    "shortcut_placeholder": "点击录制快捷键",
    "shortcut_recording": "按下快捷键…（Esc 取消）",
    "shortcut_clear": "清除",
    "shortcut_save": "保存",
    "reindex_interval": "定时重索引",
    "reindex_interval_desc": "自动定期重新扫描并更新文件索引。0 分钟 = 禁用。",
    "api_config": "在线 API（OpenAI 兼容）",
    "data_management": "数据管理",
    "clear_all": "一键清除所有索引"
  },
  "qa": {
    "new_conversation": "新对话",
    "send": "发送",
    "stop": "停止",
    "clear": "清空",
    "export": "导出对话",
    "continuous_mode": "连续对话",
    "single_mode": "单次问答",
    "placeholder_loaded": "输入问题… (Enter 发送，Shift+Enter 换行)",
    "placeholder_no_model": "请先加载模型"
  },
  "tray": {
    "show": "显示 DocMind",
    "search": "快速搜索",
    "quit": "退出"
  },
  "onboarding": {
    "title": "欢迎使用 DocMind",
    "subtitle": "本地 AI 文档搜索助手",
    "select_folder": "选择文件夹",
    "start_index": "开始索引",
    "done": "完成"
  },
  "common": {
    "save": "保存",
    "cancel": "取消",
    "confirm": "确认",
    "loading": "加载中…",
    "success": "成功",
    "error": "错误"
  }
}
```

更新 `src/i18n/en.json` 为对应英文翻译（所有 key 保持相同结构）。

**Step 2: 确认 main.tsx 已 import i18n**

在 `src/main.tsx` 中添加（如未添加）：
```typescript
import "./i18n/index";
```

**Step 3: 在 SettingsDrawer 添加语言切换 UI**

在"外观"区段中，在主题切换之后添加语言切换：
```tsx
<div style={{ marginTop: 12 }}>
  <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
    语言 / Language
  </Typography.Text>
  <div style={{ display: "flex", gap: 6 }}>
    {[{ key: "zh", label: "中文" }, { key: "en", label: "English" }].map(opt => (
      <button key={opt.key} onClick={() => { i18n.changeLanguage(opt.key); }}
        style={{ /* 与主题按钮同样样式 */ }}>
        {opt.label}
      </button>
    ))}
  </div>
</div>
```

需要 `import i18n from "../i18n";` 和 `import { useTranslation } from "react-i18next";`。

**Step 4: 在 SearchBar 使用 useTranslation**

```typescript
const { t } = useTranslation();
const placeholder = t(`search.placeholder_${mode}`);
```

**Step 5: 对 QAPanel、ResultList 等关键文本使用 t()**

限于篇幅，只对高频可见文本替换，内部逻辑字符串保留原文。

**Step 6: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

---

## Task 11: LLM 代码去重（后端 commands/llm.rs）

**Files:**
- Modify: `src-tauri/src/commands/llm.rs`

**Step 1: 提取公共 RAG 检索 + Prompt 构建函数**

在 `commands/llm.rs` 中，`ask_question_stream` 和 `ask_question_stream_api` 有大量重复的 RAG 检索代码。提取为公共函数：

在文件内部（非 pub）添加：

```rust
struct RagContext {
    sources: Vec<SourceRef>,
    context_text: String,
}

fn build_rag_context(
    question: &str,
    history: &Option<Vec<HistoryMessage>>,
    state: &crate::state::AppState,
    max_chunks: usize,
) -> Result<RagContext, String> {
    let retrieval_query = {
        let last_user = history.as_ref()
            .and_then(|h| h.iter().rev().find(|m| m.role == "user"))
            .map(|m| m.content.as_str())
            .unwrap_or("");
        if !last_user.is_empty() && last_user != question {
            format!("{} {}", last_user, question)
        } else {
            question.to_string()
        }
    };

    let chunks = crate::search::search_hybrid_for_rag(&retrieval_query, state, max_chunks)
        .map_err(|e| e.to_string())?;

    let context_chunks: Vec<String> = chunks.iter().map(|c| {
        let text = if c.content.chars().count() > 700 {
            c.content.chars().take(700).collect::<String>() + "…"
        } else {
            c.content.clone()
        };
        format!("【来源：{}】\n{}", c.name, text)
    }).collect();

    let sources: Vec<SourceRef> = chunks.iter().map(|c| SourceRef {
        name: c.name.clone(),
        path: c.path.clone(),
        snippet: c.content.chars().take(200).collect::<String>(),
    }).collect();

    let context_text = if context_chunks.is_empty() {
        "（未找到相关文档）".to_string()
    } else {
        context_chunks.join("\n\n")
    };

    Ok(RagContext { sources, context_text })
}
```

然后在 `ask_question_stream` 和 `ask_question_stream_api` 中调用 `build_rag_context(...)` 替换重复代码。

**Step 2: 验证**
```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

---

## Task 12: 前端类型统一（src/types.ts）

**Files:**
- Create: `src/types.ts`
- Modify: `src/components/QAPanel.tsx`
- Modify: `src/stores/searchStore.ts`
- Modify: `src/components/ResultList.tsx`

**Step 1: 创建 src/types.ts**

```typescript
// DocMind 共享类型定义

export interface SearchResult {
  file_id: number;
  path: string;
  name: string;
  file_type: string;
  score: number;
  snippet: string;
}

export interface SearchHistoryItem {
  id: number;
  query: string;
  mode: string;
  used_at: string;
}

export interface SourceRef {
  name: string;
  path: string;
  snippet: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: SourceRef[];
  error?: boolean;
  streaming?: boolean;
}

export interface ConversationInfo {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageInfo {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  sources_json: string | null;
  created_at: string;
}

export interface GgufModelInfo {
  id: string;
  name: string;
  filename: string;
  size_mb: number;
  downloaded: boolean;
  path: string | null;
}

export interface ApiLlmConfig {
  enabled: boolean;
  endpoint: string;
  api_key: string;
  model_name: string;
  temperature: number;
  max_tokens: number;
  top_p: number;
}
```

**Step 2: 在各组件中 import 并移除重复定义**

在 `QAPanel.tsx`：
```typescript
import type { GgufModelInfo, SourceRef, Message, ConversationInfo, MessageInfo, ApiLlmConfig } from "../types";
```
删除文件内对应的重复 interface 定义。

在 `searchStore.ts`：
```typescript
import type { SearchResult, SearchHistoryItem } from "../types";
```
删除重复定义。

在 `ResultList.tsx`：不需要 import SearchResult（从 store 中已推断类型），但可以 import 供 JSX 类型标注。

**Step 3: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

---

## 实现顺序

```
Task 7  → 最简单（语义搜索帮助）
Task 12 → 前端类型统一（无功能改动，为后续打基础）
Task 11 → LLM 代码去重（纯后端重构）
Task 4  → ZIP 支持（后端）
Task 8  → 系统托盘（后端 + 少量前端）
Task 9  → 快捷键冲突检测（后端 + 少量前端）
Task 5  → 定时重索引（后端 + 前端）
Task 1  → 虚拟滚动（前端，需先确认 react-window 安装）
Task 2  → 搜索高亮（前端，PreviewPanel）
Task 3  → 批量操作（前端，依赖 Task 1 的虚拟滚动结构）
Task 6  → 多文档摘要（后端 + 前端，依赖 Task 3 批量选中）
Task 10 → i18n 集成（最后，改动面最广）
```

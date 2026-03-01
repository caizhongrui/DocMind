# File Type Filter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让用户在设置页自定义哪些文件扩展名会被索引，保存时可选择是否清理已有的被移除类型记录。

**Architecture:** 配置存储在现有 `settings` 表（key=`indexed_file_types`，value=逗号分隔字符串）。新增两个 Tauri 命令处理读写和清理。`collect_files` 改为接收类型列表参数，`scan_and_index` 从 DB 读取启用类型后传入。前端在 SettingsDrawer 新增一个 Tag 切换卡片，保存时弹 Modal 让用户选择清理方式。

**Tech Stack:** Rust / Tauri 2、React + TypeScript、Ant Design 5、SQLite（rusqlite）、Tantivy 0.22

---

## 参考常量（写代码前先看）

`src-tauri/src/indexer/mod.rs` 中现有的全量类型常量：

```rust
const SUPPORTED_EXTS: &[&str] = &[
    "pdf", "doc", "docx", "ppt", "pptx", "rtf",
    "xls", "xlsx", "csv",
    "txt", "md", "rst",
    "zip",
    "jpg", "jpeg", "png", "bmp", "tiff", "tif", "webp",
];
```

---

### Task 1: 后端 — `get_indexed_types` 命令

**Files:**
- Modify: `src-tauri/src/commands/settings.rs`

**Step 1: 在 `settings.rs` 末尾追加函数**

```rust
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
        // key 不存在或为空 → 返回全量默认
        _ => SUPPORTED_EXTS.iter().map(|s| s.to_string()).collect(),
    }
}
```

**Step 2: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error"
```

期望：无输出（只有 warnings 可接受）

---

### Task 2: 后端 — `set_indexed_types` 命令（含清理逻辑）

**Files:**
- Modify: `src-tauri/src/commands/settings.rs`
- Modify: `src-tauri/src/indexer/tantivy_index.rs`（若 `delete_document` 需要 `&mut writer` 确认签名）

**Step 1: 在 `settings.rs` 末尾追加函数**

```rust
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
                stmt.query_map(params.as_slice(), |r| r.get(0))
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .collect()
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
```

**Step 2: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error"
```

期望：无 error

---

### Task 3: 后端 — 导出 `SUPPORTED_EXTS` 并注册命令

**Files:**
- Modify: `src-tauri/src/indexer/mod.rs`（将 `SUPPORTED_EXTS` 改为 `pub`）
- Modify: `src-tauri/src/lib.rs`（注册两个新命令）

**Step 1: 将 `SUPPORTED_EXTS` 改为 pub**

在 `indexer/mod.rs` 找到：
```rust
const SUPPORTED_EXTS: &[&str] = &[
```
改为：
```rust
pub const SUPPORTED_EXTS: &[&str] = &[
```

**Step 2: 在 `lib.rs` 的 `invoke_handler!` 宏中追加两个命令**

找到现有的 invoke_handler! 宏，在末尾（最后一个命令后）追加：
```rust
commands::settings::get_indexed_types,
commands::settings::set_indexed_types,
```

**Step 3: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error"
```

期望：无 error

---

### Task 4: 后端 — `collect_files` 使用配置类型

**Files:**
- Modify: `src-tauri/src/indexer/mod.rs`

**目标：** `collect_files` 改为接收 `&[&str]` 参数而非使用硬编码常量；`scan_and_index` 在调用前从 DB 读取配置类型。

**Step 1: 修改 `collect_files` 签名**

找到：
```rust
pub fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if !EXCLUDE_DIRS.contains(&name.as_ref()) {
                    result.extend(collect_files(&path));
                }
            } else if path.is_file() {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if SUPPORTED_EXTS.contains(&ext.as_str()) {
                    result.push(path);
                }
            }
        }
    }
    result
}
```

改为：
```rust
pub fn collect_files(root: &Path, enabled_exts: &[String]) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if !EXCLUDE_DIRS.contains(&name.as_ref()) {
                    result.extend(collect_files(&path, enabled_exts));
                }
            } else if path.is_file() {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if enabled_exts.iter().any(|e| e == &ext) {
                    result.push(path);
                }
            }
        }
    }
    result
}
```

**Step 2: 修改 `scan_and_index` 调用处**

在 `scan_and_index` 函数开头（`collect_files` 调用之前）读取配置：

找到：
```rust
    let files = collect_files(folder);
```

改为：
```rust
    // 从 DB 读取用户配置的启用类型，key 不存在时使用全量默认
    let enabled_exts: Vec<String> = {
        let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        db.query_row(
            "SELECT value FROM settings WHERE key = 'indexed_file_types'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .map(|s| s.split(',').map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect())
        .unwrap_or_else(|| SUPPORTED_EXTS.iter().map(|s| s.to_string()).collect())
    };
    let files = collect_files(folder, &enabled_exts);
```

**Step 3: 修复 `mod tests` 中的 `collect_files` 调用**

测试文件中的 `collect_files(tmp.path())` 需要改为提供类型列表。找到 `#[cfg(test)]` 块中所有调用，改为：

```rust
// test_collect_files_finds_supported
let exts: Vec<String> = vec!["txt".to_string(), "md".to_string()];
let files = collect_files(tmp.path(), &exts);

// test_collect_files_excludes_node_modules
let exts: Vec<String> = vec!["txt".to_string()];
let files = collect_files(tmp.path(), &exts);
```

**Step 4: 运行测试**

```bash
cd src-tauri && cargo test collect_files -- --nocapture 2>&1 | tail -20
```

期望：`test result: ok. 2 passed`

**Step 5: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error"
```

期望：无 error

---

### Task 5: 前端 — SettingsDrawer 新增文件类型卡片

**Files:**
- Modify: `src/components/SettingsDrawer.tsx`

**Step 1: 在现有 import 末尾补充 Tag 和 Checkbox**

找到：
```tsx
import { Drawer, Button, List, Typography, Progress, message, Modal, Statistic, InputNumber } from "antd";
```
改为：
```tsx
import { Drawer, Button, List, Typography, Progress, message, Modal, Statistic, InputNumber, Tag } from "antd";
```

找到（icons import）末尾，补充：
```tsx
  FileSearchOutlined,
```

**Step 2: 在组件顶部（其他常量之前）定义分组常量**

在 `interface IndexProgress` 之前插入：

```tsx
// ── 文件类型分组定义 ──────────────────────────────────────────────────────────
const FILE_TYPE_GROUPS = [
  { label: "文档", types: ["pdf", "docx", "doc", "pptx", "ppt", "rtf"] },
  { label: "表格", types: ["xlsx", "xls", "csv"] },
  { label: "图片（OCR）", types: ["jpg", "jpeg", "png", "bmp", "tiff", "tif", "webp"] },
  { label: "文本/标记", types: ["txt", "md", "rst"] },
  { label: "归档", types: ["zip"] },
] as const;

const ALL_TYPES = FILE_TYPE_GROUPS.flatMap((g) => g.types);
```

**Step 3: 在组件 state 区域补充文件类型状态**

找到：
```tsx
  // ── 定时重索引 ──
  const [reindexInterval, setReindexInterval] = useState(0);
```

在之前插入：
```tsx
  // ── 文件类型过滤 ──
  const [enabledTypes, setEnabledTypes] = useState<string[]>(ALL_TYPES);
  const [savingTypes, setSavingTypes] = useState(false);
```

**Step 4: 在 `useEffect([drawerOpen])` 中加载文件类型**

找到：
```tsx
      invoke<number>("get_reindex_interval").then(v => setReindexInterval(v)).catch(() => {});
```

在之后插入：
```tsx
      invoke<string[]>("get_indexed_types")
        .then((types) => setEnabledTypes(types))
        .catch(() => setEnabledTypes(ALL_TYPES));
```

**Step 5: 实现 `saveTypes` 函数**

找到：
```tsx
  const changeTheme = (mode: ThemeMode) => {
```

在之前插入：
```tsx
  const toggleType = (ext: string) => {
    setEnabledTypes((prev) =>
      prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext]
    );
  };

  const saveTypes = () => {
    Modal.confirm({
      title: "保存文件类型配置",
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>是否同时清理已索引的被移除类型文件？</p>
          <p style={{ fontSize: 12, color: "#64748b" }}>
            "清理"会从索引中删除已不再启用类型的文件记录，下次搜索不再出现这些文件。
          </p>
        </div>
      ),
      okText: "清理并保存",
      cancelText: "仅对后续生效",
      onOk: async () => {
        setSavingTypes(true);
        try {
          await invoke("set_indexed_types", { types: enabledTypes, cleanupRemoved: true });
          message.success("文件类型配置已保存，被移除类型记录已清理");
        } catch (e: unknown) {
          message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setSavingTypes(false);
        }
      },
      onCancel: async () => {
        setSavingTypes(true);
        try {
          await invoke("set_indexed_types", { types: enabledTypes, cleanupRemoved: false });
          message.success("文件类型配置已保存");
        } catch (e: unknown) {
          message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setSavingTypes(false);
        }
      },
    });
  };
```

**Step 6: 在 JSX 中插入文件类型卡片**

找到（在"已监听的文件夹"卡片的 `</div>` 结束后，"语义索引"卡片之前）：
```tsx
      {/* ── 语义索引 ── */}
```

在之前插入：
```tsx
      {/* ── 检索文件类型 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 10,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
        marginBottom: 16,
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 7,
        }}>
          <FileSearchOutlined style={{ color: "#1677ff", fontSize: 14 }} />
          <Typography.Text strong style={{ fontSize: 13 }}>检索文件类型</Typography.Text>
        </div>

        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 14, lineHeight: 1.6 }}>
            只有启用的类型才会被索引和检索。修改后需重新索引已有文件夹才能完全生效。
          </Typography.Text>

          {FILE_TYPE_GROUPS.map((group) => (
            <div key={group.label} style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 6 }}>
                {group.label}
              </Typography.Text>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {group.types.map((ext) => {
                  const active = enabledTypes.includes(ext);
                  return (
                    <Tag
                      key={ext}
                      onClick={() => toggleType(ext)}
                      color={active ? "blue" : "default"}
                      style={{
                        cursor: "pointer",
                        userSelect: "none",
                        opacity: active ? 1 : 0.5,
                        borderRadius: 5,
                        fontSize: 12,
                        padding: "1px 8px",
                      }}
                    >
                      {ext}
                    </Tag>
                  );
                })}
              </div>
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button
              size="small"
              onClick={() => setEnabledTypes(ALL_TYPES)}
              style={{ fontSize: 12 }}
            >
              全选
            </Button>
            <Button
              size="small"
              onClick={() => setEnabledTypes([])}
              style={{ fontSize: 12 }}
            >
              全不选
            </Button>
            <Button
              type="primary"
              size="small"
              loading={savingTypes}
              onClick={saveTypes}
              style={{ marginLeft: "auto", fontSize: 12 }}
            >
              保存
            </Button>
          </div>
        </div>
      </div>
```

**Step 7: TypeScript 类型检查**

```bash
cd /Users/caizhongrui/Documents/workspace/production/DocMind && npx tsc --noEmit 2>&1 | grep -E "error TS"
```

期望：无 error

---

### Task 6: 验证与收尾

**Step 1: 全量编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error"
```

**Step 2: 运行现有测试**

```bash
cd src-tauri && cargo test -- --nocapture 2>&1 | tail -30
```

期望：所有测试通过（OCR 测试 3 passed，其余测试正常）

**Step 3: 手动测试流程**

1. 启动应用：`npm run tauri dev`（在项目根目录）
2. 打开设置（齿轮图标）
3. 找到"检索文件类型"卡片
4. 取消勾选几个类型，点"保存" → 弹 Modal 选"仅对后续生效"
5. 再次打开设置，确认类型状态已持久化
6. 取消勾选一个已有索引的类型，点"保存" → 选"清理并保存"→ 确认搜索结果不再返回该类型文件
7. 添加/重新索引文件夹，确认被禁用类型的文件不被收录

---

## 注意事项

- `set_indexed_types` 中构建动态 SQL 的 IN 子句时，参数数量必须与 `?N` 占位符一一对应
- Tantivy `delete_document` 在 `indexer/tantivy_index.rs` 中签名是 `(&self, writer: &IndexWriter<TantivyDocument>, file_id: u64)`，writer 是引用传入，commit 时需要 `mut writer`
- 前端 `Modal.confirm` 的 `onCancel` 在用户点"取消"按钮（非关闭 modal）时触发，此处复用为"仅对后续生效"的路径
- `ALL_TYPES` 用 `flatMap` 展开所有分组，顺序与 `FILE_TYPE_GROUPS` 定义一致

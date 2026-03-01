# 文件类型过滤设计文档

日期：2026-03-01

## 需求

让用户自定义哪些文件扩展名会被索引和检索，而不是使用硬编码的类型列表。

## 决策摘要

- **配置粒度**：全局统一（所有监听文件夹共用一套配置）
- **保存行为**：由用户在保存时选择——仅对后续生效，或同时清理被移除类型的已有索引
- **UI 方案**：Tag 切换（按分组排列，点击切换启用/禁用）

## 数据层

### 存储

复用现有 `settings` 表：

```
key   = "indexed_file_types"
value = "pdf,docx,txt,md,..."   -- 逗号分隔，空 = 全部禁用
```

- key 不存在时，默认启用全部类型（向后兼容）
- 不需要新的数据库迁移

### Tauri 命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `get_indexed_types` | 无 | 返回 `Vec<String>`，key 不存在返回全量默认列表 |
| `set_indexed_types` | `types: Vec<String>`, `cleanup_removed: bool` | 保存并可选清理 |

`set_indexed_types` 当 `cleanup_removed = true` 时：
1. 对比新旧列表，找出被移除的扩展名
2. 从 SQLite `files` 表 `DELETE WHERE file_type IN (removed)` → CASCADE 删除 chunks/embeddings
3. 从 Tantivy FTS 删除对应文档并 commit

### 索引集成

`collect_files` 从 DB 读取启用类型替代硬编码 `SUPPORTED_EXTS`。保留 `SUPPORTED_EXTS` 常量作为默认值（key 不存在时的 fallback）。

## UI 层

在 SettingsDrawer 的"已监听的文件夹"卡片下方，新增"检索文件类型"卡片。

### 文件类型分组

| 分组 | 扩展名 |
|------|--------|
| 文档 | pdf, docx, doc, pptx, ppt, rtf |
| 表格 | xlsx, xls, csv |
| 图片（OCR） | jpg, jpeg, png, bmp, tiff, tif, webp |
| 文本/标记 | txt, md, rst |
| 归档 | zip |

### 交互

- 每个扩展名显示为 Tag，蓝色=启用，灰色=禁用，点击切换
- 底部：[全选] [全不选] [保存] 三个按钮
- 点击保存时弹 Modal，用户选择：
  - "仅对后续索引生效"（cleanup_removed = false）
  - "同时清理已索引的被移除类型"（cleanup_removed = true）

## 影响范围

| 文件 | 改动 |
|------|------|
| `src-tauri/src/commands/settings.rs` | 新增 `get_indexed_types` / `set_indexed_types` |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src-tauri/src/indexer/mod.rs` | `collect_files` 接收类型列表参数；`scan_and_index` 从 DB 读取类型 |
| `src/components/SettingsDrawer.tsx` | 新增文件类型卡片 |

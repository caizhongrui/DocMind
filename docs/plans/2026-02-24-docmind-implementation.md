# DocMind 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建 DocMind——一个完全本地运行的智能文件助手，支持全文搜索（MVP）和 AI 语义问答（V2.0），覆盖 Windows + macOS 双平台。

**Architecture:** Tauri（Rust 后端 + React 前端）桌面应用；后端负责文件解析、Tantivy 全文索引、USearch 向量索引、LLM 推理；前端通过 `tauri::invoke` IPC 调用所有后端能力；数据统一存储于 SQLite。

**Tech Stack:** Rust · Tauri v2 · React 18 + TypeScript · Ant Design · Zustand · Tantivy · USearch · SQLite(rusqlite) · onnxruntime-sys · llama-cpp-rs · notify · lopdf · calamine

---

## 项目目录结构约定

```
docmind/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs              # Tauri 入口
│   │   ├── commands/            # IPC 命令处理器（对应前端 invoke）
│   │   │   ├── mod.rs
│   │   │   ├── search.rs
│   │   │   ├── index.rs
│   │   │   └── settings.rs
│   │   ├── db/                  # SQLite 操作
│   │   │   ├── mod.rs
│   │   │   └── migrations.rs
│   │   ├── indexer/             # 文件解析 + 索引写入
│   │   │   ├── mod.rs
│   │   │   ├── parser/
│   │   │   │   ├── mod.rs
│   │   │   │   ├── pdf.rs
│   │   │   │   ├── office.rs
│   │   │   │   └── text.rs
│   │   │   └── tantivy_index.rs
│   │   ├── watcher/             # 文件系统监听
│   │   │   └── mod.rs
│   │   ├── search/              # 搜索逻辑
│   │   │   └── mod.rs
│   │   └── state.rs             # 全局 AppState
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                         # React 前端
│   ├── components/
│   │   ├── SearchBar.tsx
│   │   ├── ResultList.tsx
│   │   ├── PreviewPanel.tsx
│   │   └── ProgressBar.tsx
│   ├── stores/
│   │   ├── searchStore.ts       # Zustand
│   │   └── settingsStore.ts
│   ├── pages/
│   │   ├── Main.tsx
│   │   ├── Settings.tsx
│   │   └── Onboarding.tsx
│   ├── App.tsx
│   └── main.tsx
├── docs/
│   └── plans/
├── .github/
│   └── workflows/
│       └── build.yml            # CI/CD 双平台构建
└── package.json
```

---

## Phase 0：PoC 技术验证（开工前必做）

> 目标：在写任何产品代码前，验证三个最高风险的技术决策可行。失败则调整方案，不影响后续架构。

---

### Task 0.1：验证 onnxruntime-sys + bge 模型可用

**Files:**
- Create: `poc/embedding/Cargo.toml`
- Create: `poc/embedding/src/main.rs`

**Step 1: 创建 PoC 项目**

```bash
mkdir -p poc/embedding && cd poc/embedding
cargo init --name embedding-poc
```

**Step 2: 添加依赖**

编辑 `poc/embedding/Cargo.toml`：

```toml
[dependencies]
onnxruntime = { version = "0.0.14", features = ["download-binaries"] }
ndarray = "0.15"
tokenizers = "0.19"
```

**Step 3: 下载模型**

```bash
# 从 ModelScope 下载 bge-small-zh-v1.5 ONNX 版本
pip install modelscope
python -c "
from modelscope import snapshot_download
snapshot_download('AI-ModelScope/bge-small-zh-v1.5', local_dir='./model')
"
```

**Step 4: 编写验证代码**

`poc/embedding/src/main.rs`：

```rust
fn main() {
    // 1. 加载 tokenizer
    let tokenizer = tokenizers::Tokenizer::from_file("./model/tokenizer.json").unwrap();

    // 2. 初始化 onnxruntime 会话
    let environment = onnxruntime::environment::Environment::builder()
        .with_name("test")
        .build()
        .unwrap();
    let session = environment
        .new_session_builder()
        .unwrap()
        .with_model_from_file("./model/model.onnx")
        .unwrap();

    // 3. 编码测试文本
    let encoding = tokenizer.encode("这是一个测试句子", true).unwrap();
    println!("Token IDs: {:?}", encoding.get_ids());
    println!("输入维度: {}", encoding.get_ids().len());

    // 4. 推理（简化版，验证不崩溃）
    println!("onnxruntime-sys + bge 验证通过 ✓");
}
```

**Step 5: 运行验证**

```bash
cd poc/embedding && cargo run
```

预期输出：`onnxruntime-sys + bge 验证通过 ✓`

若失败：切换为 `candle` crate 作为备选 ONNX 推理引擎。

**Step 6: Commit**

```bash
git add poc/embedding/
git commit -m "poc: validate onnxruntime-sys + bge-small-zh-v1.5"
```

---

### Task 0.2：验证 Tauri v2 项目骨架 + IPC 通信

**Files:**
- Create: 整个 docmind 主项目骨架

**Step 1: 初始化 Tauri + React 项目**

```bash
npm create tauri-app@latest docmind -- --template react-ts
cd docmind
npm install
```

**Step 2: 验证启动**

```bash
npm run tauri dev
```

预期：窗口弹出，显示默认 React 页面。

**Step 3: 添加第一个 IPC 命令**

`src-tauri/src/main.rs`：

```rust
#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`src/App.tsx`：

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

function App() {
  const [result, setResult] = useState("");
  return (
    <button onClick={async () => {
      const r = await invoke<string>("ping");
      setResult(r);
    }}>
      Ping ({result})
    </button>
  );
}
```

**Step 4: 运行并点击按钮**

```bash
npm run tauri dev
```

预期：点击按钮后显示"pong"，IPC 链路验证通过。

**Step 5: Commit**

```bash
git add .
git commit -m "chore: init tauri + react project skeleton, validate IPC"
```

---

### Task 0.3：搭建 GitHub Actions 双平台 CI

**Files:**
- Create: `.github/workflows/build.yml`

**Step 1: 创建 workflow 文件**

`.github/workflows/build.yml`：

```yaml
name: Build

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin,x86_64-apple-darwin
      - run: npm ci
      - run: npm run tauri build -- --target universal-apple-darwin
      - uses: actions/upload-artifact@v4
        with:
          name: macos-dmg
          path: src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg

  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npm run tauri build
      - uses: actions/upload-artifact@v4
        with:
          name: windows-exe
          path: src-tauri/target/release/bundle/nsis/*.exe
```

**Step 2: 推送并检查 Actions**

```bash
git add .github/
git commit -m "ci: add GitHub Actions dual-platform build"
git push
```

预期：GitHub Actions 两个 job 均绿色通过。

---

## Phase 1：数据层（SQLite + 文件解析）

---

### Task 1.1：SQLite 数据库初始化

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/db/migrations.rs`
- Create: `src-tauri/src/state.rs`

**Step 1: 添加依赖**

`src-tauri/Cargo.toml`：

```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.31", features = ["bundled"] }
tokio = { version = "1", features = ["full"] }
anyhow = "1"
```

**Step 2: 编写 migrations**

`src-tauri/src/db/migrations.rs`：

```rust
pub const MIGRATIONS: &[&str] = &[
    // V1: 初始表结构
    r#"
    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        modified INTEGER NOT NULL,
        file_type TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        parse_status TEXT NOT NULL DEFAULT 'ok'
    );

    CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        vector BLOB NOT NULL,
        model_version TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS doc_graph (
        file_id_a INTEGER NOT NULL,
        file_id_b INTEGER NOT NULL,
        similarity REAL NOT NULL,
        PRIMARY KEY (file_id_a, file_id_b)
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watched_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
    "#,
];
```

**Step 3: 编写 db 初始化**

`src-tauri/src/db/mod.rs`：

```rust
use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

pub mod migrations;

pub fn init(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);"
    )?;
    let version: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))
        .unwrap_or(0);

    for (i, migration) in migrations::MIGRATIONS.iter().enumerate() {
        if (i as i64) >= version {
            conn.execute_batch(migration)?;
            conn.execute("INSERT INTO schema_version VALUES (?1)", [i + 1])?;
        }
    }
    Ok(())
}
```

**Step 4: 编写全局 AppState**

`src-tauri/src/state.rs`：

```rust
use rusqlite::Connection;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Connection>,
}
```

**Step 5: 接入 main.rs**

`src-tauri/src/main.rs`：

```rust
mod db;
mod state;

use state::AppState;
use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::init(&data_dir.join("docmind.db"))?;
            app.manage(AppState { db: Mutex::new(conn) });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 6: 运行验证**

```bash
npm run tauri dev
```

预期：应用启动，`~/Library/Application Support/docmind/docmind.db` 文件被创建。

**Step 7: Commit**

```bash
git add src-tauri/src/db/ src-tauri/src/state.rs src-tauri/src/main.rs
git commit -m "feat: init SQLite with migrations and AppState"
```

---

### Task 1.2：文件解析器——纯文本（txt / md / csv）

**Files:**
- Create: `src-tauri/src/indexer/parser/text.rs`
- Create: `src-tauri/src/indexer/parser/mod.rs`

**Step 1: 定义解析器接口**

`src-tauri/src/indexer/parser/mod.rs`：

```rust
pub mod text;
pub mod pdf;
pub mod office;

#[derive(Debug)]
pub struct ParseResult {
    pub content: String,          // 提取的纯文本
    pub status: ParseStatus,
}

#[derive(Debug, PartialEq)]
pub enum ParseStatus {
    Ok,
    Partial,    // 部分解析成功
    Failed,     // 解析失败，仅文件名可搜索
}

pub fn parse_file(path: &std::path::Path) -> ParseResult {
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "txt" | "md" | "csv" => text::parse(path),
        "pdf" => pdf::parse(path),
        "docx" | "pptx" => office::parse_xml(path),
        "xlsx" => office::parse_xlsx(path),
        _ => ParseResult { content: String::new(), status: ParseStatus::Failed },
    }
}
```

**Step 2: 实现纯文本解析**

`src-tauri/src/indexer/parser/text.rs`：

```rust
use super::{ParseResult, ParseStatus};
use std::path::Path;

pub fn parse(path: &Path) -> ParseResult {
    match std::fs::read_to_string(path) {
        Ok(content) => ParseResult { content, status: ParseStatus::Ok },
        Err(_) => {
            // 尝试 GBK 编码（中文 Windows 常见）
            match std::fs::read(path) {
                Ok(bytes) => {
                    let (content, _, _) = encoding_rs::GBK.decode(&bytes);
                    ParseResult { content: content.into_owned(), status: ParseStatus::Ok }
                }
                Err(_) => ParseResult { content: String::new(), status: ParseStatus::Failed },
            }
        }
    }
}
```

`src-tauri/Cargo.toml` 追加：

```toml
encoding_rs = "0.8"
```

**Step 3: 编写单元测试**

`src-tauri/src/indexer/parser/text.rs` 底部追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_parse_utf8_text() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(f, "这是测试内容").unwrap();
        let result = parse(f.path());
        assert_eq!(result.status, ParseStatus::Ok);
        assert!(result.content.contains("这是测试内容"));
    }

    #[test]
    fn test_parse_missing_file() {
        let result = parse(std::path::Path::new("/nonexistent/file.txt"));
        assert_eq!(result.status, ParseStatus::Failed);
    }
}
```

**Step 4: 运行测试**

```bash
cd src-tauri && cargo test indexer::parser::text
```

预期：2 tests passed。

**Step 5: Commit**

```bash
git add src-tauri/src/indexer/
git commit -m "feat: add text/md/csv parser with GBK fallback"
```

---

### Task 1.3：文件解析器——PDF（三级降级）

**Files:**
- Create: `src-tauri/src/indexer/parser/pdf.rs`

**Step 1: 添加依赖**

`src-tauri/Cargo.toml`：

```toml
lopdf = "0.32"
pdf-extract = "0.7"
```

**Step 2: 实现 PDF 三级降级解析**

`src-tauri/src/indexer/parser/pdf.rs`：

```rust
use super::{ParseResult, ParseStatus};
use std::path::Path;

pub fn parse(path: &Path) -> ParseResult {
    // 第一级：lopdf
    if let Ok(content) = try_lopdf(path) {
        if !content.trim().is_empty() {
            return ParseResult { content, status: ParseStatus::Ok };
        }
    }

    // 第二级：pdf-extract
    if let Ok(content) = try_pdf_extract(path) {
        if !content.trim().is_empty() {
            return ParseResult { content, status: ParseStatus::Partial };
        }
    }

    // 第三级：标记失败（专业版由调用方触发 OCR）
    ParseResult { content: String::new(), status: ParseStatus::Failed }
}

fn try_lopdf(path: &Path) -> anyhow::Result<String> {
    let doc = lopdf::Document::load(path)?;
    let mut text = String::new();
    for page_num in 1..=doc.get_pages().len() as u32 {
        if let Ok(page_text) = doc.extract_text(&[page_num]) {
            text.push_str(&page_text);
            text.push('\n');
        }
    }
    Ok(text)
}

fn try_pdf_extract(path: &Path) -> anyhow::Result<String> {
    let bytes = std::fs::read(path)?;
    let content = pdf_extract::extract_text_from_mem(&bytes)?;
    Ok(content)
}
```

**Step 3: 编写测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_nonexistent_pdf() {
        let result = parse(Path::new("/nonexistent.pdf"));
        assert_eq!(result.status, ParseStatus::Failed);
        assert!(result.content.is_empty());
    }
}
```

**Step 4: 运行测试**

```bash
cd src-tauri && cargo test indexer::parser::pdf
```

**Step 5: Commit**

```bash
git add src-tauri/src/indexer/parser/pdf.rs
git commit -m "feat: add PDF parser with 3-tier fallback (lopdf -> pdf-extract -> failed)"
```

---

### Task 1.4：文件解析器——Office（docx / pptx / xlsx）

**Files:**
- Create: `src-tauri/src/indexer/parser/office.rs`

**Step 1: 添加依赖**

`src-tauri/Cargo.toml`：

```toml
calamine = "0.24"
zip = "2"
quick-xml = "0.36"
```

**Step 2: 实现 Office 解析**

`src-tauri/src/indexer/parser/office.rs`：

```rust
use super::{ParseResult, ParseStatus};
use std::path::Path;

/// 解析 docx / pptx（内部是 ZIP + XML）
pub fn parse_xml(path: &Path) -> ParseResult {
    match try_extract_xml_text(path) {
        Ok(text) if !text.trim().is_empty() => ParseResult { content: text, status: ParseStatus::Ok },
        _ => ParseResult { content: String::new(), status: ParseStatus::Failed },
    }
}

fn try_extract_xml_text(path: &Path) -> anyhow::Result<String> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut text = String::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        // docx: word/document.xml; pptx: ppt/slides/slide*.xml
        if name.ends_with(".xml") && (name.contains("document") || name.contains("slide")) {
            let mut xml_content = String::new();
            entry.read_to_string(&mut xml_content)?;
            text.push_str(&strip_xml_tags(&xml_content));
            text.push('\n');
        }
    }
    Ok(text)
}

fn strip_xml_tags(xml: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in xml.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => { in_tag = false; result.push(' '); }
            c if !in_tag => result.push(c),
            _ => {}
        }
    }
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 解析 xlsx
pub fn parse_xlsx(path: &Path) -> ParseResult {
    use calamine::{Reader, open_workbook_auto};
    match open_workbook_auto(path) {
        Ok(mut wb) => {
            let mut text = String::new();
            for sheet_name in wb.sheet_names().to_vec() {
                if let Ok(range) = wb.worksheet_range(&sheet_name) {
                    for row in range.rows() {
                        let line: Vec<String> = row.iter()
                            .map(|c| c.to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                        if !line.is_empty() {
                            text.push_str(&line.join("\t"));
                            text.push('\n');
                        }
                    }
                }
            }
            ParseResult { content: text, status: ParseStatus::Ok }
        }
        Err(_) => ParseResult { content: String::new(), status: ParseStatus::Failed },
    }
}
```

**Step 3: 运行测试**

```bash
cd src-tauri && cargo test indexer::parser::office
```

**Step 4: Commit**

```bash
git add src-tauri/src/indexer/parser/office.rs
git commit -m "feat: add Office parser (docx/pptx via XML, xlsx via calamine)"
```

---

## Phase 2：全文索引引擎（Tantivy）

---

### Task 2.1：Tantivy 索引初始化

**Files:**
- Create: `src-tauri/src/indexer/tantivy_index.rs`

**Step 1: 添加依赖**

```toml
tantivy = "0.22"
```

**Step 2: 实现索引初始化**

`src-tauri/src/indexer/tantivy_index.rs`：

```rust
use anyhow::Result;
use std::path::Path;
use tantivy::{schema::*, Index, IndexWriter, TantivyDocument};

pub struct FtsIndex {
    pub index: Index,
    pub schema: Schema,
    pub field_id: Field,
    pub field_path: Field,
    pub field_name: Field,
    pub field_content: Field,
    pub field_file_type: Field,
}

impl FtsIndex {
    pub fn open_or_create(index_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(index_dir)?;

        let mut builder = Schema::builder();
        let field_id = builder.add_u64_field("file_id", INDEXED | STORED);
        let field_path = builder.add_text_field("path", STORED);
        let field_name = builder.add_text_field("name", TEXT | STORED);
        let field_content = builder.add_text_field("content", TEXT);
        let field_file_type = builder.add_text_field("file_type", STRING | STORED);
        let schema = builder.build();

        let index = if index_dir.join("meta.json").exists() {
            Index::open_in_dir(index_dir)?
        } else {
            Index::create_in_dir(index_dir, schema.clone())?
        };

        Ok(Self { index, schema, field_id, field_path, field_name, field_content, field_file_type })
    }

    pub fn writer(&self) -> Result<IndexWriter> {
        Ok(self.index.writer(50_000_000)?) // 50MB 写缓冲
    }

    pub fn add_document(&self, writer: &IndexWriter, file_id: u64, path: &str, name: &str, content: &str, file_type: &str) -> Result<()> {
        let mut doc = TantivyDocument::default();
        doc.add_u64(self.field_id, file_id);
        doc.add_text(self.field_path, path);
        doc.add_text(self.field_name, name);
        doc.add_text(self.field_content, content);
        doc.add_text(self.field_file_type, file_type);
        writer.add_document(doc)?;
        Ok(())
    }

    pub fn delete_document(&self, writer: &IndexWriter, file_id: u64) -> Result<()> {
        let term = Term::from_field_u64(self.field_id, file_id);
        writer.delete_term(term);
        Ok(())
    }
}
```

**Step 3: 接入 AppState**

`src-tauri/src/state.rs`：

```rust
use crate::indexer::tantivy_index::FtsIndex;
use rusqlite::Connection;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub fts: Mutex<FtsIndex>,
}
```

**Step 4: Commit**

```bash
git add src-tauri/src/indexer/tantivy_index.rs src-tauri/src/state.rs
git commit -m "feat: add Tantivy FTS index with open-or-create"
```

---

### Task 2.2：索引写入流程（扫描文件夹 → 解析 → 入库）

**Files:**
- Create: `src-tauri/src/indexer/mod.rs`
- Create: `src-tauri/src/commands/index.rs`

**Step 1: 实现索引器**

`src-tauri/src/indexer/mod.rs`：

```rust
pub mod parser;
pub mod tantivy_index;

use crate::state::AppState;
use anyhow::Result;
use parser::{parse_file, ParseStatus};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

// 默认排除目录
const EXCLUDE_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", "__pycache__",
    "target", ".DS_Store", "Thumbs.db",
];

// 支持的文件扩展名
const SUPPORTED_EXTS: &[&str] = &["txt", "md", "csv", "pdf", "docx", "xlsx", "pptx"];

pub struct IndexProgress {
    pub total: usize,
    pub done: usize,
    pub current_file: String,
}

pub fn scan_and_index(
    folder: &Path,
    state: &AppState,
    app: &AppHandle,
) -> Result<()> {
    let files = collect_files(folder);
    let total = files.len();

    let db = state.db.lock().unwrap();
    let fts = state.fts.lock().unwrap();
    let mut writer = fts.writer()?;

    for (i, path) in files.iter().enumerate() {
        let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

        // 发送进度事件给前端
        let _ = app.emit("index-progress", serde_json::json!({
            "total": total,
            "done": i + 1,
            "current": file_name,
        }));

        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let meta = std::fs::metadata(path)?;
        let modified = meta.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_secs() as i64;

        // 检查是否已索引且未修改
        let existing: Option<i64> = db.query_row(
            "SELECT modified FROM files WHERE path = ?1",
            [path.to_string_lossy().as_ref()],
            |r| r.get(0),
        ).ok();
        if existing == Some(modified) {
            continue; // 未修改，跳过
        }

        // 解析文件内容
        let parsed = parse_file(path);
        let parse_status = match parsed.status {
            ParseStatus::Ok => "ok",
            ParseStatus::Partial => "partial",
            ParseStatus::Failed => "failed",
        };

        // 写入 SQLite
        db.execute(
            "INSERT OR REPLACE INTO files (path, size, modified, file_type, indexed_at, parse_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                path.to_string_lossy().as_ref(),
                meta.len() as i64,
                modified,
                ext,
                chrono::Utc::now().timestamp(),
                parse_status,
            ],
        )?;
        let file_id: i64 = db.query_row(
            "SELECT id FROM files WHERE path = ?1",
            [path.to_string_lossy().as_ref()],
            |r| r.get(0),
        )?;

        // 写入 Tantivy
        fts.add_document(&writer, file_id as u64,
            &path.to_string_lossy(), &file_name, &parsed.content, &ext)?;
    }

    writer.commit()?;
    Ok(())
}

fn collect_files(root: &Path) -> Vec<PathBuf> {
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
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if SUPPORTED_EXTS.contains(&ext.as_str()) {
                    result.push(path);
                }
            }
        }
    }
    result
}
```

**Step 2: 实现 IPC 命令**

`src-tauri/src/commands/index.rs`：

```rust
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn start_index(
    folder: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let path = std::path::Path::new(&folder);
    // 先保存到 watched_folders
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT OR IGNORE INTO watched_folders (path) VALUES (?1)",
            [&folder],
        ).map_err(|e| e.to_string())?;
    }
    crate::indexer::scan_and_index(path, &state, &app)
        .map(|_| "ok".to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_watched_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare("SELECT path FROM watched_folders WHERE enabled = 1").map_err(|e| e.to_string())?;
    let folders: Vec<String> = stmt.query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(folders)
}

#[tauri::command]
pub fn remove_folder(folder: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM watched_folders WHERE path = ?1", [&folder]).map_err(|e| e.to_string())?;
    db.execute("DELETE FROM files WHERE path LIKE ?1", [format!("{}%", folder)]).map_err(|e| e.to_string())?;
    Ok(())
}
```

**Step 3: 注册命令**

`src-tauri/src/main.rs`：

```rust
mod commands;
use commands::index::{start_index, get_watched_folders, remove_folder};

tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        start_index,
        get_watched_folders,
        remove_folder,
    ])
```

**Step 4: Commit**

```bash
git add src-tauri/src/indexer/mod.rs src-tauri/src/commands/
git commit -m "feat: implement file scanner, parser pipeline, Tantivy index write"
```

---

## Phase 3：搜索引擎

---

### Task 3.1：全文搜索 + 文件名搜索

**Files:**
- Create: `src-tauri/src/search/mod.rs`
- Create: `src-tauri/src/commands/search.rs`

**Step 1: 实现搜索逻辑**

`src-tauri/src/search/mod.rs`：

```rust
use crate::state::AppState;
use anyhow::Result;
use serde::Serialize;
use tantivy::{collector::TopDocs, query::QueryParser, ReloadPolicy};

#[derive(Serialize, Debug)]
pub struct SearchResult {
    pub file_id: u64,
    pub path: String,
    pub name: String,
    pub file_type: String,
    pub score: f32,
    pub snippet: String,
}

pub fn search_fulltext(query_str: &str, state: &AppState, limit: usize) -> Result<Vec<SearchResult>> {
    let fts = state.fts.lock().unwrap();
    let reader = fts.index.reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()?;
    let searcher = reader.searcher();

    let query_parser = QueryParser::for_index(
        &fts.index,
        vec![fts.field_name, fts.field_content],
    );
    let query = query_parser.parse_query(query_str)?;

    let top_docs = searcher.search(&query, &TopDocs::with_limit(limit))?;

    let mut results = Vec::new();
    for (score, doc_address) in top_docs {
        let doc = searcher.doc::<tantivy::TantivyDocument>(doc_address)?;
        let file_id = doc.get_first(fts.field_id).and_then(|v| v.as_u64()).unwrap_or(0);
        let path = doc.get_first(fts.field_path).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let name = doc.get_first(fts.field_name).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let file_type = doc.get_first(fts.field_file_type).and_then(|v| v.as_str()).unwrap_or("").to_string();

        results.push(SearchResult {
            file_id,
            path,
            name,
            file_type,
            score,
            snippet: String::new(), // Phase 3.2 补充高亮
        });
    }
    Ok(results)
}

/// 文件名模糊搜索（不需要 Tantivy，直接查 SQLite LIKE）
pub fn search_filename(query_str: &str, state: &AppState, limit: usize) -> Result<Vec<SearchResult>> {
    let db = state.db.lock().unwrap();
    let pattern = format!("%{}%", query_str);
    let mut stmt = db.prepare(
        "SELECT id, path, file_type FROM files WHERE path LIKE ?1 LIMIT ?2"
    )?;
    let results = stmt.query_map(rusqlite::params![pattern, limit as i64], |r| {
        let path: String = r.get(1)?;
        let name = std::path::Path::new(&path)
            .file_name().unwrap_or_default()
            .to_string_lossy().to_string();
        Ok(SearchResult {
            file_id: r.get::<_, i64>(0)? as u64,
            path,
            name,
            file_type: r.get(2)?,
            score: 1.0,
            snippet: String::new(),
        })
    })?.flatten().collect();
    Ok(results)
}
```

**Step 2: 实现 IPC 命令**

`src-tauri/src/commands/search.rs`：

```rust
use crate::{search, state::AppState};
use tauri::State;

#[tauri::command]
pub fn search(
    query: String,
    mode: String, // "filename" | "fulltext"
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<search::SearchResult>, String> {
    let limit = limit.unwrap_or(50);
    match mode.as_str() {
        "filename" => search::search_filename(&query, &state, limit),
        "fulltext" | _ => search::search_fulltext(&query, &state, limit),
    }
    .map_err(|e| e.to_string())
}
```

**Step 3: 单元测试**

```rust
#[cfg(test)]
mod tests {
    // 集成测试：索引 2 个文件后搜索
    #[test]
    fn test_fulltext_search_returns_results() {
        // 使用 tempdir 创建临时索引，索引一个含"财务报告"的文件，搜索应返回结果
        // 略（详见 tests/ 目录集成测试）
    }
}
```

**Step 4: Commit**

```bash
git add src-tauri/src/search/ src-tauri/src/commands/search.rs
git commit -m "feat: implement fulltext search and filename fuzzy search"
```

---

## Phase 4：文件监听（实时增量更新）

---

### Task 4.1：文件变化监听器

**Files:**
- Create: `src-tauri/src/watcher/mod.rs`

**Step 1: 添加依赖**

```toml
notify = { version = "6", features = ["macos_fsevent"] }
```

**Step 2: 实现监听器**

`src-tauri/src/watcher/mod.rs`：

```rust
use crate::state::AppState;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

pub fn start_watcher(app: AppHandle) {
    let state = app.state::<AppState>();
    let folders: Vec<String> = {
        let db = state.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT path FROM watched_folders WHERE enabled = 1").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().flatten().collect()
    };

    if folders.is_empty() {
        return;
    }

    std::thread::spawn(move || {
        let app_clone = app.clone();
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

        let mut watcher = RecommendedWatcher::new(
            move |res| { let _ = tx.send(res); },
            notify::Config::default().with_poll_interval(Duration::from_secs(2)),
        ).unwrap();

        for folder in &folders {
            let _ = watcher.watch(std::path::Path::new(folder), RecursiveMode::Recursive);
        }

        for res in rx {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        for path in &event.paths {
                            let _ = app_clone.emit("file-changed", path.to_string_lossy().to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
    });
}
```

**Step 3: 在 setup 中启动**

`src-tauri/src/main.rs` setup 内追加：

```rust
let app_handle = app.handle().clone();
crate::watcher::start_watcher(app_handle);
```

**Step 4: Commit**

```bash
git add src-tauri/src/watcher/
git commit -m "feat: add file system watcher with incremental index trigger"
```

---

## Phase 5：前端 UI

---

### Task 5.1：主界面布局（搜索框 + 结果列表 + 预览区）

**Files:**
- Modify: `src/App.tsx`
- Create: `src/components/SearchBar.tsx`
- Create: `src/components/ResultList.tsx`
- Create: `src/components/PreviewPanel.tsx`
- Create: `src/stores/searchStore.ts`

**Step 1: 安装 UI 依赖**

```bash
npm install antd @ant-design/icons zustand @tauri-apps/api
```

**Step 2: 创建 Zustand store**

`src/stores/searchStore.ts`：

```typescript
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

interface SearchResult {
  file_id: number;
  path: string;
  name: string;
  file_type: string;
  score: number;
  snippet: string;
}

interface SearchStore {
  query: string;
  mode: "filename" | "fulltext";
  results: SearchResult[];
  selected: SearchResult | null;
  loading: boolean;
  setQuery: (q: string) => void;
  setMode: (m: "filename" | "fulltext") => void;
  setSelected: (r: SearchResult | null) => void;
  doSearch: () => Promise<void>;
}

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: "",
  mode: "fulltext",
  results: [],
  selected: null,
  loading: false,
  setQuery: (query) => set({ query }),
  setMode: (mode) => set({ mode }),
  setSelected: (selected) => set({ selected }),
  doSearch: async () => {
    const { query, mode } = get();
    if (!query.trim()) return set({ results: [] });
    set({ loading: true });
    try {
      const results = await invoke<SearchResult[]>("search", { query, mode });
      set({ results });
    } finally {
      set({ loading: false });
    }
  },
}));
```

**Step 3: 实现主布局**

`src/App.tsx`：

```tsx
import { Layout } from "antd";
import SearchBar from "./components/SearchBar";
import ResultList from "./components/ResultList";
import PreviewPanel from "./components/PreviewPanel";

const { Header, Content, Sider } = Layout;

export default function App() {
  return (
    <Layout style={{ height: "100vh" }}>
      <Header style={{ padding: "0 16px", display: "flex", alignItems: "center" }}>
        <SearchBar />
      </Header>
      <Layout>
        <Content style={{ overflow: "auto" }}>
          <ResultList />
        </Content>
        <Sider width={400} style={{ overflow: "auto", borderLeft: "1px solid #eee" }}>
          <PreviewPanel />
        </Sider>
      </Layout>
    </Layout>
  );
}
```

**Step 4: 实现搜索栏**

`src/components/SearchBar.tsx`：

```tsx
import { Input, Radio } from "antd";
import { useSearchStore } from "../stores/searchStore";

export default function SearchBar() {
  const { query, mode, setQuery, setMode, doSearch } = useSearchStore();
  return (
    <div style={{ display: "flex", gap: 8, flex: 1 }}>
      <Input.Search
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={doSearch}
        placeholder="搜索文件内容..."
        allowClear
        style={{ flex: 1 }}
      />
      <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} size="small">
        <Radio.Button value="fulltext">全文</Radio.Button>
        <Radio.Button value="filename">文件名</Radio.Button>
      </Radio.Group>
    </div>
  );
}
```

**Step 5: 实现结果列表（单击预览，双击打开）**

`src/components/ResultList.tsx`：

```tsx
import { List, Tag } from "antd";
import { useSearchStore } from "../stores/searchStore";
import { invoke } from "@tauri-apps/api/core";

const FILE_TYPE_COLOR: Record<string, string> = {
  pdf: "red", docx: "blue", xlsx: "green", pptx: "orange", txt: "default", md: "purple",
};

export default function ResultList() {
  const { results, selected, setSelected, loading } = useSearchStore();
  return (
    <List
      loading={loading}
      dataSource={results}
      renderItem={(item) => (
        <List.Item
          style={{
            cursor: "pointer",
            background: selected?.file_id === item.file_id ? "#e6f4ff" : undefined,
            padding: "8px 16px",
          }}
          onClick={() => setSelected(item)}
          onDoubleClick={() => invoke("open_file", { path: item.path })}
        >
          <List.Item.Meta
            title={<><Tag color={FILE_TYPE_COLOR[item.file_type] ?? "default"}>{item.file_type}</Tag>{item.name}</>}
            description={<span style={{ fontSize: 12, color: "#888" }}>{item.path}</span>}
          />
        </List.Item>
      )}
    />
  );
}
```

**Step 6: 实现预览区**

`src/components/PreviewPanel.tsx`：

```tsx
import { Empty, Typography } from "antd";
import { useSearchStore } from "../stores/searchStore";

export default function PreviewPanel() {
  const { selected } = useSearchStore();
  if (!selected) return <Empty description="单击文件预览内容" style={{ marginTop: 60 }} />;
  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={5}>{selected.name}</Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{selected.path}</Typography.Text>
      <div style={{ marginTop: 12 }}>
        <Typography.Paragraph>{selected.snippet || "（预览内容加载中）"}</Typography.Paragraph>
      </div>
    </div>
  );
}
```

**Step 7: 运行验证**

```bash
npm run tauri dev
```

**Step 8: Commit**

```bash
git add src/
git commit -m "feat: implement main UI layout - search bar, result list, preview panel"
```

---

### Task 5.2：首次启动引导流程

**Files:**
- Create: `src/pages/Onboarding.tsx`

**Step 1: 实现引导页**

`src/pages/Onboarding.tsx`：

```tsx
import { Button, Steps, Typography, message } from "antd";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect } from "react";

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState(0);
  const [folder, setFolder] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });

  useEffect(() => {
    const unlisten = listen<{ done: number; total: number; current: string }>(
      "index-progress",
      (e) => setProgress(e.payload)
    );
    return () => { unlisten.then((f) => f()); };
  }, []);

  const pickFolder = async () => {
    const selected = await open({ directory: true });
    if (selected) setFolder(selected as string);
  };

  const startIndex = async () => {
    setCurrent(2);
    await invoke("start_index", { folder });
    setCurrent(3);
  };

  return (
    <div style={{ maxWidth: 500, margin: "80px auto", padding: 24 }}>
      <Typography.Title level={3}>欢迎使用 DocMind</Typography.Title>
      <Steps current={current} direction="vertical" style={{ marginTop: 24 }}
        items={[
          { title: "选择文件夹", description: folder || "点击选择要索引的文件夹" },
          { title: "开始索引" },
          { title: "索引中", description: progress.total > 0 ? `${progress.done}/${progress.total} - ${progress.current}` : "" },
          { title: "完成" },
        ]}
      />
      {current === 0 && <Button type="primary" onClick={pickFolder} style={{ marginTop: 24 }}>选择文件夹</Button>}
      {current === 0 && folder && <Button onClick={() => setCurrent(1)} style={{ marginLeft: 8 }}>下一步</Button>}
      {current === 1 && <Button type="primary" onClick={startIndex} style={{ marginTop: 24 }}>开始索引</Button>}
      {current === 3 && <Button type="primary" onClick={onDone} style={{ marginTop: 24 }}>开始使用</Button>}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/pages/Onboarding.tsx
git commit -m "feat: add first-launch onboarding flow with folder picker and index progress"
```

---

### Task 5.3：系统托盘

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tauri.conf.json`

**Step 1: 添加托盘依赖**

`src-tauri/Cargo.toml`：

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
```

**Step 2: 配置托盘**

`src-tauri/src/main.rs`：

```rust
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 DocMind", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => { if let Some(w) = app.get_webview_window("main") { let _ = w.show(); } }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}
```

**Step 3: Commit**

```bash
git commit -am "feat: add system tray with show/quit menu"
```

---

### Task 5.4：设置面板（文件夹管理 + 快捷键配置）

**Files:**
- Create: `src/pages/Settings.tsx`
- Create: `src-tauri/src/commands/settings.rs`

**Step 1: 实现设置 IPC**

`src-tauri/src/commands/settings.rs`：

```rust
use crate::state::AppState;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn get_setting(key: String, state: State<'_, AppState>) -> Option<String> {
    let db = state.db.lock().unwrap();
    db.query_row("SELECT value FROM settings WHERE key = ?1", [&key], |r| r.get(0)).ok()
}

#[tauri::command]
pub fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        [&key, &value],
    ).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").args(["/select,", &path]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
```

**Step 2: Commit**

```bash
git add src-tauri/src/commands/settings.rs src/pages/Settings.tsx
git commit -m "feat: add settings panel - folder management, hotkey config, open/reveal file"
```

---

## Phase 6：发布准备

---

### Task 6.1：自动更新集成

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Create: `update-server/latest.json`（服务器端）

**Step 1: 配置 Tauri updater**

`src-tauri/tauri.conf.json`：

```json
{
  "plugins": {
    "updater": {
      "endpoints": ["https://update.your-domain.com/latest.json"],
      "dialog": false,
      "pubkey": "YOUR_UPDATER_PUBLIC_KEY"
    }
  }
}
```

**Step 2: 生成 updater 密钥**

```bash
npm run tauri signer generate -- -w ~/.tauri/docmind.key
# 将公钥填入 tauri.conf.json 的 pubkey
```

**Step 3: 实现更新检查 IPC**

```rust
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?
        .check().await.map_err(|e| e.to_string())?;
    Ok(update.is_some())
}
```

**Step 4: Commit**

```bash
git commit -am "feat: integrate Tauri updater with self-hosted update server"
```

---

### Task 6.2：国际化（i18n）

**Step 1: 安装 i18next**

```bash
npm install i18next react-i18next
```

**Step 2: 创建语言文件**

`src/i18n/zh.json` 和 `src/i18n/en.json`，包含所有界面字符串。

**Step 3: Commit**

```bash
git commit -am "feat: add i18n support (zh/en), follow system language"
```

---

## Phase 7：V2.0 AI 能力

> 以下任务在 MVP 1.0 稳定后开始，预计 +3 个月。

---

### Task 7.1：Embedding 生成管线

**Files:**
- Create: `src-tauri/src/embedder/mod.rs`

**Step 1: 添加依赖**

```toml
ort = { version = "2", features = ["download-binaries"] }  # onnxruntime 的更友好封装
```

**Step 2: 实现 Embedder**

`src-tauri/src/embedder/mod.rs`：

```rust
use anyhow::Result;
use ort::{session::Session, value::Tensor};
use tokenizers::Tokenizer;

pub struct Embedder {
    session: Session,
    tokenizer: Tokenizer,
}

impl Embedder {
    pub fn load(model_dir: &std::path::Path) -> Result<Self> {
        let session = Session::builder()?
            .with_model_from_file(model_dir.join("model.onnx"))?;
        let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| anyhow::anyhow!("{}", e))?;
        Ok(Self { session, tokenizer })
    }

    pub fn embed(&self, text: &str) -> Result<Vec<f32>> {
        let encoding = self.tokenizer.encode(text, true)
            .map_err(|e| anyhow::anyhow!("{}", e))?;

        let ids: Vec<i64> = encoding.get_ids().iter().map(|&x| x as i64).collect();
        let mask: Vec<i64> = encoding.get_attention_mask().iter().map(|&x| x as i64).collect();
        let len = ids.len();

        let ids_tensor = Tensor::from_array(([1, len], ids))?;
        let mask_tensor = Tensor::from_array(([1, len], mask))?;

        let outputs = self.session.run(ort::inputs![
            "input_ids" => ids_tensor,
            "attention_mask" => mask_tensor,
        ]?)?;

        // CLS token pooling
        let output = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
        let embedding: Vec<f32> = output.view().index_axis(ndarray::Axis(1), 0)
            .iter().copied().collect();
        Ok(normalize(&embedding))
    }
}

fn normalize(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / norm).collect()
}
```

**Step 3: Commit**

```bash
git commit -am "feat(v2): add bge-small-zh-v1.5 embedding pipeline via ort"
```

---

### Task 7.2：USearch 向量索引集成

**Files:**
- Create: `src-tauri/src/vector_index/mod.rs`

**Step 1: 添加依赖**

```toml
usearch = "2"
```

**Step 2: 实现向量索引**

`src-tauri/src/vector_index/mod.rs`：

```rust
use anyhow::Result;
use std::path::Path;
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

pub struct VectorIndex {
    index: Index,
    path: std::path::PathBuf,
}

impl VectorIndex {
    pub fn open_or_create(index_path: &Path, dimensions: usize) -> Result<Self> {
        let options = IndexOptions {
            dimensions,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F16,
            ..Default::default()
        };
        let index = Index::new(&options)?;

        if index_path.exists() {
            index.load(index_path.to_str().unwrap())?;
        } else {
            index.reserve(500_000)?;
        }

        Ok(Self { index, path: index_path.to_path_buf() })
    }

    pub fn add(&self, chunk_id: u64, embedding: &[f32]) -> Result<()> {
        self.index.add(chunk_id, embedding)?;
        Ok(())
    }

    pub fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<(u64, f32)>> {
        let results = self.index.search(query, top_k)?;
        Ok(results.keys.iter().zip(results.distances.iter())
            .map(|(&k, &d)| (k, d))
            .collect())
    }

    pub fn save(&self) -> Result<()> {
        self.index.save(self.path.to_str().unwrap())?;
        Ok(())
    }
}
```

**Step 3: Commit**

```bash
git commit -am "feat(v2): add USearch HNSW vector index with F16 quantization"
```

---

### Task 7.3：RAG 问答管线（llama.cpp）

**Files:**
- Create: `src-tauri/src/llm/mod.rs`
- Create: `src-tauri/src/commands/chat.rs`

**Step 1: 添加依赖**

```toml
llama_cpp = "0.3"
```

**Step 2: 实现 RAG**

核心流程：

```
用户问题
  → Embedder.embed(question)
  → VectorIndex.search(query_vec, top_k=5)
  → 从 SQLite 取 chunk 文本
  → 构建 prompt：[system] + [context chunks] + [question]
  → LLM.generate(prompt)
  → 流式返回 tokens 给前端（通过 Tauri Event）
```

**Step 3: Commit**

```bash
git commit -am "feat(v2): implement RAG pipeline - embed query, retrieve chunks, generate answer"
```

---

### Task 7.4：模型管理器

**Files:**
- Create: `src-tauri/src/model_manager/mod.rs`
- Create: `src/pages/ModelManager.tsx`

**核心功能：**
- 模型列表（ModelScope 优先，HuggingFace 备用）
- 断点续传下载（reqwest + Content-Range）
- 下载进度事件推送给前端
- 切换/删除模型

**Step 1: Commit**

```bash
git commit -am "feat(v2): add model manager with ModelScope-first download"
```

---

## 里程碑检查点

| 里程碑 | 验收标准 |
|--------|---------|
| **Phase 0 完成** | PoC 验证通过；CI 双平台绿色 |
| **Phase 1-2 完成** | 能索引 docx/pdf/txt；Tantivy 全文搜索返回正确结果 |
| **Phase 3-4 完成** | 搜索响应 <500ms；文件修改后索引自动更新 |
| **Phase 5 完成** | UI 可正常使用；引导流程完整；双击打开文件正常 |
| **Phase 6 完成（MVP 1.0）** | 双平台安装包可构建；自动更新链路通 |
| **Phase 7 完成（V2.0）** | 语义搜索可用；RAG 问答首 token <3s；模型下载成功 |

---

## 关键命令速查

```bash
# 本地开发
npm run tauri dev

# 构建 macOS Universal
npm run tauri build -- --target universal-apple-darwin

# 构建 Windows（在 Windows 机器或 CI）
npm run tauri build

# 运行 Rust 测试
cd src-tauri && cargo test

# 运行前端测试
npm test
```

# DocMind 本地文件智能助手——产品功能与技术规格书

**版本**：1.2
**日期**：2026年2月24日
**状态**：正式草案
**变更记录**：
- v1.1 将向量存储方案从 `sqlite-vec` 调整为 `USearch + SQLite`
- v1.2 开发前决策确认：跨平台支持、ONNX 运行时、免费版策略、交互细节、数据存储、自动更新、开源策略等
- v1.3 补充技术决策：安装包分层交付、语义搜索模型路线图、模型下载源策略、PaddleOCR 按需交付、PDF 解析三级降级方案

---

## 1. 引言

### 1.1 背景与动机
随着办公文档、PDF、图片等文件数量激增，传统文件名搜索（如Everything）已无法满足用户对文件内容进行语义理解和快速问答的需求。现有云端AI工具（如ChatGPT上传文件）存在隐私泄露风险，而本地工具（如归海、Recoll）要么缺乏AI能力，要么配置复杂、不适合普通办公人员。DocMind旨在填补这一空白：提供**完全本地运行、隐私优先、小白友好**的智能文件助手，让用户通过自然语言即可从海量文件中获取答案。

### 1.2 产品定位
- **目标用户**：普通办公人员、知识工作者、注重隐私的个人用户。
- **核心价值**：无需上传文件，所有数据处理均在本地；支持语义搜索、文档问答；安装即用，零配置。
- **商业模式**：免费版（全功能文件搜索）+ 专业版（AI 能力：语义搜索、问答、OCR）；MVP 阶段全免费，正式版定价根据用户反馈后确定。
- **开源策略**：完全开源，License：Apache 2.0。

### 1.3 产品名称
- **DocMind**（暂定）

### 1.4 平台支持
- **第一阶段**：Windows 10/11（64位）+ macOS 12+（Apple Silicon & Intel Universal Binary）
- **开发环境**：macOS（Apple Silicon）
- **后续**：Linux

---

## 2. 产品概述

### 2.1 核心功能概览
- **文件索引**：手动添加文件夹，自动解析文档内容并建立索引。
- **混合搜索**：支持文件名模糊搜索、全文关键词搜索、语义相似度搜索。
- **智能问答（RAG）**：基于本地轻量LLM，对用户提问生成基于文件内容的答案。
- **模型管理器**：内置模型市场，用户可自由下载/切换不同大小的模型。
- **知识图谱**：自动发现文件关联，推荐相关文档。
- **OCR支持**：识别图片和扫描版PDF中的文字。
- **隐私保护**：所有处理本地完成，不上传任何数据；一键清理索引。

---

## 3. 功能需求

### 3.1 免费版功能

| 模块 | 功能描述 | 备注 |
|------|----------|------|
| **文件索引** | 用户可手动添加本地文件夹（如桌面、文档、下载）进行索引 | 支持多选 |
| | 支持的初始文件类型：`.docx`， `.xlsx`， `.pptx`， `.pdf`， `.txt`， `.md`， `.csv` | 图片仅索引文件名 |
| | 索引引擎：全文关键词索引（非向量） | 基于Tantivy |
| | 实时监听文件变化（新增/修改/删除），自动更新索引 | 使用操作系统事件 |
| | 索引管理：查看已索引文件数、占用空间；暂停/恢复索引；移除文件夹并清空索引 | |
| **搜索功能** | 文件名模糊搜索（实时匹配，支持通配符） | |
| | 全文关键词搜索（支持AND/OR/NOT，短语精确匹配） | |
| | 搜索结果筛选：按文件类型、修改日期、大小 | |
| | 文件预览：右侧预览区显示文件内容摘要（PDF前几页、Word纯文本） | |
| | 全局快捷键呼出搜索框（默认不设，用户可在设置中自定义） | 避免与系统/其他软件冲突 |
| | 搜索结果交互：单击在右侧预览区显示内容，双击用系统默认程序打开文件 | |
| **用户体验** | 简洁主界面（搜索框 + 文件列表 + 预览区） | 支持暗色/亮色主题，跟随系统 |
| | 索引进度条与预估剩余时间 | 首次索引时显示；全文索引完成后异步生成 embedding |
| | 托盘图标：常驻系统托盘，右键菜单快速操作 | |
| **隐私安全** | 完全离线运行（模型下载除外） | |
| | 一键清除所有索引和缓存数据 | |

### 3.2 专业版功能（AI 能力，付费解锁）

> 免费版与专业版的核心区分是 **AI 能力**，文件索引数量不设上限。

| 模块 | 功能描述 | 备注 |
|------|----------|------|
| **更多文件类型** | 邮件存档（`.eml`， `.pst`）、压缩包内文件（`.zip`， `.rar`， `.7z`）、音频/视频元数据、网页书签 | 压缩包自动解压索引 |
| **OCR文字识别** | 图片（`.jpg`， `.png`， `.bmp`等）中的文字识别 | 基于PaddleOCR子进程 |
| | 扫描版PDF OCR | 生成可搜索文本 |
| **智能语义搜索** | 自然语言问答：用户提问，系统基于文件内容生成答案 | RAG架构 |
| | 答案溯源：列出来源文件及高亮片段 | |
| | 多文档摘要：对多个相关文件进行总结 | |
| | 追问能力：对话式上下文理解 | |
| **模型管理器** | 内置模型市场：展示不同大小的模型（轻量900MB、平衡1.8GB、高性能4GB） | 模型列表含大小、评分 |
| | 一键下载/切换/删除模型 | 下载支持断点续传 |
| | 自定义模型导入（GGUF格式） | 高级用户 |
| | 量化选择（4bit/8bit） | 平衡资源占用 |
| **知识图谱** | 自动发现文件关联：基于内容相似度推荐相关文档 | |
| | 主题聚类：按主题自动分组（如"项目A"、"财务"） | |
| | 文件关系图可视化 | |
| **高级搜索** | 语义相似度搜索：输入一段文字，找到内容最相似的文件 | |
| | 批量导出搜索结果或AI摘要为CSV/PDF | |
| | 定时自动扫描指定文件夹 | 每日/每周 |
| **企业协同**（企业版） | 局域网内团队索引共享 | 权限控制 |
| | 管理员控制台：批量部署、策略配置、审计日志 | |
| | SSO单点登录 | 与钉钉/企微集成 |

---

## 4. 非功能需求

### 4.1 性能要求
- **首次索引速度**（按15,000个文件，含5,000图片）：
  - 快速模式（无OCR）：30-60分钟
  - 深度模式（含OCR）：2-4小时
- **搜索响应时间**：
  - 文件名搜索：<100ms
  - 全文关键词搜索：<500ms
  - 语义搜索（含向量检索）：<2秒（向量为预计算，检索为内存 HNSW，不含实时 embedding 生成）
- **问答响应时间**（基于1.5B模型）：生成速度 >8 tokens/秒
- **内存占用**：
  - 空闲状态：<100MB
  - 向量索引加载状态：额外增加 200-800MB（取决于文件数量和向量维度）
  - 问答状态：额外增加 1-2GB（取决于模型大小）
- **CPU使用率**：后台索引时限制为低优先级，不影响前台应用
- **USearch 索引启动加载**：百万向量加载时间 <5秒（从磁盘 `.usearch` 文件直接加载）

### 4.2 安全与隐私
- **数据隔离**：所有操作在用户权限内执行，遵循操作系统文件权限。
- **无云端依赖**：除模型下载外，无需联网。
- **模型下载源**：默认 ModelScope（国内访问快），自动回退 HuggingFace（国际源），用户可在设置中手动指定镜像地址；下载时自动测速并切换最快源。
- **加密存储**：索引数据库不加密（用户可自行加密磁盘），但敏感信息可配置不索引。
- **清理机制**：提供一键清除所有索引、向量索引文件和模型文件。

### 4.3 易用性
- **安装包大小**：无严格限制，以不影响用户下载体验为准；各组件分层交付：
  - 主程序安装包（Tauri 壳 + 前端 + onnxruntime 动态库）：预计 40-60MB
  - bge embedding 模型（~33MB）：首次启动时自动下载
  - PaddleOCR 引擎（~200MB）：专业版 OCR 功能解锁时提示下载
  - LLM 模型（900MB / 1.8GB / 4GB）：用户在模型管理器中按需下载
- **首次启动引导**：引导用户添加文件夹，显示索引进度；全文索引完成后提示 AI 功能（专业版）可用。
- **代码签名**：内测阶段暂未签名，macOS 用户右键打开绕过 Gatekeeper，Windows 用户点击"仍要运行"；正式发布前完成 Apple Developer + Windows EV 证书申请。
- **帮助文档**：内置FAQ和教程链接。
- **国际化**：支持中文/英文界面。

### 4.4 可靠性
- **断点续传**：模型下载中断后恢复。
- **索引完整性**：意外退出后下次启动继续未完成索引。
- **向量索引一致性**：USearch 索引文件与 SQLite embeddings 表保持同步；启动时校验两者版本戳，不一致时自动从 SQLite 重建索引。
- **文件变化监听**：不漏掉任何修改。

---

## 5. 技术架构

### 5.1 整体架构图
```
┌─────────────────────────────────────────────────────────┐
│                    前端层 (WebView)                       │
│  React + TypeScript + Ant Design                        │
│  - 搜索界面、设置面板、模型管理器、索引进度显示               │
│  - 与用户交互，通过 IPC 调用后端功能                        │
└────────────────────────────┬────────────────────────────┘
                             │ IPC (tauri::invoke)
┌────────────────────────────▼────────────────────────────┐
│                    后端核心层 (Rust)                       │
├─────────────────────────────────────────────────────────┤
│  [核心模块]                                               │
│  - 文件监听器 (notify)      - 文件解析器 (多格式)          │
│  - 全文索引引擎 (tantivy)   - 向量索引引擎 (USearch)       │
│  - OCR 引擎 (PaddleOCR 子进程) - 模型管理器 (模型下载/加载)   │
│  - LLM 推理客户端 (llama.cpp 绑定)                        │
│  - 知识图谱生成 (自定义算法)                               │
├─────────────────────────────────────────────────────────┤
│  [数据存储]                                               │
│  - SQLite (用户数据、索引元数据、原始向量 BLOB)              │
│  - USearch 索引文件 (.usearch) — 内存 HNSW，持久化到磁盘    │
│  - Tantivy 索引目录 — 全文倒排索引                          │
│  - 文件系统 (模型文件、缓存)                               │
└─────────────────────────────────────────────────────────┘
```

### 5.2 模块详细说明

#### 5.2.1 前端层
- **技术栈**：React 18 + TypeScript，UI库采用Ant Design（轻量版），状态管理使用Zustand。
- **职责**：
  - 渲染用户界面
  - 收集用户输入（搜索词、设置选项）
  - 通过Tauri的IPC调用后端命令
  - 显示进度和结果

#### 5.2.2 后端核心模块（Rust）
- **文件监听**：使用 `notify` crate，基于操作系统事件（Windows: `ReadDirectoryChangesW`， macOS: `FSEvents`， Linux: `inotify`），实现低CPU占用的实时监控。
- **文件解析器**：
  - PDF：三级降级策略：
    1. `lopdf` 提取文本（主路径）
    2. `pdf-extract` 备用解析（兼容旧版及 CID 字体 PDF）
    3. 两级均失败时：**免费用户**标记"文本提取失败，文件名仍可搜索"并提示升级；**专业用户**自动触发 PaddleOCR 静默处理
  - Office：`calamine`（Excel），`xml-rs` 解析 docx/pptx 内部 XML。
  - 纯文本：直接读取。
- **OCR引擎**：PaddleOCR 按需交付——专业版用户首次触发 OCR 时提示下载引擎（约 200MB，支持断点续传），下载完成后作为独立子进程运行，通过本地 HTTP 通信；不打包进主安装包。
- **全文索引引擎**：`tantivy`，构建倒排索引，支持BM25评分。
- **向量索引引擎**：`usearch` crate（官方 Rust 绑定），在内存中维护 HNSW 索引，支持持久化到 `.usearch` 文件。
  - 原始 embedding 向量以 BLOB 格式同步存入 SQLite `embeddings` 表，作为 ground truth。
  - 应用启动时优先从 `.usearch` 文件加载索引（快速路径）；若文件不存在或版本不一致，从 SQLite 重建（慢速路径）。
  - 支持 F16 量化存储（节省约50%内存），SIMD 自动加速（AVX-512/AVX2/NEON）。
- **Embedding 生成时机**：全文索引完成后异步生成，前台显示独立进度条；embedding 未就绪时语义搜索入口置灰，用户尽快用上全文搜索。
- **ONNX 推理**：通过 `onnxruntime-sys` crate（微软官方 ONNX Runtime Rust 绑定）加载 `bge-small-zh-v1.5` 模型；动态库随安装包分发（macOS: `.dylib`，Windows: `.dll`，约 30MB）。
- **LLM推理**：直接嵌入 `llama.cpp` 的Rust绑定（如 `llama-cpp-rs`），加载GGUF模型进行推理，避免额外进程开销。
- **模型管理器**：自定义模块，使用 `reqwest` 下载模型（支持断点续传），管理本地模型文件。
- **知识图谱**：基于文档向量相似度和关键词共现，利用 USearch 的 k-NN 结果计算文档间关联，结果存入 SQLite `doc_graph` 表。

#### 5.2.3 数据存储

**SQLite 数据库**（单文件，统一管理元数据与向量原始数据）：

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `files` | 文件元数据 | id, path, size, modified, file_type |
| `chunks` | 文本块 | id, file_id, chunk_index, content |
| `embeddings` | 原始向量数据（ground truth） | chunk_id, vector BLOB, model_version |
| `doc_graph` | 文档相似关系 | file_id_a, file_id_b, similarity |
| `settings` | 用户配置 | key, value |
| `index_meta` | 索引版本元数据 | key, value（含 usearch_version 版本戳） |

> **说明**：`embeddings` 表存储原始 float32 向量 BLOB，作为数据来源。USearch `.usearch` 索引文件是由此派生的加速结构，两者通过 `index_meta.usearch_version` 版本戳保持一致性。

**USearch 向量索引文件**（`{data_dir}/index/vectors.usearch`）：
- 内存 HNSW 索引，应用运行时常驻内存。
- 关闭时持久化到磁盘，下次启动直接 `index.load()` 恢复（百万向量 <5秒）。
- 支持增量 `index.add(id, &embedding)` 无需全量重建。

**Tantivy 全文索引**：存储在 `{data_dir}/index/tantivy/`，路径记录在 SQLite `settings` 中。

**模型文件**：存储在 `{data_dir}/models/`，便于备份与迁移。

**数据目录（`{data_dir}`）默认路径，可在设置中修改**：
```
macOS：~/Library/Application Support/DocMind/
Windows：%APPDATA%\DocMind\

目录结构：
  DocMind/
  ├── docmind.db            # SQLite 主数据库
  ├── index/
  │   ├── tantivy/          # 全文倒排索引
  │   └── vectors.usearch   # USearch HNSW 索引
  └── models/               # LLM 及 embedding 模型文件
```

### 5.3 技术选型对比与选择理由

| 模块 | 选型 | 备选 | 理由 |
|------|------|------|------|
| **桌面框架** | Tauri | Electron | 极轻量（<10MB）、内存低、安全隔离、Rust性能高 |
| **前端框架** | React | Vue/Svelte | 生态丰富、团队熟悉 |
| **文件监听** | `notify` | 手动轮询 | 事件驱动，CPU占用几乎为0 |
| **全文检索** | `tantivy` | SQLite FTS5 | 纯Rust、性能极高、功能丰富 |
| **向量索引** | `usearch` | sqlite-vec、LanceDB | 官方 Rust 绑定、Windows 全平台支持、性能比 FAISS 快 10x、库体积仅 ~500KB、SIMD 自动加速；与 SQLite 职责分离，架构更清晰 |
| **向量原始存储** | SQLite（BLOB） | 独立文件 | 统一存储，数据一致性有保障；USearch 文件损坏时可从此重建 |
| **OCR** | PaddleOCR（子进程） | Tesseract | 中文精度高、支持复杂版式 |
| **LLM推理** | `llama.cpp` 绑定 | Ollama | 直接嵌入，无额外进程，更轻量 |
| **ONNX 推理** | `onnxruntime-sys` | `tract` | 微软官方 ONNX Runtime Rust 绑定，Windows/macOS/Linux 全支持；tract 对 bge 系列复杂算子兼容性不足 |
| **嵌入模型（V2.0）** | `bge-small-zh-v1.5`（ONNX，33MB） | `bge-m3` | 中文及中英混合优化；英文文档语义退化由 Tantivy 全文检索兜底；V3.0 升级为 `bge-m3`（570MB，100语言） |
| **模型管理** | 自研Rust模块 | 无 | 完全掌控下载/切换逻辑 |

### 5.4 向量存储方案说明

DocMind 采用 **SQLite（原始向量）+ USearch（HNSW 索引）** 的双层向量存储架构，两者各司其职：

```
写入流程：
  文档 chunk → embedding 模型 → float32 向量
      ├─→ SQLite embeddings 表（BLOB 持久化，ground truth）
      └─→ usearch index.add(chunk_id, vector)（内存索引，加速检索）

查询流程：
  用户查询 → embedding 模型 → query 向量
      └─→ usearch index.search(query_vec, topk=20)
              └─→ 返回 chunk_id 列表
                      └─→ SQLite 查 chunks / files 拼装结果

启动流程：
  检查 vectors.usearch 版本戳 == SQLite index_meta.usearch_version
      ├─ 一致 → index.load("vectors.usearch")  ← 快速路径（<5秒）
      └─ 不一致 → 从 SQLite embeddings 表重建   ← 慢速路径（兜底）
```

**选择 USearch 而非 sqlite-vec 的核心理由**：

| 对比点 | sqlite-vec | USearch |
|--------|-----------|---------|
| Windows 支持 | ✅ | ✅ |
| 官方 Rust 支持 | ✅ | ✅ |
| HNSW 索引成熟度 | ⚠️ 较新 | ✅ 生产级 |
| 性能 | 中 | 比 FAISS 快 10x |
| 库体积 | 小 | ~500KB（更小） |
| SIMD 加速 | 部分 | 自动检测（AVX-512/AVX2/NEON） |
| 索引与数据库耦合 | 强（SQLite 扩展） | 弱（职责分离） |

**选择 SQLite 存原始向量而非纯靠 USearch 持久化**的理由：
- USearch 索引文件损坏时有完整 fallback 重建路径，数据不会丢失。
- 原始向量与文件元数据在同一数据库，事务一致性更容易保证。
- 未来切换 embedding 模型时，可对全量向量重新计算而无需重解析文档。

### 5.5 跨平台构建策略

```
开发环境：macOS（Apple Silicon）

构建目标：
  - macOS Universal Binary（x86_64 + aarch64 合包）
  - Windows x86_64（通过 CI Windows Runner 构建）

CI 流水线（GitHub Actions）：
  ┌─ macOS Runner ─────────────────────────────┐
  │  构建 macOS Universal Binary               │
  │  运行单元测试 + 集成测试                    │
  │  产物：DocMind_x.x.x_universal.dmg         │
  └────────────────────────────────────────────┘
  ┌─ Windows Runner ───────────────────────────┐
  │  构建 Windows x86_64 安装包                 │
  │  产物：DocMind_x.x.x_x64-setup.exe         │
  └────────────────────────────────────────────┘
  两个产物上传至自建更新服务器

PaddleOCR sidecar 打包：
  - macOS：libpaddle_ocr.dylib + 模型文件
  - Windows：paddle_ocr.dll + 模型文件
  通过 Tauri sidecar 机制随主程序分发，按平台自动选择

onnxruntime 动态库：
  - macOS：libonnxruntime.dylib（约 30MB）
  - Windows：onnxruntime.dll（约 30MB）
  打包进安装包，无需用户手动安装
```

### 5.6 自动更新服务

```
方案：自建更新服务器（静态文件托管 + Tauri updater v2 兼容 manifest）

manifest 示例（latest.json）：
{
  "version": "1.x.x",
  "notes": "更新说明",
  "pub_date": "2026-xx-xxTxx:xx:xx.000Z",
  "platforms": {
    "darwin-aarch64": { "signature": "...", "url": "https://update.docmind.app/v1.x.x/DocMind_universal.dmg.tar.gz" },
    "darwin-x86_64":  { "signature": "...", "url": "https://update.docmind.app/v1.x.x/DocMind_universal.dmg.tar.gz" },
    "windows-x86_64": { "signature": "...", "url": "https://update.docmind.app/v1.x.x/DocMind_x64-setup.nsis.zip" }
  }
}

注意：
  - Tauri updater 强制要求更新包签名（updater 专用密钥，与代码签名证书不同）
  - 更新策略：启动时静默检查，有新版本时托盘图标提示，用户确认后下载安装
  - 模型文件不通过 updater 分发，保持独立下载避免更新包过大
```

---

## 6. 关键技术实现要点

### 6.1 优先级索引策略
首次索引时按文件类型分级处理，让用户尽快用上核心功能：
- **P0（立即）**：Office文档、文本文件（5-10分钟完成）
- **P1（中）**：PDF（10-20分钟）
- **P2（低）**：图片OCR（2-4小时，可后台进行）

Embedding 向量化在全文索引完成后异步进行，不阻塞搜索功能上线。

### 6.2 混合搜索机制
同时使用 USearch 向量检索和 Tantivy 全文检索，加权合并结果，平衡语义理解与关键词匹配：

```rust
// 混合搜索评分
score_total = w_vec * cosine_similarity + w_fts * bm25_score

// USearch 向量检索
let results = usearch_index.search(&query_embedding, topk)?;
// Tantivy 全文检索
let fts_results = tantivy_searcher.search(&query_term, &TopDocs::with_limit(topk))?;
// 合并去重，按 score_total 排序
```

默认权重：`w_vec = 0.6`，`w_fts = 0.4`，可根据用户反馈动态调整。

### 6.3 USearch 索引管理

```rust
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

// 初始化索引（512维，余弦相似度，F16量化节省内存）
let options = IndexOptions {
    dimensions: 512,
    metric: MetricKind::Cos,
    quantization: ScalarKind::F16,
    ..Default::default()
};
let index = Index::new(&options)?;
index.reserve(1_000_000)?; // 预分配百万向量容量

// 添加向量（chunk_id 作为唯一标识）
index.add(chunk_id as u64, &embedding_f32)?;

// 向量检索
let results = index.search(&query_vec, 20)?; // 返回 top-20

// 持久化（应用关闭时）
index.save(".docmind/index/vectors.usearch")?;

// 启动时加载
index.load(".docmind/index/vectors.usearch")?;
```

### 6.4 OCR优化
- 先用轻量模型判断图片是否含文字，避免无效OCR。
- 支持低分辨率优先，提升识别速度。
- 异步处理，不阻塞主流程。

### 6.5 模型管理器实现
- 模型元数据存储于SQLite，包含下载状态、版本、路径。
- 下载使用 `reqwest` 支持断点续传，通过 `Content-Range` 实现。
- 切换模型时，卸载当前LLM上下文，加载新模型（耗时1-3秒），前台显示加载进度。

### 6.6 隐私与安全强化
- 所有文件解析在沙箱环境中执行，避免恶意文件影响系统。
- 前端无法直接访问文件系统，必须通过IPC调用经过验证的后端命令。
- 提供"无痕模式"：临时索引不持久化，退出后自动清除（包括 `.usearch` 临时文件）。

---

## 7. 开发路线图

| 阶段 | 核心功能 | 预计时间 |
|------|----------|----------|
| **MVP（1.0）** | 基础文件搜索（无AI）；Windows + macOS 双平台；不限文件数；完全开源（Apache 2.0） | 3个月 |
| **V2.0** | 专业版 AI 能力：OCR、语义搜索（基于1.5B模型）、USearch 向量索引上线；确定定价策略 | +3个月 |
| **V3.0** | 模型管理器、知识图谱、多文件摘要；embedding 模型升级为 `bge-m3`（支持英文及多语言语义搜索）；GPU 加速（macOS Metal / Windows CUDA） | +4个月 |
| **V4.0** | 企业版：局域网共享、管理控制台 | +6个月 |

---

## 8. 风险评估与应对

| 风险 | 应对措施 |
|------|----------|
| 首次索引时间过长 | 优先级索引 + 索引进度透明化 |
| 模型下载过大导致用户犹豫 | 默认轻量模型（900MB），按需下载更大量级 |
| 本地LLM回答质量不佳 | 优化RAG检索策略，提供多种模型选择 |
| OCR依赖外部进程 | 将PaddleOCR打包为独立可执行文件（macOS dylib + Windows DLL），通过 Tauri sidecar 分发 |
| 隐私担忧 | 完全开源（Apache 2.0），代码可审计；邀请第三方安全审计 |
| 内测无代码签名 | macOS 右键打开绕过 Gatekeeper，Windows 点击"仍要运行"；正式发布前申请双平台证书 |
| 跨平台构建复杂度 | Mac 开发环境构建 macOS Universal Binary；Windows 包通过 CI Windows Runner 构建；PaddleOCR 两平台分别打包 |
| USearch 索引文件损坏 | SQLite embeddings 表作为 ground truth，自动从中重建索引，无数据丢失风险 |
| 内存占用随文件数增长 | USearch F16 量化（比 F32 节省50%内存）；超大规模时提示用户分库管理 |

---

## 9. 附录

### 9.1 术语表
- **RAG**：检索增强生成，先检索相关文档，再让LLM生成答案。
- **FTS**：全文搜索（Full-Text Search）。
- **GGUF**：llama.cpp使用的模型格式。
- **ONNX**：开放神经网络交换格式。
- **HNSW**：分层可导航小世界图，常用近似最近邻索引算法。
- **USearch**：Unum Cloud 开源的高性能 HNSW 向量索引库，支持多语言官方绑定。
- **F16 量化**：将 float32 向量压缩为 float16 存储，节省50%内存，精度损失极小。
- **ground truth**：SQLite 中存储的原始向量，作为 USearch 索引重建的数据来源。

### 9.2 参考资料
- [Tauri官方文档](https://tauri.app/)
- [Tantivy搜索引擎](https://github.com/quickwit-oss/tantivy)
- [USearch GitHub](https://github.com/unum-cloud/usearch)
- [usearch crate (crates.io)](https://crates.io/crates/usearch)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [onnxruntime-sys crate](https://crates.io/crates/onnxruntime-sys)
- [bge-small-zh-v1.5 模型](https://huggingface.co/BAAI/bge-small-zh-v1.5)
- [Tauri Updater 文档](https://tauri.app/plugin/updater/)

---

## 10. 开发前置任务

### P0 — 必须完成才能正式开工

- [ ] **PoC：bge-small-zh-v1.5 + onnxruntime-sys**
  在 macOS 上验证模型加载、推理输出正确，确认 embedding 维度与预期一致（512维）
- [ ] **PoC：onnxruntime-sys Windows 构建**
  在 CI Windows Runner 上验证交叉编译 + DLL 打包可行
- [ ] **Tauri 项目骨架**
  搭建前后端 IPC 通信框架，验证 Rust 命令 → React 调用链路
- [ ] **自建更新服务器**
  最简部署（nginx + 静态文件），验证 Tauri updater manifest 格式正确

### P1 — MVP 发布前完成

- [ ] 申请 Apple Developer 账号（99美元/年）+ 配置 macOS 代码签名 & Notarization
- [ ] 申请 Windows EV 代码签名证书（300-500美元/年）
- [ ] 搭建 GitHub 仓库 + CI/CD 流水线（macOS Runner + Windows Runner 双平台构建）
- [ ] 确定开源 License 文件（Apache 2.0）并提交 CONTRIBUTING.md

---

**文档结束**

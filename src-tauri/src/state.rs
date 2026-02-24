use crate::embedder::Embedder;
use crate::indexer::tantivy_index::FtsIndex;
use crate::vector_index::VectorIndex;
use rusqlite::Connection;
use std::{path::PathBuf, sync::Mutex};

/// 全局应用状态。
///
/// **锁获取顺序约定**：如需同时持有多个锁，必须按以下顺序获取，否则可能死锁：
/// 1. `db`（SQLite 连接）
/// 2. `fts`（Tantivy 全文索引）
/// 3. `vector_index`（USearch 向量索引）
/// 4. `embedder`（ONNX 推理 Session）
pub struct AppState {
    pub db: Mutex<Connection>,
    pub fts: Mutex<FtsIndex>,
    pub vector_index: Mutex<Option<VectorIndex>>,
    pub embedder: Mutex<Option<Embedder>>,
    pub model_dir: PathBuf,
}

use crate::indexer::tantivy_index::FtsIndex;
use rusqlite::Connection;
use std::sync::Mutex;

/// 全局应用状态。
///
/// **锁获取顺序约定**：如需同时持有多个锁，必须按以下顺序获取，否则可能死锁：
/// 1. `db`（SQLite 连接）
/// 2. `fts`（Tantivy 全文索引）
pub struct AppState {
    pub db: Mutex<Connection>,
    pub fts: Mutex<FtsIndex>,
}

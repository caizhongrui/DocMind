use crate::indexer::tantivy_index::FtsIndex;
use rusqlite::Connection;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub fts: Mutex<FtsIndex>,
}

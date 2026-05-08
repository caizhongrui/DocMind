//! SQLite access for the server.
//!
//! We use blocking rusqlite wrapped in `tokio::task::spawn_blocking` for queries.
//! Connection is wrapped in `Arc<Mutex<Connection>>` for simplicity — for the
//! traffic volume this server handles (low hundreds of writes/day even at
//! launch) a single connection plus a mutex is more than enough.

pub mod migrations;
pub mod models;

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

pub type DbPool = Arc<Mutex<Connection>>;

pub async fn open_and_migrate(path: &Path) -> anyhow::Result<DbPool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrations::apply(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

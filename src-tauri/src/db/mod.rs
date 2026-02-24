pub mod migrations;

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

pub fn init(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
    )?;
    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    for (i, migration) in migrations::MIGRATIONS.iter().enumerate() {
        if (i as i64) >= version {
            conn.execute_batch(migration)?;
            conn.execute(
                "INSERT INTO schema_version VALUES (?1)",
                rusqlite::params![i as i64 + 1],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_db_init_creates_tables() {
        let dir = tempdir().unwrap();
        let conn = init(&dir.path().join("test.db")).unwrap();

        // 验证表存在
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('files','chunks','embeddings','settings','watched_folders','index_meta')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 6, "应有 6 张表");
    }

    #[test]
    fn test_migrations_idempotent() {
        let dir = tempdir().unwrap();
        // 运行两次，不应出错
        let _ = init(&dir.path().join("test.db")).unwrap();
        let _ = init(&dir.path().join("test.db")).unwrap();
    }
}

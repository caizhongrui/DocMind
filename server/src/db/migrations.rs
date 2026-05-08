//! Idempotent migrations. Each call to [`apply`] brings the schema up to the
//! latest version. Versions are tracked in a `_meta` table.

use rusqlite::Connection;

pub fn apply(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

        CREATE TABLE IF NOT EXISTS licenses (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            key             TEXT UNIQUE NOT NULL,
            plan            TEXT NOT NULL,
            order_id        TEXT,
            buyer_email     TEXT,
            bound_fingerprint  TEXT,
            bound_at        TEXT,
            machine_label   TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            note            TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(buyer_email);
        CREATE INDEX IF NOT EXISTS idx_licenses_order ON licenses(order_id);

        CREATE TABLE IF NOT EXISTS orders (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            payjs_order_id  TEXT UNIQUE,
            out_trade_no    TEXT UNIQUE NOT NULL,
            amount          INTEGER NOT NULL,
            paid_at         TEXT,
            payment_type    TEXT,
            license_key     TEXT,
            raw_payload     TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS downloads (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts              TEXT NOT NULL DEFAULT (datetime('now')),
            version         TEXT NOT NULL,
            platform        TEXT NOT NULL,
            edition         TEXT NOT NULL,
            license_key     TEXT,
            ip              TEXT NOT NULL,
            user_agent      TEXT,
            bytes_served    INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_downloads_ts ON downloads(ts);
        CREATE INDEX IF NOT EXISTS idx_downloads_license ON downloads(license_key);

        CREATE TABLE IF NOT EXISTS releases (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            version         TEXT NOT NULL,
            platform        TEXT NOT NULL,
            edition         TEXT NOT NULL,
            file_path       TEXT NOT NULL,
            sha256          TEXT NOT NULL,
            size            INTEGER NOT NULL,
            signature       TEXT NOT NULL,
            notes           TEXT,
            published_at    TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(version, platform, edition)
        );

        CREATE TABLE IF NOT EXISTS admin_sessions (
            token       TEXT PRIMARY KEY,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at  TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

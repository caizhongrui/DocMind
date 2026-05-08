//! Monthly AI usage quota for Free tier.
//!
//! The quota is enforced *only* for Free users; Trial and Pro have unlimited
//! AI calls. Counters are stored in the same SQLite database used by the rest
//! of the app, in a single-row table indexed by year-month string.

use anyhow::Result;
use chrono::{Datelike, Utc};
use rusqlite::{params, Connection};

pub const FREE_MONTHLY_LIMIT: u32 = 30;

/// Ensure the `ai_quota` table exists. Cheap idempotent migration.
pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_quota (
            period TEXT PRIMARY KEY, -- 'YYYY-MM'
            used   INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    Ok(())
}

fn current_period() -> String {
    let now = Utc::now();
    format!("{:04}-{:02}", now.year(), now.month())
}

pub fn used(conn: &Connection) -> u32 {
    let _ = ensure_table(conn);
    let period = current_period();
    conn.query_row(
        "SELECT used FROM ai_quota WHERE period = ?1",
        params![period],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v.max(0) as u32)
    .unwrap_or(0)
}

pub fn remaining(conn: &Connection) -> u32 {
    FREE_MONTHLY_LIMIT.saturating_sub(used(conn))
}

/// Returns `true` if a call should be allowed and the counter has been
/// incremented atomically. Returns `false` once the monthly cap is reached.
pub fn try_consume(conn: &Connection) -> Result<bool> {
    ensure_table(conn)?;
    let period = current_period();
    let tx = conn.unchecked_transaction()?;
    let used: i64 = tx
        .query_row(
            "SELECT used FROM ai_quota WHERE period = ?1",
            params![period],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if (used as u32) >= FREE_MONTHLY_LIMIT {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO ai_quota (period, used) VALUES (?1, 1)
            ON CONFLICT(period) DO UPDATE SET used = used + 1",
        params![period],
    )?;
    tx.commit()?;
    Ok(true)
}

#[derive(Debug, serde::Serialize)]
pub struct QuotaSnapshot {
    pub period: String,
    pub used: u32,
    pub limit: u32,
    pub remaining: u32,
}

pub fn snapshot(conn: &Connection) -> QuotaSnapshot {
    let period = current_period();
    let used = used(conn);
    QuotaSnapshot {
        period,
        used,
        limit: FREE_MONTHLY_LIMIT,
        remaining: FREE_MONTHLY_LIMIT.saturating_sub(used),
    }
}

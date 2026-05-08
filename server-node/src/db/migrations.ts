/**
 * Idempotent schema migrations.
 *
 * Runs every time the server starts. CREATE TABLE IF NOT EXISTS is the
 * baseline; ALTER TABLE statements that may be repeated are guarded by
 * try/catch on "duplicate column name".
 */

import type { Database } from "better-sqlite3";

export function applyMigrations(db: Database) {
  db.exec(`
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
      claim_ticket    TEXT,
      claim_consumed_at TEXT,
      raw_payload     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_claim_ticket
        ON orders(claim_ticket) WHERE claim_ticket IS NOT NULL;

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

    -- 退款流水
    CREATE TABLE IF NOT EXISTS refunds (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      out_refund_no   TEXT UNIQUE NOT NULL,
      out_trade_no    TEXT NOT NULL,
      license_key     TEXT,
      amount          INTEGER NOT NULL,         -- 单位:分
      reason          TEXT,
      status          TEXT NOT NULL,            -- 'pending' | 'success' | 'failed' | 'closed' | 'processing'
      refund_id       TEXT,                     -- 微信退款单号(平台返回)
      raw_response    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_refunds_trade ON refunds(out_trade_no);
    CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);

    -- 门户站访问日志(每次 doc-web 请求一条)
    CREATE TABLE IF NOT EXISTS portal_access (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT NOT NULL DEFAULT (datetime('now')),
      method        TEXT NOT NULL,
      path          TEXT NOT NULL,
      status        INTEGER NOT NULL,
      ip            TEXT NOT NULL,
      user_agent    TEXT,
      referer       TEXT,
      bytes_served  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_portal_access_ts ON portal_access(ts);
    CREATE INDEX IF NOT EXISTS idx_portal_access_path ON portal_access(path);
  `);

  // Forward migrations for existing installs (post-schema additions).
  alterSafe(db, "ALTER TABLE orders ADD COLUMN claim_ticket TEXT");
  alterSafe(db, "ALTER TABLE orders ADD COLUMN claim_consumed_at TEXT");
}

function alterSafe(db: Database, sql: string) {
  try {
    db.exec(sql);
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("duplicate column name")) {
      console.warn(`[migration] ${sql} → ${msg}`);
    }
  }
}

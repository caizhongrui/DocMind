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
      bound_fingerprint TEXT,
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

    -- 试用记录(以指纹为主键,服务端是试用资格的唯一权威来源 —
    -- 客户端删除本地 license.json 不会重置试用次数)
    CREATE TABLE IF NOT EXISTS trials (
      fingerprint    TEXT PRIMARY KEY,
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at     TEXT NOT NULL,
      machine_label  TEXT,
      ip             TEXT,
      user_agent     TEXT
    );

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

    -- ── 推广大使邀请码 (v0.3.0) ────────────────────────────────────────
    --
    -- 运营手动签发给 B 站 UP 主、公众号、微信群主等推广合作伙伴。
    -- 大使私下用各种渠道宣传 → 买家在升级对话框输入码 → 后台记录归属
    -- → 运营导 Excel 离线结算返利给大使。
    --
    -- 注意:不做"返利自动到账",一切奖励叙事在 App 外、私聊里。
    -- 客户端只负责"输入码 + 校验"和"全价付款",归因纯后端事情。
    CREATE TABLE IF NOT EXISTS invite_codes (
      code             TEXT PRIMARY KEY,                 -- 'DOCMIND-AB12'
      ambassador       TEXT NOT NULL,                    -- 大使昵称/平台名
      contact          TEXT,                             -- 微信号 / 邮箱(运营结算用)
      status           TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'disabled'
      commission_cents INTEGER NOT NULL DEFAULT 0,       -- 每单分成(分,仅记账参考)
      note             TEXT,                             -- 内部备注:合作日期 / 平台 / 渠道
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at       TEXT                              -- 可选过期时间;NULL 表示永久
    );

    -- 推广订单归属:每个微信支付成功的订单 1 条
    CREATE TABLE IF NOT EXISTS invite_redemptions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      code            TEXT NOT NULL REFERENCES invite_codes(code),
      buyer_order_id  TEXT NOT NULL UNIQUE,              -- = orders.out_trade_no
      buyer_fp        TEXT,                              -- 仅记录,不参与去重
      paid_at         TEXT NOT NULL,
      paid_amount_cents INTEGER NOT NULL,                -- 实付金额(分),便于对账
      refund_at       TEXT,                              -- 退款后填,统计时排除
      settled_at      TEXT,                              -- 运营线下结算后填
      settle_note     TEXT                               -- 结算备注:红包金额 / 日期 / 凭证
    );
    CREATE INDEX IF NOT EXISTS idx_invite_redemptions_code ON invite_redemptions(code);
    CREATE INDEX IF NOT EXISTS idx_invite_redemptions_paid_at ON invite_redemptions(paid_at);
  `);

  // Forward migrations for existing installs (post-schema additions).
  alterSafe(db, "ALTER TABLE orders ADD COLUMN claim_ticket TEXT");
  alterSafe(db, "ALTER TABLE orders ADD COLUMN claim_consumed_at TEXT");
  alterSafe(db, "ALTER TABLE orders ADD COLUMN bound_fingerprint TEXT");
  // v0.3.0:在 orders 上挂推广码,webhook 标记付款成功时再写入
  // invite_redemptions 形成归因记录
  alterSafe(db, "ALTER TABLE orders ADD COLUMN invite_code TEXT");

  // v0.3.1:推广码梯度返现 —— 每个码可配多段阶梯,按订单在该码内的
  // 非退款 rank 计算实际分成。tiers_json 形如:
  //   [{"from":1,"fen":300},{"from":11,"fen":500},{"from":51,"fen":800}]
  // NULL = 不启用梯度,所有订单按 commission_cents 平价。
  alterSafe(db, "ALTER TABLE invite_codes ADD COLUMN tiers_json TEXT");
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

/**
 * Admin UI — server-rendered HTML, single-cookie session.
 *
 * Auth: a single `ADMIN_PASSWORD` from env. Login mints an opaque session
 * token persisted in `admin_sessions`. Every protected route looks up the
 * cookie at request time.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEnv } from "../app.js";
import { generateKey } from "../license/sign.js";
import { sha256Hex } from "../util.js";
import { htmlEscape, layout, standalone } from "../templates.js";

const SESSION_COOKIE = "docmind_admin_session";

export const adminRouter = new Hono<AppEnv>();

// ── Auth helpers ───────────────────────────────────────────────────────────
function requireSession(c: Context<AppEnv>): true | Response {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.redirect("/admin/login");
  const { db } = c.var.app;
  const row = db
    .prepare(
      `SELECT 1 FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')`,
    )
    .get(token);
  if (!row) return c.redirect("/admin/login");
  return true;
}

// ── Login ──────────────────────────────────────────────────────────────────
adminRouter.get("/login", (c) =>
  c.html(
    standalone(
      "登录",
      `<div class="login-box">
  <h1>DocMind Admin 登录</h1>
  <form method="POST" action="/admin/login">
    <label>用户名</label>
    <input name="username" required autocomplete="username">
    <label>密码</label>
    <input type="password" name="password" required autocomplete="current-password">
    <div style="margin-top: 20px;">
      <button class="primary" type="submit" style="width: 100%; justify-content: center;">登录</button>
    </div>
  </form>
</div>`,
    ),
  ),
);

adminRouter.post("/login", async (c) => {
  const { config, db } = c.var.app;
  const form = await c.req.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  if (
    username !== config.adminUsername ||
    sha256Hex(Buffer.from(password)) !== config.adminPasswordHash
  ) {
    return c.html(
      standalone(
        "登录失败",
        `<div class="login-box">
  <h1>DocMind Admin 登录</h1>
  <div class="alert alert-error">用户名或密码错误</div>
  <form method="POST" action="/admin/login">
    <label>用户名</label>
    <input name="username" required>
    <label>密码</label>
    <input type="password" name="password" required>
    <div style="margin-top: 20px;">
      <button class="primary" type="submit" style="width: 100%; justify-content: center;">登录</button>
    </div>
  </form>
</div>`,
      ),
      401,
    );
  }
  const token = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 7 * 86400 * 1000);
  db.prepare(
    `INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)`,
  ).run(token, expires.toISOString());
  setCookie(c, SESSION_COOKIE, token, {
    path: "/admin",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 7 * 86400,
  });
  return c.redirect("/admin");
});

adminRouter.post("/logout", (c) => {
  const { db } = c.var.app;
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    db.prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
  }
  setCookie(c, SESSION_COOKIE, "", { path: "/admin", maxAge: 0 });
  return c.redirect("/admin/login");
});

// ── Overview ───────────────────────────────────────────────────────────────
adminRouter.get("/", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;

  const totalLicenses =
    (db.prepare(`SELECT COUNT(*) AS n FROM licenses`).get() as { n: number }).n;
  const totalOrders =
    (db
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE paid_at IS NOT NULL`)
      .get() as { n: number }).n;
  const totalDownloads =
    (db.prepare(`SELECT COUNT(*) AS n FROM downloads`).get() as { n: number }).n;
  const revenueToday =
    (db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE paid_at >= date('now')`,
      )
      .get() as { n: number }).n;
  const revenueMonth =
    (db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE paid_at >= date('now', 'start of month')`,
      )
      .get() as { n: number }).n;

  const recent = db
    .prepare(
      `SELECT out_trade_no, amount, paid_at, license_key
         FROM orders WHERE paid_at IS NOT NULL
        ORDER BY paid_at DESC LIMIT 10`,
    )
    .all() as Array<{
    out_trade_no: string;
    amount: number;
    paid_at: string | null;
    license_key: string | null;
  }>;

  const rows = recent
    .map(
      (o) =>
        `<tr><td class="mono">${htmlEscape(o.out_trade_no)}</td><td class="mono">¥${(o.amount / 100).toFixed(2)}</td><td>${htmlEscape(formatDate(o.paid_at) ?? "—")}</td><td class="mono">${htmlEscape(o.license_key ?? "—")}</td></tr>`,
    )
    .join("");

  const body = `
<h1>概览</h1>
<div class="stat-grid">
  <div class="stat"><div class="stat-label">License 总数</div><div class="stat-value">${totalLicenses}</div></div>
  <div class="stat"><div class="stat-label">已支付订单</div><div class="stat-value">${totalOrders}</div></div>
  <div class="stat"><div class="stat-label">下载次数</div><div class="stat-value">${totalDownloads}</div></div>
  <div class="stat"><div class="stat-label">本月收入</div><div class="stat-value">¥${(revenueMonth / 100).toFixed(2)}</div></div>
</div>
<div class="card">
  <div class="row" style="justify-content: space-between; margin-bottom: 8px;">
    <span style="font-weight: 600;">最近订单</span>
    <span style="color: var(--text-muted); font-size: 11px;">今日收入 ¥${(revenueToday / 100).toFixed(2)}</span>
  </div>
  <table>
    <thead><tr><th>订单号</th><th>金额</th><th>支付时间</th><th>License</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
  return c.html(layout("概览", body));
});

// ── Licenses ───────────────────────────────────────────────────────────────
adminRouter.get("/licenses", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const q = c.req.query("q") ?? "";
  const pat = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT key, plan, bound_fingerprint, buyer_email, bound_at
         FROM licenses
        WHERE key LIKE ? OR COALESCE(buyer_email, '') LIKE ?
        ORDER BY created_at DESC LIMIT 200`,
    )
    .all(pat, pat) as Array<{
    key: string;
    plan: string;
    bound_fingerprint: string | null;
    buyer_email: string | null;
    bound_at: string | null;
  }>;

  const tbody = rows
    .map((l) => {
      const stateChip = l.bound_fingerprint
        ? `<span class="chip chip-primary">已激活</span>`
        : `<span class="chip">未激活</span>`;
      return `<tr>
  <td><a class="mono" href="/admin/licenses/${encodeURIComponent(l.key)}">${htmlEscape(l.key)}</a></td>
  <td>${htmlEscape(l.plan)}</td>
  <td>${stateChip}</td>
  <td>${htmlEscape(l.buyer_email ?? "—")}</td>
  <td class="mono">${htmlEscape(formatDate(l.bound_at) ?? "—")}</td>
</tr>`;
    })
    .join("");

  const body = `
<h1>License</h1>
<form method="GET" action="/admin/licenses" style="margin-bottom: 12px;">
  <input name="q" placeholder="搜索 license key 或邮箱" value="${htmlEscape(q)}" style="width: 320px;">
  <button class="primary" type="submit">搜索</button>
  <a class="btn" href="/admin/licenses/issue" style="margin-left: 8px;">手动签发</a>
</form>
<table>
  <thead><tr><th>License key</th><th>Plan</th><th>状态</th><th>邮箱</th><th>激活时间</th></tr></thead>
  <tbody>${tbody}</tbody>
</table>`;
  return c.html(layout("License", body));
});

adminRouter.get("/licenses/issue", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const body = `
<h1>手动签发 License</h1>
<div class="card">
  <p style="font-size: 13px; line-height: 1.7; color: var(--text-secondary); margin: 0 0 14px;">
    License 一经签出即与硬件指纹绑定。把客户在客户端"升级 → 离线激活"页面里看到的指纹粘贴到这里,就能直接拿到一段已签名的 token JSON 发给客户使用。<br>
    <span style="color: var(--text-muted);">指纹留空时只生成一个未绑定的 key,后续可在「License 列表 → 离线激活」中补签 token。</span>
  </p>
  <form method="POST" action="/admin/licenses/issue">
    <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono);">买家邮箱(可选,用于备注)</label>
    <input name="email" style="width: 100%; max-width: 460px; margin: 4px 0 12px;">

    <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono);">备注</label>
    <input name="note" style="width: 100%; max-width: 460px; margin: 4px 0 12px;" placeholder="例如:微信好友直转 / 退款重发 / 测试">

    <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono);">客户端硬件指纹(32 位 hex,留空则只生成 key 不签 token)</label>
    <input name="fingerprint" class="mono" placeholder="例如 71f39bea191cee7fff2c4d3f757aec98" style="width: 100%; max-width: 460px; margin: 4px 0 12px;">

    <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono);">机器标签(可选,便于识别)</label>
    <input name="machine_label" placeholder="例如:张三的 MacBook Pro" style="width: 100%; max-width: 460px; margin: 4px 0 16px;">

    <button class="primary" type="submit">生成 License Key</button>
  </form>
</div>`;
  return c.html(layout("手动签发", body));
});

adminRouter.post("/licenses/issue", async (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db, signingKey } = c.var.app;
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  const note = String(form.get("note") ?? "");
  const fingerprint = String(form.get("fingerprint") ?? "").trim().toLowerCase();
  const machineLabel = String(form.get("machine_label") ?? "");

  if (fingerprint && fingerprint.length < 16) {
    return c.text("fingerprint too short — expected 32 hex chars", 400);
  }

  const key = generateKey();
  db.prepare(
    `INSERT INTO licenses (key, plan, buyer_email, note) VALUES (?, 'lifetime', ?, ?)`,
  ).run(key, email || null, note || null);

  // No fingerprint → original behavior: just hand back the key.
  if (!fingerprint) {
    const body = `
<h1>已签发</h1>
<div class="card">
  <div class="alert alert-success">已生成新 License Key。请发给客户。</div>
  <div class="mono" style="font-size: 18px; padding: 12px; background: var(--surface-elevated); border-radius: 8px;">${htmlEscape(key)}</div>
  <div style="margin-top: 16px;">
    <a class="btn" href="/admin/licenses/${encodeURIComponent(key)}">查看详情</a>
    <a class="btn" href="/admin/licenses/issue">再签一个</a>
    <a class="btn" href="/admin/licenses/offline?key=${encodeURIComponent(key)}">补签离线 Token</a>
  </div>
</div>`;
    return c.html(layout("已签发", body));
  }

  // Fingerprint provided → bind and sign a token in one shot.
  db.prepare(
    `UPDATE licenses
        SET bound_fingerprint = ?, bound_at = datetime('now'), machine_label = ?
      WHERE key = ?`,
  ).run(fingerprint, machineLabel, key);

  const issuedAt = new Date();
  const { signToken } = await import("../license/sign.js");
  const tokenJson = await signToken(signingKey.privateKey, {
    key,
    plan: "lifetime",
    fingerprint,
    issuedAt,
    expiresAt: null,
  });

  const body = `
<h1>已签发(含离线 Token)</h1>
<div class="card">
  <div class="alert alert-success">License Key 已生成并绑定指纹 ${htmlEscape(fingerprint)}。</div>
  <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); margin: 16px 0 6px;">License Key</div>
  <div class="mono" style="font-size: 16px; padding: 10px 12px; background: var(--surface-elevated); border-radius: 8px;">${htmlEscape(key)}</div>
  <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); margin: 16px 0 6px;">Token JSON(整段复制发给客户)</div>
  <textarea id="tok" readonly style="width: 100%; min-height: 200px; font-family: var(--font-mono); font-size: 11px;">${htmlEscape(tokenJson)}</textarea>
  <div style="display:flex; gap: 8px; margin-top: 10px;">
    <button class="primary" onclick="navigator.clipboard.writeText(document.getElementById('tok').value).then(() => alert('已复制'))">复制 Token</button>
    <a class="btn" href="/admin/licenses/${encodeURIComponent(key)}">查看 license 详情</a>
    <a class="btn" href="/admin/licenses/issue">再签一个</a>
  </div>
</div>`;
  return c.html(layout("已签发", body));
});

// ── 离线激活:管理员替没网络的客户签发 license token ───────────────────────
//
// 客户端用户在自己电脑上看到指纹(顶栏 license chip → 升级框 → 复制指纹),
// 把指纹通过微信/邮件发给管理员,管理员在这里:
//   1. 选择(或填入)一个 license key
//   2. 粘贴客户端的指纹
//   3. 服务器把 fingerprint 写入 licenses.bound_fingerprint(同步绑定),
//      然后签 Ed25519 token JSON 返回。
//   4. 管理员把这串 token JSON 发给客户,客户在客户端"离线激活"模式下
//      粘贴即可,不需要联网。
adminRouter.get("/licenses/offline", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const presetKey = c.req.query("key") ?? "";

  // 列出未绑定的 license,管理员可以从下拉里选
  const unbound = db
    .prepare(
      `SELECT key, COALESCE(buyer_email, '') AS buyer_email, COALESCE(note, '') AS note
         FROM licenses WHERE bound_fingerprint IS NULL
         ORDER BY created_at DESC LIMIT 100`,
    )
    .all() as Array<{ key: string; buyer_email: string; note: string }>;
  const opts = unbound
    .map((l) => {
      const sel = l.key === presetKey ? " selected" : "";
      const tag = l.buyer_email ? ` (${l.buyer_email})` : l.note ? ` (${l.note})` : "";
      return `<option value="${htmlEscape(l.key)}"${sel}>${htmlEscape(l.key)}${htmlEscape(tag)}</option>`;
    })
    .join("");

  const body = `
<h1>离线激活(替客户签发 token)</h1>
<div class="card">
  <p style="font-size: 13px; line-height: 1.7; color: var(--text-secondary); margin: 0 0 14px;">
    用法:客户在自己电脑上的客户端打开 license 升级框 → 复制指纹 → 把指纹+key 发给你 →
    在这里填表 → 把签出来的 token JSON 返回给客户 → 客户粘贴到客户端"离线激活"模式即可。
  </p>
  <form method="POST" action="/admin/licenses/offline">
    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin-bottom: 4px;">License Key(从未绑定的库存中选,或手动输入)</label>
    ${opts ? `<select name="key" style="width: 100%; max-width: 460px; margin-bottom: 8px;">${opts}</select><br>` : ""}
    <input name="key_manual" placeholder="或手动输入一个 DM-XXXX-XXXX-XXXX-XXXX-XXXX(留空则用上方下拉选的)" class="mono" style="width: 100%; max-width: 460px; margin-bottom: 12px;" value="${htmlEscape(presetKey && !unbound.some((l) => l.key === presetKey) ? presetKey : "")}">

    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin-bottom: 4px;">客户端硬件指纹(32 位 hex,从客户那拿)</label>
    <input name="fingerprint" required class="mono" placeholder="例如 71f39bea191cee7fff2c4d3f757aec98" style="width: 100%; max-width: 460px; margin-bottom: 12px;">

    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin-bottom: 4px;">机器标签(可选,便于识别)</label>
    <input name="machine_label" placeholder="例如:张三的 MacBook Pro" style="width: 100%; max-width: 460px; margin-bottom: 16px;">

    <button class="primary" type="submit">签发 License Token</button>
    <a class="btn" href="/admin/licenses" style="margin-left: 8px;">取消</a>
  </form>
</div>`;
  return c.html(layout("离线激活", body));
});

adminRouter.post("/licenses/offline", async (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db, signingKey } = c.var.app;
  const form = await c.req.formData();
  const keyFromSelect = String(form.get("key") ?? "").trim().toUpperCase();
  const keyManual = String(form.get("key_manual") ?? "").trim().toUpperCase();
  const fingerprint = String(form.get("fingerprint") ?? "").trim().toLowerCase();
  const machineLabel = String(form.get("machine_label") ?? "");
  const key = keyManual || keyFromSelect;

  if (!key) return c.text("missing key", 400);
  if (fingerprint.length < 16) return c.text("fingerprint too short", 400);

  type Row = { plan: string; bound_fingerprint: string | null; revoked: number };
  const row = db
    .prepare(
      `SELECT plan, bound_fingerprint,
              CASE WHEN COALESCE(note, '') LIKE 'REVOKED%' THEN 1 ELSE 0 END AS revoked
         FROM licenses WHERE key = ?`,
    )
    .get(key) as Row | undefined;
  if (!row) return c.text("LICENSE_NOT_FOUND", 404);
  if (row.revoked) return c.text("LICENSE_REVOKED", 410);

  if (row.bound_fingerprint && row.bound_fingerprint.toLowerCase() !== fingerprint) {
    return c.text(
      `DEVICE_BOUND — 该 license 已绑定到指纹 ${row.bound_fingerprint},不能换机激活。`,
      409,
    );
  }
  if (!row.bound_fingerprint) {
    db.prepare(
      `UPDATE licenses
          SET bound_fingerprint = ?, bound_at = datetime('now'), machine_label = ?
        WHERE key = ?`,
    ).run(fingerprint, machineLabel, key);
  }

  const issuedAt = new Date();
  const plan = row.plan === "trial" ? "trial" : "lifetime";
  const expiresAt =
    plan === "trial" ? new Date(issuedAt.getTime() + 5 * 86400 * 1000) : null;
  const { signToken } = await import("../license/sign.js");
  const tokenJson = await signToken(signingKey.privateKey, {
    key,
    plan,
    fingerprint,
    issuedAt,
    expiresAt,
  });

  const body = `
<h1>已签发离线 Token</h1>
<div class="card">
  <div class="alert alert-success">License 已绑定到指纹 ${htmlEscape(fingerprint)},token 见下方。</div>
  <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); margin: 16px 0 6px;">
    Token JSON(整段复制发给客户)
  </div>
  <textarea id="tok" readonly style="width: 100%; min-height: 200px; font-family: var(--font-mono); font-size: 11px;">${htmlEscape(tokenJson)}</textarea>
  <div style="display:flex; gap: 8px; margin-top: 10px;">
    <button class="primary" onclick="navigator.clipboard.writeText(document.getElementById('tok').value).then(() => alert('已复制'))">复制 Token</button>
    <a class="btn" href="/admin/licenses/${encodeURIComponent(key)}">查看 license 详情</a>
    <a class="btn" href="/admin/licenses/offline">再签一个</a>
  </div>
  <p style="margin-top: 14px; font-size: 12px; color: var(--text-secondary); line-height: 1.7;">
    告诉客户:打开 DocMind → 点顶栏 license chip → 升级框 → "离线激活(粘贴 token)" → 把上面这段整个粘贴进去 → 激活。
    无需联网。
  </p>
</div>`;
  return c.html(layout("已签发离线 Token", body));
});

adminRouter.get("/licenses/:key", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const key = c.req.param("key");
  type LRow = {
    key: string;
    plan: string;
    order_id: string | null;
    bound_fingerprint: string | null;
    bound_at: string | null;
    machine_label: string | null;
    created_at: string;
    note: string | null;
  };
  const license = db
    .prepare(
      `SELECT key, plan, order_id, bound_fingerprint, bound_at, machine_label, created_at, note
         FROM licenses WHERE key = ?`,
    )
    .get(key) as LRow | undefined;
  if (!license) return c.text("license not found", 404);
  const order = license.order_id
    ? (db
        .prepare(
          `SELECT out_trade_no, amount, paid_at FROM orders WHERE payjs_order_id = ?`,
        )
        .get(license.order_id) as
        | { out_trade_no: string; amount: number; paid_at: string | null }
        | undefined)
    : undefined;

  const stateChip = license.bound_fingerprint
    ? `<span class="chip chip-primary">已激活</span>`
    : `<span class="chip">未激活</span>`;
  const orderBlock = order
    ? `<div class="card"><h2>关联订单</h2>
<div>订单号: <span class="mono">${htmlEscape(order.out_trade_no)}</span></div>
<div>金额: ¥${(order.amount / 100).toFixed(2)}</div>
<div>支付时间: ${htmlEscape(formatDate(order.paid_at) ?? "—")}</div></div>`
    : "";

  const body = `
<h1>License 详情</h1>
<div class="card">
  <h2>基本信息</h2>
  <div class="mono" style="font-size: 14px;">${htmlEscape(license.key)}</div>
  <div style="margin-top: 8px;">Plan: <span class="chip chip-primary">${htmlEscape(license.plan)}</span></div>
  <div style="margin-top: 8px;">创建时间: ${htmlEscape(formatDate(license.created_at) ?? "—")}</div>
  <div style="margin-top: 8px;">备注: ${htmlEscape(license.note ?? "—")}</div>
</div>
<div class="card">
  <h2>设备绑定</h2>
  <div>状态: ${stateChip}</div>
  <div style="margin-top: 8px;">指纹: <span class="mono">${htmlEscape(license.bound_fingerprint ?? "—")}</span></div>
  <div style="margin-top: 8px;">机器标签: ${htmlEscape(license.machine_label ?? "—")}</div>
  <div style="margin-top: 8px;">激活时间: ${htmlEscape(formatDate(license.bound_at) ?? "—")}</div>
  <p style="color: var(--text-muted); font-size: 11px; margin-top: 12px;">
    按设计,License 一旦绑定到设备即不可转移。如客户因硬件故障要求重发,请走"手动签发新 License"流程。
  </p>
</div>
${orderBlock}`;
  return c.html(layout("License 详情", body));
});

// ── Orders ─────────────────────────────────────────────────────────────────
adminRouter.get("/orders", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const rows = db
    .prepare(
      `SELECT o.out_trade_no, o.amount, o.paid_at, o.payment_type, o.license_key,
              (SELECT status FROM refunds r WHERE r.out_trade_no = o.out_trade_no
                 ORDER BY r.created_at DESC LIMIT 1) AS refund_status
         FROM orders o ORDER BY o.created_at DESC LIMIT 200`,
    )
    .all() as Array<{
    out_trade_no: string;
    amount: number;
    paid_at: string | null;
    payment_type: string | null;
    license_key: string | null;
    refund_status: string | null;
  }>;
  const tbody = rows
    .map((o) => {
      let actionCell = "";
      if (o.paid_at && o.license_key && !o.refund_status) {
        actionCell = `<a class="btn" href="/admin/orders/${encodeURIComponent(o.out_trade_no)}/refund" style="padding: 4px 10px; font-size: 11px;">退款</a>`;
      } else if (o.refund_status) {
        const chip =
          o.refund_status === "success"
            ? `<span class="chip" style="color:#dc2626; border-color:#fca5a5; background:rgba(239,68,68,0.08);">已退款</span>`
            : o.refund_status === "processing" || o.refund_status === "pending"
              ? `<span class="chip" style="color:#92400e; border-color:#fde68a; background:rgba(245,158,11,0.1);">退款中</span>`
              : `<span class="chip">退款${htmlEscape(o.refund_status)}</span>`;
        actionCell = chip;
      } else if (!o.paid_at) {
        actionCell = `<span class="chip chip-muted">待支付</span>`;
      }
      return `<tr>
  <td class="mono">${htmlEscape(o.out_trade_no)}</td>
  <td class="mono">¥${(o.amount / 100).toFixed(2)}</td>
  <td>${htmlEscape(formatDate(o.paid_at) ?? "未支付")}</td>
  <td class="mono">${htmlEscape(o.license_key ?? "—")}</td>
  <td>${htmlEscape(o.payment_type ?? "—")}</td>
  <td>${actionCell}</td>
</tr>`;
    })
    .join("");
  const body = `
<h1>订单流水</h1>
<div style="margin-bottom: 12px;">
  <a class="btn" href="/admin/refunds">退款记录</a>
</div>
<table>
  <thead><tr><th>订单号</th><th>金额</th><th>支付时间</th><th>License</th><th>支付方式</th><th>操作</th></tr></thead>
  <tbody>${tbody}</tbody>
</table>`;
  return c.html(layout("订单", body));
});

// 退款表单(GET)
adminRouter.get("/orders/:out_trade_no/refund", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const outTradeNo = c.req.param("out_trade_no");
  const order = db
    .prepare(
      `SELECT out_trade_no, amount, paid_at, license_key FROM orders WHERE out_trade_no = ?`,
    )
    .get(outTradeNo) as
    | { out_trade_no: string; amount: number; paid_at: string | null; license_key: string | null }
    | undefined;
  if (!order) return c.text("order not found", 404);
  if (!order.paid_at) return c.text("order is not paid yet", 400);

  const existing = db
    .prepare(
      `SELECT out_refund_no, status FROM refunds WHERE out_trade_no = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(outTradeNo) as { out_refund_no: string; status: string } | undefined;
  const existingNote = existing
    ? `<div class="alert alert-error" style="background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.3); color: #92400e;">
         此订单已有退款记录(${htmlEscape(existing.out_refund_no)},状态 ${htmlEscape(existing.status)})。继续提交将会再触发一次微信退款 API,可能失败。
       </div>`
    : "";

  const body = `
<h1>退款</h1>
${existingNote}
<div class="card">
  <h2>订单信息</h2>
  <div>订单号: <span class="mono">${htmlEscape(order.out_trade_no)}</span></div>
  <div>原始金额: <strong>¥${(order.amount / 100).toFixed(2)}</strong></div>
  <div>支付时间: ${htmlEscape(formatDate(order.paid_at) ?? "—")}</div>
  <div>License: <span class="mono">${htmlEscape(order.license_key ?? "—")}</span></div>
</div>
<div class="card">
  <h2>退款金额 + 原因</h2>
  <form method="POST" action="/admin/orders/${encodeURIComponent(order.out_trade_no)}/refund">
    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin-bottom: 4px;">退款金额(分,默认全额)</label>
    <input name="refund_fen" value="${order.amount}" type="number" min="1" max="${order.amount}" required style="width: 200px; margin-bottom: 12px;">
    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin-bottom: 4px;">退款原因</label>
    <input name="reason" placeholder="例如:推广期客户申请退款" style="width: 100%; max-width: 460px; margin-bottom: 16px;">
    <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.6; margin-bottom: 12px;">
      ⚠️ 退款成功后,关联的 license 会被自动标记为 <span class="mono">REVOKED</span>,客户端激活校验时会拒绝。<br>
      退款是异步的(尤其银行卡),通常 1-3 个工作日到账。
    </p>
    <button class="primary" type="submit">提交退款申请</button>
    <a class="btn" href="/admin/orders" style="margin-left: 8px;">取消</a>
  </form>
</div>`;
  return c.html(layout("退款", body));
});

// 退款提交(POST)— 调微信退款 API
adminRouter.post("/orders/:out_trade_no/refund", async (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db, config } = c.var.app;
  const outTradeNo = c.req.param("out_trade_no");
  const form = await c.req.formData();
  const refundFen = parseInt(String(form.get("refund_fen") ?? "0"), 10);
  const reason = String(form.get("reason") ?? "");

  const order = db
    .prepare(`SELECT amount, paid_at, license_key FROM orders WHERE out_trade_no = ?`)
    .get(outTradeNo) as
    | { amount: number; paid_at: string | null; license_key: string | null }
    | undefined;
  if (!order) return c.text("order not found", 404);
  if (!order.paid_at) return c.text("order not paid", 400);
  if (refundFen <= 0 || refundFen > order.amount) {
    return c.text("invalid refund amount", 400);
  }

  const w = config.wechat;
  if (!w.mchId || !w.privateKey) return c.text("wechat not configured", 500);

  const outRefundNo = `R-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  // 先落库占位(防 webhook 提前到达找不到记录)
  db.prepare(
    `INSERT INTO refunds (out_refund_no, out_trade_no, license_key, amount, reason, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  ).run(outRefundNo, outTradeNo, order.license_key, refundFen, reason);

  // 调微信退款 API
  const { WechatPay } = await import("../wechatpay.js");
  const wp = new WechatPay(w);
  const refundNotifyUrl = `https://${config.domain}/api/v1/payment/wechat/refund_webhook`;
  let resp;
  try {
    resp = await wp.createRefund({
      outTradeNo,
      outRefundNo,
      refundFen,
      totalFen: order.amount,
      reason,
      notifyUrl: refundNotifyUrl,
    });
  } catch (e) {
    db.prepare(
      `UPDATE refunds SET status = 'failed', raw_response = ?, updated_at = datetime('now') WHERE out_refund_no = ?`,
    ).run(String(e), outRefundNo);
    return c.text(`微信退款失败: ${(e as Error).message}`, 502);
  }

  const status = resp.status.toLowerCase();
  db.prepare(
    `UPDATE refunds
        SET status = ?, refund_id = ?, raw_response = ?, updated_at = datetime('now')
      WHERE out_refund_no = ?`,
  ).run(status, resp.refund_id, JSON.stringify(resp), outRefundNo);

  // 同步成功 → 立即吊销 license
  if (status === "success" && order.license_key) {
    db.prepare(
      `UPDATE licenses
          SET note = COALESCE(note, '') || 'REVOKED:refund:${outRefundNo}:' || datetime('now')
        WHERE key = ? AND note NOT LIKE 'REVOKED%'`,
    ).run(order.license_key);
  }

  return c.redirect("/admin/refunds");
});

// 退款列表
adminRouter.get("/refunds", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const rows = db
    .prepare(
      `SELECT out_refund_no, out_trade_no, license_key, amount, reason,
              status, refund_id, created_at, updated_at
         FROM refunds ORDER BY created_at DESC LIMIT 200`,
    )
    .all() as Array<{
    out_refund_no: string;
    out_trade_no: string;
    license_key: string | null;
    amount: number;
    reason: string | null;
    status: string;
    refund_id: string | null;
    created_at: string;
    updated_at: string | null;
  }>;
  const tbody = rows
    .map((r) => {
      const chip =
        r.status === "success"
          ? `<span class="chip" style="color:#15803d; border-color:#86efac; background:rgba(34,197,94,0.08);">已退款</span>`
          : r.status === "processing" || r.status === "pending"
            ? `<span class="chip" style="color:#92400e; border-color:#fde68a; background:rgba(245,158,11,0.1);">退款中</span>`
            : r.status === "failed"
              ? `<span class="chip" style="color:#dc2626; border-color:#fca5a5; background:rgba(239,68,68,0.08);">失败</span>`
              : `<span class="chip">${htmlEscape(r.status)}</span>`;
      return `<tr>
  <td class="mono">${htmlEscape(r.out_refund_no)}</td>
  <td class="mono"><a href="/admin/orders">${htmlEscape(r.out_trade_no)}</a></td>
  <td class="mono">¥${(r.amount / 100).toFixed(2)}</td>
  <td>${chip}</td>
  <td class="mono">${htmlEscape(r.license_key ?? "—")}</td>
  <td>${htmlEscape(r.reason ?? "—")}</td>
  <td>${htmlEscape(formatDate(r.updated_at ?? r.created_at) ?? "—")}</td>
</tr>`;
    })
    .join("");
  const body = `
<h1>退款记录</h1>
<table>
  <thead><tr><th>退款单号</th><th>原订单</th><th>金额</th><th>状态</th><th>License</th><th>原因</th><th>更新</th></tr></thead>
  <tbody>${tbody || `<tr><td colspan="7" style="text-align:center; padding:20px;">暂无退款</td></tr>`}</tbody>
</table>
<p style="margin-top: 16px; font-size: 11px; color: var(--text-muted); line-height: 1.7;">
  退款成功后关联 license 会被标记 REVOKED,客户端再次激活会被拒绝。<br>
  退款异步处理时间通常 1-3 个工作日,微信会通过 webhook 通知最终状态。
</p>`;
  return c.html(layout("退款", body));
});

// ── Downloads ──────────────────────────────────────────────────────────────
adminRouter.get("/downloads", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const rows = db
    .prepare(
      `SELECT ts, version, platform, edition, license_key, ip
         FROM downloads ORDER BY ts DESC LIMIT 200`,
    )
    .all() as Array<{
    ts: string;
    version: string;
    platform: string;
    edition: string;
    license_key: string | null;
    ip: string;
  }>;
  const tbody = rows
    .map(
      (d) =>
        `<tr><td>${htmlEscape(formatDate(d.ts) ?? "—")}</td><td class="mono">${htmlEscape(d.version)}</td><td class="mono">${htmlEscape(d.platform)}</td><td>${htmlEscape(d.edition)}</td><td class="mono">${htmlEscape(d.license_key ?? "—")}</td><td class="mono">${htmlEscape(d.ip)}</td></tr>`,
    )
    .join("");
  const body = `
<h1>下载日志</h1>
<table>
  <thead><tr><th>时间</th><th>版本</th><th>平台</th><th>类型</th><th>License</th><th>IP</th></tr></thead>
  <tbody>${tbody}</tbody>
</table>`;
  return c.html(layout("下载日志", body));
});

// ── Releases ───────────────────────────────────────────────────────────────
const SUPPORTED_PLATFORMS: Array<{ value: string; label: string }> = [
  { value: "darwin-aarch64", label: "macOS (Apple Silicon · M 系列)" },
  { value: "darwin-x86_64", label: "macOS (Intel)" },
  { value: "windows-x86_64", label: "Windows 64-bit" },
  { value: "windows-aarch64", label: "Windows ARM64" },
  { value: "linux-x86_64", label: "Linux x86_64" },
  { value: "linux-aarch64", label: "Linux ARM64" },
];

adminRouter.get("/releases", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db, config } = c.var.app;
  const rows = db
    .prepare(
      `SELECT version, platform, file_path, size, published_at
         FROM releases ORDER BY published_at DESC LIMIT 100`,
    )
    .all() as Array<{
    version: string;
    platform: string;
    file_path: string;
    size: number;
    published_at: string;
  }>;
  const tbody = rows
    .map((r) => {
      const url = `https://${config.domain}/releases/${encodeURIComponent(r.platform)}/${encodeURIComponent(r.file_path)}`;
      return `<tr>
  <td class="mono">${htmlEscape(r.version)}</td>
  <td class="mono">${htmlEscape(r.platform)}</td>
  <td class="mono">${htmlEscape(r.file_path)}</td>
  <td class="mono">${(r.size / (1024 * 1024)).toFixed(1)} MB</td>
  <td><a class="mono" href="${htmlEscape(url)}" target="_blank" rel="noopener">下载</a></td>
</tr>`;
    })
    .join("");

  const platformOptions = SUPPORTED_PLATFORMS.map(
    (p) => `<option value="${htmlEscape(p.value)}">${htmlEscape(p.label)}</option>`,
  ).join("");

  const body = `
<h1>版本管理</h1>
<div class="card">
  <h2>上传新版本</h2>
  <form method="POST" action="/admin/releases" enctype="multipart/form-data">
    <div class="row" style="gap: 12px; flex-wrap: wrap; margin-bottom: 8px;">
      <input name="version" placeholder="版本号 e.g. 0.2.0" required>
      <select name="platform" required>${platformOptions}</select>
    </div>
    <div class="row" style="gap: 12px; margin-bottom: 8px;">
      <input type="file" name="binary" required>
      <input name="signature" placeholder=".sig 签名(粘贴文本)" style="flex:1; min-width:200px;">
    </div>
    <textarea name="notes" placeholder="更新说明" style="width: 100%; min-height: 80px; margin-bottom: 8px;"></textarea>
    <button class="primary" type="submit">发布</button>
  </form>
</div>
<table>
  <thead><tr><th>版本</th><th>平台</th><th>文件名</th><th>大小</th><th>下载</th></tr></thead>
  <tbody>${tbody || `<tr><td colspan="5" style="text-align:center; padding:20px;">暂无发布</td></tr>`}</tbody>
</table>`;
  return c.html(layout("版本", body));
});

adminRouter.post("/releases", async (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db, config } = c.var.app;

  const form = await c.req.formData();
  const version = String(form.get("version") ?? "");
  const platform = String(form.get("platform") ?? "");
  const notes = String(form.get("notes") ?? "");
  const signature = String(form.get("signature") ?? "");
  const binary = form.get("binary");
  if (!version || !platform) return c.text("version + platform required", 400);
  if (!SUPPORTED_PLATFORMS.some((p) => p.value === platform)) {
    return c.text("unsupported platform", 400);
  }
  if (!(binary instanceof File) || binary.size === 0) {
    return c.text("missing binary", 400);
  }

  // 单一 edition 'all',兼容旧 schema 的 UNIQUE(version, platform, edition)
  const edition = "all";
  const dir = join(config.releasesDir, edition, platform);
  mkdirSync(dir, { recursive: true });
  const filename = binary.name;
  const dest = join(dir, filename);
  const bytes = Buffer.from(await binary.arrayBuffer());
  writeFileSync(dest, bytes);
  const sha = sha256Hex(bytes);

  db.prepare(
    `INSERT INTO releases (version, platform, edition, file_path, sha256, size, signature, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version, platform, edition) DO UPDATE SET
       file_path = excluded.file_path,
       sha256 = excluded.sha256,
       size = excluded.size,
       signature = excluded.signature,
       notes = excluded.notes`,
  ).run(version, platform, edition, filename, sha, bytes.length, signature, notes);

  return c.redirect("/admin/releases");
});

// ── Portal access logs ────────────────────────────────────────────────────
adminRouter.get("/portal", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;

  const totalToday =
    (db.prepare(`SELECT COUNT(*) AS n FROM portal_access WHERE ts >= date('now')`).get() as { n: number }).n;
  const totalMonth =
    (db
      .prepare(
        `SELECT COUNT(*) AS n FROM portal_access WHERE ts >= date('now', 'start of month')`,
      )
      .get() as { n: number }).n;
  const total =
    (db.prepare(`SELECT COUNT(*) AS n FROM portal_access`).get() as { n: number }).n;

  const rows = db
    .prepare(
      `SELECT ts, method, path, status, ip, user_agent, referer
         FROM portal_access ORDER BY ts DESC LIMIT 200`,
    )
    .all() as Array<{
    ts: string;
    method: string;
    path: string;
    status: number;
    ip: string;
    user_agent: string | null;
    referer: string | null;
  }>;
  const tbody = rows
    .map((r) => {
      const refDisplay = r.referer
        ? r.referer.length > 60
          ? r.referer.slice(0, 60) + "…"
          : r.referer
        : "—";
      const uaDisplay = r.user_agent
        ? r.user_agent.length > 50
          ? r.user_agent.slice(0, 50) + "…"
          : r.user_agent
        : "—";
      return `<tr>
  <td>${htmlEscape(formatDate(r.ts) ?? "—")}</td>
  <td class="mono">${htmlEscape(r.method)}</td>
  <td class="mono">${htmlEscape(r.path)}</td>
  <td class="mono">${r.status}</td>
  <td class="mono">${htmlEscape(r.ip)}</td>
  <td title="${htmlEscape(r.user_agent ?? "")}">${htmlEscape(uaDisplay)}</td>
  <td title="${htmlEscape(r.referer ?? "")}">${htmlEscape(refDisplay)}</td>
</tr>`;
    })
    .join("");

  const topPaths = db
    .prepare(
      `SELECT path, COUNT(*) AS n FROM portal_access
         WHERE ts >= date('now', 'start of month')
         GROUP BY path ORDER BY n DESC LIMIT 10`,
    )
    .all() as Array<{ path: string; n: number }>;
  const topTbody = topPaths
    .map(
      (p) =>
        `<tr><td class="mono">${htmlEscape(p.path)}</td><td class="mono">${p.n}</td></tr>`,
    )
    .join("");

  const body = `
<h1>门户访问日志</h1>
<div class="stat-grid" style="grid-template-columns: repeat(3, 1fr);">
  <div class="stat"><div class="stat-label">今日访问</div><div class="stat-value">${totalToday}</div></div>
  <div class="stat"><div class="stat-label">本月访问</div><div class="stat-value">${totalMonth}</div></div>
  <div class="stat"><div class="stat-label">累计</div><div class="stat-value">${total}</div></div>
</div>

<div class="card">
  <h2>本月热门路径</h2>
  <table>
    <thead><tr><th>路径</th><th>访问次数</th></tr></thead>
    <tbody>${topTbody || `<tr><td colspan="2" style="text-align:center; padding:20px;">暂无数据</td></tr>`}</tbody>
  </table>
</div>

<div class="card">
  <h2>最近 200 条</h2>
  <table>
    <thead><tr><th>时间</th><th>方法</th><th>路径</th><th>状态</th><th>IP</th><th>UA</th><th>来源</th></tr></thead>
    <tbody>${tbody || `<tr><td colspan="7" style="text-align:center; padding:20px;">暂无数据</td></tr>`}</tbody>
  </table>
</div>`;
  return c.html(layout("门户访问", body));
});

// ── 推广码(v0.3.0)──────────────────────────────────────────────────────
//   运营手动签发邀请码给推广大使,买家在客户端升级对话框输入码,后台
//   自动归因。这里提供:列表 + 新建 + 编辑 + 单码订单查询 + CSV 导出。

adminRouter.get("/invites", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const rows = db
    .prepare(
      `SELECT ic.code, ic.ambassador, ic.contact, ic.status, ic.commission_cents,
              ic.note, ic.created_at, ic.expires_at,
              COALESCE((
                SELECT COUNT(*) FROM invite_redemptions ir
                 WHERE ir.code = ic.code AND ir.refund_at IS NULL
              ), 0) AS valid_count,
              COALESCE((
                SELECT COUNT(*) FROM invite_redemptions ir
                 WHERE ir.code = ic.code AND ir.refund_at IS NULL
                   AND ir.settled_at IS NULL
              ), 0) AS pending_count
         FROM invite_codes ic
        ORDER BY ic.created_at DESC`,
    )
    .all() as Array<{
    code: string;
    ambassador: string;
    contact: string | null;
    status: string;
    commission_cents: number;
    note: string | null;
    created_at: string;
    expires_at: string | null;
    valid_count: number;
    pending_count: number;
  }>;

  const tbody = rows
    .map((r) => {
      const statusChip =
        r.status === "active"
          ? `<span class="chip" style="color:#16a34a;border-color:#86efac;background:rgba(34,197,94,0.08);">启用</span>`
          : `<span class="chip chip-muted">已停用</span>`;
      const pendingCash =
        r.pending_count > 0 && r.commission_cents > 0
          ? `<span style="color:#dc2626;font-weight:600;">¥${((r.pending_count * r.commission_cents) / 100).toFixed(2)}</span>`
          : "—";
      return `<tr>
  <td class="mono">${htmlEscape(r.code)}</td>
  <td>${htmlEscape(r.ambassador)}</td>
  <td class="mono" style="font-size:11px;">${htmlEscape(r.contact ?? "—")}</td>
  <td>${statusChip}</td>
  <td style="text-align:center;">${r.valid_count}</td>
  <td>${pendingCash}</td>
  <td>¥${(r.commission_cents / 100).toFixed(2)}</td>
  <td style="font-size:11px;color:var(--text-muted);">${htmlEscape(formatDate(r.created_at) ?? "—")}</td>
  <td>
    <a class="btn" href="/admin/invites/${encodeURIComponent(r.code)}/orders" style="padding:4px 8px;font-size:11px;">订单</a>
    <a class="btn" href="/admin/invites/${encodeURIComponent(r.code)}/edit" style="padding:4px 8px;font-size:11px;">编辑</a>
  </td>
</tr>`;
    })
    .join("");

  const body = `
<h1>推广码</h1>
<div class="row" style="justify-content:space-between;margin-bottom:12px;gap:8px;">
  <div>
    <a class="btn primary" href="/admin/invites/new">+ 新建邀请码</a>
    <a class="btn" href="/admin/invites/export.csv">导出全部归因订单 (CSV)</a>
  </div>
  <span style="color:var(--text-muted);font-size:11px;">共 ${rows.length} 个码</span>
</div>
<table>
  <thead><tr>
    <th>邀请码</th><th>大使</th><th>联系方式</th><th>状态</th>
    <th>归因订单数</th><th>待结算金额</th><th>单笔分成</th><th>创建时间</th><th>操作</th>
  </tr></thead>
  <tbody>${tbody || `<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--text-muted);">暂无邀请码,点击"新建邀请码"创建。</td></tr>`}</tbody>
</table>`;
  return c.html(layout("推广码", body));
});

adminRouter.get("/invites/new", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  return c.html(layout("新建邀请码", renderInviteForm(null)));
});

adminRouter.post("/invites/new", async (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const form = await c.req.formData();
  const code = String(form.get("code") ?? "").trim().toUpperCase();
  const ambassador = String(form.get("ambassador") ?? "").trim();
  const contact = String(form.get("contact") ?? "").trim() || null;
  const commission = parseInt(String(form.get("commission") ?? "0"), 10);
  const note = String(form.get("note") ?? "").trim() || null;
  const expires_at = String(form.get("expires_at") ?? "").trim() || null;

  if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
    return c.text("码格式错误:仅允许大写字母、数字、短横线,长度 4-32", 400);
  }
  if (!ambassador) {
    return c.text("大使名称不能为空", 400);
  }

  try {
    db.prepare(
      `INSERT INTO invite_codes
         (code, ambassador, contact, status, commission_cents, note, expires_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      code,
      ambassador,
      contact,
      isFinite(commission) ? commission : 0,
      note,
      expires_at,
    );
  } catch (e: any) {
    if (String(e).includes("UNIQUE")) {
      return c.text(`邀请码 ${code} 已存在`, 409);
    }
    throw e;
  }
  return c.redirect("/admin/invites");
});

adminRouter.get("/invites/:code/edit", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const code = c.req.param("code");
  const row = db
    .prepare(`SELECT * FROM invite_codes WHERE code = ?`)
    .get(code) as any;
  if (!row) return c.text("not found", 404);
  return c.html(layout(`编辑 ${code}`, renderInviteForm(row)));
});

adminRouter.post("/invites/:code/edit", async (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const code = c.req.param("code");
  const form = await c.req.formData();
  const ambassador = String(form.get("ambassador") ?? "").trim();
  const contact = String(form.get("contact") ?? "").trim() || null;
  const status = String(form.get("status") ?? "active");
  const commission = parseInt(String(form.get("commission") ?? "0"), 10);
  const note = String(form.get("note") ?? "").trim() || null;
  const expires_at = String(form.get("expires_at") ?? "").trim() || null;

  db.prepare(
    `UPDATE invite_codes
        SET ambassador = ?, contact = ?, status = ?,
            commission_cents = ?, note = ?, expires_at = ?
      WHERE code = ?`,
  ).run(
    ambassador,
    contact,
    status === "active" ? "active" : "disabled",
    isFinite(commission) ? commission : 0,
    note,
    expires_at,
    code,
  );
  return c.redirect("/admin/invites");
});

adminRouter.get("/invites/:code/orders", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const code = c.req.param("code");
  const info = db
    .prepare(
      `SELECT code, ambassador, commission_cents FROM invite_codes WHERE code = ?`,
    )
    .get(code) as
    | { code: string; ambassador: string; commission_cents: number }
    | undefined;
  if (!info) return c.text("not found", 404);

  const rows = db
    .prepare(
      `SELECT id, buyer_order_id, buyer_fp, paid_at, paid_amount_cents,
              refund_at, settled_at, settle_note
         FROM invite_redemptions
        WHERE code = ?
        ORDER BY paid_at DESC`,
    )
    .all(code) as Array<{
    id: number;
    buyer_order_id: string;
    buyer_fp: string | null;
    paid_at: string;
    paid_amount_cents: number;
    refund_at: string | null;
    settled_at: string | null;
    settle_note: string | null;
  }>;

  const tbody = rows
    .map((r) => {
      let statusChip = "";
      if (r.refund_at) {
        statusChip = `<span class="chip" style="color:#92400e;border-color:#fde68a;background:rgba(245,158,11,0.1);">退款</span>`;
      } else if (r.settled_at) {
        statusChip = `<span class="chip" style="color:#16a34a;border-color:#86efac;background:rgba(34,197,94,0.08);">已结算</span>`;
      } else {
        statusChip = `<span class="chip">待结算</span>`;
      }
      const settleBtn =
        !r.refund_at && !r.settled_at
          ? `<form method="POST" action="/admin/invites/redemption/${r.id}/settle" style="display:inline;margin:0;">
               <input type="text" name="note" placeholder="结算备注" style="width:100px;font-size:11px;padding:2px 4px;">
               <button class="btn primary" type="submit" style="padding:3px 8px;font-size:11px;">标记已结算</button>
             </form>`
          : r.settled_at
            ? `<span style="font-size:11px;color:var(--text-muted);">${htmlEscape(r.settle_note ?? "")}</span>`
            : "";
      return `<tr>
  <td class="mono">${htmlEscape(r.buyer_order_id)}</td>
  <td>¥${(r.paid_amount_cents / 100).toFixed(2)}</td>
  <td>${htmlEscape(formatDate(r.paid_at) ?? "—")}</td>
  <td>${statusChip}</td>
  <td>${htmlEscape(formatDate(r.settled_at) ?? "—")}</td>
  <td>${settleBtn}</td>
</tr>`;
    })
    .join("");

  const validCount = rows.filter((r) => !r.refund_at).length;
  const pendingCount = rows.filter((r) => !r.refund_at && !r.settled_at).length;
  const pendingAmount = pendingCount * info.commission_cents;

  const body = `
<h1>${htmlEscape(info.code)} · ${htmlEscape(info.ambassador)}</h1>
<div class="stat-grid">
  <div class="stat"><div class="stat-label">有效订单数</div><div class="stat-value">${validCount}</div></div>
  <div class="stat"><div class="stat-label">待结算订单</div><div class="stat-value">${pendingCount}</div></div>
  <div class="stat"><div class="stat-label">待结算金额</div><div class="stat-value">¥${(pendingAmount / 100).toFixed(2)}</div></div>
  <div class="stat"><div class="stat-label">单笔分成</div><div class="stat-value">¥${(info.commission_cents / 100).toFixed(2)}</div></div>
</div>
<div style="margin-bottom:12px;">
  <a class="btn" href="/admin/invites">← 返回列表</a>
  <a class="btn" href="/admin/invites/${encodeURIComponent(code)}/export.csv">导出本码 CSV</a>
</div>
<table>
  <thead><tr><th>订单号</th><th>实付</th><th>支付时间</th><th>状态</th><th>结算时间</th><th>操作</th></tr></thead>
  <tbody>${tbody || `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">还没有归因订单。</td></tr>`}</tbody>
</table>`;
  return c.html(layout(`${info.code} 订单`, body));
});

adminRouter.post("/invites/redemption/:id/settle", async (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const id = parseInt(c.req.param("id"), 10);
  const form = await c.req.formData();
  const note = String(form.get("note") ?? "").trim() || null;
  const row = db
    .prepare(`SELECT code FROM invite_redemptions WHERE id = ?`)
    .get(id) as { code: string } | undefined;
  if (!row) return c.text("not found", 404);
  db.prepare(
    `UPDATE invite_redemptions
        SET settled_at = datetime('now'), settle_note = ?
      WHERE id = ? AND settled_at IS NULL AND refund_at IS NULL`,
  ).run(note, id);
  return c.redirect(`/admin/invites/${encodeURIComponent(row.code)}/orders`);
});

// CSV 导出 —— 全部归因订单(便于运营做月度结算 Excel)
adminRouter.get("/invites/export.csv", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const rows = db
    .prepare(
      `SELECT ir.code, ic.ambassador, ic.contact, ic.commission_cents,
              ir.buyer_order_id, ir.paid_amount_cents, ir.paid_at,
              ir.refund_at, ir.settled_at, ir.settle_note
         FROM invite_redemptions ir
         JOIN invite_codes ic ON ic.code = ir.code
        ORDER BY ir.paid_at DESC`,
    )
    .all() as any[];
  return c.body(toCsv(rows), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="invite-redemptions-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

// 单个码的 CSV
adminRouter.get("/invites/:code/export.csv", (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const code = c.req.param("code");
  const rows = db
    .prepare(
      `SELECT ir.code, ic.ambassador, ic.contact, ic.commission_cents,
              ir.buyer_order_id, ir.paid_amount_cents, ir.paid_at,
              ir.refund_at, ir.settled_at, ir.settle_note
         FROM invite_redemptions ir
         JOIN invite_codes ic ON ic.code = ir.code
        WHERE ir.code = ?
        ORDER BY ir.paid_at DESC`,
    )
    .all(code) as any[];
  return c.body(toCsv(rows), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="invite-${code}-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

function renderInviteForm(
  existing:
    | {
        code: string;
        ambassador: string;
        contact: string | null;
        status: string;
        commission_cents: number;
        note: string | null;
        expires_at: string | null;
      }
    | null,
): string {
  const isNew = !existing;
  const action = isNew ? "/admin/invites/new" : `/admin/invites/${encodeURIComponent(existing.code)}/edit`;
  // scoped CSS:全局 CSS 没把 label 设成 block、input 没全宽,这里补一下,
  // 避免 label+input+label+input 全挤到一行
  return `
<style>
.invite-form { max-width: 600px; }
.invite-form label { display: block; font-size: 11px; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono);
  margin: 14px 0 6px; }
.invite-form label:first-of-type { margin-top: 0; }
.invite-form input, .invite-form select, .invite-form textarea { width: 100%; box-sizing: border-box; }
.invite-form textarea { font-family: inherit; resize: vertical; }
.invite-form .hint { color: var(--text-muted); font-size: 11px; margin-top: 4px; }
.invite-form .actions { margin-top: 22px; display: flex; gap: 8px; }
</style>
<h1>${isNew ? "新建邀请码" : `编辑 ${htmlEscape(existing!.code)}`}</h1>
<form method="POST" action="${action}" class="card invite-form">
  <label>邀请码 ${isNew ? "(只能大写字母 + 数字 + 短横线,4-32 字符)" : ""}</label>
  ${
    isNew
      ? `<input name="code" required pattern="[A-Z0-9-]{4,32}" placeholder="例如 DOCMIND-AB12" autocomplete="off">`
      : `<input value="${htmlEscape(existing!.code)}" disabled style="opacity:0.6;">`
  }

  <label>大使昵称 / 平台名</label>
  <input name="ambassador" required placeholder="例如 B 站 UP 某某 / 公众号 某某" value="${htmlEscape(existing?.ambassador ?? "")}" autocomplete="off">

  <label>联系方式(微信号 / 邮箱,运营结算用)</label>
  <input name="contact" placeholder="可选" value="${htmlEscape(existing?.contact ?? "")}" autocomplete="off">

  <label>每单分成(单位:分,仅记账参考,不实付)</label>
  <input name="commission" type="number" min="0" step="1" value="${existing?.commission_cents ?? 0}">
  <div class="hint">填 500 = ¥5,1000 = ¥10。这个字段只是给运营算账的依据,后端不会自动到账。</div>

  <label>过期时间(可选,ISO 格式 YYYY-MM-DD)</label>
  <input name="expires_at" placeholder="2027-01-01,留空表示永久" value="${htmlEscape(existing?.expires_at ?? "")}">

  ${
    !isNew
      ? `<label>状态</label>
         <select name="status">
           <option value="active" ${existing?.status === "active" ? "selected" : ""}>启用</option>
           <option value="disabled" ${existing?.status === "disabled" ? "selected" : ""}>停用</option>
         </select>`
      : ""
  }

  <label>备注</label>
  <textarea name="note" rows="3" placeholder="合作日期、平台、合作方式等内部备注">${htmlEscape(existing?.note ?? "")}</textarea>

  <div class="actions">
    <button class="primary" type="submit">${isNew ? "创建" : "保存"}</button>
    <a class="btn" href="/admin/invites">取消</a>
  </div>
</form>`;
}

function toCsv(rows: any[]): string {
  const header = [
    "邀请码",
    "大使",
    "联系方式",
    "单笔分成(元)",
    "订单号",
    "实付金额(元)",
    "支付时间",
    "退款时间",
    "结算时间",
    "结算备注",
  ];
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.code,
        r.ambassador,
        r.contact ?? "",
        ((r.commission_cents ?? 0) / 100).toFixed(2),
        r.buyer_order_id,
        ((r.paid_amount_cents ?? 0) / 100).toFixed(2),
        r.paid_at ?? "",
        r.refund_at ?? "",
        r.settled_at ?? "",
        r.settle_note ?? "",
      ]
        .map(esc)
        .join(","),
    );
  }
  // UTF-8 BOM 让 Excel 打开 CSV 不乱码
  return "﻿" + lines.join("\n");
}

// ── helpers ────────────────────────────────────────────────────────────────
function formatDate(s: string | null | undefined): string | null {
  if (!s) return null;
  // SQLite returns "YYYY-MM-DD HH:MM:SS" or RFC3339
  const d = new Date(s.replace(" ", "T") + (s.includes("T") || s.endsWith("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return s;
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}


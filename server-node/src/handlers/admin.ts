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
  <form method="POST" action="/admin/licenses/issue">
    <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono);">买家邮箱(可选,用于备注)</label>
    <input name="email" style="width: 100%; max-width: 360px; margin: 4px 0 12px;">
    <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono);">备注</label>
    <input name="note" style="width: 100%; max-width: 360px; margin: 4px 0 12px;" placeholder="例如:微信好友直转 / 退款重发 / 测试">
    <button class="primary" type="submit">生成 License Key</button>
  </form>
</div>`;
  return c.html(layout("手动签发", body));
});

adminRouter.post("/licenses/issue", async (c) => {
  const guard = requireSession(c);
  if (guard !== true) return guard;
  const { db } = c.var.app;
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  const note = String(form.get("note") ?? "");
  const key = generateKey();
  db.prepare(
    `INSERT INTO licenses (key, plan, buyer_email, note) VALUES (?, 'lifetime', ?, ?)`,
  ).run(key, email || null, note || null);
  const body = `
<h1>已签发</h1>
<div class="card">
  <div class="alert alert-success">已生成新 License Key。请发给客户。</div>
  <div class="mono" style="font-size: 18px; padding: 12px; background: var(--surface-elevated); border-radius: 8px;">${htmlEscape(key)}</div>
  <div style="margin-top: 16px;">
    <a class="btn" href="/admin/licenses/${encodeURIComponent(key)}">查看详情</a>
    <a class="btn" href="/admin/licenses/issue">再签一个</a>
  </div>
</div>`;
  return c.html(layout("已签发", body));
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
      `SELECT out_trade_no, amount, paid_at, payment_type, license_key
         FROM orders ORDER BY created_at DESC LIMIT 200`,
    )
    .all() as Array<{
    out_trade_no: string;
    amount: number;
    paid_at: string | null;
    payment_type: string | null;
    license_key: string | null;
  }>;
  const tbody = rows
    .map(
      (o) =>
        `<tr><td class="mono">${htmlEscape(o.out_trade_no)}</td><td class="mono">¥${(o.amount / 100).toFixed(2)}</td><td>${htmlEscape(formatDate(o.paid_at) ?? "未支付")}</td><td class="mono">${htmlEscape(o.license_key ?? "—")}</td><td>${htmlEscape(o.payment_type ?? "—")}</td></tr>`,
    )
    .join("");
  const body = `
<h1>订单流水</h1>
<table>
  <thead><tr><th>订单号</th><th>金额</th><th>支付时间</th><th>License</th><th>支付方式</th></tr></thead>
  <tbody>${tbody}</tbody>
</table>`;
  return c.html(layout("订单", body));
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

// ── helpers ────────────────────────────────────────────────────────────────
function formatDate(s: string | null | undefined): string | null {
  if (!s) return null;
  // SQLite returns "YYYY-MM-DD HH:MM:SS" or RFC3339
  const d = new Date(s.replace(" ", "T") + (s.includes("T") || s.endsWith("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return s;
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}


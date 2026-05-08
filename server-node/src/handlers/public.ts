/**
 * Public-facing pages on doc-api.* host:
 *   - /            small landing redirecting to docmind.app
 *   - /activate    fallback activation form for users who can't activate from inside the app
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../app.js";
import { htmlEscape, standalone } from "../templates.js";
import { signToken } from "../license/sign.js";

export const publicRouter = new Hono<AppEnv>();

publicRouter.get("/", (c) =>
  c.html(
    standalone(
      "DocMind",
      `<div class="login-box" style="text-align: center;">
  <h1>DocMind License Server</h1>
  <p style="color: var(--text-muted); font-size: 12px; line-height: 1.7;">
    这里是 DocMind 的 license / 更新 / 支付 后台。如果你在找产品页,请前往
    <a href="https://${htmlEscape(c.var.app.config.portalDomain)}">${htmlEscape(c.var.app.config.portalDomain)}</a>。
  </p>
</div>`,
    ),
  ),
);

publicRouter.get("/activate", (c) => {
  const key = c.req.query("key") ?? "";
  const status = c.req.query("status") ?? "";
  const msg = c.req.query("msg") ?? "";
  return c.html(renderActivatePage(key, status, msg));
});

publicRouter.post("/activate", async (c) => {
  const { db, signingKey } = c.var.app;
  const form = await c.req.formData();
  const key = String(form.get("key") ?? "").trim().toUpperCase();
  const fingerprint = String(form.get("fingerprint") ?? "").toLowerCase();
  const machineLabel = String(form.get("machine_label") ?? "");

  if (!key || fingerprint.length < 16) {
    return redirectActivate(c, key, "err", "请填写完整的 license key 和硬件指纹");
  }

  type Row = { plan: string; bound_fingerprint: string | null; revoked: number };
  const row = db
    .prepare(
      `SELECT plan, bound_fingerprint,
              CASE WHEN COALESCE(note, '') LIKE 'REVOKED%' THEN 1 ELSE 0 END AS revoked
         FROM licenses WHERE key = ?`,
    )
    .get(key) as Row | undefined;
  if (!row) return redirectActivate(c, key, "err", "LICENSE_NOT_FOUND");
  if (row.revoked) return redirectActivate(c, key, "err", "LICENSE_REVOKED");
  if (row.bound_fingerprint && row.bound_fingerprint.toLowerCase() !== fingerprint) {
    return redirectActivate(c, key, "err", "DEVICE_BOUND");
  }
  if (!row.bound_fingerprint) {
    db.prepare(
      `UPDATE licenses
          SET bound_fingerprint = ?, bound_at = datetime('now'), machine_label = ?
        WHERE key = ?`,
    ).run(fingerprint, machineLabel, key);
  }

  // We don't return the token from this page (the user will then activate from
  // inside the app). Just confirm the binding.
  void signToken; // signing keypair available but token isn't surfaced here
  void signingKey;

  return redirectActivate(c, key, "ok", "");
});

function redirectActivate(c: Context, key: string, status: string, msg: string): Response {
  const url = `/activate?key=${encodeURIComponent(key)}&status=${status}${msg ? `&msg=${encodeURIComponent(msg)}` : ""}`;
  return c.redirect(url);
}

function renderActivatePage(key: string, status: string, msg: string): string {
  const alert =
    status === "ok"
      ? `<div class="alert alert-success">激活成功!请回到 DocMind 应用,license 状态会自动刷新。</div>`
      : status === "err"
        ? `<div class="alert alert-error">${htmlEscape(msg || "激活失败,请检查 license key")}</div>`
        : "";

  const body = `<div class="login-box" style="width: 460px;">
  <h1>激活 DocMind Pro</h1>
  ${alert}
  <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.7; margin-bottom: 18px;">
    在 DocMind 应用顶栏点击 license 状态条,会显示当前设备的硬件指纹。
    <strong>请直接在应用内激活</strong> — 应用会自动读取本机指纹并提交。
    若你已经在应用内成功激活,这里无需任何操作。
  </p>
  <p style="color: var(--text-muted); font-size: 11px; line-height: 1.6;">
    如果应用无法访问网络,你可以手动复制 license key 与硬件指纹,通过本页面提交。
  </p>
  <form method="POST" action="/activate" style="margin-top: 16px;">
    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin-bottom: 4px;">License Key</label>
    <input name="key" required placeholder="DM-XXXX-XXXX-XXXX-XXXX-XXXX" value="${htmlEscape(key)}" class="mono" style="width: 100%; height: 36px;">
    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin: 12px 0 4px;">硬件指纹(从应用顶栏获取)</label>
    <input name="fingerprint" required class="mono" style="width: 100%; height: 36px;">
    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin: 12px 0 4px;">机器标签(可选)</label>
    <input name="machine_label" placeholder="e.g. 我的 MacBook Pro" style="width: 100%; height: 36px;">
    <div style="margin-top: 16px;">
      <button type="submit" class="primary" style="width: 100%; justify-content: center;">激活</button>
    </div>
  </form>
</div>`;
  return standalone("激活", body);
}

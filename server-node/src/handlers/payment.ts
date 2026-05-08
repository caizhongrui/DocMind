/**
 * PayJS payment integration + post-payment license delivery.
 *
 * Routes:
 *   GET  /api/v1/payment/checkout?plan=lifetime
 *   POST /api/v1/payment/payjs/webhook
 *   GET  /api/v1/payment/order_status?o=&t=
 *   GET  /payment/success?o=&t=
 */

import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { generateKey } from "../license/sign.js";
import { payjsSign, payjsVerify } from "../payjs.js";
import { htmlEscape, standalone } from "../templates.js";
import { randomBytes } from "node:crypto";

export const paymentRouter = new Hono<AppEnv>();

function randomTicket(): string {
  return randomBytes(24).toString("hex");
}

// ── /api/v1/payment/checkout ───────────────────────────────────────────────
paymentRouter.get("/checkout", async (c) => {
  const { config, db } = c.var.app;
  const plan = c.req.query("plan") ?? "lifetime";
  const email = c.req.query("email") ?? "";
  if (plan !== "lifetime") return c.text("unknown plan", 400);
  if (!config.payjsMerchantId || !config.payjsKey) {
    return c.text("PayJS not configured", 500);
  }

  const outTradeNo = `DM-${Date.now()}`;
  const claimTicket = randomTicket();
  const amount = config.priceLifetimeFen;
  const body = "DocMind Pro 终身授权";

  db.prepare(
    `INSERT INTO orders (out_trade_no, amount, claim_ticket, raw_payload)
     VALUES (?, ?, ?, ?)`,
  ).run(outTradeNo, amount, claimTicket, email);

  const returnUrl = `https://${config.domain}/payment/success?o=${encodeURIComponent(outTradeNo)}&t=${encodeURIComponent(claimTicket)}`;

  const params: Record<string, string> = {
    mchid: config.payjsMerchantId,
    total_fee: String(amount),
    out_trade_no: outTradeNo,
    body,
    notify_url: config.payjsNotifyUrl,
    return_url: returnUrl,
  };
  params.sign = payjsSign(params, config.payjsKey);

  const qs = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join("&");
  return c.redirect(`https://payjs.cn/api/cashier?${qs}`);
});

// ── PayJS webhook ──────────────────────────────────────────────────────────
paymentRouter.post("/payjs/webhook", async (c) => {
  const { config, db } = c.var.app;

  // Body is form-encoded
  const formText = await c.req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(formText).entries()) {
    if (v !== "") params[k] = v;
  }

  if (!payjsVerify(params, config.payjsKey)) {
    console.warn("[payjs] webhook signature mismatch");
    return c.text("bad signature", 401);
  }

  const outTradeNo = params.out_trade_no;
  if (!outTradeNo) return c.text("missing out_trade_no", 400);

  const order = db
    .prepare(`SELECT id, license_key FROM orders WHERE out_trade_no = ?`)
    .get(outTradeNo) as { id: number; license_key: string | null } | undefined;
  if (!order) {
    console.warn(`[payjs] webhook for unknown order ${outTradeNo}; ignoring`);
    return c.text("success", 200);
  }
  if (order.license_key) {
    return c.text("success", 200); // idempotent
  }

  const newKey = generateKey();
  db.prepare(
    `INSERT INTO licenses (key, plan, order_id) VALUES (?, 'lifetime', ?)`,
  ).run(newKey, params.payjs_order_id ?? "");
  db.prepare(
    `UPDATE orders
        SET payjs_order_id = ?,
            paid_at = COALESCE(?, datetime('now')),
            license_key = ?,
            raw_payload = ?
      WHERE out_trade_no = ?`,
  ).run(
    params.transaction_id ?? null,
    params.paid_at ?? null,
    newKey,
    JSON.stringify(params),
    outTradeNo,
  );

  console.log(`[payjs] license ${newKey} issued for order ${outTradeNo}`);
  return c.text("success", 200);
});

// ── /api/v1/payment/order_status (JSON poll) ───────────────────────────────
paymentRouter.get("/order_status", (c) => {
  const { db } = c.var.app;
  const o = c.req.query("o") ?? "";
  const t = c.req.query("t") ?? "";
  if (!o || t.length < 32) return c.text("bad params", 403);

  const row = db
    .prepare(
      `SELECT (paid_at IS NOT NULL AND license_key IS NOT NULL) AS ready
         FROM orders WHERE out_trade_no = ? AND claim_ticket = ?`,
    )
    .get(o, t) as { ready: number } | undefined;
  return c.json({ ready: row?.ready ? true : false });
});

// ── /payment/success (HTML, registered on the app root) ────────────────────
export function paymentSuccessHandler() {
  return async (c: any) => {
    const { db } = c.var.app;
    const o = c.req.query("o") ?? "";
    const t = c.req.query("t") ?? "";
    if (!o || t.length < 32) return forbidden(c, "订单参数无效");

    type Row = {
      paid_at: string | null;
      license_key: string | null;
      amount: number;
    };
    const row = db
      .prepare(
        `SELECT paid_at, license_key, amount FROM orders
          WHERE out_trade_no = ? AND claim_ticket = ?`,
      )
      .get(o, t) as Row | undefined;

    if (!row) return forbidden(c, "订单不存在或访问令牌无效");

    if (row.paid_at && row.license_key) {
      db.prepare(
        `UPDATE orders SET claim_consumed_at = COALESCE(claim_consumed_at, datetime('now')) WHERE out_trade_no = ?`,
      ).run(o);
      return c.html(renderLicenseKey(o, row.license_key, row.amount));
    }
    return c.html(renderPolling(o, t));
  };
}

function forbidden(c: any, msg: string) {
  const body = `<div class="login-box" style="text-align:center;">
  <h1>访问被拒</h1>
  <p style="color: var(--text-muted); font-size: 13px; line-height: 1.7; margin: 14px 0;">${htmlEscape(msg)}</p>
  <p style="color: var(--text-muted); font-size: 12px;">如果你刚完成支付却看到这个页面,请联系客服并提供你的订单号。</p>
</div>`;
  return c.html(standalone("访问被拒", body), 403);
}

function renderPolling(outTradeNo: string, ticket: string): string {
  const oUrl = encodeURIComponent(outTradeNo);
  const tUrl = encodeURIComponent(ticket);
  const body = `<div class="login-box" style="text-align:center; width: 460px;">
  <div style="display:inline-flex; width: 56px; height: 56px; border-radius: 14px;
              background: var(--primary-bg); align-items:center; justify-content:center; margin-bottom: 14px;">
    <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" width="28" height="28">
      <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
    </svg>
  </div>
  <h1>等待支付确认...</h1>
  <p style="color: var(--text-muted); font-size: 13px; line-height: 1.7; margin: 14px 0;">
    支付平台正在通知我们的服务器,这通常需要 5-15 秒。
    页面会自动刷新,请勿关闭。
  </p>
  <p class="mono" style="font-size: 11px; color: var(--text-muted);">订单:${htmlEscape(outTradeNo)}</p>
  <p style="color: var(--text-muted); font-size: 12px; margin-top: 24px;">
    超过 1 分钟仍在此页面?请<a href="mailto:qdzy_cai@163.com" style="color: var(--primary);">联系客服</a>。
  </p>
  <noscript><p style="color: #ef4444; font-size: 12px;">未启用 JavaScript,请手动刷新本页面。</p></noscript>
</div>
<script>
  let attempts = 0;
  const reloadUrl = "/payment/success?o=${oUrl}&t=${tUrl}";
  const tick = () => {
    attempts++;
    if (attempts > 40) return;
    fetch("/api/v1/payment/order_status?o=${oUrl}&t=${tUrl}", { cache: "no-store" })
      .then(r => r.json())
      .then(data => { if (data.ready) location.href = reloadUrl; else setTimeout(tick, 3000); })
      .catch(() => setTimeout(tick, 3000));
  };
  setTimeout(tick, 3000);
</script>`;
  return standalone("等待支付", body);
}

function renderLicenseKey(
  outTradeNo: string,
  key: string,
  amountFen: number,
): string {
  const body = `<div class="login-box" style="width: 540px;">
  <div style="text-align:center;">
    <div style="display:inline-flex; width: 56px; height: 56px; border-radius: 14px;
                background: rgba(34,197,94,0.12); align-items:center; justify-content:center; margin-bottom: 14px;">
      <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" width="28" height="28">
        <path d="m5 13 4 4L19 7"/>
      </svg>
    </div>
    <h1>支付成功</h1>
    <p style="color: var(--text-muted); font-size: 12px; margin: 6px 0 24px;">
      订单 <span class="mono">${htmlEscape(outTradeNo)}</span> · ¥${(amountFen / 100).toFixed(2)}
    </p>
  </div>

  <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); margin-bottom: 8px;">
    你的 LICENSE KEY
  </div>
  <div id="license-key" class="mono" style="
    font-size: 16px; padding: 14px 18px; background: var(--surface-elevated);
    border: 1px solid var(--border); border-radius: 8px; word-break: break-all;
    color: var(--primary); font-weight: 600;">${htmlEscape(key)}</div>
  <div style="display:flex; gap: 8px; margin-top: 10px;">
    <button class="primary" onclick="copyKey()" style="flex:1;">复制 License Key</button>
    <button onclick="window.print()">打印备份</button>
  </div>

  <div style="margin-top: 24px; padding: 12px 14px; background: rgba(245,158,11,0.08);
              border: 1px solid rgba(245,158,11,0.25); border-radius: 8px; font-size: 12px;
              line-height: 1.7; color: #92400e;">
    <strong>请立即保存 License Key。</strong>
    建议同时:
    <ol style="margin: 4px 0 0 18px; padding: 0;">
      <li>截图本页</li>
      <li>把 key 复制到密码管理器</li>
      <li>把这个 URL 收藏到浏览器,日后还能找回</li>
    </ol>
  </div>

  <h2 style="margin-top: 24px;">如何激活</h2>
  <ol style="font-size: 13px; line-height: 1.8; padding-left: 20px;">
    <li>打开 DocMind 应用,点顶栏的 license 状态条</li>
    <li>点"已购买,输入 license key 激活"</li>
    <li>粘贴上方的 key,点"激活"</li>
  </ol>

  <div style="margin-top: 16px; padding: 12px 14px; background: rgba(239,68,68,0.06);
              border-left: 3px solid #ef4444; border-radius: 0 6px 6px 0; font-size: 12px;
              line-height: 1.7; color: var(--text-secondary);">
    <strong style="color:#dc2626;">⚠️ License 一旦绑定到设备,不可转移。</strong>
    请在你的常用电脑上完成激活。换机或重装会让 license 失效需重新购买。
  </div>
</div>
<script>
  function copyKey() {
    const text = document.getElementById('license-key').textContent.trim();
    navigator.clipboard.writeText(text).then(() => alert('已复制!'));
  }
</script>`;
  return standalone("支付成功", body);
}

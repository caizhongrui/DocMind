/**
 * 微信支付集成 + 支付完成后 license 交付。
 *
 * 路由:
 *   GET  /api/v1/payment/checkout?plan=lifetime
 *        创建订单 + 调微信 Native 预下单 → 渲染二维码页 → 用户用微信
 *        扫码支付 → 页面轮询直到 webhook 通过 → 自动跳 /payment/success
 *
 *   POST /api/v1/payment/wechat/webhook
 *        微信回调,验签 + AES-GCM 解密 → 拿到 trade_state 与 out_trade_no
 *        → 生成 license,与订单关联。**只有这条路径能写入 license_key。**
 *
 *   GET  /api/v1/payment/order_status?o=&t=
 *        前端轮询用,返回 { ready: bool }。
 *
 *   GET  /payment/success?o=&t=  (注册在公开路由)
 *        校验 (o,t) 后展示 license key 或继续轮询页。
 */

import { Hono } from "hono";
import QRCode from "qrcode";

import type { AppEnv } from "../app.js";
import { generateKey } from "../license/sign.js";
import { htmlEscape, standalone } from "../templates.js";
import { randomTicket } from "../util.js";
import {
  WechatPay,
  type WechatCallbackEnvelope,
  type WechatTransactionEvent,
} from "../wechatpay.js";

export const paymentRouter = new Hono<AppEnv>();

// ── /api/v1/payment/checkout ───────────────────────────────────────────────
paymentRouter.get("/checkout", async (c) => {
  const { config, db } = c.var.app;
  const plan = c.req.query("plan") ?? "lifetime";
  const email = c.req.query("email") ?? "";
  if (plan !== "lifetime") return c.text("unknown plan", 400);

  const w = config.wechat;
  if (!w.mchId || !w.appId || !w.apiV3Key || !w.privateKey || !w.certSerialNo) {
    return c.html(
      standalone(
        "支付未配置",
        `<div class="login-box" style="text-align:center;">
  <h1>支付未配置</h1>
  <p style="color: var(--text-muted); font-size: 13px; line-height: 1.7; margin: 14px 0;">
    服务器尚未配置微信支付凭据(WECHAT_MCH_ID / WECHAT_APP_ID /
    WECHAT_API_V3_KEY / WECHAT_MCH_CERT_SERIAL_NO / 商户私钥 / 平台证书)。
    请联系管理员。
  </p>
</div>`,
      ),
      500,
    );
  }

  const outTradeNo = `DM-${Date.now()}`;
  const claimTicket = randomTicket();
  const amount = config.priceLifetimeFen;
  const desc = "DocMind Pro 终身授权";

  db.prepare(
    `INSERT INTO orders (out_trade_no, amount, claim_ticket, raw_payload)
     VALUES (?, ?, ?, ?)`,
  ).run(outTradeNo, amount, claimTicket, email);

  const wp = new WechatPay(w);
  let codeUrl: string;
  try {
    codeUrl = await wp.createNativePrepay({
      outTradeNo,
      description: desc,
      amountFen: amount,
    });
  } catch (e) {
    console.error("[wechat] prepay failed:", e);
    return c.text(`微信预下单失败: ${(e as Error).message}`, 502);
  }

  const qrSvg = await QRCode.toString(codeUrl, {
    type: "svg",
    margin: 1,
    width: 220,
  });

  return c.html(renderQrPage(outTradeNo, claimTicket, qrSvg, amount, desc));
});

// ── /api/v1/payment/wechat/webhook ─────────────────────────────────────────
paymentRouter.post("/wechat/webhook", async (c) => {
  const { config, db } = c.var.app;
  const w = config.wechat;
  if (!w.platformCert || !w.apiV3Key) {
    console.warn("[wechat] webhook hit but creds missing");
    return c.json({ code: "FAIL", message: "server not configured" }, 500);
  }

  const timestamp = c.req.header("Wechatpay-Timestamp") ?? "";
  const nonce = c.req.header("Wechatpay-Nonce") ?? "";
  const signature = c.req.header("Wechatpay-Signature") ?? "";
  const rawBody = await c.req.text();

  const wp = new WechatPay(w);
  if (!wp.verifyCallback({ timestamp, nonce, body: rawBody, signature })) {
    console.warn("[wechat] webhook signature invalid");
    return c.json({ code: "FAIL", message: "signature invalid" }, 401);
  }

  let envelope: WechatCallbackEnvelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return c.json({ code: "FAIL", message: "bad envelope" }, 400);
  }

  let plaintext: string;
  try {
    plaintext = wp.decryptResource({
      ciphertext: envelope.resource.ciphertext,
      associatedData: envelope.resource.associated_data,
      nonce: envelope.resource.nonce,
    });
  } catch (e) {
    console.error("[wechat] decrypt failed:", e);
    return c.json({ code: "FAIL", message: "decrypt failed" }, 400);
  }

  let event: WechatTransactionEvent;
  try {
    event = JSON.parse(plaintext);
  } catch {
    return c.json({ code: "FAIL", message: "bad event payload" }, 400);
  }

  if (event.trade_state !== "SUCCESS") {
    return c.json({ code: "SUCCESS", message: "noted" });
  }

  const outTradeNo = event.out_trade_no;
  const order = db
    .prepare(`SELECT id, license_key FROM orders WHERE out_trade_no = ?`)
    .get(outTradeNo) as { id: number; license_key: string | null } | undefined;
  if (!order) {
    console.warn(`[wechat] webhook for unknown order ${outTradeNo}`);
    return c.json({ code: "SUCCESS", message: "unknown order" });
  }
  if (order.license_key) {
    return c.json({ code: "SUCCESS", message: "already processed" });
  }

  const newKey = generateKey();
  db.prepare(
    `INSERT INTO licenses (key, plan, order_id) VALUES (?, 'lifetime', ?)`,
  ).run(newKey, event.transaction_id);
  db.prepare(
    `UPDATE orders
        SET payjs_order_id = ?,
            paid_at = COALESCE(?, datetime('now')),
            payment_type = 'wechat',
            license_key = ?,
            raw_payload = ?
      WHERE out_trade_no = ?`,
  ).run(
    event.transaction_id,
    event.success_time,
    newKey,
    plaintext,
    outTradeNo,
  );

  console.log(`[wechat] license ${newKey} issued for order ${outTradeNo}`);
  return c.json({ code: "SUCCESS", message: "ok" });
});

// ── /api/v1/payment/order_status ──────────────────────────────────────────
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

    const row = db
      .prepare(
        `SELECT paid_at, license_key, amount FROM orders
          WHERE out_trade_no = ? AND claim_ticket = ?`,
      )
      .get(o, t) as
      | { paid_at: string | null; license_key: string | null; amount: number }
      | undefined;
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

// ── HTML renderers ────────────────────────────────────────────────────────
function forbidden(c: any, msg: string) {
  const body = `<div class="login-box" style="text-align:center;">
  <h1>访问被拒</h1>
  <p style="color: var(--text-muted); font-size: 13px; line-height: 1.7; margin: 14px 0;">${htmlEscape(msg)}</p>
  <p style="color: var(--text-muted); font-size: 12px;">如果你刚完成支付却看到这个页面,请联系客服并提供你的订单号。</p>
</div>`;
  return c.html(standalone("访问被拒", body), 403);
}

function renderQrPage(
  outTradeNo: string,
  ticket: string,
  qrSvg: string,
  amountFen: number,
  desc: string,
): string {
  const oUrl = encodeURIComponent(outTradeNo);
  const tUrl = encodeURIComponent(ticket);
  const body = `<div class="login-box" style="width: 480px;">
  <div style="text-align:center;">
    <div style="display:inline-flex; align-items:center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: rgba(34,197,94,0.12); margin-bottom: 12px;">
      <span style="display:inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e;"></span>
      <span style="font-size: 12px; color: #15803d; font-weight: 500;">微信支付</span>
    </div>
    <h1>扫码支付</h1>
    <p style="color: var(--text-muted); font-size: 12px; margin: 6px 0 18px;">
      ${htmlEscape(desc)} · <strong style="color: var(--text);">¥${(amountFen / 100).toFixed(2)}</strong>
    </p>
  </div>

  <div style="display:flex; justify-content:center; padding: 16px; background: #fff; border-radius: 12px;">
    ${qrSvg}
  </div>

  <p style="text-align:center; color: var(--text-secondary); font-size: 12px; margin-top: 14px;">
    打开微信 → 扫一扫 → 完成支付
  </p>

  <div id="status" style="margin-top: 16px; padding: 10px 12px; border-radius: 6px; background: var(--surface-elevated); border: 1px solid var(--border); font-size: 12px; color: var(--text-secondary); text-align: center;">
    <span style="display:inline-block; width: 6px; height: 6px; border-radius: 50%; background: #f59e0b; margin-right: 6px; animation: dm-pulse 1.5s ease-in-out infinite;"></span>
    等待支付...
  </div>

  <p class="mono" style="text-align:center; font-size: 10px; color: var(--text-muted); margin-top: 12px;">
    订单号 ${htmlEscape(outTradeNo)}
  </p>
</div>
<style>
  @keyframes dm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
<script>
  const successUrl = "/payment/success?o=${oUrl}&t=${tUrl}";
  let attempts = 0;
  const tick = () => {
    attempts++;
    if (attempts > 200) return;
    fetch("/api/v1/payment/order_status?o=${oUrl}&t=${tUrl}", { cache: "no-store" })
      .then(r => r.json())
      .then(d => { if (d.ready) location.href = successUrl; else setTimeout(tick, 3000); })
      .catch(() => setTimeout(tick, 3000));
  };
  setTimeout(tick, 3000);
</script>`;
  return standalone("扫码支付", body);
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
    支付平台正在通知我们的服务器,这通常需要 5-15 秒。页面会自动刷新,请勿关闭。
  </p>
  <p class="mono" style="font-size: 11px; color: var(--text-muted);">订单:${htmlEscape(outTradeNo)}</p>
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
      .then(d => { if (d.ready) location.href = reloadUrl; else setTimeout(tick, 3000); })
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

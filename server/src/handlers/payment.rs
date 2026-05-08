//! PayJS payment integration + post-payment license delivery.
//!
//! Three routes:
//!
//! `GET /api/v1/payment/checkout?plan=lifetime`
//!     Pre-creates an order with a unique random `claim_ticket` and redirects
//!     the browser to PayJS's hosted checkout page. PayJS will redirect the
//!     user back to `/payment/success?o=…&t=…` after payment.
//!
//! `POST /api/v1/payment/payjs/webhook`
//!     PayJS calls this when a payment succeeds. We verify the MD5 signature,
//!     create a `licenses` row with a freshly generated key, link it to the
//!     order, mark `paid_at`. The webhook is the *only* place a `license_key`
//!     gets written into an order — meaning the buyer cannot obtain a license
//!     without a confirmed payment.
//!
//! `GET /payment/success?o=<out_trade_no>&t=<claim_ticket>`
//!     User lands here after PayJS finishes. Both parameters must match a
//!     stored order, and the order must be paid before the license is shown.
//!     `(out_trade_no, claim_ticket)` form a per-order secret pair so an
//!     attacker who knows the trade number alone cannot fetch the license.

use std::collections::BTreeMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    Form,
};
use rand::Rng;
use serde::Deserialize;

use crate::license::sign;
use crate::payjs;
use crate::templates::{html_escape, standalone};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct CheckoutQuery {
    pub plan: Option<String>,
    pub email: Option<String>,
}

pub async fn start_checkout(
    State(state): State<AppState>,
    Query(q): Query<CheckoutQuery>,
) -> Response {
    let plan = q.plan.unwrap_or_else(|| "lifetime".into());
    if plan != "lifetime" {
        return (StatusCode::BAD_REQUEST, "unknown plan").into_response();
    }
    if state.cfg.payjs_merchant_id.is_empty() || state.cfg.payjs_key.is_empty() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "PayJS not configured (set PAYJS_MERCHANT_ID and PAYJS_KEY)",
        )
            .into_response();
    }

    let out_trade_no = format!("DM-{}", chrono::Utc::now().timestamp_millis());
    let claim_ticket = random_ticket();
    let amount = state.cfg.product_price_lifetime;
    let body = "DocMind Pro 终身授权";

    // Persist order shell with the claim ticket. The webhook later fills in
    // license_key + paid_at; the success page proves possession of the
    // ticket before revealing the key.
    if let Ok(conn) = state.db.lock() {
        let _ = conn.execute(
            "INSERT INTO orders (out_trade_no, amount, claim_ticket, raw_payload) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![out_trade_no, amount as i64, claim_ticket, q.email.unwrap_or_default()],
        );
    }

    // Build PayJS request
    let return_url = format!(
        "https://{}/payment/success?o={}&t={}",
        state.cfg.domain,
        urlencode(&out_trade_no),
        urlencode(&claim_ticket),
    );

    let mut params: BTreeMap<String, String> = BTreeMap::new();
    params.insert("mchid".into(), state.cfg.payjs_merchant_id.clone());
    params.insert("total_fee".into(), amount.to_string());
    params.insert("out_trade_no".into(), out_trade_no.clone());
    params.insert("body".into(), body.into());
    params.insert("notify_url".into(), state.cfg.payjs_notify_url.clone());
    params.insert("return_url".into(), return_url);
    let signature = payjs::sign(&params, &state.cfg.payjs_key);
    params.insert("sign".into(), signature);

    let qs = params
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let url = format!("https://payjs.cn/api/cashier?{qs}");
    Redirect::to(&url).into_response()
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn random_ticket() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 24] = rng.gen();
    hex::encode(bytes)
}

/// Webhook payload (form-encoded body per PayJS spec).
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // some fields are only inspected through the param map
pub struct WebhookForm {
    pub return_code: Option<String>,
    pub payjs_order_id: Option<String>,
    pub out_trade_no: Option<String>,
    pub total_fee: Option<String>,
    pub paid_at: Option<String>,
    pub mchid: Option<String>,
    pub openid: Option<String>,
    pub transaction_id: Option<String>,
    pub sign: Option<String>,
    pub body: Option<String>,
}

pub async fn payjs_webhook(
    State(state): State<AppState>,
    Form(form): Form<WebhookForm>,
) -> Response {
    let mut params: BTreeMap<String, String> = BTreeMap::new();
    if let Some(v) = &form.return_code { params.insert("return_code".into(), v.clone()); }
    if let Some(v) = &form.payjs_order_id { params.insert("payjs_order_id".into(), v.clone()); }
    if let Some(v) = &form.out_trade_no { params.insert("out_trade_no".into(), v.clone()); }
    if let Some(v) = &form.total_fee { params.insert("total_fee".into(), v.clone()); }
    if let Some(v) = &form.paid_at { params.insert("paid_at".into(), v.clone()); }
    if let Some(v) = &form.mchid { params.insert("mchid".into(), v.clone()); }
    if let Some(v) = &form.openid { params.insert("openid".into(), v.clone()); }
    if let Some(v) = &form.transaction_id { params.insert("transaction_id".into(), v.clone()); }
    if let Some(v) = &form.sign { params.insert("sign".into(), v.clone()); }

    if !payjs::verify(&params, &state.cfg.payjs_key) {
        tracing::warn!("payjs webhook: signature mismatch");
        return (StatusCode::UNAUTHORIZED, "bad signature").into_response();
    }

    let out_trade_no = match form.out_trade_no.as_deref() {
        Some(s) => s,
        None => return (StatusCode::BAD_REQUEST, "missing out_trade_no").into_response(),
    };

    // Idempotently mark order paid + create license if not already.
    let new_key = sign::generate_key();
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db lock").into_response(),
    };

    // Check the order exists in our DB. If not — webhook is for an unknown
    // order, which means someone's spoofing or our checkout never ran.
    let order_row: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT id, license_key FROM orders WHERE out_trade_no = ?1",
            [out_trade_no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (_, already_keyed) = match order_row {
        Some(r) => r,
        None => {
            tracing::warn!("webhook for unknown order {}; ignoring", out_trade_no);
            return (StatusCode::OK, "success").into_response();
        }
    };

    if already_keyed.is_some() {
        // Already processed this webhook — idempotent OK.
        return (StatusCode::OK, "success").into_response();
    }

    // Insert new license row (unbound, awaiting activation).
    let _ = conn.execute(
        "INSERT INTO licenses (key, plan, order_id) VALUES (?1, 'lifetime', ?2)",
        rusqlite::params![new_key, form.payjs_order_id.clone().unwrap_or_default()],
    );

    let _ = conn.execute(
        "UPDATE orders SET payjs_order_id = ?1, paid_at = COALESCE(?2, datetime('now')), \
            license_key = ?3, raw_payload = ?4 WHERE out_trade_no = ?5",
        rusqlite::params![
            form.transaction_id,
            form.paid_at,
            new_key,
            serde_json::to_string(&params).unwrap_or_default(),
            out_trade_no
        ],
    );

    tracing::info!(
        order = %out_trade_no,
        key = %new_key,
        "license issued via webhook"
    );

    (StatusCode::OK, "success").into_response()
}

#[derive(Debug, Deserialize)]
pub struct SuccessQuery {
    pub o: Option<String>,
    pub t: Option<String>,
}

/// Page the user lands on after PayJS finishes. Verifies the (o, t) pair,
/// then either shows the license key (if webhook already processed) or a
/// polling page that auto-refreshes until it shows.
pub async fn payment_success(
    State(state): State<AppState>,
    Query(q): Query<SuccessQuery>,
) -> Response {
    let out_trade_no = q.o.unwrap_or_default();
    let ticket = q.t.unwrap_or_default();
    if out_trade_no.is_empty() || ticket.len() < 32 {
        return forbidden("订单参数无效");
    }

    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db lock").into_response(),
    };

    // Look up by **both** out_trade_no and claim_ticket. Knowing only one is
    // not enough — the random ticket is the proof of purchase.
    let row: Option<(Option<String>, Option<String>, Option<String>, i64)> = conn
        .query_row(
            "SELECT paid_at, license_key, payment_type, amount FROM orders \
             WHERE out_trade_no = ?1 AND claim_ticket = ?2",
            [&out_trade_no, &ticket],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();

    let (paid_at, license_key, _payment_type, amount) = match row {
        Some(r) => r,
        None => return forbidden("订单不存在或访问令牌无效"),
    };

    match (paid_at, license_key) {
        (Some(_), Some(key)) => {
            // Mark first display time (if not already set) for telemetry.
            let _ = conn.execute(
                "UPDATE orders SET claim_consumed_at = COALESCE(claim_consumed_at, datetime('now')) \
                 WHERE out_trade_no = ?1",
                [&out_trade_no],
            );
            render_license_key(&out_trade_no, &key, amount)
        }
        _ => render_polling(&out_trade_no, &ticket),
    }
}

fn forbidden(msg: &str) -> Response {
    let body = format!(
        r##"<div class="login-box" style="text-align:center;">
  <h1>访问被拒</h1>
  <p style="color: var(--text-muted); font-size: 13px; line-height: 1.7; margin: 14px 0;">{msg}</p>
  <p style="color: var(--text-muted); font-size: 12px;">如果你刚完成支付却看到这个页面,请联系客服并提供你的订单号。</p>
</div>"##,
        msg = html_escape(msg)
    );
    (StatusCode::FORBIDDEN, standalone("访问被拒", &body)).into_response()
}

fn render_polling(out_trade_no: &str, ticket: &str) -> Response {
    let body = format!(
        r##"<div class="login-box" style="text-align:center; width: 460px;">
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
  <p class="mono" style="font-size: 11px; color: var(--text-muted);">订单:{ord}</p>
  <p style="color: var(--text-muted); font-size: 12px; margin-top: 24px;">
    超过 1 分钟仍在此页面?请<a href="mailto:qdzy_cai@163.com" style="color: var(--primary);">联系客服</a>。
  </p>
  <noscript>
    <p style="color: #ef4444; font-size: 12px;">未启用 JavaScript,请手动刷新本页面。</p>
  </noscript>
</div>
<script>
  // Poll every 3 seconds for up to 2 minutes; reload page when status flips.
  let attempts = 0;
  const url = "/payment/success?o={ord_url}&t={ticket_url}";
  const tick = () => {{
    attempts++;
    if (attempts > 40) return; // ~2 minutes
    fetch("/api/v1/payment/order_status?o={ord_url}&t={ticket_url}", {{ cache: "no-store" }})
      .then(r => r.json())
      .then(data => {{ if (data.ready) location.href = url; else setTimeout(tick, 3000); }})
      .catch(() => setTimeout(tick, 3000));
  }};
  setTimeout(tick, 3000);
</script>"##,
        ord = html_escape(out_trade_no),
        ord_url = urlencode(out_trade_no),
        ticket_url = urlencode(ticket),
    );
    standalone("等待支付", &body).into_response()
}

fn render_license_key(out_trade_no: &str, key: &str, amount_fen: i64) -> Response {
    let body = format!(
        r##"<div class="login-box" style="width: 540px;">
  <div style="text-align:center;">
    <div style="display:inline-flex; width: 56px; height: 56px; border-radius: 14px;
                background: rgba(34,197,94,0.12); align-items:center; justify-content:center; margin-bottom: 14px;">
      <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" width="28" height="28">
        <path d="m5 13 4 4L19 7"/>
      </svg>
    </div>
    <h1>支付成功</h1>
    <p style="color: var(--text-muted); font-size: 12px; margin: 6px 0 24px;">
      订单 <span class="mono">{ord}</span> · ¥{amt:.2}
    </p>
  </div>

  <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); margin-bottom: 8px;">
    你的 LICENSE KEY
  </div>
  <div id="license-key" class="mono" style="
    font-size: 16px; padding: 14px 18px; background: var(--surface-elevated);
    border: 1px solid var(--border); border-radius: 8px; word-break: break-all;
    color: var(--primary); font-weight: 600;">{key}</div>
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
      <li>把 key 复制到密码管理器(1Password / Bitwarden)</li>
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
  function copyKey() {{
    const text = document.getElementById('license-key').textContent.trim();
    navigator.clipboard.writeText(text).then(() => {{
      alert('已复制!');
    }});
  }}
</script>"##,
        ord = html_escape(out_trade_no),
        amt = amount_fen as f64 / 100.0,
        key = html_escape(key),
    );
    standalone("支付成功", &body).into_response()
}

/// Tiny JSON endpoint used by the polling page on `/payment/success` to
/// check whether the webhook has fired without doing a full HTML reload.
pub async fn order_status(
    State(state): State<AppState>,
    Query(q): Query<SuccessQuery>,
) -> Response {
    let out_trade_no = q.o.unwrap_or_default();
    let ticket = q.t.unwrap_or_default();
    if out_trade_no.is_empty() || ticket.len() < 32 {
        return (StatusCode::FORBIDDEN, "bad params").into_response();
    }
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db lock").into_response(),
    };
    let ready: bool = conn
        .query_row(
            "SELECT paid_at IS NOT NULL AND license_key IS NOT NULL FROM orders \
             WHERE out_trade_no = ?1 AND claim_ticket = ?2",
            [&out_trade_no, &ticket],
            |r| r.get::<_, i64>(0).map(|v| v != 0),
        )
        .unwrap_or(false);
    axum::Json(serde_json::json!({ "ready": ready })).into_response()
}

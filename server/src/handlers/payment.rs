//! PayJS payment integration.
//!
//! Two routes:
//!
//! `GET /api/v1/payment/checkout?plan=lifetime`
//!     Creates a PayJS QR-code order and redirects the user to PayJS's
//!     hosted checkout page. The portal site links to this from "立即购买".
//!
//! `POST /api/v1/payment/payjs/webhook`
//!     PayJS calls this when a payment succeeds. We verify the MD5 signature,
//!     create a `licenses` row with a freshly generated key, link it to the
//!     order, and (in a real deployment) email it to the buyer.

use std::collections::BTreeMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    Form,
};
use serde::Deserialize;

use crate::license::sign;
use crate::payjs;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct CheckoutQuery {
    pub plan: Option<String>,
    /// Optional buyer email — if the portal collects it before redirect we
    /// store it on the order so admin can later look it up.
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
    let amount = state.cfg.product_price_lifetime;
    let body = "DocMind Pro 终身授权";

    // Persist order shell so the webhook can find it.
    if let Ok(conn) = state.db.lock() {
        let _ = conn.execute(
            "INSERT INTO orders (out_trade_no, amount, raw_payload) VALUES (?1, ?2, ?3)",
            rusqlite::params![out_trade_no, amount as i64, q.email.unwrap_or_default()],
        );
    }

    // Build PayJS request
    let mut params: BTreeMap<String, String> = BTreeMap::new();
    params.insert("mchid".into(), state.cfg.payjs_merchant_id.clone());
    params.insert("total_fee".into(), amount.to_string());
    params.insert("out_trade_no".into(), out_trade_no.clone());
    params.insert("body".into(), body.into());
    params.insert("notify_url".into(), state.cfg.payjs_notify_url.clone());
    let signature = payjs::sign(&params, &state.cfg.payjs_key);
    params.insert("sign".into(), signature);

    // Use PayJS cashier (collection page) — redirect the browser to it.
    // For the `cashier` endpoint, params are passed in the query string.
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

/// Webhook payload (form-encoded body per PayJS spec).
#[derive(Debug, Deserialize)]
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
    // Reconstruct param map for signature verification.
    let mut params: BTreeMap<String, String> = BTreeMap::new();
    if let Some(v) = &form.return_code {
        params.insert("return_code".into(), v.clone());
    }
    if let Some(v) = &form.payjs_order_id {
        params.insert("payjs_order_id".into(), v.clone());
    }
    if let Some(v) = &form.out_trade_no {
        params.insert("out_trade_no".into(), v.clone());
    }
    if let Some(v) = &form.total_fee {
        params.insert("total_fee".into(), v.clone());
    }
    if let Some(v) = &form.paid_at {
        params.insert("paid_at".into(), v.clone());
    }
    if let Some(v) = &form.mchid {
        params.insert("mchid".into(), v.clone());
    }
    if let Some(v) = &form.openid {
        params.insert("openid".into(), v.clone());
    }
    if let Some(v) = &form.transaction_id {
        params.insert("transaction_id".into(), v.clone());
    }
    if let Some(v) = &form.sign {
        params.insert("sign".into(), v.clone());
    }

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

    let already_keyed: Option<String> = conn
        .query_row(
            "SELECT license_key FROM orders WHERE out_trade_no = ?1",
            [out_trade_no],
            |r| r.get(0),
        )
        .ok()
        .flatten();

    if already_keyed.is_some() {
        return (StatusCode::OK, "success").into_response();
    }

    // Insert new license row (unbound, awaiting activation).
    let _ = conn.execute(
        "INSERT INTO licenses (key, plan, order_id) VALUES (?1, 'lifetime', ?2)",
        rusqlite::params![new_key, form.payjs_order_id.unwrap_or_default()],
    );

    // Update order with payment info.
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

    // PayJS expects "success" body to ack.
    (StatusCode::OK, "success").into_response()
}

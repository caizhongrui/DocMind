//! Public-facing pages on `api.docmind.app`.
//!
//! - `/`           Tiny stub (the marketing portal lives at docmind.app).
//! - `/activate`   The page the desktop client links users to when they want
//!                 to type in their license key in a browser instead of
//!                 inside the app. We render the form, accept the form post,
//!                 call the same activation logic and show the result.

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Form,
};
use serde::Deserialize;

use crate::templates::{html_escape, standalone};
use crate::AppState;

pub async fn root() -> Response {
    standalone(
        "DocMind",
        r#"<div class="login-box" style="text-align: center;">
  <h1>DocMind License Server</h1>
  <p style="color: var(--text-muted); font-size: 12px; line-height: 1.7;">
    这里是 DocMind 的 license / 更新 / 支付 后台。如果你在找产品页,请前往
    <a href="https://docmind.app">docmind.app</a>。
  </p>
</div>"#,
    )
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct ActivateQuery {
    pub key: Option<String>,
    pub status: Option<String>,
    pub msg: Option<String>,
}

pub async fn activate_get(Query(q): Query<ActivateQuery>) -> Response {
    let key = q.key.clone().unwrap_or_default();
    let alert = match q.status.as_deref() {
        Some("ok") => format!(
            r#"<div class="alert alert-success">激活成功!请回到 DocMind 应用,license 状态会自动刷新。</div>"#
        ),
        Some("err") => format!(
            r#"<div class="alert alert-error">{}</div>"#,
            html_escape(q.msg.as_deref().unwrap_or("激活失败,请检查 license key"))
        ),
        _ => String::new(),
    };
    let body = format!(
        r#"<div class="login-box" style="width: 460px;">
  <h1>激活 DocMind Pro</h1>
  {alert}
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
    <input name="key" required placeholder="DM-XXXX-XXXX-XXXX-XXXX-XXXX" value="{key}" class="mono" style="width: 100%; height: 36px;">
    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin: 12px 0 4px;">硬件指纹(从应用顶栏获取)</label>
    <input name="fingerprint" required class="mono" style="width: 100%; height: 36px;">
    <label style="display:block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono); margin: 12px 0 4px;">机器标签(可选)</label>
    <input name="machine_label" placeholder="e.g. 我的 MacBook Pro" style="width: 100%; height: 36px;">
    <div style="margin-top: 16px;">
      <button type="submit" class="primary" style="width: 100%; justify-content: center;">激活</button>
    </div>
  </form>
</div>"#,
        alert = alert,
        key = html_escape(&key)
    );
    standalone("激活", &body).into_response()
}

#[derive(Debug, Deserialize)]
pub struct ActivatePostForm {
    pub key: String,
    pub fingerprint: String,
    pub machine_label: Option<String>,
}

pub async fn activate_post(
    State(state): State<AppState>,
    Form(form): Form<ActivatePostForm>,
) -> Response {
    let req = crate::handlers::license::ActivateRequest {
        key: form.key.clone(),
        fingerprint: form.fingerprint,
        machine_label: form.machine_label,
    };
    match crate::handlers::license::activate(State(state), axum::Json(req)).await {
        Ok(_) => axum::response::Redirect::to(&format!(
            "/activate?key={}&status=ok",
            urlencoding(&form.key)
        ))
        .into_response(),
        Err((_, msg)) => axum::response::Redirect::to(&format!(
            "/activate?key={}&status=err&msg={}",
            urlencoding(&form.key),
            urlencoding(&msg)
        ))
        .into_response(),
    }
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

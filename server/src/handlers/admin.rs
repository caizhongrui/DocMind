//! Admin UI handlers — server-rendered HTML (no SPA).
//!
//! Authentication: a single `ADMIN_PASSWORD` from env-vars. On successful
//! login we mint an opaque session token, persist it in `admin_sessions` and
//! set it as an HTTP-only cookie. Middleware on every protected route looks
//! the cookie up.

use axum::{
    extract::{Multipart, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Form,
};
use chrono::{Duration, Utc};
use rand::Rng;
use serde::Deserialize;

use crate::db::models::{Download, License, Order, Release};
use crate::license::sign;
use crate::templates::{html_escape, layout, standalone};
use crate::AppState;

const SESSION_COOKIE: &str = "docmind_admin_session";

// ── Auth helpers ───────────────────────────────────────────────────────────

fn require_session(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let token = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookies| {
            cookies
                .split(';')
                .map(|c| c.trim())
                .find_map(|c| c.strip_prefix(&format!("{SESSION_COOKIE}=")))
                .map(|s| s.to_string())
        });
    let token = match token {
        Some(t) => t,
        None => return Err(Redirect::to("/admin/login").into_response()),
    };
    let conn = state
        .db
        .lock()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "db").into_response())?;
    let valid: bool = conn
        .query_row(
            "SELECT 1 FROM admin_sessions WHERE token = ?1 AND expires_at > datetime('now')",
            [&token],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !valid {
        return Err(Redirect::to("/admin/login").into_response());
    }
    Ok(())
}

fn session_cookie(token: &str, expires: chrono::DateTime<Utc>) -> String {
    let max_age = (expires - Utc::now()).num_seconds().max(0);
    format!(
        "{SESSION_COOKIE}={token}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age={max_age}"
    )
}

fn random_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 24] = rng.gen();
    hex::encode(bytes)
}

// ── Login ──────────────────────────────────────────────────────────────────

pub async fn login_get() -> Response {
    let body = r#"
<div class="login-box">
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
</div>
"#;
    standalone("登录", body).into_response()
}

#[derive(Debug, Deserialize)]
pub struct LoginForm {
    pub username: String,
    pub password: String,
}

pub async fn login_post(
    State(state): State<AppState>,
    Form(form): Form<LoginForm>,
) -> Response {
    let supplied_hash = crate::payjs::sha256_hex(form.password.as_bytes());
    if form.username != state.cfg.admin_username
        || supplied_hash != *state.admin_password_hash
    {
        return standalone(
            "登录失败",
            r#"<div class="login-box">
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
</div>"#,
        )
        .into_response();
    }

    let token = random_token();
    let expires = Utc::now() + Duration::days(7);
    if let Ok(conn) = state.db.lock() {
        let _ = conn.execute(
            "INSERT INTO admin_sessions (token, expires_at) VALUES (?1, ?2)",
            rusqlite::params![token, expires.to_rfc3339()],
        );
    }
    let cookie = session_cookie(&token, expires);
    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::SET_COOKIE, cookie)
        .header(header::LOCATION, "/admin")
        .body(axum::body::Body::empty())
        .unwrap()
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Some(token) = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| {
            c.split(';')
                .map(str::trim)
                .find_map(|c| c.strip_prefix(&format!("{SESSION_COOKIE}=")))
                .map(|s| s.to_string())
        })
    {
        if let Ok(conn) = state.db.lock() {
            let _ = conn.execute("DELETE FROM admin_sessions WHERE token = ?1", [token]);
        }
    }
    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::SET_COOKIE, format!("{SESSION_COOKIE}=; Max-Age=0; Path=/admin"))
        .header(header::LOCATION, "/admin/login")
        .body(axum::body::Body::empty())
        .unwrap()
}

// ── Overview ───────────────────────────────────────────────────────────────

pub async fn overview(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db").into_response(),
    };

    let total_licenses: i64 = conn
        .query_row("SELECT COUNT(*) FROM licenses", [], |r| r.get(0))
        .unwrap_or(0);
    let total_orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders WHERE paid_at IS NOT NULL", [], |r| {
            r.get(0)
        })
        .unwrap_or(0);
    let total_downloads: i64 = conn
        .query_row("SELECT COUNT(*) FROM downloads", [], |r| r.get(0))
        .unwrap_or(0);
    let revenue_today: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM orders WHERE paid_at >= date('now')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let revenue_month: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM orders \
             WHERE paid_at >= date('now', 'start of month')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let recent_orders = recent_orders_query(&conn, 10);

    let body = format!(
        r#"
<h1>概览</h1>
<div class="stat-grid">
  <div class="stat"><div class="stat-label">License 总数</div><div class="stat-value">{tl}</div></div>
  <div class="stat"><div class="stat-label">已支付订单</div><div class="stat-value">{to}</div></div>
  <div class="stat"><div class="stat-label">下载次数</div><div class="stat-value">{td}</div></div>
  <div class="stat"><div class="stat-label">本月收入</div><div class="stat-value">¥{rm:.2}</div></div>
</div>
<div class="card">
  <div class="row" style="justify-content: space-between; margin-bottom: 8px;">
    <span style="font-weight: 600;">最近订单</span>
    <span style="color: var(--text-muted); font-size: 11px;">今日收入 ¥{rt:.2}</span>
  </div>
  <table>
    <thead><tr><th>订单号</th><th>金额</th><th>支付时间</th><th>License</th></tr></thead>
    <tbody>{rows}</tbody>
  </table>
</div>
"#,
        tl = total_licenses,
        to = total_orders,
        td = total_downloads,
        rm = revenue_month as f64 / 100.0,
        rt = revenue_today as f64 / 100.0,
        rows = recent_orders
            .iter()
            .map(|o| format!(
                "<tr><td class=\"mono\">{}</td><td class=\"mono\">¥{:.2}</td><td>{}</td><td class=\"mono\">{}</td></tr>",
                html_escape(&o.out_trade_no),
                o.amount as f64 / 100.0,
                o.paid_at.map(|d| d.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_else(|| "—".into()),
                o.license_key.clone().unwrap_or_else(|| "—".into())
            ))
            .collect::<Vec<_>>()
            .join("")
    );

    layout("概览", &body).into_response()
}

// ── Licenses ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub q: Option<String>,
}

pub async fn licenses_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db").into_response(),
    };
    let needle = q.q.clone().unwrap_or_default();
    let pat = format!("%{}%", needle);
    let mut stmt = conn
        .prepare(
            "SELECT id, key, plan, order_id, buyer_email, bound_fingerprint, bound_at, \
                    machine_label, created_at, note FROM licenses \
             WHERE key LIKE ?1 OR COALESCE(buyer_email, '') LIKE ?1 \
             ORDER BY created_at DESC LIMIT 200",
        )
        .unwrap();
    let rows: Vec<License> = stmt
        .query_map([&pat], license_from_row)
        .map(|iter| iter.flatten().collect())
        .unwrap_or_default();

    let table_rows = rows
        .iter()
        .map(|l| {
            let state_chip = if l.bound_fingerprint.is_some() {
                r#"<span class="chip chip-primary">已激活</span>"#
            } else {
                r#"<span class="chip">未激活</span>"#
            };
            format!(
                r#"<tr>
  <td><a class="mono" href="/admin/licenses/{key}">{key}</a></td>
  <td>{plan}</td>
  <td>{state}</td>
  <td>{email}</td>
  <td class="mono">{bound_at}</td>
</tr>"#,
                key = html_escape(&l.key),
                plan = html_escape(&l.plan),
                state = state_chip,
                email = html_escape(l.buyer_email.as_deref().unwrap_or("—")),
                bound_at = l
                    .bound_at
                    .map(|d| d.format("%Y-%m-%d").to_string())
                    .unwrap_or_else(|| "—".into())
            )
        })
        .collect::<Vec<_>>()
        .join("");

    let body = format!(
        r#"
<h1>License</h1>
<form method="GET" action="/admin/licenses" style="margin-bottom: 12px;">
  <input name="q" placeholder="搜索 license key 或邮箱" value="{q}" style="width: 320px;">
  <button class="primary" type="submit">搜索</button>
  <a class="btn" href="/admin/licenses/issue" style="margin-left: 8px;">手动签发</a>
</form>
<table>
  <thead><tr><th>License key</th><th>Plan</th><th>状态</th><th>邮箱</th><th>激活时间</th></tr></thead>
  <tbody>{rows}</tbody>
</table>
"#,
        q = html_escape(&needle),
        rows = table_rows
    );
    layout("License", &body).into_response()
}

pub async fn license_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(key): axum::extract::Path<String>,
) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db").into_response(),
    };
    let license: Option<License> = conn
        .query_row(
            "SELECT id, key, plan, order_id, buyer_email, bound_fingerprint, bound_at, \
                    machine_label, created_at, note FROM licenses WHERE key = ?1",
            [&key],
            license_from_row,
        )
        .ok();
    let license = match license {
        Some(l) => l,
        None => return (StatusCode::NOT_FOUND, "license not found").into_response(),
    };
    let order: Option<Order> = license
        .order_id
        .as_deref()
        .and_then(|oid| {
            conn.query_row(
                "SELECT id, payjs_order_id, out_trade_no, amount, paid_at, payment_type, \
                        license_key, raw_payload, created_at FROM orders WHERE payjs_order_id = ?1",
                [oid],
                order_from_row,
            )
            .ok()
        });

    let body = format!(
        r#"
<h1>License 详情</h1>
<div class="card">
  <h2>基本信息</h2>
  <div class="mono" style="font-size: 14px;">{key}</div>
  <div style="margin-top: 8px;">Plan: <span class="chip chip-primary">{plan}</span></div>
  <div style="margin-top: 8px;">创建时间: {created}</div>
  <div style="margin-top: 8px;">备注: {note}</div>
</div>
<div class="card">
  <h2>设备绑定</h2>
  <div>状态: {state}</div>
  <div style="margin-top: 8px;">指纹: <span class="mono">{fp}</span></div>
  <div style="margin-top: 8px;">机器标签: {label}</div>
  <div style="margin-top: 8px;">激活时间: {bound_at}</div>
  <p style="color: var(--text-muted); font-size: 11px; margin-top: 12px;">
    按设计,License 一旦绑定到设备即不可转移。如客户因硬件故障要求重发,请走"手动签发新 License"流程,而非解绑。
  </p>
</div>
{order_block}
"#,
        key = html_escape(&license.key),
        plan = html_escape(&license.plan),
        created = license.created_at.format("%Y-%m-%d %H:%M"),
        note = html_escape(license.note.as_deref().unwrap_or("—")),
        state = if license.bound_fingerprint.is_some() {
            r#"<span class="chip chip-primary">已激活</span>"#.to_string()
        } else {
            r#"<span class="chip">未激活</span>"#.to_string()
        },
        fp = html_escape(license.bound_fingerprint.as_deref().unwrap_or("—")),
        label = html_escape(license.machine_label.as_deref().unwrap_or("—")),
        bound_at = license
            .bound_at
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "—".into()),
        order_block = match order {
            Some(o) => format!(
                r#"<div class="card"><h2>关联订单</h2>
<div>订单号: <span class="mono">{}</span></div>
<div>金额: ¥{:.2}</div>
<div>支付时间: {}</div></div>"#,
                html_escape(&o.out_trade_no),
                o.amount as f64 / 100.0,
                o.paid_at
                    .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_else(|| "—".into())
            ),
            None => String::new(),
        }
    );
    layout("License 详情", &body).into_response()
}

// ── Manual issue ───────────────────────────────────────────────────────────

pub async fn issue_form(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let body = r#"
<h1>手动签发 License</h1>
<div class="card">
  <form method="POST" action="/admin/licenses/issue">
    <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono);">买家邮箱（可选,用于备注）</label>
    <input name="email" style="width: 100%; max-width: 360px; margin: 4px 0 12px;">
    <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-family: var(--font-mono);">备注</label>
    <input name="note" style="width: 100%; max-width: 360px; margin: 4px 0 12px;" placeholder="例如:微信好友直转 / 退款重发 / 测试">
    <button class="primary" type="submit">生成 License Key</button>
  </form>
</div>
"#;
    layout("手动签发", body).into_response()
}

#[derive(Debug, Deserialize)]
pub struct IssueForm {
    pub email: Option<String>,
    pub note: Option<String>,
}

pub async fn issue_submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<IssueForm>,
) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let key = sign::generate_key();
    if let Ok(conn) = state.db.lock() {
        let _ = conn.execute(
            "INSERT INTO licenses (key, plan, buyer_email, note) VALUES (?1, 'lifetime', ?2, ?3)",
            rusqlite::params![key, form.email, form.note],
        );
    }
    let body = format!(
        r#"
<h1>已签发</h1>
<div class="card">
  <div class="alert alert-success">已生成新 License Key。请发给客户。</div>
  <div class="mono" style="font-size: 18px; padding: 12px; background: var(--surface-elevated); border-radius: 8px;">{key}</div>
  <div style="margin-top: 16px;">
    <a class="btn" href="/admin/licenses/{key}">查看详情</a>
    <a class="btn" href="/admin/licenses/issue">再签一个</a>
  </div>
</div>
"#,
        key = html_escape(&key)
    );
    layout("已签发", &body).into_response()
}

// ── Orders ─────────────────────────────────────────────────────────────────

pub async fn orders_list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db").into_response(),
    };
    let mut stmt = conn
        .prepare(
            "SELECT id, payjs_order_id, out_trade_no, amount, paid_at, payment_type, \
                    license_key, raw_payload, created_at FROM orders \
             ORDER BY created_at DESC LIMIT 200",
        )
        .unwrap();
    let rows: Vec<Order> = stmt
        .query_map([], order_from_row)
        .map(|iter| iter.flatten().collect())
        .unwrap_or_default();
    let table = rows
        .iter()
        .map(|o| {
            format!(
                "<tr><td class=\"mono\">{tno}</td><td class=\"mono\">¥{amt:.2}</td><td>{paid}</td><td class=\"mono\">{key}</td><td>{kind}</td></tr>",
                tno = html_escape(&o.out_trade_no),
                amt = o.amount as f64 / 100.0,
                paid = o
                    .paid_at
                    .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_else(|| "未支付".into()),
                key = html_escape(o.license_key.as_deref().unwrap_or("—")),
                kind = html_escape(o.payment_type.as_deref().unwrap_or("—"))
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let body = format!(
        r#"
<h1>订单流水</h1>
<table>
  <thead><tr><th>订单号</th><th>金额</th><th>支付时间</th><th>License</th><th>支付方式</th></tr></thead>
  <tbody>{table}</tbody>
</table>
"#
    );
    layout("订单", &body).into_response()
}

// ── Downloads ──────────────────────────────────────────────────────────────

pub async fn downloads_list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db").into_response(),
    };
    let mut stmt = conn
        .prepare(
            "SELECT id, ts, version, platform, edition, license_key, ip, user_agent, bytes_served \
             FROM downloads ORDER BY ts DESC LIMIT 200",
        )
        .unwrap();
    let rows: Vec<Download> = stmt
        .query_map([], download_from_row)
        .map(|iter| iter.flatten().collect())
        .unwrap_or_default();
    let table = rows
        .iter()
        .map(|d| {
            format!(
                "<tr><td>{ts}</td><td class=\"mono\">{ver}</td><td class=\"mono\">{plat}</td><td>{ed}</td><td class=\"mono\">{key}</td><td class=\"mono\">{ip}</td></tr>",
                ts = d.ts.format("%Y-%m-%d %H:%M"),
                ver = html_escape(&d.version),
                plat = html_escape(&d.platform),
                ed = html_escape(&d.edition),
                key = html_escape(d.license_key.as_deref().unwrap_or("—")),
                ip = html_escape(&d.ip)
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let body = format!(
        r#"
<h1>下载日志</h1>
<table>
  <thead><tr><th>时间</th><th>版本</th><th>平台</th><th>版本类型</th><th>License</th><th>IP</th></tr></thead>
  <tbody>{table}</tbody>
</table>
"#
    );
    layout("下载日志", &body).into_response()
}

// ── Releases ───────────────────────────────────────────────────────────────

pub async fn releases_list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db").into_response(),
    };
    let mut stmt = conn
        .prepare(
            "SELECT id, version, platform, edition, file_path, sha256, size, signature, \
                    notes, published_at FROM releases ORDER BY published_at DESC LIMIT 100",
        )
        .unwrap();
    let rows: Vec<Release> = stmt
        .query_map([], release_from_row)
        .map(|iter| iter.flatten().collect())
        .unwrap_or_default();
    let table = rows
        .iter()
        .map(|r| {
            format!(
                "<tr><td class=\"mono\">{v}</td><td class=\"mono\">{p}</td><td>{e}</td><td class=\"mono\">{f}</td><td class=\"mono\">{s}</td></tr>",
                v = html_escape(&r.version),
                p = html_escape(&r.platform),
                e = html_escape(&r.edition),
                f = html_escape(&r.file_path),
                s = format!("{:.1} MB", r.size as f64 / (1024.0 * 1024.0))
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let body = format!(
        r#"
<h1>版本管理</h1>
<div class="card">
  <h2>上传新版本</h2>
  <form method="POST" action="/admin/releases" enctype="multipart/form-data">
    <div class="row" style="gap: 12px; flex-wrap: wrap; margin-bottom: 8px;">
      <input name="version" placeholder="版本号 e.g. 0.2.0" required>
      <input name="platform" placeholder="平台 e.g. darwin-aarch64" required>
      <select name="edition"><option value="free">free</option><option value="pro">pro</option></select>
    </div>
    <div class="row" style="gap: 12px; margin-bottom: 8px;">
      <input type="file" name="binary" required>
      <input type="file" name="signature" placeholder=".sig 签名文件">
    </div>
    <textarea name="notes" placeholder="更新说明" style="width: 100%; min-height: 80px; margin-bottom: 8px;"></textarea>
    <button class="primary" type="submit">发布</button>
  </form>
</div>
<table>
  <thead><tr><th>版本</th><th>平台</th><th>类型</th><th>文件名</th><th>大小</th></tr></thead>
  <tbody>{table}</tbody>
</table>
"#
    );
    layout("版本", &body).into_response()
}

pub async fn releases_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let mut version = String::new();
    let mut platform = String::new();
    let mut edition = String::from("free");
    let mut notes = String::new();
    let mut binary: Option<(String, Vec<u8>)> = None;
    let mut signature: Option<String> = None;

    while let Some(field) = multipart.next_field().await.ok().flatten() {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "version" => version = field.text().await.unwrap_or_default(),
            "platform" => platform = field.text().await.unwrap_or_default(),
            "edition" => edition = field.text().await.unwrap_or_default(),
            "notes" => notes = field.text().await.unwrap_or_default(),
            "binary" => {
                let filename = field.file_name().unwrap_or("upload.bin").to_string();
                let bytes = field.bytes().await.unwrap_or_default().to_vec();
                binary = Some((filename, bytes));
            }
            "signature" => {
                let bytes = field.bytes().await.unwrap_or_default();
                if !bytes.is_empty() {
                    signature = Some(String::from_utf8_lossy(&bytes).trim().to_string());
                }
            }
            _ => {}
        }
    }

    let (filename, bytes) = match binary {
        Some(b) if !b.1.is_empty() => b,
        _ => return (StatusCode::BAD_REQUEST, "missing binary").into_response(),
    };
    if version.is_empty() || platform.is_empty() {
        return (StatusCode::BAD_REQUEST, "version + platform required").into_response();
    }
    let dir = state
        .cfg
        .releases_dir
        .join(&edition)
        .join(&platform);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    let dest = dir.join(&filename);
    if let Err(e) = std::fs::write(&dest, &bytes) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    let sha = crate::payjs::sha256_hex(&bytes);
    let sig = signature.unwrap_or_default();
    if let Ok(conn) = state.db.lock() {
        let _ = conn.execute(
            "INSERT INTO releases (version, platform, edition, file_path, sha256, size, signature, notes) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(version, platform, edition) DO UPDATE SET \
                file_path = excluded.file_path, sha256 = excluded.sha256, \
                size = excluded.size, signature = excluded.signature, notes = excluded.notes",
            rusqlite::params![
                version,
                platform,
                edition,
                filename,
                sha,
                bytes.len() as i64,
                sig,
                notes
            ],
        );
    }
    Redirect::to("/admin/releases").into_response()
}

// ── Row helpers ────────────────────────────────────────────────────────────

fn license_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<License> {
    use rusqlite::types::Value;
    let bound_at_str: Option<String> = r.get(6).ok();
    let created_at_str: String = r.get::<_, Value>(8).map(|v| match v {
        Value::Text(s) => s,
        _ => String::new(),
    }).unwrap_or_default();
    Ok(License {
        id: r.get(0)?,
        key: r.get(1)?,
        plan: r.get(2)?,
        order_id: r.get(3).ok(),
        buyer_email: r.get(4).ok(),
        bound_fingerprint: r.get(5).ok(),
        bound_at: bound_at_str.as_deref().and_then(parse_dt),
        machine_label: r.get(7).ok(),
        created_at: parse_dt(&created_at_str).unwrap_or_else(Utc::now),
        note: r.get(9).ok(),
    })
}

fn order_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Order> {
    let paid_at: Option<String> = r.get(4).ok();
    let created_at: String = r.get(8).unwrap_or_default();
    Ok(Order {
        id: r.get(0)?,
        payjs_order_id: r.get(1).ok(),
        out_trade_no: r.get(2)?,
        amount: r.get(3)?,
        paid_at: paid_at.as_deref().and_then(parse_dt),
        payment_type: r.get(5).ok(),
        license_key: r.get(6).ok(),
        raw_payload: r.get(7).ok(),
        created_at: parse_dt(&created_at).unwrap_or_else(Utc::now),
        // The admin queries don't ask for these columns yet; default them.
        // Future admin views can switch to a wider SELECT and populate them.
        claim_ticket: None,
        claim_consumed_at: None,
    })
}

fn download_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Download> {
    let ts: String = r.get(1)?;
    Ok(Download {
        id: r.get(0)?,
        ts: parse_dt(&ts).unwrap_or_else(Utc::now),
        version: r.get(2)?,
        platform: r.get(3)?,
        edition: r.get(4)?,
        license_key: r.get(5).ok(),
        ip: r.get(6)?,
        user_agent: r.get(7).ok(),
        bytes_served: r.get(8).ok(),
    })
}

fn release_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Release> {
    let pub_at: String = r.get(9)?;
    Ok(Release {
        id: r.get(0)?,
        version: r.get(1)?,
        platform: r.get(2)?,
        edition: r.get(3)?,
        file_path: r.get(4)?,
        sha256: r.get(5)?,
        size: r.get(6)?,
        signature: r.get(7)?,
        notes: r.get(8).ok(),
        published_at: parse_dt(&pub_at).unwrap_or_else(Utc::now),
    })
}

fn parse_dt(s: &str) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|d| d.and_utc())
        })
}

fn recent_orders_query(conn: &rusqlite::Connection, limit: i64) -> Vec<Order> {
    let mut stmt = match conn.prepare(
        "SELECT id, payjs_order_id, out_trade_no, amount, paid_at, payment_type, \
                license_key, raw_payload, created_at FROM orders \
         WHERE paid_at IS NOT NULL ORDER BY paid_at DESC LIMIT ?1",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([limit], order_from_row)
        .map(|iter| iter.flatten().collect())
        .unwrap_or_default()
}

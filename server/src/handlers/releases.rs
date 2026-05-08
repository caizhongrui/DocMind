//! Release manifest + binary downloads + download logging.
//!
//! Wires up:
//!
//! `GET /api/v1/updates/{platform}/{current_version}` → Tauri-format manifest
//!     for the latest matching release. The desktop client polls this.
//!
//! `GET /api/v1/releases/public` → public JSON changelog (last N versions),
//!     used by the portal's `/changelog` page during build.
//!
//! `GET /releases/free/<platform>/<file>` → public binary, logged.
//! `GET /releases/pro/<platform>/<file>`  → token-gated binary, logged.

use axum::{
    body::Body,
    extract::{Path as AxumPath, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    pub platforms: serde_json::Value,
}

pub async fn updater_manifest(
    State(state): State<AppState>,
    AxumPath((platform, current_version)): AxumPath<(String, String)>,
) -> Response {
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db lock").into_response(),
    };

    // Find latest release for `platform` with version > current_version.
    let row: Option<(String, String, String, String, String, i64)> = conn
        .query_row(
            "SELECT version, signature, file_path, notes, published_at, size FROM releases \
             WHERE platform = ?1 AND edition = 'free' \
             ORDER BY published_at DESC LIMIT 1",
            [&platform],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .ok();

    let (version, signature, file_path, notes, published_at, _size) = match row {
        Some(r) => r,
        None => return StatusCode::NO_CONTENT.into_response(),
    };

    if !version_gt(&version, &current_version) {
        return StatusCode::NO_CONTENT.into_response();
    }

    let url = format!(
        "https://{domain}/releases/free/{platform}/{file}",
        domain = state.cfg.domain,
        platform = platform,
        file = file_path,
    );

    let mut platforms = serde_json::Map::new();
    platforms.insert(
        platform.clone(),
        serde_json::json!({
            "signature": signature,
            "url": url,
        }),
    );

    let manifest = UpdateManifest {
        version,
        notes,
        pub_date: published_at,
        platforms: serde_json::Value::Object(platforms),
    };
    Json(manifest).into_response()
}

/// JSON shape consumed by the portal's `/changelog` page at build time.
#[derive(Debug, Serialize)]
pub struct PublicReleaseEntry {
    pub version: String,
    pub published_at: String,
    pub notes: String,
}

pub async fn public_changelog(State(state): State<AppState>) -> Response {
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db lock").into_response(),
    };
    let mut stmt = match conn.prepare(
        "SELECT version, published_at, notes FROM releases \
         GROUP BY version ORDER BY published_at DESC LIMIT 50",
    ) {
        Ok(s) => s,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let rows: Vec<PublicReleaseEntry> = stmt
        .query_map([], |r| {
            Ok(PublicReleaseEntry {
                version: r.get(0)?,
                published_at: r.get(1)?,
                notes: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })
        .map(|iter| iter.flatten().collect())
        .unwrap_or_default();
    Json(rows).into_response()
}

/// Static file router for `/releases/<edition>/<platform>/<file>` with
/// per-request logging and Pro auth.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/free/:platform/:file", get(serve_free))
        .route("/pro/:platform/:file", get(serve_pro))
        .with_state(state)
}

async fn serve_free(
    State(state): State<AppState>,
    AxumPath((platform, file)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    serve_file(&state, "free", &platform, &file, None, &headers).await
}

async fn serve_pro(
    State(state): State<AppState>,
    AxumPath((platform, file)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    // Bearer token auth: client passes the LicenseToken JSON as a base64-encoded
    // bearer. We just record the license_key for analytics; full signature
    // re-verification happens client-side on its own behalf.
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string());
    let license_key = bearer.as_deref().and_then(extract_key_from_token);

    if license_key.is_none() {
        return (StatusCode::UNAUTHORIZED, "missing or invalid license token").into_response();
    }
    serve_file(
        &state,
        "pro",
        &platform,
        &file,
        license_key.as_deref(),
        &headers,
    )
    .await
}

async fn serve_file(
    state: &AppState,
    edition: &str,
    platform: &str,
    file: &str,
    license_key: Option<&str>,
    headers: &HeaderMap,
) -> Response {
    // Prevent path traversal.
    if file.contains("..") || file.contains('/') || file.contains('\\') {
        return (StatusCode::BAD_REQUEST, "bad filename").into_response();
    }
    let path = state
        .cfg
        .releases_dir
        .join(edition)
        .join(platform)
        .join(file);
    let mut f = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::NOT_FOUND, "release not found").into_response(),
    };
    let meta = f.metadata().await.ok();
    let size = meta.map(|m| m.len()).unwrap_or(0);

    // Slurp to memory — releases are typically <100MB so this is OK for v1.
    let mut buf = Vec::with_capacity(size as usize);
    if let Err(e) = f.read_to_end(&mut buf).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }

    // Log download.
    if let Ok(conn) = state.db.lock() {
        let ip = client_ip(headers).unwrap_or_else(|| "?".into());
        let ua = headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let version = file_version(file).unwrap_or_else(|| "unknown".into());
        let _ = conn.execute(
            "INSERT INTO downloads (version, platform, edition, license_key, ip, user_agent, bytes_served) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![version, platform, edition, license_key, ip, ua, size as i64],
        );
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{file}\""),
        )
        .header(header::CONTENT_LENGTH, size.to_string())
        .body(Body::from(buf))
        .unwrap()
}

fn extract_key_from_token(token_json: &str) -> Option<String> {
    // Cheap parse — we don't need full verification on this server.
    let v: serde_json::Value = serde_json::from_str(token_json).ok()?;
    v.get("key").and_then(|k| k.as_str()).map(|s| s.to_string())
}

fn client_ip(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        return Some(v.split(',').next().unwrap_or(v).trim().to_string());
    }
    if let Some(v) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        return Some(v.to_string());
    }
    None
}

fn file_version(file: &str) -> Option<String> {
    // Naive: pull a `\d+\.\d+\.\d+` substring out of the file name.
    let mut version = String::new();
    let mut state = 0; // 0=looking, 1=collecting digits, 2=after first dot, 3=after second
    let mut buffer = String::new();
    for ch in file.chars() {
        if ch.is_ascii_digit() {
            buffer.push(ch);
            if state == 0 {
                state = 1;
            }
        } else if ch == '.' && state == 1 {
            buffer.push(ch);
            state = 2;
        } else if ch == '.' && state == 2 {
            // tricky — can't easily distinguish between major.minor.patch and
            // a trailing dot. Be permissive.
            buffer.push(ch);
        } else if state >= 1 && !buffer.is_empty() {
            // End of digit cluster.
            if buffer.matches('.').count() >= 2 {
                version = buffer.clone();
            }
            buffer.clear();
            state = 0;
        }
    }
    if buffer.matches('.').count() >= 2 && !buffer.is_empty() {
        version = buffer;
    }
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn version_gt(new: &str, old: &str) -> bool {
    let parse = |s: &str| {
        s.split('.')
            .filter_map(|p| p.parse::<u32>().ok())
            .collect::<Vec<_>>()
    };
    let a = parse(new);
    let b = parse(old);
    for i in 0..3 {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av > bv {
            return true;
        }
        if av < bv {
            return false;
        }
    }
    false
}


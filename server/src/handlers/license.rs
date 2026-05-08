//! License activation endpoint.
//!
//! POST /api/v1/license/activate
//!   { "key": "DM-XXXX-XXXX-XXXX-XXXX-XXXX", "fingerprint": "<hex>", "machine_label"?: "..." }
//!   →
//!   200 { "token_json": "<JSON-encoded LicenseToken>" }
//!   404 LICENSE_NOT_FOUND
//!   409 DEVICE_BOUND  (already bound to a different machine)
//!   410 LICENSE_REVOKED
//!
//! No unbinding logic exists — the spec is explicit that licenses are bound
//! to a single device for life. The only re-bind allowed is when the same
//! fingerprint comes back (e.g. after a reinstall) — that path returns the
//! same signed token.

use axum::{extract::State, http::StatusCode, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::license::{sign, TokenPlan};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ActivateRequest {
    pub key: String,
    pub fingerprint: String,
    #[serde(default)]
    pub machine_label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ActivateResponse {
    pub token_json: String,
}

pub async fn activate(
    State(state): State<AppState>,
    Json(req): Json<ActivateRequest>,
) -> Result<Json<ActivateResponse>, (StatusCode, String)> {
    if req.key.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "key required".into()));
    }
    if req.fingerprint.len() < 16 {
        return Err((StatusCode::BAD_REQUEST, "fingerprint required".into()));
    }

    let key = req.key.trim().to_uppercase();
    let fingerprint = req.fingerprint.to_lowercase();
    let label = req.machine_label.unwrap_or_default();

    let conn = state.db.lock().map_err(internal)?;

    // 1. Find license
    #[derive(Debug)]
    struct Row {
        plan: String,
        bound_fp: Option<String>,
        revoked: bool,
    }
    let row: Option<Row> = conn
        .query_row(
            "SELECT plan, bound_fingerprint, COALESCE(note, '') LIKE 'REVOKED%' \
             FROM licenses WHERE key = ?1",
            [&key],
            |r| {
                Ok(Row {
                    plan: r.get(0)?,
                    bound_fp: r.get(1)?,
                    revoked: r.get(2)?,
                })
            },
        )
        .ok();

    let row = match row {
        Some(r) => r,
        None => return Err((StatusCode::NOT_FOUND, "LICENSE_NOT_FOUND".into())),
    };

    if row.revoked {
        return Err((StatusCode::GONE, "LICENSE_REVOKED".into()));
    }

    // 2. Binding check
    if let Some(bound) = &row.bound_fp {
        if !bound.eq_ignore_ascii_case(&fingerprint) {
            return Err((StatusCode::CONFLICT, "DEVICE_BOUND".into()));
        }
        // Same fingerprint re-activating — sign a fresh token and return it.
    } else {
        // First activation — bind it now.
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE licenses SET bound_fingerprint = ?1, bound_at = ?2, machine_label = ?3 \
             WHERE key = ?4",
            rusqlite::params![fingerprint, now, label, key],
        )
        .map_err(internal)?;
    }

    // 3. Sign and return.
    let plan = match row.plan.as_str() {
        "lifetime" => TokenPlan::Lifetime,
        "trial" => TokenPlan::Trial,
        other => {
            tracing::warn!("unknown license plan {} for key {}", other, key);
            TokenPlan::Lifetime
        }
    };
    let issued = Utc::now();
    let expires = if matches!(plan, TokenPlan::Trial) {
        Some(issued + chrono::Duration::days(5))
    } else {
        None
    };
    let token = sign::sign_token(&state.signing_key, &key, plan, &fingerprint, issued, expires);
    let token_json = serde_json::to_string(&token).map_err(internal)?;

    Ok(Json(ActivateResponse { token_json }))
}

fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    tracing::error!("activate: {}", e);
    (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
}

//! Tauri commands exposing license state to the front-end.
//!
//! All side-effects (writing `license.json`, kicking the LLM downgrade flow)
//! live here so command handlers stay thin.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::license::{
    fingerprint,
    gates,
    quota,
    state::{LicenseState, Plan},
    storage,
    token::LicenseToken,
};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct LicenseStatus {
    pub plan: Plan,
    pub reason: &'static str,
    pub fingerprint: String,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub license_key: Option<String>,
    pub quota: quota::QuotaSnapshot,
}

#[tauri::command]
pub fn get_license_status(state: State<'_, AppState>) -> Result<LicenseStatus, String> {
    let lic = state
        .license
        .read()
        .map_err(|e| format!("license lock poisoned: {e}"))?
        .clone();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let q = quota::snapshot(&conn);
    Ok(LicenseStatus {
        plan: lic.plan,
        reason: lic.reason,
        fingerprint: lic.fingerprint,
        expires_at: lic.expires_at,
        license_key: lic.license_key,
        quota: q,
    })
}

#[derive(Debug, Deserialize)]
pub struct ActivateInput {
    pub token_json: String,
}

/// Persist a license token returned by the server and refresh runtime state.
///
/// The server is expected to return the full signed JSON. We re-verify it on
/// the client before writing to disk and updating shared state. After that
/// no network call is made for the lifetime of this token.
#[tauri::command]
pub fn install_license_token(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ActivateInput,
) -> Result<LicenseStatus, String> {
    let token = LicenseToken::parse_and_verify(&input.token_json)
        .map_err(|e| format!("INVALID_TOKEN:{e}"))?;
    let fp = fingerprint::current();
    if !token.fingerprint_matches(&fp) {
        return Err("FINGERPRINT_MISMATCH".to_string());
    }
    if token.is_expired() {
        return Err("EXPIRED_TOKEN".to_string());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    storage::write(&app_data_dir, &input.token_json)
        .map_err(|e| format!("write license: {e}"))?;

    let new_state = LicenseState::from_token(fp, &token);
    {
        let mut w = state
            .license
            .write()
            .map_err(|e| format!("license lock: {e}"))?;
        *w = new_state.clone();
    }
    let _ = app.emit("license-updated", &new_state);

    get_license_status(state)
}

/// Wipe the local license token (used for testing and for "Sign out"-style UX).
/// After this, the runtime state falls back to the trial / free path.
#[tauri::command]
pub fn clear_license(app: AppHandle, state: State<'_, AppState>) -> Result<LicenseStatus, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let _ = storage::delete(&app_data_dir);
    let bootstrap = crate::license::state::bootstrap(&app_data_dir);
    {
        let mut w = state
            .license
            .write()
            .map_err(|e| format!("license lock: {e}"))?;
        *w = bootstrap.clone();
    }
    let _ = app.emit("license-updated", &bootstrap);

    get_license_status(state)
}

/// Returns the hardware fingerprint as a hex string.
///
/// Used by the activation page so the front-end can display the binding
/// preview before submitting it to the license server.
#[tauri::command]
pub fn get_hardware_fingerprint() -> String {
    fingerprint::current()
}


/// Returns the snapshot of the AI quota counter.
#[tauri::command]
pub fn get_quota(state: State<'_, AppState>) -> Result<quota::QuotaSnapshot, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    Ok(quota::snapshot(&conn))
}

/// Convenience helper used by gating: returns Err(PRO_REQUIRED:...) when the
/// caller is not Pro. Free / Trial-expired callers see the upsell prompt.
pub fn require_pro(state: &AppState, reason: &str) -> Result<(), String> {
    let lic = state
        .license
        .read()
        .map_err(|e| format!("license lock: {e}"))?;
    if lic.is_pro_active() {
        Ok(())
    } else {
        Err(gates::pro_required(reason))
    }
}

/// Free-tier quota check. Returns Err if the user is Free and out of quota.
/// Trial / Pro callers always pass through. The counter is incremented when
/// the call is granted, and a `quota-consumed` event is emitted so the
/// front-end status chip can refresh its `used` counter.
pub fn consume_ai_quota(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let lic = state
        .license
        .read()
        .map_err(|e| format!("license lock: {e}"))?
        .clone();
    if matches!(lic.plan, Plan::Pro | Plan::Trial) {
        return Ok(());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match quota::try_consume(&conn) {
        Ok(true) => {
            let snap = quota::snapshot(&conn);
            let _ = app.emit("quota-consumed", &snap);
            Ok(())
        }
        Ok(false) => Err(format!(
            "QUOTA_EXCEEDED:ai/{}/{}",
            quota::FREE_MONTHLY_LIMIT,
            quota::FREE_MONTHLY_LIMIT
        )),
        Err(e) => Err(format!("quota error: {e}")),
    }
}

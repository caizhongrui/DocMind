//! Runtime license state shared across the application.
//!
//! The state is computed once at startup (see [`bootstrap`]) and updated
//! whenever the user activates a license or the trial flips to expired.
//! Read access is wrapped in [`SharedLicense`] (an `Arc<RwLock<…>>`) so
//! Tauri command handlers can take quick read locks.

use std::path::Path;
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::fingerprint;
use super::storage;
use super::token::{LicenseToken, TokenPlan};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Plan {
    Free,
    Trial,
    Pro,
}

#[derive(Debug, Clone, Serialize)]
pub struct LicenseState {
    pub plan: Plan,
    /// Reason why the current state was selected. Useful for telemetry and
    /// for surfacing diagnostic hints in the UI.
    pub reason: &'static str,
    pub fingerprint: String,
    /// For Trial / Pro-with-expiry, when access ends. None for permanent Pro.
    pub expires_at: Option<DateTime<Utc>>,
    /// License key string if a Pro token is active.
    pub license_key: Option<String>,
}

impl LicenseState {
    pub fn free(fp: String, reason: &'static str) -> Self {
        Self {
            plan: Plan::Free,
            reason,
            fingerprint: fp,
            expires_at: None,
            license_key: None,
        }
    }

    /// Build the runtime state from a verified license token.
    /// Lifetime tokens become `Plan::Pro`; trial tokens become `Plan::Trial`.
    pub fn from_token(fp: String, token: &LicenseToken) -> Self {
        match token.plan {
            TokenPlan::Lifetime => Self {
                plan: Plan::Pro,
                reason: "license_active",
                fingerprint: fp,
                expires_at: token.expires_at,
                license_key: Some(token.key.clone()),
            },
            TokenPlan::Trial => Self {
                plan: Plan::Trial,
                reason: "trial_active",
                fingerprint: fp,
                expires_at: token.expires_at,
                license_key: None,
            },
        }
    }

    pub fn is_pro_active(&self) -> bool {
        matches!(self.plan, Plan::Pro | Plan::Trial)
    }
}

pub type SharedLicense = Arc<RwLock<LicenseState>>;

/// Decide the current state from on-disk artifacts.
///
/// Order of precedence:
/// 1. A signature-verified [`LicenseToken`] (Lifetime OR Trial) whose
///    fingerprint matches and which has not expired → `Plan::Pro` /
///    `Plan::Trial`.
/// 2. A signature-verified Trial token that has *expired* →
///    `Plan::Free` ("trial_expired"). We keep the file around so we can
///    distinguish "trial used + over" from "trial never started".
/// 3. No token (or signature failed) → `Plan::Free` ("no_trial_yet").
///
/// Trial eligibility is enforced by the **server** at /license/start_trial;
/// deleting `license.json` doesn't grant the user a fresh trial because
/// the server still has the fingerprint on record.
pub fn bootstrap(app_data_dir: &Path) -> LicenseState {
    let fp = fingerprint::current();

    if let Some(token) = storage::load_and_verify(app_data_dir) {
        if token.fingerprint_matches(&fp) {
            if !token.is_expired() {
                return LicenseState::from_token(fp, &token);
            }
            if matches!(token.plan, TokenPlan::Trial) {
                return LicenseState::free(fp, "trial_expired");
            }
        }
    }
    LicenseState::free(fp, "no_trial_yet")
}

pub fn shared(state: LicenseState) -> SharedLicense {
    Arc::new(RwLock::new(state))
}

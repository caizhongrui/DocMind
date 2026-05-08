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
use super::storage::{self, TrialMarker};
use super::token::{LicenseToken, TokenPlan};

pub const TRIAL_DAYS: i64 = 5;

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

    pub fn trial(fp: String, marker: &TrialMarker) -> Self {
        Self {
            plan: Plan::Trial,
            reason: "trial_active",
            fingerprint: fp,
            expires_at: Some(marker.expires_at(TRIAL_DAYS)),
            license_key: None,
        }
    }

    pub fn pro(fp: String, token: &LicenseToken) -> Self {
        Self {
            plan: Plan::Pro,
            reason: "license_active",
            fingerprint: fp,
            expires_at: token.expires_at,
            license_key: Some(token.key.clone()),
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
/// 1. A signature-verified [`LicenseToken`] whose fingerprint matches the
///    machine and which has not expired → `Plan::Pro`.
/// 2. A trial marker whose fingerprint matches and whose 5-day window is
///    still open → `Plan::Trial`.
/// 3. Otherwise → `Plan::Free`. A trial marker is created on first run
///    (the user has never seen the app before).
pub fn bootstrap(app_data_dir: &Path) -> LicenseState {
    let fp = fingerprint::current();

    if let Some(token) = storage::load_and_verify(app_data_dir) {
        if token.fingerprint_matches(&fp) && !token.is_expired() {
            return match token.plan {
                TokenPlan::Lifetime | TokenPlan::Trial => LicenseState::pro(fp, &token),
            };
        }
    }

    let marker = storage::ensure_trial(app_data_dir, &fp);
    if marker.is_active(TRIAL_DAYS) && marker.fingerprint == fp {
        LicenseState::trial(fp, &marker)
    } else {
        LicenseState::free(fp, "trial_expired")
    }
}

pub fn shared(state: LicenseState) -> SharedLicense {
    Arc::new(RwLock::new(state))
}

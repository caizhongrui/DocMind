//! Read / write the license token to disk.
//!
//! Stored as a JSON file inside the app data directory:
//!   `{app_data}/license.json`
//!
//! Trial tokens are also generated and persisted here on first launch (see
//! [`ensure_trial_token`]).

use std::path::{Path, PathBuf};

use chrono::{Duration, Utc};

use super::token::LicenseToken;

const LICENSE_FILE: &str = "license.json";

pub fn license_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LICENSE_FILE)
}

pub fn read(app_data_dir: &Path) -> Option<String> {
    std::fs::read_to_string(license_path(app_data_dir)).ok()
}

pub fn write(app_data_dir: &Path, json: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(app_data_dir)?;
    std::fs::write(license_path(app_data_dir), json)
}

pub fn delete(app_data_dir: &Path) -> std::io::Result<()> {
    let p = license_path(app_data_dir);
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

pub fn load_and_verify(app_data_dir: &Path) -> Option<LicenseToken> {
    let raw = read(app_data_dir)?;
    LicenseToken::parse_and_verify(&raw).ok()
}

/// Persist a marker that records the start of the locally-tracked trial.
///
/// The trial token is **not** signature-verified — there is no server signature
/// for free trials. We simply persist a small JSON blob with the start time
/// and treat its presence as authoritative. This is intentional: the trial is
/// a local-only mechanism with low value to attack (5 days).
pub const TRIAL_FILE: &str = "trial.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrialMarker {
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub fingerprint: String,
}

impl TrialMarker {
    pub fn expires_at(&self, days: i64) -> chrono::DateTime<chrono::Utc> {
        self.started_at + Duration::days(days)
    }
    pub fn is_active(&self, days: i64) -> bool {
        Utc::now() < self.expires_at(days)
    }
}

pub fn trial_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(TRIAL_FILE)
}

pub fn read_trial(app_data_dir: &Path) -> Option<TrialMarker> {
    let raw = std::fs::read_to_string(trial_path(app_data_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_trial(app_data_dir: &Path, marker: &TrialMarker) -> std::io::Result<()> {
    std::fs::create_dir_all(app_data_dir)?;
    let json = serde_json::to_string_pretty(marker).unwrap_or_default();
    std::fs::write(trial_path(app_data_dir), json)
}

/// Returns the existing trial marker, or creates a fresh 5-day trial on first
/// run and returns it.
pub fn ensure_trial(app_data_dir: &Path, fingerprint: &str) -> TrialMarker {
    if let Some(existing) = read_trial(app_data_dir) {
        if existing.fingerprint == fingerprint {
            return existing;
        }
    }
    let marker = TrialMarker {
        started_at: Utc::now(),
        fingerprint: fingerprint.to_string(),
    };
    let _ = write_trial(app_data_dir, &marker);
    marker
}

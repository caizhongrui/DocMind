//! Read / write the license token to disk.
//!
//! Stored as a JSON file inside the app data directory:
//!   `{app_data}/license.json`
//!
//! Trial tokens live in the same file — they're just signed Ed25519
//! tokens with `plan="trial"` and a 5-day `expires_at`. The server is
//! the source of truth for trial eligibility (see
//! `POST /api/v1/license/start_trial` in the server).

use std::path::{Path, PathBuf};

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

// Legacy `trial.json` (used in older builds for the local-only trial)
// is no longer read or written. If it exists from a previous install the
// app simply ignores it; the user must click "开始试用" once to fetch a
// proper signed trial token from the server.

//! Cross-platform hardware fingerprint.
//!
//! Combines a stable platform UUID with an app-level salt. The result is
//! deterministic on the same machine and survives reboots, but changes on
//! reinstall, hardware swap (motherboard / disk), or VM clone.
//!
//! Salt is hard-coded to thwart trivial off-line forgery. If the salt ever
//! has to change, every existing license must be re-issued.

use sha2::{Digest, Sha256};

/// Hard-coded app secret. Anyone with the source can read it, but it does
/// raise the bar for casual fingerprint forgery.
const APP_FINGERPRINT_SALT: &str = "docmind/v1/fingerprint/2026";

/// Returns a 32-character hex fingerprint identifying the current machine.
pub fn current() -> String {
    let primary = primary_id();
    let secondary = secondary_id().unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(primary.as_bytes());
    hasher.update(b"|");
    hasher.update(secondary.as_bytes());
    hasher.update(b"|");
    hasher.update(APP_FINGERPRINT_SALT.as_bytes());
    let digest = hasher.finalize();
    let hex = hex::encode(digest);
    hex[..32].to_string()
}

fn primary_id() -> String {
    // `machine-uid` returns a stable per-machine identifier across all major
    // desktop platforms:
    //   - macOS:   IOPlatformUUID
    //   - Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
    //   - Linux:   /etc/machine-id
    machine_uid::get().unwrap_or_else(|_| "unknown-machine".to_string())
}

#[cfg(target_os = "macos")]
fn secondary_id() -> Option<String> {
    use std::process::Command;
    let out = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let stdout = String::from_utf8(out.stdout).ok()?;
    for line in stdout.lines() {
        if line.contains("IOPlatformSerialNumber") {
            if let Some(eq) = line.find('=') {
                return Some(line[eq + 1..].trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn secondary_id() -> Option<String> {
    use std::process::Command;
    let out = Command::new("wmic")
        .args(["csproduct", "get", "UUID"])
        .output()
        .ok()?;
    let stdout = String::from_utf8(out.stdout).ok()?;
    stdout
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.eq_ignore_ascii_case("UUID"))
        .map(|s| s.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn secondary_id() -> Option<String> {
    std::fs::read_to_string("/sys/class/dmi/id/product_uuid")
        .ok()
        .map(|s| s.trim().to_string())
}

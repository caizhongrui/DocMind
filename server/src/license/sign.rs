//! Signing & key generation for license tokens.
//!
//! Generates new license keys with the format `DM-XXXX-XXXX-XXXX-XXXX-XXXX`
//! (5 chunks of 4 alphanumeric characters, ~100 bits of entropy) and signs
//! the canonical JSON payload with Ed25519.

use chrono::{DateTime, Utc};
use ed25519_dalek::{Signer, SigningKey};
use rand::Rng;

use super::{LicenseToken, TokenPlan};

const KEY_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // base32-ish, no I/O/0/1

/// Generate a fresh license key string. Not signed; persistence happens before
/// signing, so the server can re-issue tokens without re-storing.
pub fn generate_key() -> String {
    let mut rng = rand::thread_rng();
    let mut chunks = Vec::with_capacity(5);
    for _ in 0..5 {
        let mut chunk = String::with_capacity(4);
        for _ in 0..4 {
            let idx = rng.gen_range(0..KEY_CHARS.len());
            chunk.push(KEY_CHARS[idx] as char);
        }
        chunks.push(chunk);
    }
    format!("DM-{}", chunks.join("-"))
}

/// Sign a license token. The sig field is overwritten with the resulting
/// base64 signature.
pub fn sign_token(
    signing: &SigningKey,
    key: &str,
    plan: TokenPlan,
    fingerprint: &str,
    issued_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
) -> LicenseToken {
    let mut token = LicenseToken {
        v: 1,
        key: key.to_string(),
        plan,
        fingerprint: fingerprint.to_string(),
        issued_at,
        expires_at,
        sig: String::new(),
    };
    let payload = serde_json::to_string(&token).unwrap_or_default();
    let signature = signing.sign(payload.as_bytes());
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    token.sig = STANDARD.encode(signature.to_bytes());
    token
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format() {
        let k = generate_key();
        assert!(k.starts_with("DM-"));
        let parts: Vec<&str> = k.split('-').collect();
        assert_eq!(parts.len(), 6);
        for p in &parts[1..] {
            assert_eq!(p.len(), 4);
        }
    }
}

//! Ed25519 keypair management.
//!
//! On first start the server generates a fresh keypair under `keys/` and
//! prints the public key — the operator copies it into the desktop client's
//! `SERVER_PUBLIC_KEY_HEX` constant before shipping.
//!
//! Subsequent starts read the existing private key. The private key is
//! 0o600-permissioned and never leaves this server.

use std::path::Path;

use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;

const PRIV_FILE: &str = "ed25519.priv";
const PUB_FILE: &str = "ed25519.pub";

pub fn load_or_generate(dir: &Path) -> anyhow::Result<(SigningKey, VerifyingKey)> {
    std::fs::create_dir_all(dir)?;
    let priv_path = dir.join(PRIV_FILE);
    let pub_path = dir.join(PUB_FILE);

    if priv_path.exists() {
        let raw = std::fs::read(&priv_path)?;
        if raw.len() != 32 {
            anyhow::bail!(
                "{} is not a 32-byte Ed25519 secret key (got {} bytes)",
                priv_path.display(),
                raw.len()
            );
        }
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&raw);
        let signing = SigningKey::from_bytes(&bytes);
        let verifying = signing.verifying_key();
        return Ok((signing, verifying));
    }

    tracing::warn!(
        "no signing key at {}; generating a new keypair. \
         REMEMBER to bake the printed public key into the desktop client \
         (src-tauri/src/license/token.rs SERVER_PUBLIC_KEY_HEX) before shipping.",
        priv_path.display()
    );

    let mut csprng = OsRng;
    let signing = SigningKey::generate(&mut csprng);
    let verifying = signing.verifying_key();

    std::fs::write(&priv_path, signing.to_bytes())?;
    std::fs::write(&pub_path, hex::encode(verifying.to_bytes()))?;
    set_private_perms(&priv_path)?;

    println!("=================================================================");
    println!("  DocMind license server — new Ed25519 keypair generated");
    println!("  Public key (hex):");
    println!("  {}", hex::encode(verifying.to_bytes()));
    println!("  Bake this into the desktop client before publishing the next");
    println!("  release. Existing license tokens were signed with this key");
    println!("  and will fail verification if the key changes.");
    println!("=================================================================");

    Ok((signing, verifying))
}

#[cfg(unix)]
fn set_private_perms(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn set_private_perms(_: &Path) -> std::io::Result<()> {
    Ok(())
}

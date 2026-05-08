//! Helpers for the four enforcement gates described in the monetization spec.
//!
//! Gates 1, 3, 4 are wired in `lib.rs` and individual command modules; this
//! module centralizes the predicates so that the rules live in exactly one
//! place.

use std::path::Path;

use super::state::{LicenseState, Plan};

/// Identifies a model tier from a GGUF filename / path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelTier {
    /// Free-allowed light model (~600MB, 0.6B params).
    Light,
    /// Pro-only mid model (~1.3GB, 1.7B params).
    Mid,
    /// Pro-only heavy model (~2.5GB, 4B params).
    Heavy,
    /// User-imported GGUF — Pro-only on principle.
    Custom,
}

/// Best-effort tier classification. Pattern-matches the GGUF filename, which
/// is how DocMind names the models it ships (`qwen3-0.6b-q4`, `qwen3-1.7b-q4`,
/// `qwen3-4b-q4`). Anything we don't recognise is treated as Custom.
pub fn classify_model_path(path: &Path) -> ModelTier {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.contains("0.6b") || name.contains("0_6b") {
        ModelTier::Light
    } else if name.contains("1.7b") || name.contains("1_7b") {
        ModelTier::Mid
    } else if name.contains("4b") {
        ModelTier::Heavy
    } else {
        ModelTier::Custom
    }
}

/// Free / Trial-expired users are restricted to [`ModelTier::Light`].
/// Trial users may use any built-in tier but **not** custom GGUF.
/// Pro users may use anything.
pub fn is_model_allowed(tier: ModelTier, state: &LicenseState) -> bool {
    match state.plan {
        Plan::Pro => true,
        Plan::Trial => !matches!(tier, ModelTier::Custom),
        Plan::Free => matches!(tier, ModelTier::Light),
    }
}

/// Suggest a default model id for a given license plan when we have to
/// downgrade the user. Returns the canonical built-in id; the caller is
/// responsible for translating it to a path.
pub fn default_model_id(state: &LicenseState) -> &'static str {
    match state.plan {
        Plan::Pro | Plan::Trial => "qwen3-1.7b-q4",
        Plan::Free => "qwen3-0.6b-q4",
    }
}

/// Standard error code reported back to the front-end when a Pro feature
/// is invoked outside of an active Pro/Trial license.
pub fn pro_required(reason: &str) -> String {
    format!("PRO_REQUIRED:{reason}")
}

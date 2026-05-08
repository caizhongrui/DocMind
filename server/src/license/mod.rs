//! Server-side license signing.
//!
//! The token format **must** match the client's `LicenseToken` struct exactly.
//! Don't change one side without updating the other; the canonical signing
//! payload depends on JSON field order, so the structs are kept in sync.

pub mod keys;
pub mod sign;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TokenPlan {
    Lifetime,
    Trial,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseToken {
    pub v: u32,
    pub key: String,
    pub plan: TokenPlan,
    pub fingerprint: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub sig: String,
}

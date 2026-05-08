//! License layer.
//!
//! Validates and persists the locally stored license token. All checks happen
//! offline against an Ed25519 signature that was issued by the self-hosted
//! license server during activation. Once written, the token is never sent
//! back online — this module never makes network calls.
//!
//! ## Modules
//! - [`fingerprint`] — cross-platform hardware fingerprint
//! - [`token`]       — license token format + Ed25519 verification
//! - [`storage`]     — read/write `license.json` to the app data directory
//! - [`state`]       — runtime [`LicenseState`] shared via [`crate::state::AppState`]
//! - [`quota`]       — monthly AI usage counter for Free tier
//! - [`gates`]       — helpers used by the four enforcement gates (model tier
//!                     checks, transition handlers)

pub mod fingerprint;
pub mod token;
pub mod storage;
pub mod state;
pub mod quota;
pub mod gates;

pub use state::{LicenseState, Plan, SharedLicense};
pub use token::{LicenseToken, TokenError};

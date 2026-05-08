//! Plain-old-data structs that map to SQLite rows. CRUD helpers live alongside
//! handlers so this file stays focused on shape only.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    pub id: i64,
    pub key: String,
    pub plan: String,
    pub order_id: Option<String>,
    pub buyer_email: Option<String>,
    pub bound_fingerprint: Option<String>,
    pub bound_at: Option<DateTime<Utc>>,
    pub machine_label: Option<String>,
    pub created_at: DateTime<Utc>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: i64,
    pub payjs_order_id: Option<String>,
    pub out_trade_no: String,
    pub amount: i64,
    pub paid_at: Option<DateTime<Utc>>,
    pub payment_type: Option<String>,
    pub license_key: Option<String>,
    pub raw_payload: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Download {
    pub id: i64,
    pub ts: DateTime<Utc>,
    pub version: String,
    pub platform: String,
    pub edition: String,
    pub license_key: Option<String>,
    pub ip: String,
    pub user_agent: Option<String>,
    pub bytes_served: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub id: i64,
    pub version: String,
    pub platform: String,
    pub edition: String,
    pub file_path: String,
    pub sha256: String,
    pub size: i64,
    pub signature: String,
    pub notes: Option<String>,
    pub published_at: DateTime<Utc>,
}

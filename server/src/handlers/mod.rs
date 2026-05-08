pub mod admin;
pub mod license;
pub mod payment;
pub mod public;
pub mod releases;

use axum::http::StatusCode;
use axum::response::IntoResponse;

/// Common error wrapper used across handlers — all errors render as plain
/// text 500 unless the handler chose otherwise.
pub struct ApiError(pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.0).into_response()
    }
}

impl<E: std::fmt::Display> From<E> for ApiError {
    fn from(e: E) -> Self {
        ApiError(e.to_string())
    }
}

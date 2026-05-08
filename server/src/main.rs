//! DocMind license / payment / updater / admin backend.
//!
//! Single Axum application that serves three logical areas:
//! - `/api/v1/*`        — JSON API consumed by the desktop client
//! - `/admin/*`         — server-rendered HTML admin (Basic Auth)
//! - `/releases/*`      — static binary downloads with logging
//! - `/activate`        — public activation flow (HTML)
//!
//! The portal site (`docmind.app`) is served separately by Caddy as a static
//! Astro build; this server only serves `api.docmind.app`.

mod config;
mod db;
mod handlers;
mod license;
mod payjs;
mod templates;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<config::Config>,
    pub db: db::DbPool,
    pub signing_key: Arc<ed25519_dalek::SigningKey>,
    pub verifying_key: Arc<ed25519_dalek::VerifyingKey>,
    pub admin_password_hash: Arc<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info,docmind_server=debug".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cfg = config::Config::from_env()?;
    tracing::info!(domain = %cfg.domain, listen_addr = %cfg.listen_addr, "starting docmind-server");

    let db = db::open_and_migrate(&cfg.db_path).await?;
    let (signing_key, verifying_key) = license::keys::load_or_generate(&cfg.keys_dir)?;
    tracing::info!(
        public_key = %hex::encode(verifying_key.to_bytes()),
        "ed25519 server key ready"
    );

    let admin_hash = payjs::sha256_hex(cfg.admin_password.as_bytes());

    let state = AppState {
        cfg: Arc::new(cfg.clone()),
        db,
        signing_key: Arc::new(signing_key),
        verifying_key: Arc::new(verifying_key),
        admin_password_hash: Arc::new(admin_hash),
    };

    let api_router = Router::new()
        .route("/license/activate", post(handlers::license::activate))
        .route("/payment/payjs/webhook", post(handlers::payment::payjs_webhook))
        .route("/payment/checkout", get(handlers::payment::start_checkout))
        .route("/payment/order_status", get(handlers::payment::order_status))
        .route("/releases/public", get(handlers::releases::public_changelog))
        .route("/updates/:platform/:current_version", get(handlers::releases::updater_manifest));

    let admin_router = Router::new()
        .route("/", get(handlers::admin::overview))
        .route("/login", get(handlers::admin::login_get).post(handlers::admin::login_post))
        .route("/logout", post(handlers::admin::logout))
        .route("/licenses", get(handlers::admin::licenses_list))
        .route("/licenses/:key", get(handlers::admin::license_detail))
        .route("/licenses/issue", get(handlers::admin::issue_form).post(handlers::admin::issue_submit))
        .route("/orders", get(handlers::admin::orders_list))
        .route("/downloads", get(handlers::admin::downloads_list))
        .route("/releases", get(handlers::admin::releases_list).post(handlers::admin::releases_upload));

    let public_router = Router::new()
        .route("/", get(handlers::public::root))
        .route("/activate", get(handlers::public::activate_get).post(handlers::public::activate_post))
        .route("/payment/success", get(handlers::payment::payment_success));

    let app = Router::new()
        .nest("/api/v1", api_router)
        .nest("/admin", admin_router)
        .merge(public_router)
        .nest_service(
            "/releases",
            handlers::releases::router(state.clone()),
        )
        .with_state(state.clone())
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = state.cfg.listen_addr.parse()?;
    tracing::info!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}


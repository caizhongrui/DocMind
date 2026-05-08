//! Runtime configuration loaded from environment variables.
//!
//! Read once at startup. The Docker container is configured via env-vars passed
//! through `docker-compose.yml` / `-e` flags; everything has a sensible default
//! so the container starts even if the operator forgot to set things.

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub domain: String,
    pub listen_addr: String,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub keys_dir: PathBuf,
    pub releases_dir: PathBuf,
    pub admin_username: String,
    pub admin_password: String,
    pub payjs_merchant_id: String,
    pub payjs_key: String,
    pub payjs_notify_url: String,
    pub product_price_lifetime: u32, // 单位:分(2000 = ¥20)
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let data_dir = PathBuf::from(envv("DATA_DIR", "/data"));
        let db_path = data_dir.join("db").join("docmind.sqlite");
        let keys_dir = data_dir.join("keys");
        let releases_dir = data_dir.join("releases");
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(data_dir.join("db"))?;
        std::fs::create_dir_all(&keys_dir)?;
        std::fs::create_dir_all(&releases_dir)?;

        Ok(Self {
            domain: envv("DOMAIN", "doc-api.boyobang.com"),
            listen_addr: envv("LISTEN_ADDR", "0.0.0.0:8080"),
            data_dir,
            db_path,
            keys_dir,
            releases_dir,
            admin_username: envv("ADMIN_USERNAME", "admin"),
            admin_password: envv("ADMIN_PASSWORD", "change-me"),
            payjs_merchant_id: envv("PAYJS_MERCHANT_ID", ""),
            payjs_key: envv("PAYJS_KEY", ""),
            payjs_notify_url: envv("PAYJS_NOTIFY_URL", ""),
            product_price_lifetime: envv("PRICE_LIFETIME_FEN", "2000")
                .parse()
                .unwrap_or(2000),
        })
    }
}

fn envv(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

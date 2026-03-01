use crate::embedder::Embedder;
use crate::indexer::tantivy_index::FtsIndex;
use crate::llm::Llm;
use crate::vector_index::VectorIndex;
use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::{
        atomic::AtomicBool,
        Arc, Mutex, RwLock,
    },
};

/// 全局应用状态。
///
/// **锁获取顺序约定**：如需同时持有多个锁，必须按以下顺序获取，否则可能死锁：
/// 1. `db`（SQLite 连接）
/// 2. `fts`（Tantivy 全文索引）
/// 3. `vector_index`（USearch 向量索引）
/// 4. `embedder`（ONNX 推理 Session）
/// 5. `llm`（LLM 推理）
pub struct AppState {
    pub db: Mutex<Connection>,
    pub fts: Mutex<FtsIndex>,
    pub vector_index: Mutex<Option<VectorIndex>>,
    pub embedder: Mutex<Option<Embedder>>,
    pub llm: Mutex<Option<Llm>>,
    /// 序列化 LLM 加载操作，防止启动自动加载与手动切换并发导致 BackendAlreadyInitialized
    pub llm_loading: Mutex<()>,
    pub model_dir: PathBuf,
    /// 向量索引 stamp 文件路径（记录上次保存时 DB max chunk_id，用于启动时一致性校验）
    pub vi_stamp_path: PathBuf,
    /// LLM 生成取消标志：true = 请求中止当前生成
    pub llm_cancel: Arc<AtomicBool>,
    /// API LLM 配置（RwLock 允许并发读，写时独占）
    pub api_llm_config: Arc<RwLock<ApiLlmConfig>>,
}

/// API LLM 配置（OpenAI 兼容接口）
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ApiLlmConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub api_key: String,
    pub model_name: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub top_p: f32,
}

impl Default for ApiLlmConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            api_key: String::new(),
            model_name: "gpt-4o-mini".to_string(),
            temperature: 0.7,
            max_tokens: 2048,
            top_p: 1.0,
        }
    }
}

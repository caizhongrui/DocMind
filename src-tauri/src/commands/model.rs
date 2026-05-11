use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const MODEL_VERSION: &str = "bge-small-zh-v1.5";

// 模型文件下载地址（按优先级排列：国内镜像优先，最后回退到 HuggingFace 官方）
const MODEL_ONNX_URLS: &[&str] = &[
    // 国内镜像（速度快，推荐）
    "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model.onnx",
    "https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/onnx/model.onnx",
    "https://www.modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/onnx/model.onnx",
    // HuggingFace 官方（国际用户回退）
    "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model.onnx",
];
const TOKENIZER_URLS: &[&str] = &[
    // 国内镜像
    "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json",
    "https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/tokenizer.json",
    "https://www.modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/tokenizer.json",
    // HuggingFace 官方
    "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json",
];

// ── BGE Reranker(可选答案精排模型,~80MB INT8 量化版)─────────────
//   bge-reranker-base 是 Xenova 在 Hugging Face 上的现成 ONNX 版本,
//   含 model_quantized.onnx(INT8, ~80MB)和 tokenizer.json。
//   中文 + 多语言效果在 80MB 这个尺寸里属于第一档。
const RERANKER_VERSION: &str = "bge-reranker-base";
const RERANKER_DIR_NAME: &str = "bge-reranker-v2-m3"; // 沿用之前定义的目录名,保持兼容
const RERANKER_ONNX_URLS: &[&str] = &[
    "https://hf-mirror.com/Xenova/bge-reranker-base/resolve/main/onnx/model_quantized.onnx",
    "https://modelscope.cn/models/Xenova/bge-reranker-base/resolve/master/onnx/model_quantized.onnx",
    "https://www.modelscope.cn/models/Xenova/bge-reranker-base/resolve/master/onnx/model_quantized.onnx",
    "https://huggingface.co/Xenova/bge-reranker-base/resolve/main/onnx/model_quantized.onnx",
];
const RERANKER_TOKENIZER_URLS: &[&str] = &[
    "https://hf-mirror.com/Xenova/bge-reranker-base/resolve/main/tokenizer.json",
    "https://modelscope.cn/models/Xenova/bge-reranker-base/resolve/master/tokenizer.json",
    "https://www.modelscope.cn/models/Xenova/bge-reranker-base/resolve/master/tokenizer.json",
    "https://huggingface.co/Xenova/bge-reranker-base/resolve/main/tokenizer.json",
];

#[derive(Serialize, Clone)]
pub struct ModelStatus {
    pub available: bool,
    pub model_dir: String,
    pub model_version: String,
    pub embedding_count: i64, // 已生成的 embedding 数量（0 = 需要重新索引）
}

/// Reranker(答案精排)模型的就绪状态。前端用它决定是否弹"下载精排模型"
/// 的提示横幅,以及在设置里展示按钮。
#[derive(Serialize, Clone)]
pub struct RerankerStatus {
    /// 本地是否就绪(model + tokenizer 都存在)
    pub available: bool,
    /// 运行时是否已加载到 AppState(可能本地存在但加载失败)
    pub loaded: bool,
    pub model_dir: String,
    pub model_version: String,
}

#[tauri::command]
pub fn get_model_status(state: State<'_, AppState>) -> ModelStatus {
    let available = crate::embedder::Embedder::is_available(&state.model_dir);
    let embedding_count = if available {
        state
            .db
            .lock()
            .ok()
            .and_then(|db| {
                db.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
                    .ok()
            })
            .unwrap_or(0)
    } else {
        0
    };
    ModelStatus {
        available,
        model_dir: state.model_dir.to_string_lossy().to_string(),
        model_version: MODEL_VERSION.to_string(),
        embedding_count,
    }
}

#[tauri::command]
pub async fn download_model(app: AppHandle) -> Result<(), String> {
    let model_dir = {
        let state = app.state::<AppState>();
        state.model_dir.clone()
    };

    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    // 先下载 tokenizer.json（小文件）
    download_file_with_fallback(
        &client,
        TOKENIZER_URLS,
        &model_dir.join("tokenizer.json"),
        &app,
        "tokenizer.json",
    )
    .await?;

    // 再下载 model.onnx（大文件，~100MB）
    download_file_with_fallback(
        &client,
        MODEL_ONNX_URLS,
        &model_dir.join("model.onnx"),
        &app,
        "model.onnx",
    )
    .await?;

    // 下载完成后热加载 embedder 和 vector_index，无需重启应用
    reload_ai_components(&app)?;

    let _ = app.emit("model-ready", MODEL_VERSION);
    Ok(())
}

/// 下载后热加载 embedder + vector_index 到 AppState（阻塞操作，在 spawn_blocking 中运行）
fn reload_ai_components(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let model_dir = state.model_dir.clone();

    // 加载 Embedder
    let embedder = crate::embedder::Embedder::load(&model_dir)
        .map_err(|e| format!("加载模型失败：{e}"))?;

    // 初始化 VectorIndex（data_dir = model_dir/../..）
    let data_dir = model_dir
        .parent()
        .and_then(|p| p.parent())
        .ok_or("无法推断 data_dir")?;
    let vi_path = data_dir.join("index").join("vectors.usearch");
    std::fs::create_dir_all(data_dir.join("index")).map_err(|e| e.to_string())?;
    let vi = crate::vector_index::VectorIndex::open_or_create(&vi_path, 512)
        .map_err(|e| format!("初始化向量索引失败：{e}"))?;

    // 写入 AppState（锁顺序：vector_index → embedder）
    {
        let mut vi_guard = state
            .vector_index
            .lock()
            .map_err(|_| "vector_index lock poisoned".to_string())?;
        *vi_guard = Some(vi);
    }
    {
        let mut emb_guard = state
            .embedder
            .lock()
            .map_err(|_| "embedder lock poisoned".to_string())?;
        *emb_guard = Some(embedder);
    }

    println!("[embedder] hot-loaded successfully");
    Ok(())
}

/// 依次尝试 urls 中的每个地址，第一个成功的即完成下载，全部失败才返回错误
async fn download_file_with_fallback(
    client: &reqwest::Client,
    urls: &[&str],
    dest: &std::path::Path,
    app: &AppHandle,
    filename: &str,
) -> Result<(), String> {
    let mut last_err = String::new();
    for &url in urls {
        match download_file(client, url, dest, app, filename).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                eprintln!("[model] download failed from {url}: {e}, trying next source...");
                last_err = e;
                // 删除可能已写入的不完整文件，再尝试下一个源
                let _ = std::fs::remove_file(dest);
            }
        }
    }
    Err(format!("所有下载源均失败：{last_err}"))
}

// ─── BGE Reranker ───────────────────────────────────────────────────────

/// Reranker 状态查询(前端启动后调用一次,决定是否弹下载横幅)。
#[tauri::command]
pub fn get_reranker_status(state: State<'_, AppState>) -> RerankerStatus {
    let available = crate::reranker::Reranker::is_available(&state.reranker_dir);
    let loaded = state
        .reranker
        .lock()
        .ok()
        .map(|g| g.is_some())
        .unwrap_or(false);
    RerankerStatus {
        available,
        loaded,
        model_dir: state.reranker_dir.to_string_lossy().to_string(),
        model_version: RERANKER_VERSION.to_string(),
    }
}

/// 下载 BGE-reranker(progress 事件 "reranker-download-progress")。
/// 下载完成后热加载到 AppState,前端立即可用,无需重启。
#[tauri::command]
pub async fn download_reranker(app: AppHandle) -> Result<(), String> {
    let reranker_dir = {
        let state = app.state::<AppState>();
        state.reranker_dir.clone()
    };

    std::fs::create_dir_all(&reranker_dir).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;

    // 小文件先(tokenizer ~5MB)
    download_with_progress_event(
        &client,
        RERANKER_TOKENIZER_URLS,
        &reranker_dir.join("tokenizer.json"),
        &app,
        "tokenizer.json",
        "reranker-download-progress",
    )
    .await?;

    // 大文件(INT8 量化 ONNX ~80MB)
    download_with_progress_event(
        &client,
        RERANKER_ONNX_URLS,
        &reranker_dir.join("model_quantized.onnx"),
        &app,
        "model_quantized.onnx",
        "reranker-download-progress",
    )
    .await?;

    // 下载完毕,热加载 + 立即 warmup(避免用户首次问答承担冷启动延迟)
    {
        let state = app.state::<AppState>();
        match crate::reranker::Reranker::load(&state.reranker_dir) {
            Ok(mut r) => {
                r.warmup(); // 同步,~1-2 秒;下载完已经在等了,多 2 秒可接受
                let mut guard = state
                    .reranker
                    .lock()
                    .map_err(|_| "reranker lock poisoned".to_string())?;
                *guard = Some(r);
                let _ = app.emit("reranker-ready", RERANKER_VERSION);
                Ok(())
            }
            Err(e) => Err(format!("加载 reranker 失败：{e}")),
        }
    }
}

/// 在 download_file 之上加一个 event-name 参数版本,这样 reranker 用
/// 自己的 progress 事件名,不会和 embedder 模型的 progress 冲突。
async fn download_with_progress_event(
    client: &reqwest::Client,
    urls: &[&str],
    dest: &std::path::Path,
    app: &AppHandle,
    filename: &str,
    event_name: &str,
) -> Result<(), String> {
    let mut last_err = String::new();
    for &url in urls {
        match download_one_url(client, url, dest, app, filename, event_name).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                eprintln!("[reranker] download failed from {url}: {e}, trying next source...");
                last_err = e;
                let _ = std::fs::remove_file(dest);
            }
        }
    }
    Err(format!("所有下载源均失败：{last_err}"))
}

async fn download_one_url(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
    app: &AppHandle,
    filename: &str,
    event_name: &str,
) -> Result<(), String> {
    use std::io::Write;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut response = resp;
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|e| format!("chunk error: {e}"))?;
        let Some(bytes) = chunk else { break };
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        let _ = app.emit(
            event_name,
            serde_json::json!({
                "file": filename,
                "done": downloaded,
                "total": total,
            }),
        );
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────

async fn download_file(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
    app: &AppHandle,
    filename: &str,
) -> Result<(), String> {
    use std::io::Write;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {url}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;

    let mut response = resp;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("download error: {e}"))?
    {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "model-download-progress",
            serde_json::json!({
                "file": filename,
                "done": downloaded,
                "total": total,
            }),
        );
    }

    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

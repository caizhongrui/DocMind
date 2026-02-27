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

#[derive(Serialize, Clone)]
pub struct ModelStatus {
    pub available: bool,
    pub model_dir: String,
    pub model_version: String,
    pub embedding_count: i64, // 已生成的 embedding 数量（0 = 需要重新索引）
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

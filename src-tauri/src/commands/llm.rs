use crate::{
    llm::Llm,
    search::{search_hybrid_for_rag, search_hybrid_for_rag_v2, RecallStats},
    state::AppState,
};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};

// ─── 内部辅助类型与函数 ────────────────────────────────────────────────────────

struct RagContext {
    sources: Vec<SourceRef>,
    context_text: String,
    /// 多文档检索 V2 的召回统计(老路径用 default,新路径返回真值)
    stats: RecallStats,
}

/// V2 上下文构建:走 search_hybrid_for_rag_v2(top-50 + 每文件保底 + 邻居 +
/// 可选 reranker),并返回召回统计供前端展示"已分析 X 段 · 涉及 Y 个文件"。
///
/// `app` 可选:传了就在中间阶段 emit 进度事件给前端,让 UI 实时显示
/// "📋 检索中"/"✨ 精排中" 而不是干等"思考中..."。
fn build_rag_context_v2(
    question: &str,
    state: &crate::state::AppState,
    max_chunks: usize,
    app: Option<&AppHandle>,
) -> Result<RagContext, String> {
    let (chunks, stats) = match app {
        Some(handle) => crate::search::search_hybrid_for_rag_v2_with_progress(
            question, state, max_chunks, handle,
        ),
        None => search_hybrid_for_rag_v2(question, state, max_chunks),
    }.map_err(|e| e.to_string())?;

    // 按文件名分组聚合上下文:同一份文档的多个 chunk **不再各自占一个
    // 【来源:...】块**,否则小模型会把"5 段属于同一文档"误读成"5 份不同文档"。
    //
    // 输出形态:
    //   === 文件 N: filename (共 X 个相关片段) ===
    //   [片段 1] ...content...
    //   [片段 2] ...content...
    //
    // chunk_index 仍保留在 RagChunk 里,以后做"点引用跳原文"时用,
    // 只是不再喂给 LLM(因为小模型会照搬"#3"这种标签到输出)。
    //
    // ── 每段字符上限随 chunk 数量自适应 ────────────────────────
    //   送 16 段 × 700 字 = 11000 字 → 5000+ tokens,加上 prompt
    //   就 7000-8000 tokens,在 1.7B 上 prefill 要 10+ 秒,用户感知"卡"。
    //   总预算约 6000 字(对 1.7B 友好),按 chunk 数均分,留 300-800 区间。
    let per_chunk_budget: usize = if chunks.is_empty() {
        700
    } else {
        (6000 / chunks.len()).clamp(300, 800)
    };
    let context_chunks: Vec<String> = {
        use std::collections::HashMap;
        // 用 Vec 维持首次出现的顺序(就是 RAG 排序后的相关性顺序)
        let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
        let mut name_to_idx: HashMap<String, usize> = HashMap::new();
        for (i, c) in chunks.iter().enumerate() {
            match name_to_idx.get(&c.name) {
                Some(&gi) => groups[gi].1.push(i),
                None => {
                    name_to_idx.insert(c.name.clone(), groups.len());
                    groups.push((c.name.clone(), vec![i]));
                }
            }
        }

        groups.iter().enumerate().map(|(gi, (name, idxs))| {
            let snippets: Vec<String> = idxs.iter().enumerate().map(|(slot, &i)| {
                let c = &chunks[i];
                let text = if c.content.chars().count() > per_chunk_budget {
                    c.content.chars().take(per_chunk_budget).collect::<String>() + "…"
                } else {
                    c.content.clone()
                };
                if idxs.len() > 1 {
                    format!("[片段 {}]\n{}", slot + 1, text)
                } else {
                    text
                }
            }).collect();
            let header = if idxs.len() > 1 {
                format!("=== 文件 {}: {} (同一文件,共 {} 个相关片段) ===", gi + 1, name, idxs.len())
            } else {
                format!("=== 文件 {}: {} ===", gi + 1, name)
            };
            format!("{}\n{}", header, snippets.join("\n\n"))
        }).collect()
    };

    let sources: Vec<SourceRef> = chunks.iter().map(|c| SourceRef {
        name: c.name.clone(),
        path: c.path.clone(),
        snippet: c.content.chars().take(200).collect::<String>(),
    }).collect();

    let context_text = if context_chunks.is_empty() {
        "（未找到相关文档）".to_string()
    } else {
        context_chunks.join("\n\n")
    };

    Ok(RagContext { sources, context_text, stats })
}

fn build_rag_context(
    question: &str,
    state: &crate::state::AppState,
    max_chunks: usize,
) -> Result<RagContext, String> {
    let chunks = crate::search::search_hybrid_for_rag(question, state, max_chunks)
        .map_err(|e| e.to_string())?;

    let context_chunks: Vec<String> = chunks.iter().map(|c| {
        let text = if c.content.chars().count() > 700 {
            c.content.chars().take(700).collect::<String>() + "…"
        } else {
            c.content.clone()
        };
        format!("【来源：{}】\n{}", c.name, text)
    }).collect();

    let sources: Vec<SourceRef> = chunks.iter().map(|c| SourceRef {
        name: c.name.clone(),
        path: c.path.clone(),
        snippet: c.content.chars().take(200).collect::<String>(),
    }).collect();

    let context_text = if context_chunks.is_empty() {
        "（未找到相关文档）".to_string()
    } else {
        context_chunks.join("\n\n")
    };

    Ok(RagContext { sources, context_text, stats: RecallStats::default() })
}

// ─────────────────────────────────────────────────────────────────────────────

/// 可在线下载的 GGUF 模型列表（Qwen3 系列，bartowski 量化）
/// urls 按优先级排序：ModelScope（国内首选）→ hf-mirror.com → huggingface.co
static AVAILABLE_GGUF_MODELS: &[GgufModelDef] = &[
    GgufModelDef {
        id: "qwen3-0.6b-q4",
        name: "Qwen3-0.6B（轻量 ~490MB）",
        filename: "Qwen3-0.6B-Q4_K_M.gguf",
        urls: &[
            "https://modelscope.cn/models/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/master/Qwen_Qwen3-0.6B-Q4_K_M.gguf",
            "https://hf-mirror.com/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q4_K_M.gguf",
            "https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q4_K_M.gguf",
        ],
        size_mb: 490,
    },
    GgufModelDef {
        id: "qwen3-1.7b-q4",
        name: "Qwen3-1.7B（推荐 ~1.3GB）",
        filename: "Qwen3-1.7B-Q4_K_M.gguf",
        urls: &[
            "https://modelscope.cn/models/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/master/Qwen_Qwen3-1.7B-Q4_K_M.gguf",
            "https://hf-mirror.com/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf",
            "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf",
        ],
        size_mb: 1300,
    },
    GgufModelDef {
        id: "qwen3-4b-q4",
        name: "Qwen3-4B（高质量 ~2.5GB）",
        filename: "Qwen3-4B-Q4_K_M.gguf",
        urls: &[
            "https://modelscope.cn/models/Qwen/Qwen3-4B-GGUF/resolve/master/Qwen3-4B-Q4_K_M.gguf",
            "https://modelscope.cn/models/bartowski/Qwen_Qwen3-4B-GGUF/resolve/master/Qwen_Qwen3-4B-Q4_K_M.gguf",
            "https://hf-mirror.com/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q4_K_M.gguf",
            "https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q4_K_M.gguf",
        ],
        size_mb: 2500,
    },
];

struct GgufModelDef {
    id: &'static str,
    name: &'static str,
    filename: &'static str,
    urls: &'static [&'static str],
    size_mb: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct GgufModelInfo {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub size_mb: u64,
    pub downloaded: bool,
    pub path: Option<String>,
}

/// 返回可下载模型列表，并标注是否已下载
#[tauri::command]
pub fn list_available_gguf_models(state: State<'_, AppState>) -> Vec<GgufModelInfo> {
    let models_root = state.model_dir.parent().unwrap_or(&state.model_dir).to_path_buf();
    AVAILABLE_GGUF_MODELS
        .iter()
        .map(|def| {
            let path = models_root.join(def.filename);
            let downloaded = path.exists();
            GgufModelInfo {
                id: def.id.to_string(),
                name: def.name.to_string(),
                filename: def.filename.to_string(),
                size_mb: def.size_mb,
                downloaded,
                path: if downloaded { Some(path.to_string_lossy().into_owned()) } else { None },
            }
        })
        .collect()
}

/// 下载指定 GGUF 模型，通过事件 "gguf-download-progress" 上报进度
#[tauri::command]
pub async fn download_gguf_model(model_id: String, app: AppHandle) -> Result<String, String> {
    let def = AVAILABLE_GGUF_MODELS
        .iter()
        .find(|d| d.id == model_id)
        .ok_or_else(|| format!("未知模型 id: {model_id}"))?;

    let models_root = {
        let state = app.state::<AppState>();
        state.model_dir.parent().unwrap_or(&state.model_dir).to_path_buf()
    };
    std::fs::create_dir_all(&models_root).map_err(|e| e.to_string())?;
    let dest = models_root.join(def.filename);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| e.to_string())?;

    // 断点续传：检测已下载的字节数
    let partial_dest = models_root.join(format!("{}.part", def.filename));
    let resume_from: u64 = if partial_dest.exists() {
        std::fs::metadata(&partial_dest).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    // 逐个尝试镜像地址（带 Range 头实现断点续传）
    let mut last_err = String::new();
    let mut resp_opt = None;
    for &url in def.urls {
        let mut req = client.get(url);
        if resume_from > 0 {
            req = req.header("Range", format!("bytes={resume_from}-"));
        }
        match req.send().await {
            Ok(r) if r.status().is_success() || r.status().as_u16() == 206 => {
                resp_opt = Some(r);
                break;
            }
            Ok(r) => {
                last_err = format!("HTTP {} from {url}", r.status());
            }
            Err(e) => {
                last_err = format!("请求失败 {url}: {e}");
            }
        }
    }
    let response_init = resp_opt.ok_or_else(|| last_err)?;

    // 如果服务器不支持 Range（返回 200 而非 206），则重新下载
    let actual_resume = if response_init.status().as_u16() == 206 { resume_from } else { 0 };
    let content_len = response_init.content_length().unwrap_or(0);
    let total = if actual_resume > 0 { actual_resume + content_len } else { content_len };
    let mut downloaded: u64 = actual_resume;

    use std::io::Write;
    let mut file = if actual_resume > 0 {
        std::fs::OpenOptions::new().append(true).open(&partial_dest).map_err(|e| e.to_string())?
    } else {
        std::fs::File::create(&partial_dest).map_err(|e| e.to_string())?
    };
    let mut response = response_init;

    while let Some(chunk) = response.chunk().await.map_err(|e| format!("下载错误: {e}"))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "gguf-download-progress",
            serde_json::json!({
                "model_id": model_id,
                "done": downloaded,
                "total": total,
            }),
        );
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    // 下载完成，将 .part 文件重命名为正式文件
    std::fs::rename(&partial_dest, &dest).map_err(|e| format!("文件重命名失败: {e}"))?;

    Ok(dest.to_string_lossy().into_owned())
}

/// 列出 models 目录下所有 .gguf 文件
#[tauri::command]
pub fn list_llm_models(state: State<'_, AppState>) -> Vec<String> {
    let models_root = state.model_dir.parent().unwrap_or(&state.model_dir);
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(models_root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("gguf") {
                found.push(p.to_string_lossy().into_owned());
            }
        }
    }
    // 也搜 models_root 子目录
    if let Ok(entries) = std::fs::read_dir(models_root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Ok(sub) = std::fs::read_dir(&p) {
                    for se in sub.flatten() {
                        let sp = se.path();
                        if sp.extension().and_then(|s| s.to_str()) == Some("gguf") {
                            found.push(sp.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
    }
    found
}

/// 加载指定路径的 GGUF 模型（后台线程异步加载，立即返回）
///
/// 加载结果通过 Tauri 事件通知前端：
/// - 成功：emit "llm-loaded" (payload = path)
/// - 失败：emit "llm-load-failed" (payload = 错误描述)
#[tauri::command]
pub fn load_llm_model(path: String, app: AppHandle) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("文件不存在: {path}"));
    }

    // ── Gate 2: license-aware model tier check (synchronous, before we
    //     spawn the background loader). Custom GGUF and Pro-tier built-ins
    //     are blocked here for Free / Trial-expired users. ──
    {
        let state = app.state::<AppState>();
        let lic = state
            .license
            .read()
            .map_err(|e| format!("license lock: {e}"))?
            .clone();
        let tier = crate::license::gates::classify_model_path(Path::new(&path));
        if !crate::license::gates::is_model_allowed(tier, &lic) {
            let reason = match tier {
                crate::license::gates::ModelTier::Custom => "custom_gguf",
                _ => "model_tier",
            };
            return Err(crate::license::gates::pro_required(reason));
        }
    }

    // 立即返回，实际加载在后台线程完成
    std::thread::spawn(move || {
        let state = app.state::<AppState>();

        // 持有加载互斥锁，防止与启动自动加载线程并发（避免 BackendAlreadyInitialized）
        // 如果自动加载正在进行，此处会阻塞直到其完成，再进行模型切换
        let _loading_guard = match state.llm_loading.lock() {
            Ok(g) => g,
            Err(_) => {
                let _ = app.emit("llm-load-failed", "内部错误：加载互斥锁中毒");
                return;
            }
        };

        // 先释放旧模型（触发 LlamaBackend::drop，重置 INITIALIZED 标志）
        if let Ok(mut guard) = state.llm.lock() {
            *guard = None;
        }

        match Llm::load(Path::new(&path)) {
            Ok(llm) => {
                if let Ok(mut guard) = state.llm.lock() {
                    *guard = Some(llm);
                }
                // 记住最后加载的模型路径，下次启动自动恢复
                if let Ok(db) = state.db.lock() {
                    let _ = db.execute(
                        "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_llm_path', ?1)",
                        rusqlite::params![path],
                    );
                }
                let _ = app.emit("llm-loaded", &path);
            }
            Err(e) => {
                let _ = app.emit("llm-load-failed", format!("加载失败: {e}"));
            }
        }
    });

    Ok(())
}

/// 对话历史消息（多轮追问用）
#[derive(serde::Deserialize)]
pub struct HistoryMessage {
    pub role: String,   // "user" | "assistant"
    pub content: String,
}

/// 基于 RAG 回答问题
///
/// 流程：混合检索（语义 + BM25）→ top chunks → 拼 Prompt → LLM 生成答案
#[tauri::command]
pub fn ask_question(
    question: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<AskResponse, String> {
    // Free-tier monthly quota check (no-op for Trial / Pro).
    crate::commands::license::consume_ai_quota(&app, &state)?;

    // 1. 混合检索：chunk 上限根据已加载模型的参数量自适应
    let max_chunks = {
        let guard = state.llm.lock().map_err(|_| "llm lock poisoned".to_string())?;
        guard.as_ref().map(|llm| llm.rag_max_chunks()).unwrap_or(5)
    };
    let chunks = search_hybrid_for_rag(&question, &state, max_chunks).map_err(|e| e.to_string())?;

    // 每个 chunk 截取前 700 字符，防止 prompt 过长导致生成空间不足
    let context_chunks: Vec<String> = chunks
        .iter()
        .map(|c| {
            let text = if c.content.chars().count() > 700 {
                c.content.chars().take(700).collect::<String>() + "…"
            } else {
                c.content.clone()
            };
            format!("【来源：{}】\n{}", c.name, text)
        })
        .collect();

    let sources: Vec<SourceRef> = chunks
        .iter()
        .map(|c| SourceRef {
            name: c.name.clone(),
            path: c.path.clone(),
            snippet: c.content.chars().take(200).collect::<String>(),
        })
        .collect();

    // 2. 构建 Prompt（Qwen/Llama chat 格式）
    let context_text = if context_chunks.is_empty() {
        "（未找到相关文档）".to_string()
    } else {
        context_chunks.join("\n\n")
    };

    // Qwen3 使用 /no_think 禁用思考模式，直接输出答案
    let prompt = format!(
        "<|im_start|>system\n你是一个本地文件助手。请严格根据用户提供的文档内容回答问题，直接给出答案，不要编造信息。只有文档中确实没有相关内容时，才说找不到答案。<|im_end|>\n\
         <|im_start|>user\n以下是相关文档内容：\n\n{context_text}\n\n请根据上述内容回答：{question} /no_think<|im_end|>\n\
         <|im_start|>assistant\n<think>\n\n</think>\n\n"
    );

    // 3. LLM 推理
    let llm_guard = state
        .llm
        .lock()
        .map_err(|_| "llm lock poisoned".to_string())?;

    let answer = match llm_guard.as_ref() {
        Some(llm) => llm.generate(&prompt, 2048).map_err(|e| e.to_string())?,
        None => return Err("LLM 未加载，请先在设置中选择并加载模型".to_string()),
    };

    Ok(AskResponse { answer, sources })
}

#[derive(serde::Serialize)]
pub struct AskResponse {
    pub answer: String,
    pub sources: Vec<SourceRef>,
}

#[derive(serde::Serialize, Clone)]
pub struct SourceRef {
    pub name: String,
    pub path: String,
    pub snippet: String,
}

/// 召回完整性快照,用于前端展示"已分析 X 段 · 涉及 Y 个文件"
/// 以及"还有 N 段未引用,点击展开"。
#[derive(serde::Serialize, Clone, Default)]
pub struct AskRecallInfo {
    /// 第一轮检索得到的总候选数(去重 + 阈值过滤后)
    pub initial_pool: usize,
    /// 加上"每文件保底"补进来后的候选数
    pub after_threshold: usize,
    /// 最终送进 LLM context 的 chunk 数(含邻居扩展)
    pub used: usize,
    /// 涉及不同文件数
    pub files: usize,
    /// 精排实际状态:"off"/"absent"/"ok"/"failed"
    pub reranker_state: String,
}

/// 启动一次流式问答后,后端立即返回的元数据。
/// (sources + recall),前端在 token 流到达前可以先把信息块画出来。
#[derive(serde::Serialize, Clone)]
pub struct AskStreamStart {
    pub sources: Vec<SourceRef>,
    pub recall: AskRecallInfo,
}

/// 流式问答（支持多轮对话追问）：直接返回检索来源，通过 Tauri 事件逐 token 推送生成结果
///
/// 返回值：Vec<SourceRef>（检索来源，供前端立即展示）
/// 事件序列：
///   ask-token    → String（每生成一个 token 片段）
///   ask-done     → null（生成结束）
///   ask-error    → String（发生错误时发出）
#[tauri::command]
pub fn ask_question_stream(
    question: String,
    history: Option<Vec<HistoryMessage>>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<AskStreamStart, String> {
    // Free-tier monthly quota check (no-op for Trial / Pro).
    crate::commands::license::consume_ai_quota(&app, &state)?;

    // 1. 混合检索（快速，同步完成）
    // 多轮对话时，将上一轮用户问题拼入检索词，保留实体/上下文信息
    // 例如：上轮"东方雨虹的项目有多少"，本轮"每个项目的价格"
    //   → 检索词："东方雨虹的项目有多少 每个项目的价格"
    let retrieval_query = {
        let last_user = history.as_ref()
            .and_then(|h| h.iter().rev().find(|m| m.role == "user"))
            .map(|m| m.content.as_str())
            .unwrap_or("");
        if !last_user.is_empty() && last_user != question.as_str() {
            format!("{} {}", last_user, question)
        } else {
            question.clone()
        }
    };
    // chunk 上限根据已加载模型的参数量自适应（同时检查模型是否已加载）
    let max_chunks = {
        let guard = state.llm.lock().map_err(|_| "llm lock poisoned".to_string())?;
        match guard.as_ref() {
            Some(llm) => llm.rag_max_chunks(),
            None => return Err("LLM 未加载，请先在设置中选择并加载模型".to_string()),
        }
    };

    // 进度事件:让前端在等待 reranker / 检索 / LLM prefill 时能看到具体进展,
    // 而不是干等"思考中...";前端监听 "rag-stage" 实时替换 assistant 占位文本。
    let _ = app.emit("rag-stage", "📋 正在检索相关片段…");

    // 2. 构建上下文文本和来源引用 — 走 V2 管线
    //    (top-50 召回 + 每文件保底 + 邻居扩展 + 可选 reranker)
    let rag = build_rag_context_v2(&retrieval_query, &state, max_chunks, Some(&app))?;
    let RagContext { sources, context_text, stats } = rag;

    // 检索完了,告诉用户接下来 LLM 要开工(prefill 是真正最慢的一步)
    let _ = app.emit("rag-stage", "🤔 模型正在思考…");

    // [DEBUG] 打印 RAG 检索到的上下文
    eprintln!(
        "[RAG DEBUG] q={question:?} | pool={} after_floor={} used={} files={} rerank={}",
        stats.initial_pool, stats.after_threshold, stats.used, stats.files, stats.reranker_state
    );
    eprintln!("[RAG DEBUG] context=\n{context_text}");

    // 5. 构建多轮对话 prompt — 强约束防止"答非所问 / 漏答 / 编造"
    //
    //   注意 prompt 里**绝不要用"文件名"、"编号"这种占位词**当模板,
    //   小模型(0.6B / 1.7B / 4B)会直接照抄占位词作为输出,
    //   导致答案里出现"根据《文件名 · #0》"这种 bug。
    //   解决办法:用真实样子的具体例子,并显式禁止照抄占位词。
    // ── 紧凑版 system prompt(原版 3000 字 → 现在 ~1200 字)──
    //   为啥要瘦身:1.7B 模型有效 context ~4-8k tokens,大 prompt 会
    //   显著拖慢 prefill,用户感知"卡住"。把核心规则保留,把多余的
    //   示例砍掉(它们提升边际很小,但占了 1500+ 字)。
    let mut prompt = String::from(
        "<|im_start|>system\n\
         你是文档助手。基于「参考文档」回答用户问题。每条规则都必须遵守。\n\
         \n\
         核心规则:\n\
         1. **答案 = 内容 + 引用**:必须给出具体内容(数字/名称/句子),引用《文件名》是注脚,不是答案本身。只写文件名而不给内容 = 不合格。\n\
         2. 只用「参考文档」,绝对不调用训练知识。文档里没写的 → 直接说「提供的文档中没有相关内容」,不要猜。\n\
         3. 数字、日期、姓名、金额、税号、账号必须与原文字面**完全一致**。\n\
         4. 「参考文档」按 `=== 文件 N: 文件名 ===` 分组,同一文件可能多个 `[片段 N]`。统计「几份」时**只数 `=== 文件 N ===` 头数**,不要把片段当文件。\n\
         5. 问「X 是什么 / 内容 / 信息」→ 必须给出文档里的具体数据,不能只列文件名。\n\
         6. 问「几份 / 哪些 X」(X 是类型)→ 严格按类型过滤:\n\
           - 「合同 / 协议」 ≠ 「招标 / 投标 / 需求 / 方案 / 模板」\n\
           - 文件名带「招标」「投标」「需求」的**不是**合同\n\
         7. 多份文档讲**同一信息**(如同一家公司的开票信息)→ **合并列一次** + 文末写「以上信息见于:《f1》《f2》《f3》」。绝不要逐份重复 3-4 遍。\n\
         8. 列表用标准 markdown `- `(短横线 + 空格),**不要用 `·` 中点**(会丢字)。\n\
         8a. [可视化]:用户问题涉及**多组可比较的数值**(月份销售、各公司金额、季度趋势、占比等)时,优先用 **markdown 表格**列数据,不要用纯文字列表。表格第一列是分类(月份/公司/季度),后面是数值列。表头要明确,例:\n\
            | 月份 | 销售额(¥) |\n\
            |------|----------|\n\
            | 1 月 | 12000 |\n\
            用户可以在前端把表格一键转成柱/线/饼图,不要自己用 ASCII 画图。\n\
         9. 引用文件名用 `《文件名.ext》`,不要 `【...】`、不要 `=== 文件 N: ===`,不要占位词「文件名」「文档1」。\n\
         10. 不要用「...」「等等」「以下省略」「同上」代替具体内容。\n\
         11. 多份文档说法**不一致**时,共同部分列一遍,差异点分别说明哪份文档说什么。\n\
         12. 不重复问题、不输出「好的」「很高兴帮你」等礼貌套话。\n\
         \n\
         好答案示例(用户问「博约云开票信息」,4 份文档基本一致):\n\
         > 博约云的开票信息如下:\n\
         > - 公司名称:青岛博约云信息科技有限公司\n\
         > - 税号:91370214MA94LP7X4G\n\
         > - 开户行:青岛银行股份有限公司深圳路支行\n\
         > - 账号:802920200158066\n\
         > 以上信息见于:《外包协议.doc》《开票信息.docx》《投标文件.doc》《硬件合同.docx》。\n\
         \n\
         坏答案示例(必须避免):\n\
         - 只回文件名 → 「《xxx.doc》」(空答案)\n\
         - 逐份列同样信息 4 遍 → 「《f1》:开票信息...《f2》:开票信息...」(噪声)\n\
         - 把招标 / 投标错算成合同 → 「6 份合同」(实际只有 1 份合同)\n\
         - 凭训练知识补 → 「应该是 2024 年」(应说「提供的文档中没有相关内容」)\n\
         <|im_end|>\n"
    );

    // 历史轮（最多保留最近 6 轮，避免 context 溢出）
    if let Some(hist) = &history {
        let start = if hist.len() > 6 { hist.len() - 6 } else { 0 };
        for msg in &hist[start..] {
            match msg.role.as_str() {
                "user" => prompt.push_str(&format!("<|im_start|>user\n{}<|im_end|>\n", msg.content)),
                "assistant" => prompt.push_str(&format!("<|im_start|>assistant\n{}<|im_end|>\n", msg.content)),
                _ => {}
            }
        }
    }

    // 当前问题（附带检索到的上下文）
    prompt.push_str(&format!(
        "<|im_start|>user\n参考文档:\n\n{context_text}\n\n问题:{question}\n\n请严格根据上述参考文档回答,不能调用你的常识。/no_think<|im_end|>\n\
         <|im_start|>assistant\n<think>\n\n</think>\n\n"
    ));

    // 重置取消标志，确保新请求不被上次残留的 true 阻断
    state.llm_cancel.store(false, std::sync::atomic::Ordering::SeqCst);

    // 在 spawn 之前克隆 cancel，避免 state 被 move 进线程后无法访问
    let cancel = std::sync::Arc::clone(&state.llm_cancel);

    // 6. 后台线程流式生成
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let guard = match state.llm.lock() {
            Ok(g) => g,
            Err(_) => {
                let _ = app.emit("ask-error", "llm lock poisoned");
                return;
            }
        };
        match guard.as_ref() {
            Some(llm) => {
                let result = llm.generate_stream(&prompt, 2048, cancel, |piece| {
                    let _ = app.emit("ask-token", piece);
                });
                match result {
                    Ok(_) => { let _ = app.emit("ask-done", ()); }
                    Err(e) => { let _ = app.emit("ask-error", e.to_string()); }
                }
            }
            None => {
                let _ = app.emit("ask-error", "LLM 未加载");
            }
        }
    });

    Ok(AskStreamStart {
        sources,
        recall: AskRecallInfo {
            initial_pool: stats.initial_pool,
            after_threshold: stats.after_threshold,
            used: stats.used,
            files: stats.files,
            reranker_state: stats.reranker_state.to_string(),
        },
    })
}

/// 限定文档范围的流式问答(NotebookLM 模式)。
///
/// 用户在结果列表里多选若干文档,然后向 AI 提问 —— 只用这些文档的内容
/// 作为上下文,不走全库 RAG。比起在整库里搜索答案,精度更高,也避免
/// 跨项目污染。
///
/// 事件序列:ask-token / ask-done / ask-error,与 `ask_question_stream` 一致。
/// 同样受月度 AI 配额限制(Free 用户每月 30 次)。
#[tauri::command]
pub fn ask_question_scoped(
    question: String,
    paths: Vec<String>,
    history: Option<Vec<HistoryMessage>>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<SourceRef>, String> {
    crate::commands::license::consume_ai_quota(&app, &state)?;

    if paths.is_empty() {
        return Err("请先选择要问答的文档".to_string());
    }

    // 模型必须已加载。
    let max_chunks = {
        let guard = state.llm.lock().map_err(|_| "llm lock poisoned".to_string())?;
        match guard.as_ref() {
            Some(llm) => llm.rag_max_chunks(),
            None => return Err("LLM 未加载,请先在设置中选择并加载模型".to_string()),
        }
    };

    // 文档总量预算:每份文档分到的字符数 = (max_chunks * 700) / paths.len()
    // 但下限 1000 字符,上限 4000 字符,避免极端情况。
    use crate::indexer::parser::parse_file;
    let per_doc_chars: usize = ((max_chunks * 700) / paths.len().max(1))
        .max(1000)
        .min(4000);

    let mut sources: Vec<SourceRef> = Vec::new();
    let mut context_parts: Vec<String> = Vec::new();
    for path_str in &paths {
        let p = std::path::Path::new(path_str);
        if !p.exists() { continue; }
        let parsed = parse_file(p);
        if parsed.content.is_empty() { continue; }
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        let snippet: String = parsed.content.chars().take(per_doc_chars).collect();
        sources.push(SourceRef {
            name: name.clone(),
            path: path_str.clone(),
            snippet: parsed.content.chars().take(200).collect::<String>(),
        });
        context_parts.push(format!("【文件:{name}】\n{snippet}"));
    }
    if context_parts.is_empty() {
        return Err("无法读取所选文件内容".to_string());
    }
    let context_text = context_parts.join("\n\n---\n\n");

    let mut prompt = String::from(
        "<|im_start|>system\n\
         你是一名严谨的文档助手。请严格按以下规则作答:\n\
         1. 只使用「参考文档」中的内容,绝对不能调用训练知识\n\
         2. 如果参考文档里没有明确写出答案,直接回复「提供的文档中没有相关内容」,不要猜测\n\
         3. 回答时必须引用具体文件名作为依据,例如:根据《xxx.docx》...\n\
         4. 数字、日期、姓名、金额等关键事实必须与文档完全一致\n\
         5. 回答简洁直接,不重复问题\n\
         <|im_end|>\n"
    );
    if let Some(hist) = &history {
        let start = if hist.len() > 6 { hist.len() - 6 } else { 0 };
        for msg in &hist[start..] {
            match msg.role.as_str() {
                "user" => prompt.push_str(&format!("<|im_start|>user\n{}<|im_end|>\n", msg.content)),
                "assistant" => prompt.push_str(&format!("<|im_start|>assistant\n{}<|im_end|>\n", msg.content)),
                _ => {}
            }
        }
    }
    prompt.push_str(&format!(
        "<|im_start|>user\n参考文档(用户已限定为以下 {} 份):\n\n{context_text}\n\n问题:{question}\n\n请严格根据上述参考文档回答,不能调用你的常识。/no_think<|im_end|>\n\
         <|im_start|>assistant\n<think>\n\n</think>\n\n",
        sources.len()
    ));

    state.llm_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel = std::sync::Arc::clone(&state.llm_cancel);

    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let guard = match state.llm.lock() {
            Ok(g) => g,
            Err(_) => {
                let _ = app.emit("ask-error", "llm lock poisoned");
                return;
            }
        };
        match guard.as_ref() {
            Some(llm) => {
                let result = llm.generate_stream(&prompt, 2048, cancel, |piece| {
                    let _ = app.emit("ask-token", piece);
                });
                match result {
                    Ok(_) => { let _ = app.emit("ask-done", ()); }
                    Err(e) => { let _ = app.emit("ask-error", e.to_string()); }
                }
            }
            None => {
                let _ = app.emit("ask-error", "LLM 未加载");
            }
        }
    });

    Ok(sources)
}

/// 导入本地 GGUF 模型文件（将文件复制到 models 目录）
#[tauri::command]
pub async fn import_custom_gguf(path: String, app: AppHandle) -> Result<String, String> {
    // Gate 4: Pro-only command.
    {
        let state = app.state::<AppState>();
        crate::commands::license::require_pro(&state, "custom_gguf")?;
    }

    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err(format!("文件不存在: {path}"));
    }
    if src.extension().and_then(|s| s.to_str()) != Some("gguf") {
        return Err("只支持 .gguf 格式文件".to_string());
    }
    let filename = src.file_name().ok_or("无效文件名")?.to_string_lossy().into_owned();
    let models_root = {
        let state = app.state::<AppState>();
        state.model_dir.parent().unwrap_or(&state.model_dir).to_path_buf()
    };
    std::fs::create_dir_all(&models_root).map_err(|e| e.to_string())?;
    let dest = models_root.join(&filename);
    if dest == src {
        // 文件已在 models 目录，直接返回
        return Ok(dest.to_string_lossy().into_owned());
    }
    std::fs::copy(src, &dest).map_err(|e| format!("复制失败: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 查询当前已加载的 LLM 模型路径（未加载则返回 null）
///
/// 前端启动时调用此接口：若后端已自动加载（后台线程），可直接恢复 UI 状态
/// 而无需重复加载模型。
#[tauri::command]
pub fn get_loaded_llm_path(state: State<'_, AppState>) -> Option<String> {
    let is_loaded = state.llm.lock().ok().map(|g| g.is_some()).unwrap_or(false);
    if !is_loaded {
        return None;
    }
    state.db.lock().ok().and_then(|db| {
        db.query_row::<String, _, _>(
            "SELECT value FROM settings WHERE key = 'last_llm_path'",
            [],
            |r| r.get(0),
        )
        .ok()
    })
}

/// 中止当前 LLM 流式生成
#[tauri::command]
pub fn stop_generation(state: tauri::State<'_, crate::state::AppState>) {
    state.llm_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 获取 API LLM 配置
#[tauri::command]
pub fn get_api_llm_config(state: State<'_, AppState>) -> Result<crate::state::ApiLlmConfig, String> {
    let config = state.api_llm_config.read().map_err(|_| "api_llm_config lock poisoned".to_string())?;
    Ok(config.clone())
}

/// 保存 API LLM 配置
#[tauri::command]
pub fn set_api_llm_config(
    config: crate::state::ApiLlmConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 写入内存
    {
        let mut guard = state.api_llm_config.write().map_err(|_| "api_llm_config lock poisoned".to_string())?;
        *guard = config.clone();
    }
    // 持久化到 DB
    let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('api_llm_config', ?1)",
        rusqlite::params![json],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 对多个文件路径生成联合摘要（流式输出，事件：ask-token / ask-done / ask-error）
#[tauri::command]
pub fn summarize_documents(
    paths: Vec<String>,
    state: tauri::State<'_, crate::state::AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Gate 4: Pro-only command.
    crate::commands::license::require_pro(&state, "batch_summary")?;

    use crate::indexer::parser::parse_file;

    let mut context_parts: Vec<String> = Vec::new();
    for path_str in &paths {
        let p = std::path::Path::new(path_str);
        if !p.exists() {
            continue;
        }
        let result = parse_file(p);
        if result.content.is_empty() {
            continue;
        }
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        let snippet: String = result.content.chars().take(1500).collect();
        context_parts.push(format!("【文件：{name}】\n{snippet}"));
    }

    if context_parts.is_empty() {
        return Err("无法读取所选文件内容".to_string());
    }

    let context = context_parts.join("\n\n---\n\n");
    let prompt = format!(
        "<|im_start|>system\n你是文档摘要助手，请对以下多个文件的内容进行简洁的综合摘要，指出各文件的主要内容和相互关系。<|im_end|>\n\
         <|im_start|>user\n以下是需要摘要的文件内容：\n\n{context}\n\n请生成综合摘要。 /no_think<|im_end|>\n\
         <|im_start|>assistant\n<think>\n\n</think>\n\n"
    );

    state.llm_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel = std::sync::Arc::clone(&state.llm_cancel);

    std::thread::spawn(move || {
        let st = app.state::<crate::state::AppState>();
        let guard = match st.llm.lock() {
            Ok(g) => g,
            Err(_) => {
                let _ = app.emit("ask-error", "llm lock poisoned");
                return;
            }
        };
        match guard.as_ref() {
            Some(llm) => {
                let result = llm.generate_stream(&prompt, 2048, cancel, |piece| {
                    let _ = app.emit("ask-token", piece);
                });
                match result {
                    Ok(_) => {
                        let _ = app.emit("ask-done", ());
                    }
                    Err(e) => {
                        let _ = app.emit("ask-error", e.to_string());
                    }
                }
            }
            None => {
                let _ = app.emit("ask-error", "LLM 未加载，请先在「文档问答」面板加载模型");
            }
        }
    });

    Ok(())
}

/// 流式问答（API 模式，OpenAI 兼容接口）
///
/// 与本地模式一样使用 RAG 检索，但生成部分通过 HTTP API 调用
/// 事件序列：ask-token / ask-done / ask-error
#[tauri::command]
pub async fn ask_question_stream_api(
    question: String,
    history: Option<Vec<HistoryMessage>>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<SourceRef>, String> {
    // Free-tier monthly quota check (no-op for Trial / Pro).
    crate::commands::license::consume_ai_quota(&app, &state)?;

    // 读取 API 配置
    let config = {
        let guard = state.api_llm_config.read().map_err(|_| "api_llm_config lock poisoned".to_string())?;
        guard.clone()
    };
    if !config.enabled {
        return Err("API LLM 未启用，请在设置中配置".to_string());
    }

    // RAG 检索（与本地模式相同逻辑）
    let retrieval_query = {
        let last_user = history.as_ref()
            .and_then(|h| h.iter().rev().find(|m| m.role == "user"))
            .map(|m| m.content.as_str())
            .unwrap_or("");
        if !last_user.is_empty() && last_user != question.as_str() {
            format!("{} {}", last_user, question)
        } else {
            question.clone()
        }
    };

    let rag = build_rag_context(&retrieval_query, &state, 5)?;
    let RagContext { sources, context_text, stats: _ } = rag;

    // 构建 messages 数组（OpenAI 格式）
    let mut messages: Vec<serde_json::Value> = vec![
        serde_json::json!({
            "role": "system",
            "content": "你是一个本地文件助手。请严格根据用户提供的文档内容回答问题，直接给出答案，不要编造信息。只有文档中确实没有相关内容时，才说找不到答案。"
        })
    ];

    if let Some(hist) = &history {
        let start = if hist.len() > 6 { hist.len() - 6 } else { 0 };
        for msg in &hist[start..] {
            messages.push(serde_json::json!({
                "role": msg.role,
                "content": msg.content,
            }));
        }
    }

    messages.push(serde_json::json!({
        "role": "user",
        "content": format!("以下是相关文档内容：\n\n{context_text}\n\n请根据上述内容回答：{question}")
    }));

    let body = serde_json::json!({
        "model": config.model_name,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "top_p": config.top_p,
        "stream": true,
    });

    // 重置取消标志
    state.llm_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel = std::sync::Arc::clone(&state.llm_cancel);

    let endpoint = config.endpoint.clone();
    let api_key = config.api_key.clone();

    // 在后台任务中处理 SSE 流（避免阻塞 Tauri 命令线程）
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let req = client
            .post(&endpoint)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {api_key}"))
            .json(&body);

        let response = match req.send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let status = r.status();
                let body_text = r.text().await.unwrap_or_default();
                let _ = app.emit("ask-error", format!("API 请求失败 HTTP {status}: {body_text}"));
                return;
            }
            Err(e) => {
                let _ = app.emit("ask-error", format!("API 请求失败: {e}"));
                return;
            }
        };

        // 逐行解析 SSE
        use tokio::io::AsyncBufReadExt;
        use tokio_util::io::StreamReader;
        use futures_util::TryStreamExt;

        let bytes_stream = response.bytes_stream();
        let stream = bytes_stream.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
        let reader = tokio::io::BufReader::new(StreamReader::new(stream));
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let line = line.trim().to_string();
            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line["data: ".len()..];
            if data == "[DONE]" {
                break;
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                    if !content.is_empty() {
                        let _ = app.emit("ask-token", content);
                    }
                }
            }
        }
        let _ = app.emit("ask-done", ());
    });

    Ok(sources)
}

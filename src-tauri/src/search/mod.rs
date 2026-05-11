use crate::state::AppState;
use anyhow::Result;
use serde::Serialize;
use tantivy::{collector::TopDocs, query::QueryParser, schema::Value};

#[derive(Serialize, Debug)]
pub struct SearchResult {
    pub file_id: u64,
    pub path: String,
    pub name: String,
    pub file_type: String,
    pub score: f32,
    pub snippet: String,
    pub size: u64,
    pub modified: i64,
}

/// 从文本中提取围绕查询词的上下文片段
fn extract_snippet(content: &str, query: &str, max_chars: usize) -> String {
    if content.is_empty() {
        return String::new();
    }

    let content_lower = content.to_lowercase();

    // 按空格拆分查询词（与前端高亮逻辑一致：空格=OR，无空格=整体短语）
    let first_byte_pos = query
        .split_whitespace()
        .filter_map(|term| content_lower.find(&term.to_lowercase()))
        .min()
        .unwrap_or(0);

    // 转换字节位置为字符位置
    let first_char_pos = content[..first_byte_pos].chars().count();
    let chars: Vec<char> = content.chars().collect();
    let total_chars = chars.len();

    // 在匹配位置前后各取一定上下文
    let start_char = first_char_pos.saturating_sub(40);
    let end_char = (start_char + max_chars).min(total_chars);

    let snippet: String = chars[start_char..end_char].iter().collect();

    match (start_char > 0, end_char < total_chars) {
        (true, true) => format!("...{}...", snippet),
        (true, false) => format!("...{}", snippet),
        (false, true) => format!("{}...", snippet),
        (false, false) => snippet,
    }
}

pub fn search_fulltext(query_str: &str, state: &AppState, limit: usize) -> Result<Vec<SearchResult>> {
    // Phase 1: Tantivy 搜索（持有 fts 锁，尽快释放）
    let (searcher, query, field_id, field_path, field_name, field_file_type) = {
        let fts = state.fts.lock().map_err(|_| anyhow::anyhow!("fts lock poisoned"))?;
        fts.reader.reload()?;
        let searcher = fts.reader.searcher();
        let query_parser = QueryParser::for_index(
            &fts.index,
            vec![fts.field_name, fts.field_content],
        );
        // 先尝试解析带 AND/OR/NOT/引号 等高级语法；失败则降级为纯词组搜索
        let query = query_parser.parse_query(query_str).or_else(|_| {
            // 将查询词直接用空格拼接（Tantivy 默认 OR 语义），作为安全 fallback
            let safe: String = query_str
                .chars()
                .map(|c| {
                    if "+-&|!(){}[]^\"~*?:\\/".contains(c) {
                        ' '
                    } else {
                        c
                    }
                })
                .collect();
            query_parser.parse_query(safe.trim())
        })?;
        (searcher, query, fts.field_id, fts.field_path, fts.field_name, fts.field_file_type)
        // fts 锁在此释放
    };

    let top_docs = searcher.search(&query, &TopDocs::with_limit(limit))?;

    let mut results = Vec::new();
    for (score, doc_address) in top_docs {
        let doc = searcher.doc::<tantivy::TantivyDocument>(doc_address)?;
        let file_id = doc.get_first(field_id).and_then(|v| v.as_u64()).unwrap_or(0);
        let path = doc.get_first(field_path).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let name = doc.get_first(field_name).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let file_type = doc.get_first(field_file_type).and_then(|v| v.as_str()).unwrap_or("").to_string();

        results.push(SearchResult {
            file_id,
            path,
            name,
            file_type,
            score,
            snippet: String::new(),
            size: 0,
            modified: 0,
        });
    }

    // Phase 2: 从 chunks 表找到包含查询词的那个 chunk 做 snippet
    if !results.is_empty() {
        let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        let terms: Vec<String> = query_str
            .split_whitespace()
            .map(|t| t.to_lowercase())
            .collect();

        for result in results.iter_mut() {
            let mut stmt = match db.prepare(
                "SELECT content FROM chunks WHERE file_id = ?1 ORDER BY chunk_index",
            ) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let chunks: Vec<String> = stmt
                .query_map(rusqlite::params![result.file_id as i64], |r| {
                    r.get::<_, String>(0)
                })
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();

            // 优先使用包含任意查询词的 chunk，保证高亮有内容可标
            let best = chunks
                .iter()
                .find(|c| {
                    let lower = c.to_lowercase();
                    terms.iter().any(|t| lower.contains(t.as_str()))
                })
                .or_else(|| chunks.first());

            if let Some(content) = best {
                result.snippet = extract_snippet(content, query_str, 200);
            }

            if let Ok((size, modified)) = db.query_row(
                "SELECT size, modified FROM files WHERE id = ?1",
                rusqlite::params![result.file_id as i64],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)?))
            ) {
                result.size = size;
                result.modified = modified;
            }
        }
    }

    Ok(results)
}

/// 文件名模糊搜索（SQLite LIKE，不需要 Tantivy）
pub fn search_filename(query_str: &str, state: &AppState, limit: usize) -> Result<Vec<SearchResult>> {
    let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
    let escaped = query_str
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{}%", escaped);
    let mut stmt = db.prepare(
        "SELECT id, path, file_type, size, modified FROM files WHERE path LIKE ?1 ESCAPE '\\' LIMIT ?2",
    )?;
    let results: Result<Vec<SearchResult>, _> = stmt
        .query_map(rusqlite::params![pattern, limit as i64], |r| {
            let path: String = r.get(1)?;
            let name = std::path::Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            Ok(SearchResult {
                file_id: r.get::<_, i64>(0)? as u64,
                path,
                name,
                file_type: r.get(2)?,
                score: 1.0,
                snippet: String::new(),
                size: r.get::<_, i64>(3).unwrap_or(0) as u64,
                modified: r.get::<_, i64>(4).unwrap_or(0),
            })
        })?
        .collect();
    Ok(results?)
}

/// 语义搜索（基于 embedding 向量相似度）
/// 若 embedder 或 vector_index 不可用，返回空结果（优雅降级）
pub fn search_semantic(query_str: &str, state: &AppState, limit: usize) -> Result<Vec<SearchResult>> {
    // Step 1: 生成查询 embedding（持有 embedder 锁，尽快释放）
    let query_embedding = {
        let mut embedder_guard = state
            .embedder
            .lock()
            .map_err(|_| anyhow::anyhow!("embedder lock poisoned"))?;
        match embedder_guard.as_mut() {
            Some(embedder) => embedder.embed(query_str)?,
            None => return Ok(vec![]), // 模型未加载，返回空
        }
    }; // embedder lock released

    // Step 2: 向量搜索（持有 vector_index 锁，尽快释放）
    let chunk_scores: Vec<(u64, f32)> = {
        let vi_guard = state
            .vector_index
            .lock()
            .map_err(|_| anyhow::anyhow!("vector_index lock poisoned"))?;
        match vi_guard.as_ref() {
            Some(vi) => {
                if vi.len() == 0 {
                    return Ok(vec![]);
                }
                vi.search(&query_embedding, limit)?
            }
            None => return Ok(vec![]),
        }
    }; // vi lock released

    if chunk_scores.is_empty() {
        return Ok(vec![]);
    }

    // 过滤相似度过低的结果（cosine distance 越小越相似，>0.5 视为不相关）
    const SEMANTIC_THRESHOLD: f32 = 0.5;
    let chunk_scores: Vec<(u64, f32)> = chunk_scores
        .into_iter()
        .filter(|(_, dist)| *dist <= SEMANTIC_THRESHOLD)
        .collect();

    if chunk_scores.is_empty() {
        return Ok(vec![]);
    }

    // Step 3: 从 SQLite 取 chunk + 文件信息
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("db lock poisoned"))?;

    let mut results = Vec::new();
    for (chunk_id, score) in &chunk_scores {
        let row = db.query_row(
            "SELECT c.content, f.id, f.path, f.file_type, f.size, f.modified
             FROM chunks c JOIN files f ON c.file_id = f.id
             WHERE c.id = ?1",
            rusqlite::params![*chunk_id as i64],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4).unwrap_or(0) as u64,
                    r.get::<_, i64>(5).unwrap_or(0),
                ))
            },
        );
        if let Ok((content, file_id, path, file_type, size, modified)) = row {
            let name = std::path::Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let snippet = extract_snippet(&content, query_str, 200);
            results.push(SearchResult {
                file_id: file_id as u64,
                path,
                name,
                file_type,
                score: *score,
                snippet,
                size,
                modified,
            });
        }
    }
    Ok(results)
}

/// 提取查询字符串的 2-gram + 3-gram 集合
fn query_ngrams(query: &str) -> std::collections::HashSet<String> {
    let chars: Vec<char> = query.to_lowercase().chars().collect();
    let mut terms = std::collections::HashSet::new();
    for i in 0..chars.len() {
        if i + 2 <= chars.len() { terms.insert(chars[i..i + 2].iter().collect::<String>()); }
        if i + 3 <= chars.len() { terms.insert(chars[i..i + 3].iter().collect::<String>()); }
    }
    terms
}

/// IDF 加权关键词覆盖率
///
/// 在已检索到的 chunk 集合内计算每个 n-gram 的文档频率（DF）：
/// - 稀有词（如"亿利盛"，只出现在少数 chunk 中）→ IDF 高 → 权重大
/// - 通用词（如"项目"、"乙方"，几乎所有 chunk 都有）→ IDF 低 → 权重小
///
/// 这样"亿利盛"类实体名即使只贡献 3 个 n-gram，也能以高 IDF 权重主导最终得分，
/// 避免含大量通用词的无关项目文档被错误排在前面。
fn keyword_coverage_idf(
    chunk_text: &str,
    terms: &std::collections::HashSet<String>,
    ngram_df: &std::collections::HashMap<String, usize>,
    total_docs: usize,
) -> f32 {
    if terms.is_empty() {
        return 0.0;
    }
    let chunk_lower = chunk_text.to_lowercase();
    let n = total_docs as f32;
    let mut weighted_hits = 0.0f32;
    let mut total_weight = 0.0f32;

    for term in terms {
        // IDF = log(N / df) + 1，df=0 时取保守值 0.5（避免 infinity）
        let df = ngram_df.get(term).copied().unwrap_or(0) as f32;
        let idf = if df > 0.0 {
            (n / df).ln().max(0.0) + 1.0
        } else {
            // 该 n-gram 在所有 retrieved chunk 中均未出现（查询词本身就不在候选集里）
            // 给中等权重，不影响已命中词的比较
            1.0
        };
        let hit = if chunk_lower.contains(term.as_str()) { 1.0_f32 } else { 0.0 };
        weighted_hits += hit * idf;
        total_weight += idf;
    }

    if total_weight == 0.0 { 0.0 } else { weighted_hits / total_weight }
}

/// RAG 专用混合检索：语义 + BM25 并行，关键词覆盖度重排序
///
/// 流程：
/// 1. 语义检索（向量相似度，宽阈值 0.9）
/// 2. BM25 全文检索（始终运行，每文件取包含查询词的所有 chunk，最多 3 个）
/// 3. 合并去重
/// 4. 重排序：final_score = 0.3 * vector_sim + 0.7 * keyword_coverage
///    → 实体名等关键词匹配获得高权重，防止"同语义不同项目"的混淆
pub fn search_hybrid_for_rag(
    query_str: &str,
    state: &AppState,
    max_chunks: usize,
) -> Result<Vec<RagChunk>> {
    let mut chunks: Vec<RagChunk> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // ── 1. 语义检索（始终运行）──────────────────────────────────────
    {
        let query_embedding = {
            let mut eg = state.embedder.lock().map_err(|_| anyhow::anyhow!("embedder lock"))?;
            match eg.as_mut() {
                Some(e) => Some(e.embed(query_str)?),
                None => None,
            }
        };

        if let Some(embedding) = query_embedding {
            let fetch_n = max_chunks * 3; // 多取一些，后续重排
            let chunk_scores = {
                let vi = state.vector_index.lock().map_err(|_| anyhow::anyhow!("vi lock"))?;
                match vi.as_ref() {
                    Some(v) if v.len() > 0 => v.search(&embedding, fetch_n)?,
                    _ => vec![],
                }
            };

            let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock"))?;
            for (chunk_id, dist) in chunk_scores {
                if dist > 0.9 { continue; }
                let row = db.query_row(
                    "SELECT c.content, c.chunk_index, f.id, f.path, f.file_type
                     FROM chunks c JOIN files f ON c.file_id = f.id
                     WHERE c.id = ?1",
                    rusqlite::params![chunk_id as i64],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?,
                             r.get::<_, i64>(2)?,
                             r.get::<_, String>(3)?, r.get::<_, String>(4)?)),
                );
                if let Ok((content, chunk_index, file_id, path, file_type)) = row {
                    // 跳过磁盘上已不存在的文件（文件被删除但 SQLite/向量库未及时清理时的兜底）
                    if !std::path::Path::new(&path).exists() { continue; }
                    // 跳过乱码内容：有效 CJK/ASCII 字符比例低于 50% 视为二进制垃圾
                    if is_garbage_content(&content) { continue; }
                    let key = content.chars().take(80).collect::<String>();
                    if seen.insert(key) {
                        let name = std::path::Path::new(&path)
                            .file_name().unwrap_or_default().to_string_lossy().to_string();
                        chunks.push(RagChunk {
                            content,
                            file_id: file_id as u64,
                            path,
                            name,
                            file_type,
                            score: 1.0 - dist,
                            chunk_index,
                            chunk_id: chunk_id as i64,
                        });
                    }
                }
            }
        }
    }

    // ── 2. BM25 全文检索（始终运行）──────────────────────────────────
    {
        let (searcher, query, field_id, field_path, field_name, field_file_type) = {
            let fts = state.fts.lock().map_err(|_| anyhow::anyhow!("fts lock"))?;
            fts.reader.reload()?;
            let searcher = fts.reader.searcher();
            // tantivy QueryParser 默认使用 OR 语义（不调用 set_conjunction_by_default 即为 OR）
            // 这样自然语言问句"亿利盛是什么公司"只需任意 bigram 命中即可返回结果
            let qp = QueryParser::for_index(&fts.index, vec![fts.field_name, fts.field_content]);
            let query = qp.parse_query(query_str).unwrap_or_else(|_| {
                qp.parse_query("").unwrap()
            });
            (searcher, query, fts.field_id, fts.field_path, fts.field_name, fts.field_file_type)
        };

        let top_docs = searcher.search(&query, &TopDocs::with_limit(20))?;

        let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock"))?;
        // 提取查询的 2-gram 关键词用于 chunk 过滤
        let query_chars: Vec<char> = query_str.to_lowercase().chars().collect();
        let grams: Vec<String> = (0..query_chars.len())
            .filter_map(|i| {
                if i + 2 <= query_chars.len() {
                    Some(query_chars[i..i + 2].iter().collect::<String>())
                } else {
                    None
                }
            })
            .collect();

        for (_bm25_score, doc_addr) in top_docs {
            let doc = searcher.doc::<tantivy::TantivyDocument>(doc_addr)?;
            let file_id = doc.get_first(field_id).and_then(|v| v.as_u64()).unwrap_or(0);
            let path = doc.get_first(field_path).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = doc.get_first(field_name).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let file_type = doc.get_first(field_file_type).and_then(|v| v.as_str()).unwrap_or("").to_string();

            // 取该文件中所有包含查询词的 chunk（最多 3 个），而非只取第一个
            let mut stmt = db.prepare(
                "SELECT id, chunk_index, content FROM chunks WHERE file_id = ?1 ORDER BY chunk_index"
            )?;
            let all_chunks: Vec<(i64, i64, String)> = stmt
                .query_map(rusqlite::params![file_id as i64], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
                })
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();

            // 跳过磁盘上已不存在的文件
            if !std::path::Path::new(&path).exists() { continue; }

            let mut added = 0;
            for (cid, cidx, content) in &all_chunks {
                if added >= 3 { break; }
                // 跳过乱码内容
                if is_garbage_content(content) { continue; }
                let lower = content.to_lowercase();
                let matches = grams.iter().any(|g| lower.contains(g.as_str()));
                if !matches { continue; }

                let key = content.chars().take(80).collect::<String>();
                if seen.insert(key) {
                    chunks.push(RagChunk {
                        content: content.clone(),
                        file_id,
                        path: path.clone(),
                        name: name.clone(),
                        file_type: file_type.clone(),
                        score: 0.5, // 初始分，后面会被关键词覆盖度重算
                        chunk_index: *cidx,
                        chunk_id: *cid,
                    });
                    added += 1;
                }
            }
            // 无匹配 chunk 时不再兜底——避免乱码/二进制文件的内容污染 RAG 上下文
        }
    }

    // ── 3. IDF 加权关键词覆盖度重排序 ────────────────────────────────
    // 先在 retrieved chunk 集合内统计每个 n-gram 的文档频率（DF），
    // 再用 IDF 权重计算加权覆盖率，让稀有词（实体名"亿利盛"）权重远高于通用词（"项目"、"乙方"）
    let terms = query_ngrams(query_str);
    let total_docs = chunks.len().max(1);

    // 统计每个 n-gram 在多少个 chunk 中出现
    let mut ngram_df: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for chunk in &chunks {
        let lower = chunk.content.to_lowercase();
        for t in &terms {
            if lower.contains(t.as_str()) {
                *ngram_df.entry(t.clone()).or_insert(0) += 1;
            }
        }
    }

    for chunk in chunks.iter_mut() {
        let kw = keyword_coverage_idf(&chunk.content, &terms, &ngram_df, total_docs);
        chunk.score = 0.3 * chunk.score + 0.7 * kw;
    }

    chunks.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // 相关性分数过滤:更严格的双重阈值,防止无关 chunk 污染 LLM 上下文,
    // 减少"答非所问"的概率。
    //   - 相对阈值: max_score * 0.4 (旧值 0.25 太宽松,差太多分的 chunk 还会进 LLM)
    //   - 绝对地板: 0.12  (BM25 only 命中分通常 0.05-0.15,小于这个基本是噪声)
    //   - 兜底:    至少保留得分最高的那一条
    if chunks.len() > 1 {
        let max_score = chunks[0].score;
        let threshold = (max_score * 0.4).max(0.12);
        let keep = chunks.iter().position(|c| c.score < threshold).unwrap_or(chunks.len());
        let keep = keep.max(1);
        chunks.truncate(keep);
    }

    chunks.truncate(max_chunks);
    Ok(chunks)
}

/// 同上,带 AppHandle,允许中间过程 emit 进度事件给前端。
pub fn search_hybrid_for_rag_v2_with_progress(
    query_str: &str,
    state: &AppState,
    max_chunks: usize,
    app: &tauri::AppHandle,
) -> Result<(Vec<RagChunk>, RecallStats)> {
    use tauri::Emitter;
    let pool_target = 50usize.max(max_chunks * 4);
    let full_pool = search_hybrid_for_rag(query_str, state, pool_target * 2)?;
    let initial_pool = full_pool.len();

    let primary_take = pool_target.min(full_pool.len());
    let mut primary: Vec<RagChunk> = full_pool[..primary_take].to_vec();

    {
        use std::collections::HashSet;
        let mut seen_files: HashSet<u64> = primary.iter().map(|c| c.file_id).collect();
        for c in full_pool.iter().skip(primary_take) {
            if c.score < 0.10 { break; }
            if seen_files.insert(c.file_id) {
                primary.push(c.clone());
            }
        }
    }
    let after_threshold = primary.len();

    // 让 UI 知道"开始精排"这一阶段(占总时间的大头)
    let _ = app.emit("rag-stage", "✨ 正在精排候选片段…");

    let reranker_state = run_reranker_in_place(query_str, &mut primary, state)
        .unwrap_or("failed");

    primary.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    primary.truncate(max_chunks);

    let total_budget = max_chunks.saturating_mul(2).max(6);
    let with_neighbors = {
        let full = expand_with_neighbors(&primary, state)?;
        if full.len() <= total_budget {
            full
        } else {
            let mut v = full;
            v.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
            v.truncate(total_budget);
            v.sort_by(|a, b| a.file_id.cmp(&b.file_id)
                .then(a.chunk_index.cmp(&b.chunk_index)));
            v
        }
    };
    let files: std::collections::HashSet<u64> =
        with_neighbors.iter().map(|c| c.file_id).collect();

    let stats = RecallStats {
        initial_pool,
        after_threshold,
        used: with_neighbors.len(),
        files: files.len(),
        reranker_state,
    };
    Ok((with_neighbors, stats))
}

/// V2 混合检索 — 治"答案不全 / 答非所问"。
///
/// 与 [`search_hybrid_for_rag`] 的区别：
/// 1. 初筛池子从 ~max_chunks 提到 **50**(语义) + 50(BM25),覆盖更多候选
/// 2. (可选)调用 BGE-reranker 对 cross-encoder 重排;失败/未下载时跳过
/// 3. 每个"超过分数地板"的文件保底拿 1 个最佳 chunk,防止散在多文件
///    的相关内容因全局排名不够高被整体抛弃
/// 4. 命中 chunk 自动带上前后**邻居**(N-1, N+1),补全切片断裂导致的
///    上下文丢失("第 7 条计算"在另一个 chunk 的场景)
/// 5. 返回 [`RecallStats`] 供前端展示"已分析 X 段 / 还有 Y 段未引用"
///
/// `max_chunks` 是**最终送给 LLM** 的硬上限。中间召回池总是 50。
pub fn search_hybrid_for_rag_v2(
    query_str: &str,
    state: &AppState,
    max_chunks: usize,
) -> Result<(Vec<RagChunk>, RecallStats)> {
    // ── 1. 拿一个大池子(v1 内部已做 IDF 重排 + 阈值过滤),只调一次 ──
    //   v1 阈值是 `max_score * 0.4` 配合绝对地板 0.12,我们要的是
    //   "尽量多的真候选",而不是绕过那个阈值,所以直接放大 limit。
    let pool_target = 50usize.max(max_chunks * 4);
    let full_pool = search_hybrid_for_rag(query_str, state, pool_target * 2)?;
    let initial_pool = full_pool.len();

    // 主候选取前 pool_target 个(已按 IDF 加权分数降序)
    let primary_take = pool_target.min(full_pool.len());
    let mut primary: Vec<RagChunk> = full_pool[..primary_take].to_vec();

    // ── 2. 每文件保底召回:扫剩下的尾巴,任何未在 primary 里出现过的
    //      文件、且分数 >= 0.10 的,补 1 个 chunk 进来 ─────────────
    {
        use std::collections::HashSet;
        let mut seen_files: HashSet<u64> = primary.iter().map(|c| c.file_id).collect();
        for c in full_pool.iter().skip(primary_take) {
            if c.score < 0.10 { break; } // v1 已降序,首次低于地板即可终止
            if seen_files.insert(c.file_id) {
                primary.push(c.clone());
            }
        }
    }
    let after_threshold = primary.len();

    // ── 3. (可选)Cross-encoder reranker ───────────────────────────
    //   bge-reranker-v2-m3 / base 拿 (query, passage) 对打分,比单 embedding
    //   准很多。未下载时 state.reranker = None,自动跳过用 IDF 分。
    let reranker_state = run_reranker_in_place(query_str, &mut primary, state)
        .unwrap_or("failed");

    // ── 4. 按(可能 rerank 后的)分数降序,截到 max_chunks ────────
    primary.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    primary.truncate(max_chunks);

    // ── 5. 邻居扩展 ─ 命中 chunk 自动带 N-1 / N+1 ────────────────
    //   邻居本身不参与排序竞争,但**会膨胀总 chunk 数**,从而推高送进
    //   LLM 的 prompt 长度。对 0.6B / 1.7B 这种小模型,长 prompt =
    //   prefill 慢 = 用户感知"卡住"。所以加一个软上限:
    //     - 总 chunk 数 ≤ max_chunks * 2
    //   超过则把最低分的命中 chunk 的邻居丢掉(保留命中,牺牲邻居)。
    let total_budget = max_chunks.saturating_mul(2).max(6);
    let with_neighbors = {
        let full = expand_with_neighbors(&primary, state)?;
        if full.len() <= total_budget {
            full
        } else {
            // 优先保留命中 chunk(score 高的 + 由 RAG 选出的),
            // 邻居用 0.6× score 标记,排序后自然落后。
            let mut v = full;
            v.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
            v.truncate(total_budget);
            // 再按文件 + chunk_index 重排,保持段落顺序便于阅读
            v.sort_by(|a, b| a.file_id.cmp(&b.file_id)
                .then(a.chunk_index.cmp(&b.chunk_index)));
            v
        }
    };
    let files: std::collections::HashSet<u64> =
        with_neighbors.iter().map(|c| c.file_id).collect();

    let stats = RecallStats {
        initial_pool,
        after_threshold,
        used: with_neighbors.len(),
        files: files.len(),
        reranker_state,
    };
    Ok((with_neighbors, stats))
}

/// 用 BGE-reranker 对 `chunks` 原地重打分,返回 reranker 实际运行状态字符串
/// ("off" / "absent" / "ok" / "failed")。
///
/// 失败时 / reranker 未加载时返回 Ok(false),保持 chunks.score 不变,
/// 调用方继续走 IDF 分数排序。
///
/// ## 为什么只对 top-N 跑 reranker
/// 在 M1 Max 上 Xenova INT8 量化的 BGE-reranker-base 实测每对 215ms,
/// 跑 10 对 → 2.1 秒,Tauri 命令同步返回,用户感受为"卡"。
/// 砍到 top-5 → 1.1 秒,加上 retrieval + neighbor expand 总命令时间
/// 控制在 1.5 秒以内。top-5 by IDF 已经覆盖了真正最相关的候选,
/// 后面的 chunk 保留 IDF 分,但被 SHIFT 到 rerank 候选之下,排序自然落后。
const RERANK_TOP_N: usize = 5;

fn run_reranker_in_place(
    query: &str,
    chunks: &mut [RagChunk],
    state: &AppState,
) -> Result<&'static str> {
    if chunks.is_empty() {
        return Ok("absent");
    }

    // ── 紧急开关:用户在设置里勾掉"启用精排" → 直接跳过,即使模型已下载 ──
    {
        let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock"))?;
        let enabled: String = db
            .query_row(
                "SELECT value FROM settings WHERE key = 'reranker_enabled'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "1".to_string());
        if enabled == "0" {
            eprintln!("[reranker] disabled by user setting, skipping");
            return Ok("off");
        }
    }

    let mut guard = state
        .reranker
        .lock()
        .map_err(|_| anyhow::anyhow!("reranker lock"))?;
    let reranker = match guard.as_mut() {
        Some(r) => r,
        None => return Ok("absent"), // 未下载,优雅降级
    };

    // chunks 已按 IDF 分数降序,取前 RERANK_TOP_N 个跑 cross-encoder
    let n_rerank = chunks.len().min(RERANK_TOP_N);
    let passages: Vec<String> = chunks[..n_rerank]
        .iter()
        .map(|c| c.content.chars().take(800).collect::<String>())
        .collect();
    let passage_refs: Vec<&str> = passages.iter().map(|s| s.as_str()).collect();

    eprintln!("[reranker] starting batch of {} pairs", n_rerank);
    let start = std::time::Instant::now();

    // ── 单对带 timing,任何超 500ms 的都报警(帮助定位是哪些 chunk 出问题)
    let mut rerank_scores: Vec<f32> = Vec::with_capacity(n_rerank);
    for (i, p) in passage_refs.iter().enumerate() {
        let t = std::time::Instant::now();
        match reranker.score_one(query, p) {
            Ok(s) => {
                let ms = t.elapsed().as_millis();
                if ms > 500 {
                    eprintln!(
                        "[reranker] WARN pair #{} took {}ms (passage len={})",
                        i, ms, p.chars().count()
                    );
                }
                rerank_scores.push(s);
            }
            Err(e) => {
                eprintln!("[reranker] pair #{} FAILED: {e}; aborting batch, fallback to IDF", i);
                return Ok("failed");
            }
        }
        // 超过 20 秒总耗时就紧急中断,避免用户被卡住
        if start.elapsed().as_secs() > 20 {
            eprintln!(
                "[reranker] total time exceeded 20s after {}/{}; aborting batch, fallback to IDF",
                i + 1, n_rerank
            );
            return Ok("failed");
        }
    }

    let elapsed_ms = start.elapsed().as_millis();
    eprintln!(
        "[reranker] scored {} candidates in {}ms ({}ms/pair)",
        n_rerank,
        elapsed_ms,
        if n_rerank > 0 { elapsed_ms / n_rerank as u128 } else { 0 }
    );

    // 把 reranker 分数与 IDF 分数加权融合,并加 +10 偏移把 rerank 候选
    // 推到一个 IDF 不可能达到的分数区间,确保它们排在尾部之前
    for (c, rs) in chunks[..n_rerank].iter_mut().zip(rerank_scores.iter()) {
        c.score = 10.0 + 0.75 * (*rs) + 0.25 * c.score;
    }
    Ok("ok")
}

/// 对每个命中 chunk 取前后邻居,合并去重后按 (file_id, chunk_index) 排序输出。
fn expand_with_neighbors(
    hits: &[RagChunk],
    state: &AppState,
) -> Result<Vec<RagChunk>> {
    use std::collections::HashMap;
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock"))?;
    // 为每个命中文件加载它的全部 (chunk_id, chunk_index, content) 一次,
    // 后续按 index 邻接取数,避免对每个 hit 都单独 SQL。
    let mut file_chunks: HashMap<u64, Vec<(i64, i64, String)>> = HashMap::new();
    for h in hits {
        if file_chunks.contains_key(&h.file_id) { continue; }
        let mut stmt = db.prepare(
            "SELECT id, chunk_index, content FROM chunks WHERE file_id = ?1 ORDER BY chunk_index",
        )?;
        let rows: Vec<(i64, i64, String)> = stmt
            .query_map(rusqlite::params![h.file_id as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
            })
            .map(|it| it.flatten().collect())
            .unwrap_or_default();
        file_chunks.insert(h.file_id, rows);
    }

    // 用 BTreeMap 保留 (file_id, chunk_index) 排序 + 去重
    use std::collections::BTreeMap;
    let mut merged: BTreeMap<(u64, i64), RagChunk> = BTreeMap::new();

    for h in hits {
        let key = (h.file_id, h.chunk_index);
        merged.insert(key, RagChunk {
            content: h.content.clone(),
            file_id: h.file_id,
            path: h.path.clone(),
            name: h.name.clone(),
            file_type: h.file_type.clone(),
            score: h.score,
            chunk_index: h.chunk_index,
            chunk_id: h.chunk_id,
        });
        let neighbors_of = file_chunks.get(&h.file_id);
        if let Some(all) = neighbors_of {
            if let Some(pos) = all.iter().position(|(_, idx, _)| *idx == h.chunk_index) {
                // 前一个
                if pos > 0 {
                    let (cid, idx, content) = &all[pos - 1];
                    if !is_garbage_content(content) {
                        merged.entry((h.file_id, *idx)).or_insert_with(|| RagChunk {
                            content: content.clone(),
                            file_id: h.file_id,
                            path: h.path.clone(),
                            name: h.name.clone(),
                            file_type: h.file_type.clone(),
                            // 邻居用命中分的 0.6 倍标记(纯展示,排序时不使用)
                            score: h.score * 0.6,
                            chunk_index: *idx,
                            chunk_id: *cid,
                        });
                    }
                }
                // 后一个
                if pos + 1 < all.len() {
                    let (cid, idx, content) = &all[pos + 1];
                    if !is_garbage_content(content) {
                        merged.entry((h.file_id, *idx)).or_insert_with(|| RagChunk {
                            content: content.clone(),
                            file_id: h.file_id,
                            path: h.path.clone(),
                            name: h.name.clone(),
                            file_type: h.file_type.clone(),
                            score: h.score * 0.6,
                            chunk_index: *idx,
                            chunk_id: *cid,
                        });
                    }
                }
            }
        }
    }

    Ok(merged.into_values().collect())
}

/// 检测 chunk 内容是否为乱码/二进制垃圾。
///
/// 两种检测策略：
/// 1. 有效字符比例 < 50%：含大量非 CJK/ASCII 控制字符（适用于 Latin1 乱码）
/// 2. CJK 唯一率 > 85%：真实中文文本中常用字频繁重复（的、是、了、在…），
///    而 .doc 二进制垃圾的随机字节对恰好落在 CJK 码点范围，几乎全是唯一字符。
///    100 个汉字的正常中文唯一率约 40–70%，二进制噪声通常 > 90%。
fn is_garbage_content(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return true;
    }

    // 策略 1：有效字符比例
    let valid = chars.iter().filter(|&&c| {
        c.is_ascii_graphic()
            || c.is_whitespace()
            || ('\u{4E00}'..='\u{9FFF}').contains(&c)   // CJK Unified Ideographs
            || ('\u{3400}'..='\u{4DBF}').contains(&c)   // CJK Extension A
            || ('\u{3000}'..='\u{303F}').contains(&c)   // CJK Symbols and Punctuation
            || ('\u{FF00}'..='\u{FFEF}').contains(&c)   // Halfwidth/Fullwidth Forms
    }).count();
    if valid * 2 < chars.len() {
        return true;
    }

    // 策略 2：CJK 唯一率（仅对较长文本才检查，短文本天然唯一率也高）
    let cjk_chars: Vec<char> = chars.iter()
        .filter(|&&c| ('\u{4E00}'..='\u{9FFF}').contains(&c))
        .copied()
        .collect();
    if cjk_chars.len() >= 100 {
        use std::collections::HashSet;
        let unique: HashSet<char> = cjk_chars.iter().copied().collect();
        // 唯一率 > 85% → 视为二进制垃圾
        if unique.len() * 100 > cjk_chars.len() * 85 {
            return true;
        }
    }

    false
}

/// RAG 检索结果（chunk 级别）
#[derive(Clone, Debug)]
pub struct RagChunk {
    pub content: String,
    pub file_id: u64,
    pub path: String,
    pub name: String,
    pub file_type: String,
    pub score: f32,
    /// 该 chunk 在文件内的顺序索引（0-based）。-1 表示未知 / 邻居拼接得到。
    pub chunk_index: i64,
    /// 该 chunk 在 chunks 表中的主键 id。-1 表示未知 / 邻居拼接得到。
    pub chunk_id: i64,
}

/// 多文档检索摘要(供前端展示"已分析 X 段 / 还有 Y 段未引用")
#[derive(Clone, Debug, Default)]
pub struct RecallStats {
    /// 第一轮(语义 + BM25)合并去重后的候选总数
    pub initial_pool: usize,
    /// 经过阈值过滤后留下、实际进入精排候选的数量
    pub after_threshold: usize,
    /// 最终送入 LLM 上下文的 chunk 数
    pub used: usize,
    /// 涉及的不同文件数
    pub files: usize,
    /// reranker 实际运行状态:
    /// - "off"     用户在设置里关闭了精排
    /// - "absent"  reranker 模型未下载 / 未加载
    /// - "ok"      精排成功跑完
    /// - "failed"  精排尝试运行但中途出错(已 fallback 到 IDF)
    pub reranker_state: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::indexer::tantivy_index::FtsIndex;
    use std::sync::{Arc, Mutex, RwLock};
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> AppState {
        let db_path = tmp.path().join("test.db");
        let conn = db::init(&db_path).unwrap();
        let index_dir = tmp.path().join("index");
        let fts = FtsIndex::open_or_create(&index_dir).unwrap();
        AppState {
            db: Mutex::new(conn),
            fts: Mutex::new(fts),
            vector_index: Mutex::new(None),
            embedder: Mutex::new(None),
            reranker: Mutex::new(None),
            reranker_dir: tmp.path().join("models").join("bge-reranker-v2-m3"),
            llm: Mutex::new(None),
            llm_loading: Mutex::new(()),
            model_dir: tmp.path().join("models"),
            vi_stamp_path: tmp.path().join("vi_stamp"),
            llm_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            api_llm_config: Arc::new(RwLock::new(crate::state::ApiLlmConfig::default())),
            license: crate::license::state::shared(
                crate::license::state::LicenseState::free(String::new(), "test"),
            ),
            app_data_dir: tmp.path().to_path_buf(),
        }
    }

    #[test]
    fn test_fulltext_search_returns_results() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);

        {
            let fts = state.fts.lock().unwrap();
            let mut writer = fts.writer().unwrap();
            fts.add_document(
                &writer,
                1,
                "/tmp/finance.txt",
                "finance.txt",
                "annual budget planning report",
                "txt",
            )
            .unwrap();
            writer.commit().unwrap();
        }

        let results = search_fulltext("budget", &state, 10).unwrap();
        assert!(!results.is_empty(), "全文搜索应返回结果");
        assert_eq!(results[0].name, "finance.txt");
    }

    #[test]
    fn test_fulltext_search_no_results() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let results = search_fulltext("不存在的词语xyz123", &state, 10).unwrap();
        assert!(results.is_empty(), "空索引搜索应返回空结果");
    }

    #[test]
    fn test_filename_search() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);

        {
            let db = state.db.lock().unwrap();
            db.execute(
                "INSERT INTO files (path, size, modified, file_type, indexed_at, parse_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params!["/home/user/report_2024.txt", 100i64, 1000i64, "txt", 1000i64, "ok"],
            )
            .unwrap();
        }

        let results = search_filename("report", &state, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].path.contains("report_2024.txt"));
    }

    #[test]
    fn test_filename_search_escapes_underscore() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);

        {
            let db = state.db.lock().unwrap();
            db.execute(
                "INSERT INTO files (path, size, modified, file_type, indexed_at, parse_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params!["/home/abc.txt", 100i64, 1000i64, "txt", 1000i64, "ok"],
            )
            .unwrap();
        }

        let results = search_filename("a_c", &state, 10).unwrap();
        assert!(results.is_empty(), "下划线应该被转义，不应匹配 'abc'");
    }

    #[test]
    fn test_extract_snippet_finds_context() {
        let content = "这是一段很长的文字内容，其中包含了budget这个关键词，希望能够被正确提取出来";
        let snippet = extract_snippet(content, "budget", 50);
        assert!(snippet.contains("budget"), "snippet 应包含关键词");
    }
}

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
                    "SELECT c.content, f.id, f.path, f.file_type
                     FROM chunks c JOIN files f ON c.file_id = f.id
                     WHERE c.id = ?1",
                    rusqlite::params![chunk_id as i64],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?,
                             r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
                );
                if let Ok((content, file_id, path, file_type)) = row {
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
                "SELECT content FROM chunks WHERE file_id = ?1 ORDER BY chunk_index"
            )?;
            let all_chunks: Vec<String> = stmt
                .query_map(rusqlite::params![file_id as i64], |r| r.get(0))
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();

            // 跳过磁盘上已不存在的文件
            if !std::path::Path::new(&path).exists() { continue; }

            let mut added = 0;
            for content in &all_chunks {
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

    // 相关性分数过滤：去除得分远低于最高分的 chunk，防止无关内容污染 LLM 上下文。
    // 策略：保留得分 >= max_score * 0.25 的 chunk（相对阈值），
    //       且至少保留得分最高的那一条（兜底）。
    if chunks.len() > 1 {
        let max_score = chunks[0].score;
        let threshold = (max_score * 0.25).max(0.05);
        let keep = chunks.iter().position(|c| c.score < threshold).unwrap_or(chunks.len());
        let keep = keep.max(1); // 至少保留 1 条
        chunks.truncate(keep);
    }

    chunks.truncate(max_chunks);
    Ok(chunks)
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
pub struct RagChunk {
    pub content: String,
    pub file_id: u64,
    pub path: String,
    pub name: String,
    pub file_type: String,
    pub score: f32,
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
            llm: Mutex::new(None),
            llm_loading: Mutex::new(()),
            model_dir: tmp.path().join("models"),
            vi_stamp_path: tmp.path().join("vi_stamp"),
            llm_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            api_llm_config: Arc::new(RwLock::new(crate::state::ApiLlmConfig::default())),
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

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
}

pub fn search_fulltext(query_str: &str, state: &AppState, limit: usize) -> Result<Vec<SearchResult>> {
    // 在锁范围内只取搜索所需的对象，然后立即释放锁
    let (searcher, query, field_id, field_path, field_name, field_file_type) = {
        let fts = state.fts.lock().map_err(|_| anyhow::anyhow!("fts lock poisoned"))?;
        // 强制重载以感知最新提交（对于写后即搜场景保证可见性）
        fts.reader.reload()?;
        let searcher = fts.reader.searcher();
        let query_parser = QueryParser::for_index(
            &fts.index,
            vec![fts.field_name, fts.field_content],
        );
        let query = query_parser.parse_query(query_str)?;
        // Field 是 Copy 类型（u32 的 newtype），可在锁内拷贝后在锁外使用
        (searcher, query, fts.field_id, fts.field_path, fts.field_name, fts.field_file_type)
        // MutexGuard 在此 scope 结束时 drop，锁释放
    };

    // 锁已释放，在锁外执行实际搜索（Searcher 是线程安全的）
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
            snippet: String::new(), // TODO: 后续版本补充 Tantivy SnippetGenerator 高亮
        });
    }
    Ok(results)
}

/// 文件名模糊搜索（SQLite LIKE，不需要 Tantivy）
pub fn search_filename(query_str: &str, state: &AppState, limit: usize) -> Result<Vec<SearchResult>> {
    let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
    // 对 LIKE 特殊字符转义
    let escaped = query_str
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{}%", escaped);
    let mut stmt = db.prepare(
        "SELECT id, path, file_type FROM files WHERE path LIKE ?1 ESCAPE '\\' LIMIT ?2",
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
            Some(vi) => vi.search(&query_embedding, limit)?,
            None => return Ok(vec![]),
        }
    }; // vi lock released

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
            "SELECT c.content, f.id, f.path, f.file_type
             FROM chunks c JOIN files f ON c.file_id = f.id
             WHERE c.id = ?1",
            rusqlite::params![*chunk_id as i64],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        );
        if let Ok((content, file_id, path, file_type)) = row {
            let name = std::path::Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let snippet = if content.chars().count() > 200 {
                format!("{}...", content.chars().take(200).collect::<String>())
            } else {
                content
            };
            results.push(SearchResult {
                file_id: file_id as u64,
                path,
                name,
                file_type,
                score: *score,
                snippet,
            });
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::indexer::tantivy_index::FtsIndex;
    use std::sync::Mutex;
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
            model_dir: tmp.path().join("models"),
        }
    }

    #[test]
    fn test_fulltext_search_returns_results() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);

        // 先写入一个文档到 Tantivy
        // 注意：Tantivy 默认的 SimpleTokenizer 按空格/标点分词，中文连续字符会被作为
        // 单一 token，因此使用英文关键词 "budget" 进行搜索验证
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

        // 搜索英文关键词
        let results = search_fulltext("budget", &state, 10).unwrap();
        assert!(!results.is_empty(), "全文搜索应返回结果");
        assert_eq!(results[0].name, "finance.txt");
    }

    #[test]
    fn test_fulltext_search_no_results() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // 空索引
        let results = search_fulltext("不存在的词语xyz123", &state, 10).unwrap();
        assert!(results.is_empty(), "空索引搜索应返回空结果");
    }

    #[test]
    fn test_filename_search() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);

        // 写入 SQLite
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

        // 搜索 "a_c" - 如果 _ 未转义，会匹配 "abc.txt"（_ 作为单字符通配符）
        // 如果正确转义了，_ 是字面量，不会匹配
        let results = search_filename("a_c", &state, 10).unwrap();
        assert!(results.is_empty(), "下划线应该被转义，不应匹配 'abc'");
    }
}

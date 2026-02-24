use crate::state::AppState;
use anyhow::Result;
use serde::Serialize;
use tantivy::{collector::TopDocs, query::QueryParser, schema::Value, ReloadPolicy};

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
    let fts = state.fts.lock().unwrap();
    let reader = fts
        .index
        .reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()?;
    let searcher = reader.searcher();

    let query_parser = QueryParser::for_index(
        &fts.index,
        vec![fts.field_name, fts.field_content],
    );
    let query = query_parser.parse_query(query_str)?;

    let top_docs = searcher.search(&query, &TopDocs::with_limit(limit))?;

    let mut results = Vec::new();
    for (score, doc_address) in top_docs {
        let doc = searcher.doc::<tantivy::TantivyDocument>(doc_address)?;
        let file_id = doc
            .get_first(fts.field_id)
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let path = doc
            .get_first(fts.field_path)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = doc
            .get_first(fts.field_name)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let file_type = doc
            .get_first(fts.field_file_type)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        results.push(SearchResult {
            file_id,
            path,
            name,
            file_type,
            score,
            snippet: String::new(), // 后续版本补充高亮
        });
    }
    Ok(results)
}

/// 文件名模糊搜索（SQLite LIKE，不需要 Tantivy）
pub fn search_filename(query_str: &str, state: &AppState, limit: usize) -> Result<Vec<SearchResult>> {
    let db = state.db.lock().unwrap();
    // 对 LIKE 特殊字符转义
    let escaped = query_str
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{}%", escaped);
    let mut stmt = db.prepare(
        "SELECT id, path, file_type FROM files WHERE path LIKE ?1 ESCAPE '\\' LIMIT ?2",
    )?;
    let results = stmt
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
        .flatten()
        .collect();
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

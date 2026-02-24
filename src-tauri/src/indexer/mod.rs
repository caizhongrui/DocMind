pub mod parser;
pub mod tantivy_index;

use crate::state::AppState;
use anyhow::Result;
use parser::{parse_file, ParseStatus};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    "__pycache__",
    "target",
    ".DS_Store",
    "Thumbs.db",
];

const SUPPORTED_EXTS: &[&str] = &["txt", "md", "csv", "pdf", "docx", "xlsx", "pptx"];

pub fn scan_and_index(folder: &Path, state: &AppState, app: &AppHandle) -> Result<()> {
    let files = collect_files(folder);
    let total = files.len();

    // --- Phase 1: Full-text indexing ---
    // Collect (file_id, content) for Phase 2 embedding
    let mut to_embed: Vec<(i64, String)> = Vec::new();
    {
        let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        let fts = state.fts.lock().map_err(|_| anyhow::anyhow!("fts lock poisoned"))?;
        let mut writer = fts.writer()?;

        for (i, path) in files.iter().enumerate() {
            let file_name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let _ = app.emit(
                "index-progress",
                serde_json::json!({
                    "total": total,
                    "done": i + 1,
                    "current": file_name,
                }),
            );

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let meta = std::fs::metadata(path)?;
            let modified = meta
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs() as i64;

            let existing_modified: Option<i64> = db
                .query_row(
                    "SELECT modified FROM files WHERE path = ?1",
                    [path.to_string_lossy().as_ref()],
                    |r| r.get(0),
                )
                .ok();
            if existing_modified == Some(modified) {
                continue;
            }

            let old_file_id: Option<i64> = db
                .query_row(
                    "SELECT id FROM files WHERE path = ?1",
                    [path.to_string_lossy().as_ref()],
                    |r| r.get(0),
                )
                .ok();
            if let Some(old_id) = old_file_id {
                fts.delete_document(&writer, old_id as u64)
                    .map_err(|e| anyhow::anyhow!(e))?;
            }

            let parsed = parse_file(path);
            let parse_status = match parsed.status {
                ParseStatus::Ok => "ok",
                ParseStatus::Partial => "partial",
                ParseStatus::Failed => "failed",
            };

            db.execute(
                "INSERT OR REPLACE INTO files (path, size, modified, file_type, indexed_at, parse_status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    path.to_string_lossy().as_ref(),
                    meta.len() as i64,
                    modified,
                    ext,
                    chrono::Utc::now().timestamp(),
                    parse_status,
                ],
            )?;
            let file_id: i64 = db.query_row(
                "SELECT id FROM files WHERE path = ?1",
                [path.to_string_lossy().as_ref()],
                |r| r.get(0),
            )?;

            fts.add_document(
                &writer,
                file_id as u64,
                &path.to_string_lossy(),
                &file_name,
                &parsed.content,
                &ext,
            )?;

            // Collect for Phase 2 if parse succeeded and content is non-empty
            if parse_status != "failed" && !parsed.content.is_empty() {
                to_embed.push((file_id, parsed.content));
            }
        }

        writer.commit()?;
    } // db and fts locks released here

    // --- Phase 2: Embedding generation (only if embedder available) ---
    // Lock order: db → vector_index → embedder
    {
        let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        let vi_guard = state.vector_index.lock().map_err(|_| anyhow::anyhow!("vi lock poisoned"))?;
        let mut embedder_guard = state.embedder.lock().map_err(|_| anyhow::anyhow!("embedder lock poisoned"))?;

        if let (Some(vi), Some(ref mut embedder)) = (vi_guard.as_ref(), embedder_guard.as_mut()) {
            for (file_id, content) in &to_embed {
                let chunks = crate::embedder::chunk_text(content, 400);
                for (chunk_idx, chunk) in chunks.iter().enumerate() {
                    db.execute(
                        "INSERT OR REPLACE INTO chunks (file_id, chunk_index, content) VALUES (?1, ?2, ?3)",
                        rusqlite::params![file_id, chunk_idx as i64, chunk],
                    )?;
                    let chunk_id: i64 = db.query_row(
                        "SELECT id FROM chunks WHERE file_id = ?1 AND chunk_index = ?2",
                        rusqlite::params![file_id, chunk_idx as i64],
                        |r| r.get(0),
                    )?;
                    match embedder.embed(chunk) {
                        Ok(embedding) => {
                            if let Err(e) = vi.add(chunk_id as u64, &embedding) {
                                eprintln!("[embed] vector add error for chunk {chunk_id}: {e}");
                            } else {
                                let vec_bytes: Vec<u8> = embedding
                                    .iter()
                                    .flat_map(|f| f.to_le_bytes())
                                    .collect();
                                if let Err(e) = db.execute(
                                    "INSERT OR REPLACE INTO embeddings (chunk_id, vector, model_version) VALUES (?1, ?2, ?3)",
                                    rusqlite::params![chunk_id, vec_bytes, "bge-small-zh-v1.5"],
                                ) {
                                    eprintln!("[embed] db insert error: {e}");
                                }
                            }
                        }
                        Err(e) => eprintln!("[embed] embed error for chunk {chunk_id}: {e}"),
                    }
                }
            }
            if let Err(e) = vi.save() {
                eprintln!("[embed] save vector index error: {e}");
            }
        }
    }

    Ok(())
}

pub fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if !EXCLUDE_DIRS.contains(&name.as_ref()) {
                    result.extend(collect_files(&path));
                }
            } else if path.is_file() {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if SUPPORTED_EXTS.contains(&ext.as_str()) {
                    result.push(path);
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn write_file(dir: &std::path::Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    #[test]
    fn test_collect_files_finds_supported() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "a.txt", "hello");
        write_file(tmp.path(), "b.md", "world");
        write_file(tmp.path(), "c.exe", "ignored");

        let files = collect_files(tmp.path());
        assert_eq!(files.len(), 2);
        let names: Vec<_> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.md"));
    }

    #[test]
    fn test_collect_files_excludes_node_modules() {
        let tmp = TempDir::new().unwrap();
        let nm = tmp.path().join("node_modules");
        std::fs::create_dir(&nm).unwrap();
        write_file(&nm, "a.txt", "should be excluded");
        write_file(tmp.path(), "b.txt", "included");

        let files = collect_files(tmp.path());
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].file_name().unwrap().to_str().unwrap(),
            "b.txt"
        );
    }
}

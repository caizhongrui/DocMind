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

const SUPPORTED_EXTS: &[&str] = &[
    // 文档
    "pdf", "doc", "docx", "ppt", "pptx", "rtf",
    // 表格
    "xls", "xlsx", "csv",
    // 文本 / 标记
    "txt", "md", "rst",
    // 归档
    "zip",
    // 图片（OCR）
    "jpg", "jpeg", "png", "bmp", "tiff", "tif", "webp",
];

/// Phase 2 每个文件最多处理的 chunk 数，防止大文件内存/时间失控
const MAX_CHUNKS_PER_FILE: usize = 100;

/// Phase 1：全文索引
/// 返回需要 embedding 的 (file_id, path) 列表（不存 content，避免内存爆炸）
pub fn scan_and_index(folder: &Path, state: &AppState, app: &AppHandle) -> Result<Vec<(i64, PathBuf)>> {
    let files = collect_files(folder);
    let total = files.len();
    let mut to_embed: Vec<(i64, PathBuf)> = Vec::new();

    {
        let db = state.db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        let fts = state.fts.lock().map_err(|_| anyhow::anyhow!("fts lock poisoned"))?;
        let mut writer = fts.writer()?;

        // ── 清理孤儿记录：文件已不在磁盘上，但索引中还有 ──
        // 每次扫描开始时检查该 folder 下的所有已索引文件，将磁盘上已删除的移除。
        // 这是防止"删除文件仍能检索到"问题的根本修复。
        {
            let escaped = folder.to_string_lossy()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let like_pattern = format!("{}%", escaped);
            let mut stmt = db.prepare(
                "SELECT id, path FROM files WHERE path LIKE ?1 ESCAPE '\\'",
            )?;
            let stale: Vec<(i64, String)> = stmt
                .query_map([&like_pattern], |r| Ok((r.get(0)?, r.get(1)?)))?
                .flatten()
                .filter(|(_, p)| !std::path::Path::new(p).exists())
                .collect();
            for (id, p) in &stale {
                let _ = fts.delete_document(&writer, *id as u64);
                let _ = db.execute("DELETE FROM files WHERE id = ?1", rusqlite::params![id]);
                println!("[scan] removed stale entry: {p}");
            }
            if !stale.is_empty() {
                let _ = writer.commit(); // commit 不消耗 writer，可继续复用
            }
        }

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

            // 只记录路径，不缓存 content（避免大量文件内容长时间驻留内存）
            if parse_status != "failed" && !parsed.content.is_empty() {
                to_embed.push((file_id, path.clone()));
            }
        }

        writer.commit()?;
    } // db 和 fts 锁在此释放

    Ok(to_embed)
}

/// Phase 2：embedding 生成（细粒度锁管理）
///
/// 关键原则：ONNX 推理期间不持有任何 Mutex 锁。
/// 每个 chunk 的锁步骤：
///   A. 短暂持有 db 锁 → 写入 chunk，获取 chunk_id → 释放
///   B. 短暂持有 embedder 锁 → ONNX 推理 → 释放
///   C. 短暂持有 vi 锁 → 向量写入 → 释放
///   D. 短暂持有 db 锁 → 写入 embeddings 表 → 释放
pub fn generate_embeddings(to_embed: Vec<(i64, PathBuf)>, state: &AppState, app: &AppHandle) {
    // 快速检查 embedder 是否可用，不可用则直接返回
    {
        let embedder_guard = match state.embedder.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if embedder_guard.is_none() {
            return;
        }
    }

    let total = to_embed.len();
    for (idx, (file_id, path)) in to_embed.iter().enumerate() {
        // 重新从磁盘解析文件（避免在内存中保留大量 content）
        let parsed = parse_file(path);
        if parsed.content.is_empty() {
            continue;
        }

        // 只删除旧的 embedding 向量（内容变化后需重新生成），但保留 chunk 行本身。
        // 这样 BM25 RAG 路径在 embedding 生成期间也能正常读取 chunk 内容。
        {
            let db = match state.db.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            let _ = db.execute(
                "DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?1)",
                rusqlite::params![file_id],
            );
        }

        let chunks = crate::embedder::chunk_text(&parsed.content, 800);
        let chunk_count = chunks.len().min(MAX_CHUNKS_PER_FILE);

        for (chunk_idx, chunk) in chunks.iter().take(chunk_count).enumerate() {
            // --- Step A: 原地更新或新增 chunk（保持 chunk_id 稳定）---
            // UPDATE 保留 id，避免向量索引 chunk_id 失效；无匹配行时才 INSERT。
            let chunk_id: i64 = {
                let db = match state.db.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let updated = db.execute(
                    "UPDATE chunks SET content = ?3 WHERE file_id = ?1 AND chunk_index = ?2",
                    rusqlite::params![file_id, chunk_idx as i64, chunk],
                ).unwrap_or(0);
                if updated == 0 {
                    if let Err(e) = db.execute(
                        "INSERT INTO chunks (file_id, chunk_index, content) VALUES (?1, ?2, ?3)",
                        rusqlite::params![file_id, chunk_idx as i64, chunk],
                    ) {
                        eprintln!("[embed] chunk insert error: {e}");
                        continue;
                    }
                }
                match db.query_row(
                    "SELECT id FROM chunks WHERE file_id = ?1 AND chunk_index = ?2",
                    rusqlite::params![file_id, chunk_idx as i64],
                    |r| r.get(0),
                ) {
                    Ok(id) => id,
                    Err(e) => {
                        eprintln!("[embed] chunk query error: {e}");
                        continue;
                    }
                }
            }; // db 锁释放 —— ONNX 推理不持有任何锁

            // --- Step B: ONNX 推理（持有 embedder 锁，推理完成后立即释放）---
            let embedding = {
                let mut embedder_guard = match state.embedder.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                match embedder_guard.as_mut() {
                    Some(embedder) => match embedder.embed(chunk) {
                        Ok(emb) => emb,
                        Err(e) => {
                            eprintln!("[embed] embed error for chunk {chunk_id}: {e}");
                            continue;
                        }
                    },
                    None => continue, // 模型已卸载
                }
            }; // embedder 锁释放

            // --- Step C: 写入向量索引（短暂持有 vi 锁）---
            {
                let vi_guard = match state.vector_index.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                if let Some(vi) = vi_guard.as_ref() {
                    if let Err(e) = vi.add(chunk_id as u64, &embedding) {
                        eprintln!("[embed] vector add error for chunk {chunk_id}: {e}");
                    }
                }
            } // vi 锁释放

            // --- Step D: 写入 embeddings 表（短暂持有 db 锁）---
            {
                let db = match state.db.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let vec_bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
                if let Err(e) = db.execute(
                    "INSERT OR REPLACE INTO embeddings (chunk_id, vector, model_version) VALUES (?1, ?2, ?3)",
                    rusqlite::params![chunk_id, vec_bytes, "bge-small-zh-v1.5"],
                ) {
                    eprintln!("[embed] embeddings insert error: {e}");
                }
            } // db 锁释放
        }

        // 删除多余的旧 chunk（文件重索引后 chunk 数量可能减少）
        {
            let db = match state.db.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            let _ = db.execute(
                "DELETE FROM embeddings WHERE chunk_id IN \
                 (SELECT id FROM chunks WHERE file_id = ?1 AND chunk_index >= ?2)",
                rusqlite::params![file_id, chunk_count as i64],
            );
            let _ = db.execute(
                "DELETE FROM chunks WHERE file_id = ?1 AND chunk_index >= ?2",
                rusqlite::params![file_id, chunk_count as i64],
            );
        }

        // 每处理完一个文件发送进度事件
        let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let _ = app.emit(
            "embed-progress",
            serde_json::json!({ "done": idx + 1, "total": total, "current": filename }),
        );

        // 主动让出 CPU，避免后台 embedding 持续抢占系统资源
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // 所有 chunk 处理完毕后，持久化向量索引，并更新一致性 stamp
    if let Ok(vi_guard) = state.vector_index.lock() {
        if let Some(vi) = vi_guard.as_ref() {
            if let Err(e) = vi.save() {
                eprintln!("[embed] save vector index error: {e}");
            } else {
                // 保存成功后写入 stamp（DB max chunk_id），供下次启动时一致性校验
                if let Ok(db) = state.db.lock() {
                    let max_id: i64 = db
                        .query_row(
                            "SELECT COALESCE(MAX(chunk_id), 0) FROM embeddings",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    let _ = std::fs::write(&state.vi_stamp_path, max_id.to_string());
                    println!("[embed] vector index saved, stamp updated (max_chunk_id={max_id})");
                }
            }
        }
    }
}

/// 对单个文件进行增量重索引（文件系统监听到变化时调用）。
/// 若文件的 modified 时间戳未变则跳过，避免重复处理。
pub fn index_single_file(path: &Path, state: &AppState, app: &AppHandle) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !SUPPORTED_EXTS.contains(&ext.as_str()) {
        return;
    }

    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return, // 文件已删除或无读取权限
    };
    let modified = match meta.modified() {
        Ok(t) => t
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        Err(_) => return,
    };

    let parsed = parse_file(path);
    let parse_status = match parsed.status {
        ParseStatus::Ok => "ok",
        ParseStatus::Partial => "partial",
        ParseStatus::Failed => "failed",
    };
    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // 在持有 db + fts 锁的块内完成：检查变化 → 删旧 → 写新
    let file_id_to_embed: Option<(i64, PathBuf)> = {
        let db = match state.db.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let fts = match state.fts.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        // modified 时间戳相同 → 文件内容未变，跳过
        let existing_modified: Option<i64> = db
            .query_row(
                "SELECT modified FROM files WHERE path = ?1",
                [path.to_string_lossy().as_ref()],
                |r| r.get(0),
            )
            .ok();
        if existing_modified == Some(modified) {
            return;
        }

        // 用一个 writer 完成：删除旧文档 + 添加新文档（一次 commit）
        let mut writer = match fts.writer() {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[watcher] Failed to get FTS writer: {e}");
                return;
            }
        };

        // 删除旧 FTS 条目（若存在）
        if let Ok(old_id) = db.query_row(
            "SELECT id FROM files WHERE path = ?1",
            [path.to_string_lossy().as_ref()],
            |r| r.get::<_, i64>(0),
        ) {
            let _ = fts.delete_document(&writer, old_id as u64);
        }

        // 更新 SQLite files 表
        if let Err(e) = db.execute(
            "INSERT OR REPLACE INTO files (path, size, modified, file_type, indexed_at, parse_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                path.to_string_lossy().as_ref(),
                meta.len() as i64,
                modified,
                &ext,
                chrono::Utc::now().timestamp(),
                parse_status,
            ],
        ) {
            eprintln!("[watcher] Failed to upsert file record: {e}");
            let _ = writer.commit();
            return;
        }

        let file_id: i64 = match db.query_row(
            "SELECT id FROM files WHERE path = ?1",
            [path.to_string_lossy().as_ref()],
            |r| r.get(0),
        ) {
            Ok(id) => id,
            Err(_) => {
                let _ = writer.commit();
                return;
            }
        };

        // 添加新 FTS 文档
        let _ = fts.add_document(
            &writer,
            file_id as u64,
            &path.to_string_lossy(),
            &file_name,
            &parsed.content,
            &ext,
        );
        let _ = writer.commit();

        if parse_status != "failed" && !parsed.content.is_empty() {
            Some((file_id, path.to_path_buf()))
        } else {
            None
        }
    }; // db 和 fts 锁在此释放

    // 预先向 chunks 表写入文本内容（无 embedding），确保 BM25 RAG 路径在 embedding 生成前也能找到内容。
    // 若 embedder 未加载，generate_embeddings 会直接 return，chunks 表将永久保留此预填数据供 RAG 使用。
    // 若 embedder 已加载，generate_embeddings 会删除并重建 chunks（附带 embedding），预填数据被正常替换。
    if let Some((ref id, _)) = file_id_to_embed {
        if let Ok(db) = state.db.lock() {
            let chunk_texts = crate::embedder::chunk_text(&parsed.content, 800);
            let _ = db.execute(
                "DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?1)",
                rusqlite::params![id],
            );
            let _ = db.execute("DELETE FROM chunks WHERE file_id = ?1", rusqlite::params![id]);
            for (i, chunk) in chunk_texts.iter().enumerate().take(MAX_CHUNKS_PER_FILE) {
                let _ = db.execute(
                    "INSERT INTO chunks (file_id, chunk_index, content) VALUES (?1, ?2, ?3)",
                    rusqlite::params![id, i as i64, chunk],
                );
            }
        }
    }

    // 在锁释放后生成 embedding（避免锁持有期间进行 ONNX 推理）
    if let Some((id, p)) = file_id_to_embed {
        generate_embeddings(vec![(id, p)], state, app);
    }

    let _ = app.emit("file-reindexed", path.to_string_lossy().to_string());
    println!("[watcher] Re-indexed: {}", path.display());
}

/// 从索引中移除文件（文件被删除时调用）。
///
/// 完整清理三层索引：
///   1. Tantivy 全文索引（FTS）
///   2. USearch 向量索引（语义搜索）
///   3. SQLite：files 表（CASCADE → chunks → embeddings）
pub fn remove_file_from_index(path: &Path, state: &AppState) {
    // ── Step 1: 取 file_id 及其所有 chunk_id（删除前先查，之后 CASCADE 会清掉它们）──
    let (file_id, chunk_ids) = {
        let db = match state.db.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let fid: Option<i64> = db
            .query_row(
                "SELECT id FROM files WHERE path = ?1",
                [path.to_string_lossy().as_ref()],
                |r| r.get(0),
            )
            .ok();
        let fid = match fid {
            Some(id) => id,
            None => return, // 索引里本来就没有这个文件
        };
        let mut stmt = match db.prepare(
            "SELECT id FROM chunks WHERE file_id = ?1",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let cids: Vec<i64> = stmt
            .query_map(rusqlite::params![fid], |r| r.get(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default();
        (fid, cids)
    };

    // ── Step 2: 删除 Tantivy FTS 条目 ──
    {
        let fts = match state.fts.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Ok(mut writer) = fts.writer() {
            let _ = fts.delete_document(&writer, file_id as u64);
            let _ = writer.commit();
        }
    }

    // ── Step 3: 从 USearch 向量索引删除该文件的所有 chunk 向量 ──
    {
        let vi_guard = match state.vector_index.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(vi) = vi_guard.as_ref() {
            for cid in &chunk_ids {
                let _ = vi.remove(*cid as u64);
            }
            // 持久化：让磁盘上的索引也同步删除
            if !chunk_ids.is_empty() {
                if let Err(e) = vi.save() {
                    eprintln!("[watcher] Failed to save vector index after removal: {e}");
                }
            }
        }
    }

    // ── Step 4: 删除 SQLite files 记录（CASCADE → chunks → embeddings）──
    {
        let db = match state.db.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let _ = db.execute("DELETE FROM files WHERE id = ?1", rusqlite::params![file_id]);
    }

    // ── Step 5: 更新向量索引 stamp（保证下次启动一致性校验正确）──
    {
        if let (Ok(vi_guard), Ok(db)) = (state.vector_index.lock(), state.db.lock()) {
            if vi_guard.is_some() {
                let max_id: i64 = db
                    .query_row(
                        "SELECT COALESCE(MAX(chunk_id), 0) FROM embeddings",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                let _ = std::fs::write(&state.vi_stamp_path, max_id.to_string());
            }
        }
    }

    println!("[watcher] Removed from index: {} ({} vectors cleaned)", path.display(), chunk_ids.len());
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

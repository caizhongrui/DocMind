mod commands;
mod db;
mod embedder;
mod indexer;
mod license;
mod llm;
mod search;
mod state;
mod vector_index;
mod watcher;

use state::AppState;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 从 DB 的 embeddings 表重建向量索引（修复重启后 chunk ID 不一致问题）
fn rebuild_vector_index_from_db(
    vi: &mut vector_index::VectorIndex,
    conn: &rusqlite::Connection,
) -> anyhow::Result<()> {
    vi.reset()?;
    let mut stmt = conn.prepare("SELECT chunk_id, vector FROM embeddings")?;
    let rows: Vec<(i64, Vec<u8>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .flatten()
        .collect();
    for (chunk_id, vec_bytes) in rows {
        if vec_bytes.len() % 4 != 0 {
            continue;
        }
        let embedding: Vec<f32> = vec_bytes
            .chunks(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        if let Err(e) = vi.add(chunk_id as u64, &embedding) {
            eprintln!("[rebuild_vi] add error for chunk {chunk_id}: {e}");
        }
    }
    vi.save()?;
    Ok(())
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn ping() -> String {
    "pong from DocMind backend".to_string()
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    };
    let show = MenuItem::with_id(app, "show", "显示 DocMind", true, None::<&str>)?;
    let search = MenuItem::with_id(app, "search", "快速搜索 (Ctrl+K)", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &search, &sep, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            "search" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.emit("tray-focus-search", ());
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state == ShortcutState::Pressed {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::init(&data_dir.join("docmind.db"))
                .expect("Failed to init database");
            let index_dir = data_dir.join("index").join("tantivy");
            let fts = indexer::tantivy_index::FtsIndex::open_or_create(&index_dir)
                .expect("Failed to init FTS index");

            // Initialize AI components (optional - gracefully degrade if model not available)
            let model_dir = data_dir.join("models").join("bge-small-zh-v1.5");
            let embedder = if embedder::Embedder::is_available(&model_dir) {
                match embedder::Embedder::load(&model_dir) {
                    Ok(e) => {
                        println!("[embedder] loaded bge-small-zh-v1.5 from {}", model_dir.display());
                        Some(e)
                    }
                    Err(e) => {
                        eprintln!("[embedder] failed to load: {e}");
                        None
                    }
                }
            } else {
                println!("[embedder] model not found at {}, semantic search disabled", model_dir.display());
                None
            };

            // stamp 文件路径提前定义，供 AppState 使用（无论 embedder 是否可用）
            let vi_stamp_path = data_dir.join("index").join("vi_stamp");
            let vector_index = if embedder.is_some() {
                let vi_path = data_dir.join("index").join("vectors.usearch");
                std::fs::create_dir_all(data_dir.join("index"))?;
                match vector_index::VectorIndex::open_or_create(&vi_path, 512) {
                    Ok(mut vi) => {
                        let vi_len = vi.len();
                        // 读取 DB 中当前 embeddings 的最大 chunk_id 和总数
                        let (emb_count, db_max_id): (i64, i64) = conn
                            .query_row(
                                "SELECT COUNT(*), COALESCE(MAX(chunk_id), 0) FROM embeddings",
                                [],
                                |r| Ok((r.get(0)?, r.get(1)?)),
                            )
                            .unwrap_or((0, 0));
                        // 读取上次保存时记录的 max chunk_id
                        let saved_max_id: i64 = std::fs::read_to_string(&vi_stamp_path)
                            .ok()
                            .and_then(|s| s.trim().parse().ok())
                            .unwrap_or(-1);
                        println!("[vector_index] opened (vi_size={vi_len}, db_embeddings={emb_count}, db_max_chunk={db_max_id}, vi_stamp={saved_max_id})");
                        // 不一致条件：
                        //   1. 数量差 > 5%（明显不一致）
                        //   2. max chunk_id 与 stamp 记录不符（DB 有新增/重建）
                        //   3. stamp 不存在（新特性首次运行，为安全起见强制重建）
                        let count_mismatch = emb_count > 0
                            && (vi_len as i64 - emb_count).unsigned_abs() > (emb_count as u64 / 20);
                        let id_mismatch = saved_max_id < 0 // 无 stamp → 首次使用此特性，重建一次
                            || saved_max_id != db_max_id;
                        if emb_count > 0 && (count_mismatch || id_mismatch) {
                            eprintln!("[vector_index] mismatch detected (vi={vi_len}, db={emb_count}, saved_max={saved_max_id}, db_max={db_max_id}), rebuilding...");
                            match rebuild_vector_index_from_db(&mut vi, &conn) {
                                Ok(()) => {
                                    println!("[vector_index] rebuilt successfully ({} vectors)", vi.len());
                                    // 更新 stamp
                                    let _ = std::fs::write(&vi_stamp_path, db_max_id.to_string());
                                }
                                Err(e) => eprintln!("[vector_index] rebuild failed: {e}"),
                            }
                        }
                        Some(vi)
                    }
                    Err(e) => {
                        eprintln!("[vector_index] failed to open: {e}");
                        None
                    }
                }
            } else {
                None
            };

            let api_llm_config: crate::state::ApiLlmConfig = conn
                .query_row::<String, _, _>(
                    "SELECT value FROM settings WHERE key = 'api_llm_config'",
                    [],
                    |r| r.get(0),
                )
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            // ── License bootstrap (Gate 1: read on-disk artifacts and decide
            //     plan; ensures last_llm_path matches what the current plan
            //     allows, so a Trial-expired user can't keep using a Pro
            //     model that was loaded last session). ──
            let license_state = license::state::bootstrap(&data_dir);
            println!(
                "[license] bootstrap: plan={:?} reason={} fp={}",
                license_state.plan, license_state.reason, license_state.fingerprint
            );
            // Reset last_llm_path if the saved model is no longer allowed
            // under the current plan. The setup body holds the only handle
            // to `conn`, so do this before we move it into AppState.
            let last_path: Option<String> = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = 'last_llm_path'",
                    [],
                    |r| r.get(0),
                )
                .ok();
            if let Some(p) = last_path.as_deref() {
                let tier = license::gates::classify_model_path(std::path::Path::new(p));
                if !license::gates::is_model_allowed(tier, &license_state) {
                    eprintln!(
                        "[license] downgrading: saved model {p} not allowed under plan {:?}",
                        license_state.plan
                    );
                    let _ = conn.execute(
                        "DELETE FROM settings WHERE key = 'last_llm_path'",
                        [],
                    );
                }
            }
            // Make sure the quota table exists.
            let _ = license::quota::ensure_table(&conn);

            let shared_license = license::state::shared(license_state);

            app.manage(AppState {
                db: Mutex::new(conn),
                fts: Mutex::new(fts),
                vector_index: Mutex::new(vector_index),
                embedder: Mutex::new(embedder),
                llm: Mutex::new(None),
                llm_loading: Mutex::new(()),
                model_dir,
                vi_stamp_path,
                llm_cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                api_llm_config: std::sync::Arc::new(std::sync::RwLock::new(api_llm_config)),
                license: shared_license,
                app_data_dir: data_dir.clone(),
            });
            let app_handle = app.handle().clone();
            let watcher_state = watcher::start_watcher(app_handle);
            app.manage(watcher_state);

            // ── 定时重索引任务 ──
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(60));
                        let state = app_handle.state::<AppState>();
                        let interval_min: u64 = state.db.lock().ok()
                            .and_then(|db| {
                                db.query_row::<String, _, _>(
                                    "SELECT value FROM settings WHERE key = 'reindex_interval_min'",
                                    [], |r| r.get(0),
                                ).ok()
                            })
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0);
                        if interval_min == 0 {
                            continue;
                        }

                        let last_indexed: i64 = state.db.lock().ok()
                            .and_then(|db| {
                                db.query_row::<i64, _, _>(
                                    "SELECT COALESCE(MAX(indexed_at), 0) FROM files",
                                    [], |r| r.get(0),
                                ).ok()
                            })
                            .unwrap_or(0);

                        let now = chrono::Utc::now().timestamp();
                        let elapsed_min = (now - last_indexed) / 60;
                        if elapsed_min < interval_min as i64 {
                            continue;
                        }

                        // 触发所有 enabled 文件夹重新索引
                        let folders: Vec<String> = state.db.lock().ok()
                            .map(|db| {
                                let mut stmt = match db.prepare("SELECT path FROM watched_folders WHERE enabled = 1") {
                                    Ok(s) => s,
                                    Err(_) => return vec![],
                                };
                                stmt.query_map([], |r| r.get(0))
                                    .map(|rows| rows.flatten().collect::<Vec<String>>())
                                    .unwrap_or_default()
                            })
                            .unwrap_or_default();

                        println!("[reindex] Scheduled reindex triggered for {} folders", folders.len());
                        for folder in folders {
                            let app2 = app_handle.clone();
                            let folder_clone = folder.clone();
                            std::thread::spawn(move || {
                                let st = app2.state::<AppState>();
                                let _ = crate::indexer::scan_and_index(
                                    std::path::Path::new(&folder_clone), &st, &app2
                                );
                            });
                        }
                    }
                });
            }

            if let Err(e) = build_tray(app) {
                eprintln!("[tray] Failed to build tray: {e}");
            }

            // 恢复用户保存的全局快捷键
            // 先从 DB 读取（state 借用在此内部块结束时释放），再用 app 注册
            let saved_shortcut: Option<String> = {
                let state = app.state::<AppState>();
                state.db.lock().ok().and_then(|db| {
                    db.query_row::<String, _, _>(
                        "SELECT value FROM settings WHERE key = 'global_shortcut'",
                        [],
                        |r| r.get(0),
                    )
                    .ok()
                })
            };
            if let Some(sc) = saved_shortcut {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(e) = app.global_shortcut().register(sc.as_str()) {
                    eprintln!("[shortcut] Failed to restore '{sc}': {e}");
                } else {
                    println!("[shortcut] Restored global shortcut: {sc}");
                }
            }

            // 自动恢复上次加载的 LLM 模型（后台线程，不阻塞 UI）
            let last_llm_path: Option<String> = {
                let state = app.state::<AppState>();
                state.db.lock().ok().and_then(|db| {
                    db.query_row::<String, _, _>(
                        "SELECT value FROM settings WHERE key = 'last_llm_path'",
                        [],
                        |r| r.get(0),
                    )
                    .ok()
                })
            };
            if let Some(model_path) = last_llm_path {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let state = app_handle.state::<AppState>();
                    let p = std::path::Path::new(&model_path);
                    if p.exists() {
                        // 持有加载互斥锁，防止与手动切换并发导致 BackendAlreadyInitialized
                        let _loading_guard = match state.llm_loading.lock() {
                            Ok(g) => g,
                            Err(_) => return,
                        };
                        match llm::Llm::load(p) {
                            Ok(loaded) => {
                                if let Ok(mut guard) = state.llm.lock() {
                                    *guard = Some(loaded);
                                    println!("[llm] Auto-loaded last model: {model_path}");
                                    // 通知前端：后端已完成自动加载，可直接更新 UI 状态
                                    let _ = app_handle.emit("llm-auto-loaded", &model_path);
                                }
                            }
                            Err(e) => {
                                eprintln!("[llm] Failed to auto-load last model '{model_path}': {e}");
                                let _ = app_handle.emit("llm-auto-load-failed", &model_path);
                            }
                        }
                    } else {
                        eprintln!("[llm] Last model path no longer exists, skipping auto-load: {model_path}");
                        let _ = app_handle.emit("llm-auto-load-failed", &model_path);
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 应用关闭前显式释放 LLM，避免 ggml Metal 后端在进程退出时
            // 因 GCD dispatch block 尚未完成而触发 ggml_abort (SIGABRT)
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.app_handle().state::<AppState>();
                if let Ok(mut guard) = state.llm.lock() {
                    let _ = guard.take();
                }
                // 给 Metal GCD block 足够时间完成资源初始化，再允许进程退出
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            ping,
            commands::index::start_index,
            commands::index::get_watched_folders,
            commands::index::remove_folder,
            commands::index::rebuild_vector_index,
            commands::search::search_files,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::open_file,
            commands::settings::reveal_in_finder,
            commands::settings::read_file_preview,
            commands::updater::check_update,
            commands::model::get_model_status,
            commands::model::download_model,
            commands::settings::read_binary_preview,
            commands::llm::list_available_gguf_models,
            commands::llm::download_gguf_model,
            commands::llm::list_llm_models,
            commands::llm::load_llm_model,
            commands::llm::ask_question,
            commands::llm::ask_question_stream,
            commands::llm::import_custom_gguf,
            commands::llm::get_loaded_llm_path,
            commands::index::get_index_stats,
            commands::index::clear_all_index,
            commands::settings::get_global_shortcut,
            commands::settings::set_global_shortcut,
            commands::settings::write_text_file,
            commands::settings::convert_legacy_doc_to_html,
            commands::llm::stop_generation,
            commands::llm::get_api_llm_config,
            commands::llm::set_api_llm_config,
            commands::llm::ask_question_stream_api,
            commands::history::get_search_history,
            commands::history::add_search_history,
            commands::history::delete_search_history_item,
            commands::history::clear_search_history,
            commands::conversation::create_conversation,
            commands::conversation::list_conversations,
            commands::conversation::get_conversation_messages,
            commands::conversation::save_message,
            commands::conversation::delete_conversation,
            commands::conversation::rename_conversation,
            commands::settings::check_shortcut_conflict,
            commands::settings::get_reindex_interval,
            commands::settings::set_reindex_interval,
            commands::settings::get_indexed_types,
            commands::settings::set_indexed_types,
            commands::llm::summarize_documents,
            commands::license::get_license_status,
            commands::license::install_license_token,
            commands::license::clear_license,
            commands::license::get_hardware_fingerprint,
            commands::license::get_quota,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod commands;
mod db;
mod embedder;
mod indexer;
mod search;
mod state;
mod vector_index;
mod watcher;

use state::AppState;
use std::sync::Mutex;
use tauri::Manager;

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
        menu::{Menu, MenuItem},
        tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    };
    let show = MenuItem::with_id(app, "show", "显示 DocMind", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
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

            let vector_index = if embedder.is_some() {
                let vi_path = data_dir.join("index").join("vectors.usearch");
                std::fs::create_dir_all(data_dir.join("index"))?;
                match vector_index::VectorIndex::open_or_create(&vi_path, 512) {
                    Ok(vi) => {
                        println!("[vector_index] opened (size: {})", vi.len());
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

            app.manage(AppState {
                db: Mutex::new(conn),
                fts: Mutex::new(fts),
                vector_index: Mutex::new(vector_index),
                embedder: Mutex::new(embedder),
                model_dir,
            });
            let app_handle = app.handle().clone();
            watcher::start_watcher(app_handle);
            if let Err(e) = build_tray(app) {
                eprintln!("[tray] Failed to build tray: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            ping,
            commands::index::start_index,
            commands::index::get_watched_folders,
            commands::index::remove_folder,
            commands::search::search_files,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::open_file,
            commands::settings::reveal_in_finder,
            commands::settings::read_file_preview,
            commands::updater::check_update,
            commands::model::get_model_status,
            commands::model::download_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod commands;
mod db;
mod indexer;
mod search;
mod state;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::init(&data_dir.join("docmind.db"))
                .expect("Failed to init database");
            let index_dir = data_dir.join("index").join("tantivy");
            let fts = indexer::tantivy_index::FtsIndex::open_or_create(&index_dir)
                .expect("Failed to init FTS index");
            app.manage(AppState {
                db: Mutex::new(conn),
                fts: Mutex::new(fts),
            });
            let app_handle = app.handle().clone();
            watcher::start_watcher(app_handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            ping,
            commands::index::start_index,
            commands::index::get_watched_folders,
            commands::index::remove_folder,
            commands::search::search_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

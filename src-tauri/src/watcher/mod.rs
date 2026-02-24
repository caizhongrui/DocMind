use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub fn start_watcher(app: AppHandle) {
    // 读取已监听的文件夹列表
    let folders: Vec<String> = {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|_| ()).unwrap();
        let mut stmt = db
            .prepare("SELECT path FROM watched_folders WHERE enabled = 1")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect()
    };

    if folders.is_empty() {
        return;
    }

    std::thread::spawn(move || {
        let app_clone = app.clone();
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

        let mut watcher = match RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            notify::Config::default().with_poll_interval(Duration::from_secs(2)),
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[watcher] Failed to create watcher: {e}");
                return;
            }
        };

        for folder in &folders {
            if let Err(e) = watcher.watch(std::path::Path::new(folder), RecursiveMode::Recursive) {
                eprintln!("[watcher] Failed to watch '{folder}': {e}");
            }
        }

        for res in rx {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        for path in &event.paths {
                            let _ = app_clone
                                .emit("file-changed", path.to_string_lossy().to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
    });
}

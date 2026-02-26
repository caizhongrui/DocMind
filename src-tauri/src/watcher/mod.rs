use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Watcher 句柄类型：由调用方通过 app.manage() 保持存活，从而让监听器持续工作。
pub type WatcherState = Arc<Mutex<Option<RecommendedWatcher>>>;

/// 启动文件系统监听。
///
/// 启动时读取 DB 中已有的监听文件夹，对每个文件夹注册递归监听。
/// 文件变化时直接在后台线程调用 indexer 完成增量更新，不再向前端发送无意义事件。
///
/// 返回 WatcherState；调用方必须通过 `app.manage(watcher_state)` 保持其存活。
pub fn start_watcher(app: AppHandle) -> WatcherState {
    let folders: Vec<String> = {
        let state = app.state::<AppState>();
        let db = match state.db.lock() {
            Ok(g) => g,
            Err(_) => return Arc::new(Mutex::new(None)),
        };
        let mut stmt = match db.prepare("SELECT path FROM watched_folders WHERE enabled = 1") {
            Ok(s) => s,
            Err(_) => return Arc::new(Mutex::new(None)),
        };
        stmt.query_map([], |r| r.get(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    };

    let watcher_state: WatcherState = Arc::new(Mutex::new(None));
    let watcher_state_clone = watcher_state.clone();

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let tx_cb = tx.clone();

    let mut watcher = match RecommendedWatcher::new(
        move |res| {
            let _ = tx_cb.send(res);
        },
        notify::Config::default().with_poll_interval(Duration::from_secs(3)),
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[watcher] Failed to create watcher: {e}");
            return watcher_state;
        }
    };

    for folder in &folders {
        if let Err(e) = watcher.watch(std::path::Path::new(folder), RecursiveMode::Recursive) {
            eprintln!("[watcher] Failed to watch '{folder}': {e}");
        }
    }

    // 存入 Arc，由 Tauri manage 保持存活（watcher 必须活着才能持续监听）
    *watcher_state_clone.lock().unwrap() = Some(watcher);

    // 事件处理线程
    std::thread::spawn(move || {
        for res in rx {
            if let Ok(event) = res {
                let is_remove = matches!(event.kind, EventKind::Remove(_));
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        for path in event.paths {
                            let app_h = app.clone();
                            std::thread::spawn(move || {
                                // 等待 500ms，避免文件还在写入时就开始解析
                                std::thread::sleep(std::time::Duration::from_millis(500));
                                let state = app_h.state::<AppState>();
                                if is_remove {
                                    crate::indexer::remove_file_from_index(&path, &state);
                                } else {
                                    crate::indexer::index_single_file(&path, &state, &app_h);
                                }
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    });

    watcher_state
}

/// 向已运行的监听器动态添加新的监听路径（在设置中添加新文件夹时调用）。
pub fn add_watch_path(watcher_state: &WatcherState, folder: &str) {
    if let Ok(mut guard) = watcher_state.lock() {
        if let Some(watcher) = guard.as_mut() {
            match watcher.watch(std::path::Path::new(folder), RecursiveMode::Recursive) {
                Ok(()) => println!("[watcher] Now watching: {folder}"),
                Err(e) => eprintln!("[watcher] Failed to add watch path '{folder}': {e}"),
            }
        } else {
            eprintln!("[watcher] Watcher not initialized, cannot add path '{folder}'");
        }
    }
}

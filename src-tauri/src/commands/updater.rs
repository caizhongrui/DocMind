use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<bool, String> {
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(update) => Ok(update.is_some()),
            Err(e) => Err(e.to_string()),
        },
        Err(e) => Err(e.to_string()),
    }
}

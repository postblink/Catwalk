use crate::error::AppResult;
use crate::scanner::{self, ScanProgress, ScanResult};
use crate::AppState;
use serde::Serialize;
use tauri::{Emitter, State};

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModelRow {
    pub id: String,
    pub library_id: String,
    pub relative_path: String,
    pub filename: String,
    pub extension: String,
    pub size_bytes: i64,
    pub byte_hash: Option<String>,
    pub thumbnail_path: Option<String>,
    pub modified_at: String,
    pub indexed_at: String,
}

/// List models in a library, newest-indexed first.
#[tauri::command]
pub async fn list_models(
    state: State<'_, AppState>,
    library_id: String,
) -> AppResult<Vec<ModelRow>> {
    let db = state.db.lock().await;
    let rows = sqlx::query_as::<_, ModelRow>(
        "SELECT id, library_id, relative_path, filename, extension, size_bytes, \
         byte_hash, thumbnail_path, modified_at, indexed_at \
         FROM models WHERE library_id = ? ORDER BY filename COLLATE NOCASE ASC",
    )
    .bind(&library_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows)
}

/// Trigger a scan of a library. Progress is streamed to the frontend via the
/// `scan:progress` event; the final `ScanResult` is returned directly.
#[tauri::command]
pub async fn scan_library(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    library_id: String,
) -> AppResult<ScanResult> {
    // Clone the pool so we don't hold the state lock across the whole scan.
    let pool = {
        let db = state.db.lock().await;
        db.pool.clone()
    };

    let app_for_progress = app.clone();
    let result = scanner::scan_library(&pool, &library_id, move |p: ScanProgress| {
        let _ = app_for_progress.emit("scan:progress", &p);
    })
    .await?;

    let _ = app.emit("scan:complete", &result);
    Ok(result)
}

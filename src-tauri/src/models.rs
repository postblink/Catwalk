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

/// Maximum file size we'll stream to the frontend viewer (256 MiB).
const MAX_VIEWER_BYTES: u64 = 256 * 1024 * 1024;

/// Read a model file's raw bytes for the frontend 3D loader.
///
/// Resolves `model_id` → `(library root, relative_path)`, joins them, and
/// canonicalizes the result to ensure it stays within the library root before
/// reading. This blocks path-traversal via a poisoned `relative_path`.
#[tauri::command]
pub async fn read_model_file(
    state: State<'_, AppState>,
    model_id: String,
) -> AppResult<Vec<u8>> {
    let (root, relative_path): (String, String) = {
        let db = state.db.lock().await;
        sqlx::query_as(
            "SELECT l.root_path, m.relative_path FROM models m \
             JOIN libraries l ON l.id = m.library_id WHERE m.id = ?",
        )
        .bind(&model_id)
        .fetch_optional(&db.pool)
        .await?
        .ok_or(crate::error::AppError::NotFound)?
    };

    let root_canon = std::path::Path::new(&root)
        .canonicalize()
        .map_err(|_| crate::error::AppError::NotFound)?;
    let target = root_canon.join(&relative_path);
    let target_canon = target
        .canonicalize()
        .map_err(|_| crate::error::AppError::NotFound)?;

    if !target_canon.starts_with(&root_canon) {
        return Err(crate::error::AppError::InvalidInput(
            "Resolved path escapes the library root".into(),
        ));
    }

    let meta = std::fs::metadata(&target_canon)?;
    if meta.len() > MAX_VIEWER_BYTES {
        return Err(crate::error::AppError::InvalidInput(format!(
            "File too large to preview ({} MiB)",
            meta.len() / (1024 * 1024)
        )));
    }

    Ok(std::fs::read(&target_canon)?)
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

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

/// Parsed slicer/format metadata for a single model.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModelMetadata {
    pub model_id: String,
    pub format: String,
    pub plate_count: Option<i64>,
    pub print_time_seconds: Option<i64>,
    pub filament_grams: Option<f64>,
    pub filament_types: Option<String>, // JSON array string
    pub nozzle_diameter: Option<f64>,
    pub layer_height: Option<f64>,
    pub bbox_min_x: Option<f64>,
    pub bbox_min_y: Option<f64>,
    pub bbox_min_z: Option<f64>,
    pub bbox_max_x: Option<f64>,
    pub bbox_max_y: Option<f64>,
    pub bbox_max_z: Option<f64>,
    pub triangle_count: Option<i64>,
}

/// Fetch parsed metadata for a model, if any was extracted during scanning.
#[tauri::command]
pub async fn get_model_metadata(
    state: State<'_, AppState>,
    model_id: String,
) -> AppResult<Option<ModelMetadata>> {
    let db = state.db.lock().await;
    let row = sqlx::query_as::<_, ModelMetadata>(
        "SELECT model_id, format, plate_count, print_time_seconds, filament_grams, \
         filament_types, nozzle_diameter, layer_height, bbox_min_x, bbox_min_y, \
         bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z, triangle_count \
         FROM model_metadata WHERE model_id = ?",
    )
    .bind(&model_id)
    .fetch_optional(&db.pool)
    .await?;
    Ok(row)
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
) -> AppResult<tauri::ipc::Response> {
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

    // Return raw bytes (ArrayBuffer on the JS side) rather than a JSON number[],
    // which would inflate the payload ~4x and cost a parse on a multi-MB mesh.
    Ok(tauri::ipc::Response::new(std::fs::read(&target_canon)?))
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

    let thumb_dir = state.thumb_dir.clone();
    let app_for_progress = app.clone();
    let result = scanner::scan_library(&pool, &library_id, &thumb_dir, move |p: ScanProgress| {
        let _ = app_for_progress.emit("scan:progress", &p);
    })
    .await?;

    let _ = app.emit("scan:complete", &result);
    Ok(result)
}

/// Read a cached thumbnail's PNG bytes for a model. Returns `NotFound` if the
/// model has no thumbnail. The stored path is validated against the thumbnail
/// cache dir to prevent reading arbitrary files.
#[tauri::command]
pub async fn read_thumbnail(
    state: State<'_, AppState>,
    model_id: String,
) -> AppResult<tauri::ipc::Response> {
    let thumb_path: Option<String> = {
        let db = state.db.lock().await;
        sqlx::query_scalar("SELECT thumbnail_path FROM models WHERE id = ?")
            .bind(&model_id)
            .fetch_optional(&db.pool)
            .await?
            .flatten()
    };

    let thumb_path = thumb_path.ok_or(crate::error::AppError::NotFound)?;

    // Confine reads to the thumbnail cache directory.
    let cache_canon = state
        .thumb_dir
        .canonicalize()
        .map_err(|_| crate::error::AppError::NotFound)?;
    let target_canon = std::path::Path::new(&thumb_path)
        .canonicalize()
        .map_err(|_| crate::error::AppError::NotFound)?;
    if !target_canon.starts_with(&cache_canon) {
        return Err(crate::error::AppError::InvalidInput(
            "Thumbnail path escapes the cache directory".into(),
        ));
    }

    Ok(tauri::ipc::Response::new(std::fs::read(&target_canon)?))
}

/// Persist a thumbnail rendered on the frontend (STL/OBJ meshes have no embedded
/// preview, so the WebGL viewer renders one offscreen and hands it back here).
///
/// The image is cached content-addressed by the model's byte hash so identical
/// files share one file, mirroring the 3MF thumbnail path.
#[tauri::command]
pub async fn save_thumbnail(
    state: State<'_, AppState>,
    model_id: String,
    png: Vec<u8>,
) -> AppResult<()> {
    // Reject anything that isn't a PNG before it touches the cache.
    const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if png.len() < 8 || png[..8] != PNG_SIG {
        return Err(crate::error::AppError::InvalidInput(
            "Thumbnail is not a PNG".into(),
        ));
    }

    let (exists, byte_hash): (bool, Option<String>) = {
        let db = state.db.lock().await;
        let row: Option<Option<String>> =
            sqlx::query_scalar("SELECT byte_hash FROM models WHERE id = ?")
                .bind(&model_id)
                .fetch_optional(&db.pool)
                .await?;
        match row {
            Some(h) => (true, h),
            None => (false, None),
        }
    };
    if !exists {
        return Err(crate::error::AppError::NotFound);
    }

    // Key by byte hash when available; fall back to the model id. Both are
    // already safe (hex / UUID), but sanitize to hex+dash as defense-in-depth so
    // a poisoned value can never escape the cache dir via path separators.
    let raw_key = byte_hash.unwrap_or_else(|| model_id.clone());
    let key: String = raw_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if key.is_empty() {
        return Err(crate::error::AppError::InvalidInput(
            "Unusable thumbnail cache key".into(),
        ));
    }
    let dest = state.thumb_dir.join(format!("{key}.png"));
    std::fs::write(&dest, &png)?;

    let dest_str = dest.to_string_lossy().into_owned();
    {
        let db = state.db.lock().await;
        sqlx::query("UPDATE models SET thumbnail_path = ? WHERE id = ?")
            .bind(&dest_str)
            .bind(&model_id)
            .execute(&db.pool)
            .await?;
    }

    Ok(())
}

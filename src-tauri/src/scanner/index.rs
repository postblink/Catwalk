use super::format::ModelFormat;
use super::hash::hash_file;
use super::walk::{walk_library, DiscoveredFile};
use crate::error::{AppError, AppResult};
use crate::parsers::threemf;
use crate::tagging;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::Path;
use uuid::Uuid;

/// Progress payload emitted to the frontend during a scan.
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub library_id: String,
    pub phase: String, // "walking" | "indexing" | "pruning" | "done"
    pub processed: usize,
    pub total: usize,
    pub current: Option<String>,
}

/// Summary returned when a scan finishes.
#[derive(Debug, Clone, Serialize)]
pub struct ScanResult {
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub total_seen: usize,
}

/// Existing row state we need to decide whether a file changed.
struct ExistingRow {
    id: String,
    size_bytes: i64,
    modified_at: String,
}

/// Run a full scan of one library. `on_progress` is invoked as work proceeds so the
/// caller can forward it to the UI (Tauri events).
pub async fn scan_library<F>(
    pool: &SqlitePool,
    library_id: &str,
    thumb_dir: &Path,
    mut on_progress: F,
) -> AppResult<ScanResult>
where
    F: FnMut(ScanProgress),
{
    let root: String =
        sqlx::query_scalar("SELECT root_path FROM libraries WHERE id = ?")
            .bind(library_id)
            .fetch_optional(pool)
            .await?
            .ok_or(AppError::NotFound)?;

    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "Library root no longer exists: {root}"
        )));
    }

    on_progress(ScanProgress {
        library_id: library_id.to_string(),
        phase: "walking".into(),
        processed: 0,
        total: 0,
        current: None,
    });

    let discovered = walk_library(root_path);
    let total = discovered.len();

    let mut result = ScanResult {
        added: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
        total_seen: total,
    };

    let mut seen_paths: HashSet<String> = HashSet::with_capacity(total);

    for (i, file) in discovered.iter().enumerate() {
        seen_paths.insert(file.relative_path.clone());

        on_progress(ScanProgress {
            library_id: library_id.to_string(),
            phase: "indexing".into(),
            processed: i,
            total,
            current: Some(file.filename.clone()),
        });

        match upsert_file(pool, library_id, file, thumb_dir).await {
            Ok(Upsert::Added) => result.added += 1,
            Ok(Upsert::Updated) => result.updated += 1,
            Ok(Upsert::Unchanged) => result.unchanged += 1,
            Err(e) => tracing::warn!("failed to index {}: {e:?}", file.relative_path),
        }
    }

    // Prune rows for files that no longer exist on disk.
    on_progress(ScanProgress {
        library_id: library_id.to_string(),
        phase: "pruning".into(),
        processed: total,
        total,
        current: None,
    });
    result.removed = prune_missing(pool, library_id, &seen_paths).await?;

    on_progress(ScanProgress {
        library_id: library_id.to_string(),
        phase: "done".into(),
        processed: total,
        total,
        current: None,
    });

    Ok(result)
}

enum Upsert {
    Added,
    Updated,
    Unchanged,
}

async fn upsert_file(
    pool: &SqlitePool,
    library_id: &str,
    file: &DiscoveredFile,
    thumb_dir: &Path,
) -> AppResult<Upsert> {
    let existing = sqlx::query_as::<_, (String, i64, String)>(
        "SELECT id, size_bytes, modified_at FROM models WHERE library_id = ? AND relative_path = ?",
    )
    .bind(library_id)
    .bind(&file.relative_path)
    .fetch_optional(pool)
    .await?
    .map(|(id, size_bytes, modified_at)| ExistingRow {
        id,
        size_bytes,
        modified_at,
    });

    let modified_rfc = file.modified.to_rfc3339();
    let size = file.size_bytes as i64;

    if let Some(row) = &existing {
        // Unchanged if size and mtime match — skip the expensive hash.
        if row.size_bytes == size && row.modified_at == modified_rfc {
            return Ok(Upsert::Unchanged);
        }
    }

    // File is new or changed: compute byte hash.
    let byte_hash = hash_file(&file.absolute_path)?;

    let (model_id, outcome) = if let Some(row) = existing {
        sqlx::query(
            "UPDATE models SET filename = ?, extension = ?, size_bytes = ?, \
             byte_hash = ?, modified_at = ?, indexed_at = datetime('now') WHERE id = ?",
        )
        .bind(&file.filename)
        .bind(&file.extension)
        .bind(size)
        .bind(&byte_hash)
        .bind(&modified_rfc)
        .bind(&row.id)
        .execute(pool)
        .await?;
        (row.id, Upsert::Updated)
    } else {
        let id = Uuid::new_v4().to_string();
        // ON CONFLICT guards against a concurrent scan having inserted the same
        // (library_id, relative_path) between our SELECT and this INSERT. We then
        // read the canonical id back so it's correct whether we inserted or the
        // conflicting row won.
        sqlx::query(
            "INSERT INTO models (id, library_id, relative_path, filename, extension, \
             size_bytes, byte_hash, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(library_id, relative_path) DO UPDATE SET \
             filename = excluded.filename, extension = excluded.extension, \
             size_bytes = excluded.size_bytes, byte_hash = excluded.byte_hash, \
             modified_at = excluded.modified_at, indexed_at = datetime('now')",
        )
        .bind(&id)
        .bind(library_id)
        .bind(&file.relative_path)
        .bind(&file.filename)
        .bind(&file.extension)
        .bind(size)
        .bind(&byte_hash)
        .bind(&modified_rfc)
        .execute(pool)
        .await?;

        let canonical_id: String = sqlx::query_scalar(
            "SELECT id FROM models WHERE library_id = ? AND relative_path = ?",
        )
        .bind(library_id)
        .bind(&file.relative_path)
        .fetch_one(pool)
        .await?;
        (canonical_id, Upsert::Added)
    };

    // Extract metadata + a preview thumbnail for formats that carry them. Failures
    // here are non-fatal: the file is still indexed, just without rich metadata.
    // The parsed 3MF data (if any) also feeds tier-1 auto-tagging below.
    let threemf_data = if file.format == ModelFormat::ThreeMf {
        match store_threemf_metadata(pool, &model_id, file, &byte_hash, thumb_dir).await {
            Ok(data) => Some(data),
            Err(e) => {
                tracing::warn!("3mf metadata failed for {}: {e:?}", file.relative_path);
                None
            }
        }
    } else {
        None
    };

    // Deterministic auto-tagging. Tier-1 draws on parsed metadata (3MF only);
    // tier-2 always runs against the filename. Non-fatal on failure.
    let input = tagging::AutoTagInput {
        filename: &file.filename,
        format: threemf_data.as_ref().map(|d| d.format.as_str()),
        filament_types: threemf_data
            .as_ref()
            .map(|d| d.filament_types.as_slice())
            .unwrap_or(&[]),
        bbox: threemf_data.as_ref().and_then(|d| d.bbox),
        triangle_count: threemf_data.as_ref().and_then(|d| d.triangle_count),
        source_url: None,
    };
    if let Err(e) = tagging::apply_auto_tags(pool, &model_id, &input).await {
        tracing::warn!("auto-tagging failed for {}: {e:?}", file.relative_path);
    }

    Ok(outcome)
}

/// Parse a 3MF, cache its embedded thumbnail (content-addressed by byte hash),
/// and upsert the parsed metadata row. Returns the parsed data so the caller can
/// reuse it for auto-tagging without re-parsing the archive.
async fn store_threemf_metadata(
    pool: &SqlitePool,
    model_id: &str,
    file: &DiscoveredFile,
    byte_hash: &str,
    thumb_dir: &Path,
) -> AppResult<threemf::ThreeMfData> {
    let data = threemf::parse(&file.absolute_path)?;

    // Write the thumbnail to the cache, keyed by file hash so identical files
    // share one cached image. Store the absolute path on the model row.
    let mut thumb_path: Option<String> = None;
    if let Some(png) = &data.thumbnail_png {
        let dest = thumb_dir.join(format!("{byte_hash}.png"));
        if !dest.exists() {
            std::fs::write(&dest, png)?;
        }
        thumb_path = Some(dest.to_string_lossy().into_owned());
    }

    if let Some(tp) = &thumb_path {
        sqlx::query("UPDATE models SET thumbnail_path = ? WHERE id = ?")
            .bind(tp)
            .bind(model_id)
            .execute(pool)
            .await?;
    }

    let filament_types_json = if data.filament_types.is_empty() {
        None
    } else {
        serde_json::to_string(&data.filament_types).ok()
    };
    let (bbox_min, bbox_max) = match data.bbox {
        Some((mn, mx)) => (Some(mn), Some(mx)),
        None => (None, None),
    };

    sqlx::query(
        "INSERT INTO model_metadata (model_id, format, plate_count, print_time_seconds, \
         filament_grams, filament_types, nozzle_diameter, layer_height, \
         bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z, \
         triangle_count) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(model_id) DO UPDATE SET \
         format = excluded.format, plate_count = excluded.plate_count, \
         print_time_seconds = excluded.print_time_seconds, \
         filament_grams = excluded.filament_grams, filament_types = excluded.filament_types, \
         nozzle_diameter = excluded.nozzle_diameter, layer_height = excluded.layer_height, \
         bbox_min_x = excluded.bbox_min_x, bbox_min_y = excluded.bbox_min_y, \
         bbox_min_z = excluded.bbox_min_z, bbox_max_x = excluded.bbox_max_x, \
         bbox_max_y = excluded.bbox_max_y, bbox_max_z = excluded.bbox_max_z, \
         triangle_count = excluded.triangle_count",
    )
    .bind(model_id)
    .bind(&data.format)
    .bind(data.plate_count)
    .bind(data.print_time_seconds)
    .bind(data.filament_grams)
    .bind(&filament_types_json)
    .bind(data.nozzle_diameter)
    .bind(data.layer_height)
    .bind(bbox_min.map(|b| b[0]))
    .bind(bbox_min.map(|b| b[1]))
    .bind(bbox_min.map(|b| b[2]))
    .bind(bbox_max.map(|b| b[0]))
    .bind(bbox_max.map(|b| b[1]))
    .bind(bbox_max.map(|b| b[2]))
    .bind(data.triangle_count)
    .execute(pool)
    .await?;

    Ok(data)
}

/// Delete model rows whose relative_path was not seen during the walk.
async fn prune_missing(
    pool: &SqlitePool,
    library_id: &str,
    seen: &HashSet<String>,
) -> AppResult<usize> {
    let existing: Vec<(String, String)> =
        sqlx::query_as("SELECT id, relative_path FROM models WHERE library_id = ?")
            .bind(library_id)
            .fetch_all(pool)
            .await?;

    // Wrap deletions in a single transaction so a crash mid-prune doesn't leave
    // the index half-pruned.
    let mut tx = pool.begin().await?;
    let mut removed = 0;
    for (id, rel) in existing {
        if !seen.contains(&rel) {
            sqlx::query("DELETE FROM models WHERE id = ?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            removed += 1;
        }
    }
    tx.commit().await?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::fs::File;
    use std::io::Write;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    async fn setup() -> (SqlitePool, std::path::PathBuf, std::path::PathBuf, String) {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut root = std::env::temp_dir();
        root.push(format!("catwalk-idx-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&root).unwrap();
        let thumbs = root.join(".thumbs");
        std::fs::create_dir_all(&thumbs).unwrap();

        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        tagging::seed_vocabulary(&pool).await.unwrap();

        let lib_id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO libraries (id, name, root_path) VALUES (?, ?, ?)")
            .bind(&lib_id)
            .bind("test")
            .bind(root.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .unwrap();

        (pool, root, thumbs, lib_id)
    }

    fn write(root: &Path, rel: &str, bytes: &[u8]) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        File::create(&p).unwrap().write_all(bytes).unwrap();
    }

    // A valid binary STL: 80-byte header + u32 count + count*50 bytes.
    fn bin_stl(tris: u32) -> Vec<u8> {
        let mut v = vec![0u8; 80];
        v.extend_from_slice(&tris.to_le_bytes());
        v.extend(std::iter::repeat(0u8).take(tris as usize * 50));
        v
    }

    #[tokio::test]
    async fn indexes_prunes_and_skips_unchanged() {
        let (pool, root, thumbs, lib_id) = setup().await;

        write(&root, "a.stl", &bin_stl(1));
        write(&root, "sub/b.obj", b"v 0 0 0\n");
        write(&root, "notes.txt", b"ignore me");

        // First scan: 2 recognized files added.
        let r1 = scan_library(&pool, &lib_id, &thumbs, |_| {}).await.unwrap();
        assert_eq!(r1.added, 2, "should add 2 model files");
        assert_eq!(r1.total_seen, 2, "txt is ignored");

        // Second scan, nothing changed: both unchanged, no hashing churn.
        let r2 = scan_library(&pool, &lib_id, &thumbs, |_| {}).await.unwrap();
        assert_eq!(r2.unchanged, 2);
        assert_eq!(r2.added, 0);

        // Delete one file → it should be pruned.
        std::fs::remove_file(root.join("a.stl")).unwrap();
        let r3 = scan_library(&pool, &lib_id, &thumbs, |_| {}).await.unwrap();
        assert_eq!(r3.removed, 1);
        assert_eq!(r3.total_seen, 1);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM models WHERE library_id = ?")
            .bind(&lib_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn relative_paths_use_forward_slashes() {
        let (pool, root, thumbs, lib_id) = setup().await;
        write(&root, "deep/nested/c.obj", b"v 1 1 1\n");
        scan_library(&pool, &lib_id, &thumbs, |_| {}).await.unwrap();

        let rel: String = sqlx::query_scalar("SELECT relative_path FROM models LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rel, "deep/nested/c.obj");
        assert!(!rel.contains('\\'));

        std::fs::remove_dir_all(&root).ok();
    }
}

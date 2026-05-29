use super::hash::hash_file;
use super::walk::{walk_library, DiscoveredFile};
use crate::error::{AppError, AppResult};
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

        match upsert_file(pool, library_id, file).await {
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

    if let Some(row) = existing {
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
        Ok(Upsert::Updated)
    } else {
        let id = Uuid::new_v4().to_string();
        // ON CONFLICT guards against a concurrent scan having inserted the same
        // (library_id, relative_path) between our SELECT and this INSERT.
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
        Ok(Upsert::Added)
    }
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

    async fn setup() -> (SqlitePool, std::path::PathBuf, String) {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut root = std::env::temp_dir();
        root.push(format!("catwalk-idx-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&root).unwrap();

        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let lib_id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO libraries (id, name, root_path) VALUES (?, ?, ?)")
            .bind(&lib_id)
            .bind("test")
            .bind(root.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .unwrap();

        (pool, root, lib_id)
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
        let (pool, root, lib_id) = setup().await;

        write(&root, "a.stl", &bin_stl(1));
        write(&root, "sub/b.obj", b"v 0 0 0\n");
        write(&root, "notes.txt", b"ignore me");

        // First scan: 2 recognized files added.
        let r1 = scan_library(&pool, &lib_id, |_| {}).await.unwrap();
        assert_eq!(r1.added, 2, "should add 2 model files");
        assert_eq!(r1.total_seen, 2, "txt is ignored");

        // Second scan, nothing changed: both unchanged, no hashing churn.
        let r2 = scan_library(&pool, &lib_id, |_| {}).await.unwrap();
        assert_eq!(r2.unchanged, 2);
        assert_eq!(r2.added, 0);

        // Delete one file → it should be pruned.
        std::fs::remove_file(root.join("a.stl")).unwrap();
        let r3 = scan_library(&pool, &lib_id, |_| {}).await.unwrap();
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
        let (pool, root, lib_id) = setup().await;
        write(&root, "deep/nested/c.obj", b"v 1 1 1\n");
        scan_library(&pool, &lib_id, |_| {}).await.unwrap();

        let rel: String = sqlx::query_scalar("SELECT relative_path FROM models LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rel, "deep/nested/c.obj");
        assert!(!rel.contains('\\'));

        std::fs::remove_dir_all(&root).ok();
    }
}

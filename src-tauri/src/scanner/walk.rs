use super::format::{detect_format, ModelFormat};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// A model file discovered on disk, with its detected format and basic stat info.
#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub filename: String,
    pub extension: String,
    // Consumed by the upcoming parser/metadata stage; detection still gates indexing.
    #[allow(dead_code)]
    pub format: ModelFormat,
    pub size_bytes: u64,
    pub modified: chrono::DateTime<chrono::Utc>,
}

/// Walk a library root and return all recognized model files.
///
/// Hidden directories (dotfiles) are skipped. Symlinks are not followed to avoid
/// cycles and escaping the library root.
pub fn walk_library(root: &Path) -> Vec<DiscoveredFile> {
    let mut out = Vec::new();

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e.path()));

    for entry in walker.filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();

        let format = match detect_format(path) {
            Ok(Some(f)) => f,
            Ok(None) => continue,
            Err(e) => {
                tracing::warn!("failed to sniff {}: {e}", path.display());
                continue;
            }
        };

        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .map(chrono::DateTime::<chrono::Utc>::from)
            .unwrap_or_else(chrono::Utc::now);

        // Normalize to forward slashes so the stored relative_path is identical
        // across platforms (keeps the DB portable; a Windows-indexed library
        // resolves the same on macOS/Linux).
        let relative_path = match path.strip_prefix(root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();

        out.push(DiscoveredFile {
            absolute_path: path.to_path_buf(),
            relative_path,
            filename,
            extension,
            format,
            size_bytes: meta.len(),
            modified,
        });
    }

    out
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.') && n != "." && n != "..")
        .unwrap_or(false)
}

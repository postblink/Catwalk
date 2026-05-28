use crate::error::AppResult;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
pub struct SlicerCandidate {
    pub slicer: String,
    pub label: String,
    pub path: String,
    pub exists: bool,
}

/// Common per-slicer "project / model" directories users tend to keep STL/3MF files in.
/// We intentionally point at *user content* dirs, not config dirs.
#[tauri::command]
pub fn detect_slicer_libraries() -> AppResult<Vec<SlicerCandidate>> {
    let home = dirs::home_dir();
    let docs = dirs::document_dir();
    let downloads = dirs::download_dir();

    let mut candidates: Vec<(&str, &str, Option<PathBuf>)> = Vec::new();

    // Bambu Studio
    if let Some(d) = docs.clone() {
        candidates.push(("bambu-studio", "Bambu Studio — Documents", Some(d.join("BambuStudio"))));
    }
    if let Some(h) = home.clone() {
        candidates.push((
            "bambu-studio",
            "Bambu Studio — User data",
            #[cfg(target_os = "macos")]
            Some(h.join("Library/Application Support/BambuStudio/user")),
            #[cfg(target_os = "linux")]
            Some(h.join(".config/BambuStudio/user")),
            #[cfg(target_os = "windows")]
            Some(h.join("AppData/Roaming/BambuStudio/user")),
        ));
    }

    // OrcaSlicer
    if let Some(d) = docs.clone() {
        candidates.push(("orca-slicer", "OrcaSlicer — Documents", Some(d.join("OrcaSlicer"))));
    }
    if let Some(h) = home.clone() {
        candidates.push((
            "orca-slicer",
            "OrcaSlicer — User data",
            #[cfg(target_os = "macos")]
            Some(h.join("Library/Application Support/OrcaSlicer/user")),
            #[cfg(target_os = "linux")]
            Some(h.join(".config/OrcaSlicer/user")),
            #[cfg(target_os = "windows")]
            Some(h.join("AppData/Roaming/OrcaSlicer/user")),
        ));
    }

    // PrusaSlicer
    if let Some(d) = docs.clone() {
        candidates.push(("prusa-slicer", "PrusaSlicer — Documents", Some(d.join("PrusaSlicer"))));
    }

    // Cura
    if let Some(d) = docs.clone() {
        candidates.push(("cura", "Cura — Documents", Some(d.join("Cura"))));
    }

    // Common user folders that often hold 3D models
    if let Some(h) = home.clone() {
        candidates.push(("user", "Home — 3D Models", Some(h.join("3D Models"))));
        candidates.push(("user", "Home — Models", Some(h.join("Models"))));
    }
    if let Some(d) = docs {
        candidates.push(("user", "Documents — 3D Models", Some(d.join("3D Models"))));
    }
    if let Some(d) = downloads {
        candidates.push(("user", "Downloads — 3D Models", Some(d.join("3D Models"))));
    }

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (slicer, label, path) in candidates {
        let Some(p) = path else { continue };
        let key = p.to_string_lossy().to_string();
        if !seen.insert(key.clone()) {
            continue;
        }
        out.push(SlicerCandidate {
            slicer: slicer.to_string(),
            label: label.to_string(),
            path: key,
            exists: p.is_dir(),
        });
    }

    // Sort: existing first, then alphabetical
    out.sort_by(|a, b| b.exists.cmp(&a.exists).then(a.label.cmp(&b.label)));
    Ok(out)
}

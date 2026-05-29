//! Vocabulary seeding + deterministic auto-tagging.
//!
//! - **Tier 1** is metadata-derived and high-confidence: material from filament
//!   type, slicer from the 3MF flavor, size from the bounding box, poly count,
//!   and source from a download URL.
//! - **Tier 2** is filename keyword matching against the vocabulary aliases
//!   (word-boundary, case-insensitive) — lower confidence.
//!
//! Both tiers are written as *unconfirmed suggestions* (`confirmed = 0`) and
//! never clobber an existing assignment (manual or already-confirmed), so a
//! re-scan preserves the user's curation.

use crate::error::AppResult;
use crate::vocab::vocab;
use sqlx::SqlitePool;
use std::collections::HashSet;

/// Insert every vocabulary tag, ignoring ones that already exist. Idempotent.
pub async fn seed_vocabulary(pool: &SqlitePool) -> AppResult<()> {
    for t in &vocab().tags {
        sqlx::query(
            "INSERT INTO tags (id, name, color, category) VALUES (?, ?, ?, ?) \
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(&t.id)
        .bind(&t.label)
        .bind(&t.color)
        .bind(&t.category)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Inputs the auto-tagger reasons over. Borrows so callers can build it cheaply.
#[derive(Debug, Default)]
pub struct AutoTagInput<'a> {
    pub filename: &'a str,
    /// Refined format string, e.g. `3mf-bambu` (drives the slicer tag).
    pub format: Option<&'a str>,
    pub filament_types: &'a [String],
    /// `(min_xyz, max_xyz)` in millimeters.
    pub bbox: Option<([f64; 3], [f64; 3])>,
    pub triangle_count: Option<i64>,
    pub source_url: Option<&'a str>,
}

/// A single derived tag assignment.
#[derive(Debug, Clone, PartialEq)]
pub struct TagAssignment {
    pub tag_id: String,
    pub source: String, // "auto-tier1" | "auto-tier2"
    pub confidence: f64,
}

/// Compute deterministic tag assignments for a model. Pure (no DB) so it's unit
/// testable; `apply_auto_tags` persists the result.
pub fn auto_tag(input: &AutoTagInput) -> Vec<TagAssignment> {
    let v = vocab();
    let mut out: Vec<TagAssignment> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // ---- Tier 1: material from filament types ----
    if !input.filament_types.is_empty() {
        let hay = padded(&input.filament_types.join(" "));
        for t in v.tags.iter().filter(|t| t.category == "material") {
            if t.aliases.iter().any(|a| word_match(&hay, a)) {
                push(&mut out, &mut seen, &t.id, "auto-tier1", 1.0);
            }
        }
    }

    // ---- Tier 1: slicer from 3MF flavor ----
    if let Some(fmt) = input.format {
        let slicer = match fmt {
            "3mf-bambu" => Some("slicer-bambu"),
            "3mf-orca" => Some("slicer-orca"),
            "3mf-prusa" => Some("slicer-prusa"),
            "3mf-cura" => Some("slicer-cura"),
            _ => None,
        };
        if let Some(id) = slicer {
            push(&mut out, &mut seen, id, "auto-tier1", 1.0);
        }
    }

    // ---- Tier 1: size from bounding box ----
    if let Some((mn, mx)) = input.bbox {
        let longest = (mx[0] - mn[0]).max(mx[1] - mn[1]).max(mx[2] - mn[2]);
        if longest >= v.heuristics.large_min_bbox_mm {
            push(&mut out, &mut seen, "attr-large", "auto-tier1", 1.0);
        } else if longest > 0.0 && longest <= v.heuristics.tiny_max_bbox_mm {
            push(&mut out, &mut seen, "attr-tiny", "auto-tier1", 1.0);
        }
    }

    // ---- Tier 1: high poly ----
    if let Some(tris) = input.triangle_count {
        if tris >= v.heuristics.high_poly_min_triangles {
            push(&mut out, &mut seen, "attr-high-poly", "auto-tier1", 1.0);
        }
    }

    // ---- Tier 1: source from URL ----
    if let Some(url) = input.source_url {
        let hay = padded(url);
        for t in v.tags.iter().filter(|t| t.category == "source") {
            if t.aliases.iter().any(|a| word_match(&hay, a)) {
                push(&mut out, &mut seen, &t.id, "auto-tier1", 1.0);
            }
        }
    }

    // ---- Tier 2: filename keyword matching (all categories) ----
    let stem = file_stem(input.filename);
    let hay = padded(&stem);
    for t in &v.tags {
        if t.aliases.iter().any(|a| word_match(&hay, a)) {
            push(&mut out, &mut seen, &t.id, "auto-tier2", 0.6);
        }
    }

    out
}

/// Compute and persist auto-tags for a model. Existing assignments win.
pub async fn apply_auto_tags(
    pool: &SqlitePool,
    model_id: &str,
    input: &AutoTagInput<'_>,
) -> AppResult<usize> {
    let assignments = auto_tag(input);
    let mut applied = 0;
    for a in assignments {
        let res = sqlx::query(
            "INSERT INTO model_tags (model_id, tag_id, source, confidence, confirmed) \
             VALUES (?, ?, ?, ?, 0) ON CONFLICT(model_id, tag_id) DO NOTHING",
        )
        .bind(model_id)
        .bind(&a.tag_id)
        .bind(&a.source)
        .bind(a.confidence)
        .execute(pool)
        .await?;
        applied += res.rows_affected() as usize;
    }
    Ok(applied)
}

// ---- Matching helpers ----

fn push(
    out: &mut Vec<TagAssignment>,
    seen: &mut HashSet<String>,
    id: &str,
    source: &str,
    confidence: f64,
) {
    if seen.insert(id.to_string()) {
        out.push(TagAssignment {
            tag_id: id.to_string(),
            source: source.to_string(),
            confidence,
        });
    }
}

/// Lowercase, replace every non-alphanumeric char with a space, collapse runs,
/// and pad with a leading/trailing space so word-boundary checks are simple
/// substring tests.
fn padded(s: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            cur.extend(ch.to_lowercase());
        } else if !cur.is_empty() {
            words.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    format!(" {} ", words.join(" "))
}

/// Does `alias` appear as a whole word (or whole multi-word phrase) in the
/// already-`padded` haystack?
fn word_match(padded_haystack: &str, alias: &str) -> bool {
    let needle = padded(alias);
    let trimmed = needle.trim();
    if trimmed.is_empty() {
        return false;
    }
    padded_haystack.contains(&format!(" {trimmed} "))
}

/// Filename without its final extension.
fn file_stem(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((stem, _ext)) if !stem.is_empty() => stem.to_string(),
        _ => filename.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn material_and_slicer_from_metadata() {
        let fils = vec!["PLA".to_string()];
        let input = AutoTagInput {
            filename: "widget.3mf",
            format: Some("3mf-bambu"),
            filament_types: &fils,
            ..Default::default()
        };
        let tags = auto_tag(&input);
        let ids: Vec<&str> = tags.iter().map(|t| t.tag_id.as_str()).collect();
        assert!(ids.contains(&"material-pla"));
        assert!(ids.contains(&"slicer-bambu"));
        // Tier-1 confidence for metadata-derived tags.
        let pla = tags.iter().find(|t| t.tag_id == "material-pla").unwrap();
        assert_eq!(pla.source, "auto-tier1");
    }

    #[test]
    fn size_from_bbox() {
        let big = AutoTagInput {
            filename: "x.3mf",
            bbox: Some(([0.0, 0.0, 0.0], [200.0, 50.0, 20.0])),
            ..Default::default()
        };
        let ids: Vec<String> = auto_tag(&big).into_iter().map(|t| t.tag_id).collect();
        assert!(ids.contains(&"attr-large".to_string()));

        let small = AutoTagInput {
            filename: "x.3mf",
            bbox: Some(([0.0, 0.0, 0.0], [10.0, 10.0, 10.0])),
            ..Default::default()
        };
        let ids: Vec<String> = auto_tag(&small).into_iter().map(|t| t.tag_id).collect();
        assert!(ids.contains(&"attr-tiny".to_string()));
    }

    #[test]
    fn filename_keywords_are_tier2() {
        let input = AutoTagInput {
            filename: "Cute_Dragon_keychain_x1c.stl",
            ..Default::default()
        };
        let tags = auto_tag(&input);
        let ids: Vec<&str> = tags.iter().map(|t| t.tag_id.as_str()).collect();
        assert!(ids.contains(&"subject-dragon"));
        assert!(ids.contains(&"subject-keychain"));
        assert!(ids.contains(&"printer-bambu-x1")); // matches "x1c" alias
        for t in &tags {
            assert_eq!(t.source, "auto-tier2");
        }
    }

    #[test]
    fn no_false_substring_matches() {
        // "abs" must not match inside "absolute".
        let input = AutoTagInput {
            filename: "absolute_unit.stl",
            ..Default::default()
        };
        let ids: Vec<String> = auto_tag(&input).into_iter().map(|t| t.tag_id).collect();
        assert!(!ids.contains(&"material-abs".to_string()));
    }
}

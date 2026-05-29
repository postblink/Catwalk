//! Curated tag vocabulary, parsed once from the bundled `resources/tags.yaml`.
//!
//! The vocabulary drives two things: seeding the `tags` table with stable,
//! well-known tag ids, and the auto-tagger's alias/heuristic matching. The file
//! is embedded at compile time so it's always available (and works in tests).

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize)]
pub struct VocabTag {
    pub id: String,
    pub label: String,
    pub category: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Heuristics {
    pub large_min_bbox_mm: f64,
    pub tiny_max_bbox_mm: f64,
    pub high_poly_min_triangles: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Vocab {
    #[allow(dead_code)] // present for forward-compat / schema migrations
    pub version: u32,
    pub tags: Vec<VocabTag>,
    pub heuristics: Heuristics,
}

const TAGS_YAML: &str = include_str!("../resources/tags.yaml");

/// The parsed vocabulary. Panics at first access only if the bundled YAML is
/// malformed, which a test guards against.
pub fn vocab() -> &'static Vocab {
    static V: OnceLock<Vocab> = OnceLock::new();
    V.get_or_init(|| serde_yaml::from_str(TAGS_YAML).expect("bundled tags.yaml is valid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_vocab_parses() {
        let v = vocab();
        assert!(v.tags.len() > 20, "expected a populated vocabulary");
        assert!(v.heuristics.large_min_bbox_mm > 0.0);
        // Spot-check a couple of well-known ids the auto-tagger relies on.
        assert!(v.tags.iter().any(|t| t.id == "material-pla"));
        assert!(v.tags.iter().any(|t| t.id == "slicer-bambu"));
    }
}

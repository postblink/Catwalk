//! Tauri commands for reading and editing tags.

use crate::error::{AppError, AppResult};
use crate::AppState;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub category: Option<String>,
}

/// A tag plus how many models in scope carry it (drives the sidebar).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TagCount {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub category: Option<String>,
    pub count: i64,
}

/// A tag as it applies to one model (with assignment provenance).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModelTag {
    pub tag_id: String,
    pub name: String,
    pub color: Option<String>,
    pub category: Option<String>,
    pub source: String,
    pub confidence: Option<f64>,
    pub confirmed: i64, // 0/1
}

/// List tags in use, optionally scoped to one library, ordered by frequency.
#[tauri::command]
pub async fn list_tags(
    state: State<'_, AppState>,
    library_id: Option<String>,
) -> AppResult<Vec<TagCount>> {
    let db = state.db.lock().await;
    let rows = sqlx::query_as::<_, TagCount>(
        "SELECT t.id, t.name, t.color, t.category, COUNT(mt.model_id) AS count \
         FROM tags t \
         JOIN model_tags mt ON mt.tag_id = t.id \
         JOIN models m ON m.id = mt.model_id \
         WHERE (?1 IS NULL OR m.library_id = ?1) \
         GROUP BY t.id, t.name, t.color, t.category \
         ORDER BY count DESC, t.name COLLATE NOCASE ASC",
    )
    .bind(&library_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows)
}

/// All tags applied to a model, confirmed first.
#[tauri::command]
pub async fn list_model_tags(
    state: State<'_, AppState>,
    model_id: String,
) -> AppResult<Vec<ModelTag>> {
    let db = state.db.lock().await;
    let rows = sqlx::query_as::<_, ModelTag>(
        "SELECT mt.tag_id, t.name, t.color, t.category, mt.source, mt.confidence, mt.confirmed \
         FROM model_tags mt JOIN tags t ON t.id = mt.tag_id \
         WHERE mt.model_id = ? \
         ORDER BY mt.confirmed DESC, t.category, t.name COLLATE NOCASE ASC",
    )
    .bind(&model_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows)
}

/// Attach an existing tag to a model as a confirmed, manual assignment.
#[tauri::command]
pub async fn add_model_tag(
    state: State<'_, AppState>,
    model_id: String,
    tag_id: String,
) -> AppResult<()> {
    let db = state.db.lock().await;
    sqlx::query(
        "INSERT INTO model_tags (model_id, tag_id, source, confirmed) \
         VALUES (?, ?, 'manual', 1) \
         ON CONFLICT(model_id, tag_id) DO UPDATE SET source = 'manual', confirmed = 1",
    )
    .bind(&model_id)
    .bind(&tag_id)
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Create a tag by free-text name (or reuse an existing one of the same name)
/// and attach it to the model. Returns the resolved tag.
#[tauri::command]
pub async fn create_and_add_tag(
    state: State<'_, AppState>,
    model_id: String,
    name: String,
) -> AppResult<Tag> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("Tag name is required".into()));
    }

    let db = state.db.lock().await;

    // Reuse an existing tag with the same name (case-insensitive).
    let existing = sqlx::query_as::<_, Tag>(
        "SELECT id, name, color, category FROM tags WHERE name = ? COLLATE NOCASE",
    )
    .bind(trimmed)
    .fetch_optional(&db.pool)
    .await?;

    let tag = if let Some(tag) = existing {
        tag
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO tags (id, name) VALUES (?, ?)")
            .bind(&id)
            .bind(trimmed)
            .execute(&db.pool)
            .await?;
        Tag {
            id,
            name: trimmed.to_string(),
            color: None,
            category: None,
        }
    };

    sqlx::query(
        "INSERT INTO model_tags (model_id, tag_id, source, confirmed) \
         VALUES (?, ?, 'manual', 1) \
         ON CONFLICT(model_id, tag_id) DO UPDATE SET source = 'manual', confirmed = 1",
    )
    .bind(&model_id)
    .bind(&tag.id)
    .execute(&db.pool)
    .await?;

    Ok(tag)
}

/// Confirm an auto-suggested tag (keeps its provenance, flips `confirmed`).
#[tauri::command]
pub async fn confirm_model_tag(
    state: State<'_, AppState>,
    model_id: String,
    tag_id: String,
) -> AppResult<()> {
    let db = state.db.lock().await;
    sqlx::query("UPDATE model_tags SET confirmed = 1 WHERE model_id = ? AND tag_id = ?")
        .bind(&model_id)
        .bind(&tag_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

/// Remove a tag from a model.
#[tauri::command]
pub async fn remove_model_tag(
    state: State<'_, AppState>,
    model_id: String,
    tag_id: String,
) -> AppResult<()> {
    let db = state.db.lock().await;
    sqlx::query("DELETE FROM model_tags WHERE model_id = ? AND tag_id = ?")
        .bind(&model_id)
        .bind(&tag_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

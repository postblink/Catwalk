//! Tauri commands for smart collections (saved searches).
//!
//! A smart collection is a named, reusable filter preset. The `query` column
//! holds an opaque string owned by the frontend (it JSON-encodes the text query
//! plus any selected tag); the backend treats it as a blob and never parses it,
//! so the search vocabulary can grow without a schema change.

use crate::error::{AppError, AppResult};
use crate::AppState;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SmartCollection {
    pub id: String,
    pub name: String,
    pub query: String,
    pub icon: Option<String>,
    pub created_at: String,
}

/// List saved collections, newest first.
#[tauri::command]
pub async fn list_collections(state: State<'_, AppState>) -> AppResult<Vec<SmartCollection>> {
    let db = state.db.lock().await;
    let rows = sqlx::query_as::<_, SmartCollection>(
        "SELECT id, name, query, icon, created_at FROM smart_collections \
         ORDER BY created_at DESC, name COLLATE NOCASE ASC",
    )
    .fetch_all(&db.pool)
    .await?;
    Ok(rows)
}

/// Persist the current search as a named collection. Returns the new row.
#[tauri::command]
pub async fn create_collection(
    state: State<'_, AppState>,
    name: String,
    query: String,
    icon: Option<String>,
) -> AppResult<SmartCollection> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("Collection name is required".into()));
    }

    let id = Uuid::new_v4().to_string();
    let db = state.db.lock().await;
    sqlx::query("INSERT INTO smart_collections (id, name, query, icon) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(trimmed)
        .bind(&query)
        .bind(&icon)
        .execute(&db.pool)
        .await?;

    // Read back so the returned row carries the DB-assigned created_at.
    let row = sqlx::query_as::<_, SmartCollection>(
        "SELECT id, name, query, icon, created_at FROM smart_collections WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&db.pool)
    .await?;
    Ok(row)
}

/// Delete a saved collection by id.
#[tauri::command]
pub async fn delete_collection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let db = state.db.lock().await;
    sqlx::query("DELETE FROM smart_collections WHERE id = ?")
        .bind(&id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

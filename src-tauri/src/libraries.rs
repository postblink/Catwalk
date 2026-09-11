use crate::error::{AppError, AppResult};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct Library {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    /// Whether `root_path` is still a readable directory. The path is only
    /// validated when a library is CREATED, so a folder that is later moved,
    /// renamed, or left on an unplugged drive would otherwise surface as a
    /// per-model "not found" on every click rather than one clear explanation.
    pub root_exists: bool,
}

#[tauri::command]
pub async fn list_libraries(state: State<'_, AppState>) -> AppResult<Vec<Library>> {
    let db = state.db.lock().await;
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT id, name, root_path, created_at FROM libraries ORDER BY created_at ASC",
    )
    .fetch_all(&db.pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, name, root_path, created_at)| Library {
            root_exists: std::path::Path::new(&root_path).is_dir(),
            id,
            name,
            root_path,
            created_at,
        })
        .collect())
}

#[tauri::command]
pub async fn create_library(
    state: State<'_, AppState>,
    name: String,
    root_path: String,
) -> AppResult<Library> {
    let trimmed_name = name.trim().to_string();
    if trimmed_name.is_empty() {
        return Err(AppError::InvalidInput("Library name is required".into()));
    }
    let path = PathBuf::from(&root_path);
    if !path.exists() {
        return Err(AppError::InvalidInput(format!(
            "Path does not exist: {root_path}"
        )));
    }
    if !path.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "Path is not a directory: {root_path}"
        )));
    }

    let id = Uuid::new_v4().to_string();
    let db = state.db.lock().await;

    sqlx::query("INSERT INTO libraries (id, name, root_path) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&trimmed_name)
        .bind(&root_path)
        .execute(&db.pool)
        .await?;

    let (created_at,): (String,) =
        sqlx::query_as("SELECT created_at FROM libraries WHERE id = ?")
            .bind(&id)
            .fetch_one(&db.pool)
            .await?;

    Ok(Library {
        id,
        name: trimmed_name,
        root_path,
        created_at,
        // Validated as an existing directory at the top of this function.
        root_exists: true,
    })
}

#[tauri::command]
pub async fn create_library_dir(parent: String, name: String) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("Folder name is required".into()));
    }
    if trimmed.contains(['/', '\\']) {
        return Err(AppError::InvalidInput(
            "Folder name cannot contain path separators".into(),
        ));
    }

    let parent_path = PathBuf::from(&parent);
    if !parent_path.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "Parent directory does not exist: {parent}"
        )));
    }

    let target = parent_path.join(trimmed);
    if target.exists() {
        return Err(AppError::InvalidInput(format!(
            "Folder already exists: {}",
            target.display()
        )));
    }

    std::fs::create_dir_all(&target)?;
    Ok(target.to_string_lossy().to_string())
}

mod db;
mod error;
mod libraries;
mod models;
mod scanner;
mod slicers;

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

pub struct AppState {
    pub db: Arc<Mutex<db::Db>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "catwalk_lib=debug,info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("app data dir resolvable");
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("catwalk.db");

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::Db::open(&db_path).await {
                    Ok(db) => {
                        handle.manage(AppState {
                            db: Arc::new(Mutex::new(db)),
                        });
                        tracing::info!("database ready at {:?}", db_path);
                    }
                    Err(e) => {
                        tracing::error!("failed to open database: {e:?}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            libraries::list_libraries,
            libraries::create_library,
            libraries::create_library_dir,
            slicers::detect_slicer_libraries,
            models::list_models,
            models::scan_library,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

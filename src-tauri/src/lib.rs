mod commands;
mod mcdf;

use tauri_plugin_dialog::DialogExt;

pub use commands::{extract_mcdf, scan_mcdf, get_app_version};

/// Create and configure the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            extract_mcdf,
            scan_mcdf,
            get_app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

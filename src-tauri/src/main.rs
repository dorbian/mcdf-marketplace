#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mcdf_marketplace_lib::{extract_mcdf, get_app_version, scan_mcdf};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
    // Initialize logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    info!("Starting MCDF Marketplace v{}", get_app_version());

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            scan_mcdf,
            extract_mcdf,
            get_app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
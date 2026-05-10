#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mcdf_marketplace_lib::run;
use tracing::info;

fn main() {
    // Initialize logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    info!("Starting MCDF Marketplace");
    run();
}

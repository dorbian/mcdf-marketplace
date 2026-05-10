#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mcdf_marketplace_lib::run;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Registry};

fn main() {
    // Initialize logging
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    Registry::default()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting MCDF Marketplace");
    run();
}

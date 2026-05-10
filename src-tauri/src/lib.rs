mod commands;
mod local_cache;
mod mcdf;
mod online_locations;
mod vault_manifest;

pub use commands::{
    add_online_location, create_local_manifest, create_manifest_from_online_entry, get_app_version,
    get_cache_dir, inspect_mcdf_files, list_online_locations, read_manifest, rebuild_from_manifest,
    remove_online_location, scan_mcdf, scan_online_location, scan_online_locations,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            add_online_location,
            create_local_manifest,
            create_manifest_from_online_entry,
            get_app_version,
            get_cache_dir,
            inspect_mcdf_files,
            list_online_locations,
            read_manifest,
            rebuild_from_manifest,
            remove_online_location,
            scan_mcdf,
            scan_online_location,
            scan_online_locations,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

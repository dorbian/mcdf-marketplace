use crate::local_cache;
use crate::mcdf::{ExtractedFileInfo, MCDFParser, MareCharaFileData};
use crate::online_locations::{self, OnlineLocation, OnlineLocationScanResult, OnlineLocationType, OnlineManifestBuildRequest};
use crate::vault_manifest::{self, ManifestBuildResult, RebuildResult, VaultManifest};
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use tauri::command;

#[command]
pub fn scan_mcdf(path: String) -> Result<MareCharaFileData, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let (metadata, _binary_payload) =
        MCDFParser::parse(&mut reader).map_err(|e| format!("Failed to parse MCDF: {e}"))?;
    Ok(metadata)
}

#[command]
pub fn inspect_mcdf_files(path: String) -> Result<Vec<ExtractedFileInfo>, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let (metadata, binary_payload) =
        MCDFParser::parse(&mut reader).map_err(|e| format!("Failed to parse MCDF: {e}"))?;
    MCDFParser::extract_file_infos(&metadata, &binary_payload).map_err(|e| e.to_string())
}

#[command]
pub fn create_local_manifest(
    path: String,
    title: Option<String>,
    description: Option<String>,
    chunk_size: Option<u64>,
) -> Result<ManifestBuildResult, String> {
    let chunk_size = chunk_size.map(|v| v as usize);
    vault_manifest::create_local_manifest(PathBuf::from(path).as_path(), title, description, chunk_size)
}

#[command]
pub fn read_manifest(path: String) -> Result<VaultManifest, String> {
    vault_manifest::read_manifest(PathBuf::from(path).as_path())
}

#[command]
pub fn rebuild_from_manifest(
    manifest_path: String,
    output_path: Option<String>,
) -> Result<RebuildResult, String> {
    vault_manifest::rebuild_from_manifest(
        PathBuf::from(manifest_path).as_path(),
        output_path.map(PathBuf::from),
    )
}

#[command]
pub fn list_online_locations() -> Result<Vec<OnlineLocation>, String> {
    online_locations::list_online_locations()
}

#[command]
pub fn add_online_location(
    name: String,
    url: String,
    source_type: OnlineLocationType,
    google_api_key: Option<String>,
) -> Result<OnlineLocation, String> {
    online_locations::add_online_location(name, url, source_type, google_api_key)
}

#[command]
pub fn remove_online_location(id: String) -> Result<Vec<OnlineLocation>, String> {
    online_locations::remove_online_location(id)
}

#[command]
pub fn scan_online_locations() -> Result<Vec<OnlineLocationScanResult>, String> {
    online_locations::scan_online_locations()
}

#[command]
pub fn scan_online_location(id: String) -> Result<OnlineLocationScanResult, String> {
    online_locations::scan_online_location(id)
}

#[command]
pub fn create_manifest_from_online_entry(
    request: OnlineManifestBuildRequest,
) -> Result<ManifestBuildResult, String> {
    online_locations::create_manifest_from_online_entry(request)
}

#[command]
pub fn get_cache_dir() -> Result<String, String> {
    Ok(local_cache::app_home()?.to_string_lossy().to_string())
}

#[command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

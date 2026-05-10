use crate::local_cache;
use crate::vault_manifest::{self, ManifestBuildResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineLocation {
    pub id: String,
    pub name: String,
    pub source_type: OnlineLocationType,
    pub url: String,
    #[serde(default)]
    pub google_api_key: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnlineLocationType {
    GenericJsonIndex,
    GoogleDriveFolder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineLibraryEntry {
    pub source_id: String,
    pub source_name: String,
    pub provider: String,
    pub name: String,
    pub mcdf_file_name: String,
    pub mcdf_url: String,
    #[serde(default)]
    pub image_file_name: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
    pub can_prepare_for_central: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineLocationScanResult {
    pub source: OnlineLocation,
    pub entries: Vec<OnlineLibraryEntry>,
    pub orphan_mcdf_files: Vec<OnlineFileRef>,
    pub orphan_image_files: Vec<OnlineFileRef>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineFileRef {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineManifestBuildRequest {
    pub mcdf_url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
}

fn default_enabled() -> bool {
    true
}

pub fn list_online_locations() -> Result<Vec<OnlineLocation>, String> {
    if !locations_path()?.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(locations_path()?).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn add_online_location(
    name: String,
    url: String,
    source_type: OnlineLocationType,
    google_api_key: Option<String>,
) -> Result<OnlineLocation, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Location name is required".to_string());
    }
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        return Err("Location URL is required".to_string());
    }

    let mut locations = list_online_locations()?;
    let id_hash = blake3::hash(format!("{trimmed_name}:{trimmed_url}").as_bytes()).to_hex().to_string();
    let id = format!("loc_{}", &id_hash[..16]);
    let location = OnlineLocation {
        id: id.clone(),
        name: trimmed_name.to_string(),
        source_type,
        url: trimmed_url.to_string(),
        google_api_key: google_api_key.and_then(|v| {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        }),
        enabled: true,
    };

    locations.retain(|existing| existing.id != id);
    locations.push(location.clone());
    write_locations(&locations)?;
    Ok(location)
}

pub fn remove_online_location(id: String) -> Result<Vec<OnlineLocation>, String> {
    let mut locations = list_online_locations()?;
    locations.retain(|location| location.id != id);
    write_locations(&locations)?;
    Ok(locations)
}

pub fn scan_online_locations() -> Result<Vec<OnlineLocationScanResult>, String> {
    let mut results = Vec::new();
    for location in list_online_locations()?.into_iter().filter(|location| location.enabled) {
        match scan_online_location_by_value(location.clone()) {
            Ok(result) => results.push(result),
            Err(error) => results.push(OnlineLocationScanResult {
                source: location,
                entries: Vec::new(),
                orphan_mcdf_files: Vec::new(),
                orphan_image_files: Vec::new(),
                warnings: vec![error],
            }),
        }
    }
    Ok(results)
}

pub fn scan_online_location(id: String) -> Result<OnlineLocationScanResult, String> {
    let location = list_online_locations()?
        .into_iter()
        .find(|location| location.id == id)
        .ok_or_else(|| format!("Unknown online location: {id}"))?;
    scan_online_location_by_value(location)
}

pub fn create_manifest_from_online_entry(
    request: OnlineManifestBuildRequest,
) -> Result<ManifestBuildResult, String> {
    let url = request.mcdf_url.trim();
    if url.is_empty() {
        return Err("MCDF URL is required".to_string());
    }

    let response = reqwest::blocking::get(url).map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Failed to download MCDF: HTTP {}", response.status()));
    }
    let bytes = response.bytes().map_err(|e| e.to_string())?;
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let file_name = filename_from_url(url).unwrap_or_else(|| format!("online-{hash}.mcdf"));
    let import_dir = online_imports_dir()?;
    let local_path = import_dir.join(file_name);
    fs::write(&local_path, &bytes).map_err(|e| e.to_string())?;

    let mut result = vault_manifest::create_local_manifest(
        &local_path,
        request.title,
        request.description,
        None,
    )?;

    result.manifest.source.online_source_url = Some(url.to_string());
    result.manifest.source.thumbnail_url = request.image_url;
    vault_manifest::write_manifest(Path::new(&result.manifest_path), &result.manifest)?;
    Ok(result)
}

fn scan_online_location_by_value(location: OnlineLocation) -> Result<OnlineLocationScanResult, String> {
    let files = match location.source_type {
        OnlineLocationType::GenericJsonIndex => fetch_generic_json_index(&location)?,
        OnlineLocationType::GoogleDriveFolder => fetch_google_drive_folder(&location)?,
    };
    Ok(pair_files(location, files))
}

fn pair_files(location: OnlineLocation, files: Vec<OnlineFileRef>) -> OnlineLocationScanResult {
    let mut mcdfs: BTreeMap<String, OnlineFileRef> = BTreeMap::new();
    let mut images: BTreeMap<String, OnlineFileRef> = BTreeMap::new();
    let mut warnings = Vec::new();

    for file in files {
        let lower = file.name.to_ascii_lowercase();
        if lower.ends_with(".mcdf") {
            mcdfs.insert(stem_key(&file.name), file);
        } else if is_supported_image(&lower) {
            images.insert(stem_key(&file.name), file);
        }
    }

    let mut entries = Vec::new();
    let mut orphan_mcdf_files = Vec::new();
    for (stem, mcdf) in mcdfs {
        let image = images.remove(&stem);
        if let Some(image) = image {
            entries.push(OnlineLibraryEntry {
                source_id: location.id.clone(),
                source_name: location.name.clone(),
                provider: provider_name(&location.source_type).to_string(),
                name: display_name_from_stem(&stem),
                mcdf_file_name: mcdf.name,
                mcdf_url: mcdf.url,
                image_file_name: Some(image.name),
                image_url: Some(image.url),
                can_prepare_for_central: true,
            });
        } else {
            orphan_mcdf_files.push(mcdf);
        }
    }

    if !orphan_mcdf_files.is_empty() {
        warnings.push("Some MCDF files have no image with the same base name".to_string());
    }
    if !images.is_empty() {
        warnings.push("Some image files have no MCDF with the same base name".to_string());
    }

    OnlineLocationScanResult {
        source: location,
        entries,
        orphan_mcdf_files,
        orphan_image_files: images.into_values().collect(),
        warnings,
    }
}

fn fetch_generic_json_index(location: &OnlineLocation) -> Result<Vec<OnlineFileRef>, String> {
    let response = reqwest::blocking::get(&location.url).map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Failed to fetch JSON index: HTTP {}", response.status()));
    }
    let value: Value = response.json().map_err(|e| e.to_string())?;
    parse_generic_file_index(value)
}

fn parse_generic_file_index(value: Value) -> Result<Vec<OnlineFileRef>, String> {
    let array = if let Some(files) = value.get("files").and_then(|v| v.as_array()) {
        files.clone()
    } else if let Some(entries) = value.get("entries").and_then(|v| v.as_array()) {
        entries.clone()
    } else if let Some(array) = value.as_array() {
        array.clone()
    } else {
        return Err("JSON index must be an array, or an object with files[] or entries[]".to_string());
    };

    let mut files = Vec::new();
    for item in array {
        let name = item
            .get("name")
            .or_else(|| item.get("filename"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let url = item
            .get("url")
            .or_else(|| item.get("download_url"))
            .or_else(|| item.get("mcdf_url"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if !name.is_empty() && !url.is_empty() {
            files.push(OnlineFileRef { name, url });
        }
    }
    Ok(files)
}

fn fetch_google_drive_folder(location: &OnlineLocation) -> Result<Vec<OnlineFileRef>, String> {
    let folder_id = google_drive_folder_id(&location.url)
        .ok_or_else(|| "Could not determine Google Drive folder ID from URL".to_string())?;
    let key = location
        .google_api_key
        .clone()
        .or_else(|| std::env::var("GOOGLE_DRIVE_API_KEY").ok())
        .ok_or_else(|| "Google Drive folder scanning requires a Google Drive API key for serverless listing".to_string())?;

    let query = format!("'{}' in parents and trashed = false", folder_id);
    let url = format!(
        "https://www.googleapis.com/drive/v3/files?q={}&fields=files(id,name,mimeType,size)&key={}",
        simple_url_encode(&query),
        simple_url_encode(&key)
    );
    let response = reqwest::blocking::get(url).map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Failed to list Google Drive folder: HTTP {}", response.status()));
    }
    let value: Value = response.json().map_err(|e| e.to_string())?;
    let files = value
        .get("files")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Google Drive response did not contain files[]".to_string())?;

    let mut refs = Vec::new();
    for file in files {
        let id = file.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let name = file.get("name").and_then(|v| v.as_str()).unwrap_or_default();
        if !id.is_empty() && !name.is_empty() {
            refs.push(OnlineFileRef {
                name: name.to_string(),
                url: format!("https://www.googleapis.com/drive/v3/files/{}?alt=media&key={}", simple_url_encode(id), simple_url_encode(&key)),
            });
        }
    }
    Ok(refs)
}

fn google_drive_folder_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('/') && !trimmed.contains('?') {
        return Some(trimmed.to_string());
    }
    if let Some(pos) = trimmed.find("/folders/") {
        let rest = &trimmed[pos + "/folders/".len()..];
        let id = rest.split(['?', '/', '&']).next().unwrap_or_default();
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    None
}

fn stem_key(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((stem, _)) => stem.trim().to_ascii_lowercase(),
        None => base.trim().to_ascii_lowercase(),
    }
}

fn display_name_from_stem(stem: &str) -> String {
    stem.replace(['_', '-'], " ")
        .split_whitespace()
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_supported_image(lower_name: &str) -> bool {
    lower_name.ends_with(".png")
        || lower_name.ends_with(".jpg")
        || lower_name.ends_with(".jpeg")
        || lower_name.ends_with(".webp")
}

fn provider_name(source_type: &OnlineLocationType) -> &'static str {
    match source_type {
        OnlineLocationType::GenericJsonIndex => "Generic JSON index",
        OnlineLocationType::GoogleDriveFolder => "Google Drive",
    }
}

fn filename_from_url(url: &str) -> Option<String> {
    let without_query = url.split('?').next().unwrap_or(url);
    let name = without_query.rsplit('/').next()?.trim();
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".mcdf") {
        None
    } else {
        Some(name.to_string())
    }
}

fn simple_url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn locations_path() -> Result<PathBuf, String> {
    Ok(local_cache::app_home()?.join("online-locations.json"))
}

fn write_locations(locations: &[OnlineLocation]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(locations).map_err(|e| e.to_string())?;
    fs::write(locations_path()?, bytes).map_err(|e| e.to_string())
}

fn online_imports_dir() -> Result<PathBuf, String> {
    let path = local_cache::app_home()?.join("online-imports");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_mcdf_and_image_by_stem() {
        let location = OnlineLocation {
            id: "loc_test".to_string(),
            name: "Test".to_string(),
            source_type: OnlineLocationType::GenericJsonIndex,
            url: "https://example.invalid/index.json".to_string(),
            google_api_key: None,
            enabled: true,
        };
        let result = pair_files(location, vec![
            OnlineFileRef { name: "A Cool Look.mcdf".to_string(), url: "https://example.invalid/a.mcdf".to_string() },
            OnlineFileRef { name: "A Cool Look.png".to_string(), url: "https://example.invalid/a.png".to_string() },
        ]);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].name, "A Cool Look");
    }

    #[test]
    fn extracts_google_drive_folder_id() {
        assert_eq!(
            google_drive_folder_id("https://drive.google.com/drive/folders/abc123?usp=sharing"),
            Some("abc123".to_string())
        );
        assert_eq!(google_drive_folder_id("abc123"), Some("abc123".to_string()));
    }
}

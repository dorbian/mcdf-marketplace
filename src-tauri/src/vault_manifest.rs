use crate::local_cache;
use crate::mcdf::MCDFParser;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const DEFAULT_CHUNK_SIZE: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultManifest {
    pub schema_version: u32,
    pub archive_id: String,
    pub title: String,
    pub description: String,
    pub original_filename: String,
    pub mcdf_hash_blake3: String,
    pub mcdf_size: u64,
    pub chunk_size: u64,
    pub chunks: Vec<VaultChunk>,
    #[serde(default)]
    pub mcdf_files: Vec<ManifestMcdfFile>,
    #[serde(default)]
    pub parity: Vec<VaultChunk>,
    #[serde(default)]
    pub source: ManifestSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ManifestSource {
    #[serde(default)]
    pub server_base_url: Option<String>,
    #[serde(default)]
    pub index_url: Option<String>,
    #[serde(default)]
    pub online_source_url: Option<String>,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultChunk {
    pub index: u32,
    pub hash_blake3: String,
    pub size: u64,
    pub offset: u64,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub attachment_url: Option<String>,
    #[serde(default)]
    pub discord_channel_id: Option<String>,
    #[serde(default)]
    pub discord_message_id: Option<String>,
    #[serde(default)]
    pub discord_attachment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestMcdfFile {
    pub index: u32,
    pub game_paths: Vec<String>,
    pub length: u64,
    pub mcdf_hash: String,
    pub payload_offset: u64,
    pub payload_blake3: String,
    #[serde(default)]
    pub central_status: ComponentCentralStatus,
    #[serde(default)]
    pub central_blob_url: Option<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ComponentCentralStatus {
    #[default]
    Unknown,
    Present,
    Missing,
    Queued,
    ExternalOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestStatus {
    pub archive_id: String,
    pub chunks: Vec<ChunkAvailability>,
    pub files: Vec<ComponentAvailability>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkAvailability {
    pub index: u32,
    pub hash_blake3: String,
    pub size: u64,
    pub cached: bool,
    pub online_available: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentAvailability {
    pub index: u32,
    pub game_paths: Vec<String>,
    pub length: u64,
    pub mcdf_hash: String,
    pub payload_blake3: String,
    pub central_status: ComponentCentralStatus,
    pub online_status: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestBuildResult {
    pub manifest: VaultManifest,
    pub manifest_path: String,
    pub cache_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebuildResult {
    pub output_path: String,
    pub bytes_written: u64,
    pub chunks_used: usize,
    pub downloaded_chunks: usize,
    pub verified_blake3: String,
}

pub fn create_local_manifest(
    input_path: &Path,
    title: Option<String>,
    description: Option<String>,
    chunk_size: Option<usize>,
) -> Result<ManifestBuildResult, String> {
    let chunk_size = chunk_size.unwrap_or(DEFAULT_CHUNK_SIZE).max(1024 * 1024);
    let metadata = fs::metadata(input_path).map_err(|e| e.to_string())?;
    let original_filename = input_path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("archive.mcdf")
        .to_string();

    // MCDF is a compiled package. Parse it before chunking so manifests carry
    // the individual internal component/file list and their payload hashes.
    let mut parse_file = File::open(input_path).map_err(|e| e.to_string())?;
    let (mcdf_metadata, binary_payload) = MCDFParser::parse(&mut parse_file)
        .map_err(|e| format!("Failed to extract MCDF before manifest creation: {e}"))?;
    let extracted_files = MCDFParser::extract_file_infos(&mcdf_metadata, &binary_payload)
        .map_err(|e| format!("Failed to inspect MCDF internal files: {e}"))?;
    let mcdf_files: Vec<ManifestMcdfFile> = extracted_files
        .into_iter()
        .map(|file| ManifestMcdfFile {
            index: file.index as u32,
            game_paths: file.game_paths,
            length: file.length as u64,
            mcdf_hash: file.hash,
            payload_offset: file.offset,
            payload_blake3: file.blake3,
            central_status: ComponentCentralStatus::Unknown,
            central_blob_url: None,
            notes: Vec::new(),
        })
        .collect();

    // Re-open the original MCDF bytes for chunking. The chunks represent the
    // compiled MCDF artifact; the mcdf_files section above represents the files
    // inside that compiled artifact.
    let mut file = File::open(input_path).map_err(|e| e.to_string())?;
    let mut full_hasher = blake3::Hasher::new();
    let mut chunks = Vec::new();
    let mut buffer = vec![0u8; chunk_size];
    let mut offset = 0u64;
    let mut index = 0u32;

    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }

        let bytes = &buffer[..read];
        full_hasher.update(bytes);
        let hash = blake3::hash(bytes).to_hex().to_string();
        let blob_path = local_cache::blob_path(&hash)?;

        if !blob_path.exists() {
            let mut blob = File::create(&blob_path).map_err(|e| e.to_string())?;
            blob.write_all(bytes).map_err(|e| e.to_string())?;
            blob.flush().map_err(|e| e.to_string())?;
        }

        chunks.push(VaultChunk {
            index,
            hash_blake3: hash,
            size: read as u64,
            offset,
            local_path: Some(blob_path.to_string_lossy().to_string()),
            attachment_url: None,
            discord_channel_id: None,
            discord_message_id: None,
            discord_attachment_id: None,
        });

        offset += read as u64;
        index += 1;
    }

    let mcdf_hash_blake3 = full_hasher.finalize().to_hex().to_string();
    let archive_id = format!("mcdf_{}", &mcdf_hash_blake3[..16]);
    let manifest = VaultManifest {
        schema_version: 1,
        archive_id: archive_id.clone(),
        title: title.unwrap_or_else(|| original_filename.clone()),
        description: description.unwrap_or_default(),
        original_filename,
        mcdf_hash_blake3,
        mcdf_size: metadata.len(),
        chunk_size: chunk_size as u64,
        chunks,
        mcdf_files,
        parity: Vec::new(),
        source: ManifestSource::default(),
    };

    let manifest_path = local_cache::manifest_dir()?.join(format!("{archive_id}.json"));
    write_manifest(&manifest_path, &manifest)?;

    Ok(ManifestBuildResult {
        manifest,
        manifest_path: manifest_path.to_string_lossy().to_string(),
        cache_dir: local_cache::app_home()?.to_string_lossy().to_string(),
    })
}

pub fn read_manifest(path: &Path) -> Result<VaultManifest, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn write_manifest(path: &Path, manifest: &VaultManifest) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())
}

pub fn rebuild_from_manifest(
    manifest_path: &Path,
    output_path: Option<PathBuf>,
) -> Result<RebuildResult, String> {
    let manifest = read_manifest(manifest_path)?;
    let output_path = output_path.unwrap_or_else(|| {
        local_cache::downloads_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(&manifest.original_filename)
    });

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut output = File::create(&output_path).map_err(|e| e.to_string())?;
    let mut full_hasher = blake3::Hasher::new();
    let mut bytes_written = 0u64;
    let mut downloaded_chunks = 0usize;

    let mut chunks = manifest.chunks.clone();
    chunks.sort_by_key(|chunk| chunk.index);

    for chunk in chunks.iter() {
        let (bytes, downloaded) = load_or_download_chunk(chunk)?;
        if bytes.len() as u64 != chunk.size {
            return Err(format!(
                "Chunk {} size mismatch: expected {}, got {}",
                chunk.index,
                chunk.size,
                bytes.len()
            ));
        }
        let actual_hash = blake3::hash(&bytes).to_hex().to_string();
        if actual_hash != chunk.hash_blake3 {
            return Err(format!(
                "Chunk {} hash mismatch: expected {}, got {}",
                chunk.index, chunk.hash_blake3, actual_hash
            ));
        }
        output.write_all(&bytes).map_err(|e| e.to_string())?;
        full_hasher.update(&bytes);
        bytes_written += bytes.len() as u64;
        if downloaded {
            downloaded_chunks += 1;
        }
    }

    output.flush().map_err(|e| e.to_string())?;
    let verified_blake3 = full_hasher.finalize().to_hex().to_string();
    if verified_blake3 != manifest.mcdf_hash_blake3 {
        return Err(format!(
            "Rebuilt MCDF hash mismatch: expected {}, got {}",
            manifest.mcdf_hash_blake3, verified_blake3
        ));
    }

    Ok(RebuildResult {
        output_path: output_path.to_string_lossy().to_string(),
        bytes_written,
        chunks_used: manifest.chunks.len(),
        downloaded_chunks,
        verified_blake3,
    })
}

pub fn inspect_manifest_status(manifest_path: &Path) -> Result<ManifestStatus, String> {
    let manifest = read_manifest(manifest_path)?;
    let mut chunks = manifest.chunks.clone();
    chunks.sort_by_key(|chunk| chunk.index);

    let chunk_statuses: Vec<ChunkAvailability> = chunks
        .iter()
        .map(|chunk| {
            let cached = local_cache::blob_path(&chunk.hash_blake3)
                .map(|path| path.exists())
                .unwrap_or(false)
                || chunk
                    .local_path
                    .as_ref()
                    .map(|path| PathBuf::from(path).exists())
                    .unwrap_or(false);
            let online_available = chunk.attachment_url.as_ref().map(|url| !url.trim().is_empty()).unwrap_or(false);
            let status = if cached {
                "cached"
            } else if online_available {
                "online_available"
            } else {
                "missing"
            };
            ChunkAvailability {
                index: chunk.index,
                hash_blake3: chunk.hash_blake3.clone(),
                size: chunk.size,
                cached,
                online_available,
                status: status.to_string(),
            }
        })
        .collect();

    let all_chunks_cached = !chunk_statuses.is_empty() && chunk_statuses.iter().all(|chunk| chunk.cached);
    let all_chunks_available = !chunk_statuses.is_empty()
        && chunk_statuses.iter().all(|chunk| chunk.cached || chunk.online_available);
    let external_package_available = manifest
        .source
        .online_source_url
        .as_ref()
        .map(|url| !url.trim().is_empty())
        .unwrap_or(false);

    let files = manifest
        .mcdf_files
        .iter()
        .map(|file| {
            let mut notes = file.notes.clone();
            let online_status = match file.central_status {
                ComponentCentralStatus::Present => "central_present",
                ComponentCentralStatus::Missing => "central_missing",
                ComponentCentralStatus::Queued => "central_queued",
                ComponentCentralStatus::ExternalOnly => "external_only",
                ComponentCentralStatus::Unknown => {
                    if file.central_blob_url.as_ref().map(|url| !url.trim().is_empty()).unwrap_or(false) {
                        "central_present"
                    } else if all_chunks_cached {
                        "local_cached"
                    } else if all_chunks_available {
                        "package_chunks_available"
                    } else if external_package_available {
                        "external_package_available"
                    } else {
                        "unknown_or_missing"
                    }
                }
            };
            if file.central_status == ComponentCentralStatus::Unknown && file.central_blob_url.is_none() {
                notes.push("No central component status has been checked yet.".to_string());
            }
            ComponentAvailability {
                index: file.index,
                game_paths: file.game_paths.clone(),
                length: file.length,
                mcdf_hash: file.mcdf_hash.clone(),
                payload_blake3: file.payload_blake3.clone(),
                central_status: file.central_status.clone(),
                online_status: online_status.to_string(),
                notes,
            }
        })
        .collect();

    Ok(ManifestStatus {
        archive_id: manifest.archive_id,
        chunks: chunk_statuses,
        files,
    })
}

fn load_or_download_chunk(chunk: &VaultChunk) -> Result<(Vec<u8>, bool), String> {
    let cache_path = local_cache::blob_path(&chunk.hash_blake3)?;
    if cache_path.exists() {
        return fs::read(cache_path).map(|bytes| (bytes, false)).map_err(|e| e.to_string());
    }

    if let Some(local_path) = &chunk.local_path {
        let path = PathBuf::from(local_path);
        if path.exists() {
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            fs::write(&cache_path, &bytes).map_err(|e| e.to_string())?;
            return Ok((bytes, false));
        }
    }

    let url = chunk
        .attachment_url
        .as_ref()
        .ok_or_else(|| format!("Chunk {} is missing locally and has no attachment_url", chunk.index))?;

    let response = reqwest::blocking::get(url).map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Failed to download chunk {}: HTTP {}", chunk.index, response.status()));
    }

    let bytes = response.bytes().map_err(|e| e.to_string())?.to_vec();
    fs::write(&cache_path, &bytes).map_err(|e| e.to_string())?;
    Ok((bytes, true))
}

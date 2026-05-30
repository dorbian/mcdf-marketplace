//! Central MCDF registry server.
//!
//! The desktop app can run against this server locally during development, or against
//! a hosted instance such as `https://mcdf.thebigtree.life` in production. The server
//! accepts full MCDF uploads, extracts every internal file, stores each extracted full
//! file as an addressable artifact, and writes a rebuild manifest that can recreate the
//! package without keeping the original MCDF container as the archival source of truth.

use crate::mcdf::{MCDFParser, MareCharaFileData};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufReader, Write};
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tokio::net::TcpListener;

const FILE_ARTIFACT_TYPE: &str = "application/vnd.mcdf.file.v1";
const MANIFEST_ARTIFACT_TYPE: &str = "application/vnd.mcdf.rebuild-manifest.v1+json";

#[derive(Debug, Clone, Copy, ValueEnum, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegistryStorageMode {
    /// Store artifacts as local files only. This is the default for local end-to-end tests.
    Local,
    /// Store local files and print the GHCR references that would be used.
    GhcrDryRun,
    /// Store local files and push artifacts to GHCR through an installed `oras` binary.
    GhcrOras,
}

#[derive(Debug, Clone, Parser)]
#[command(name = "mcdf-registry-server")]
#[command(about = "Central MCDF file artifact registry and rebuild server")]
pub struct ServerArgs {
    /// Bind address. Use 0.0.0.0:8080 behind Traefik/Caddy/nginx, or 127.0.0.1:8080 locally.
    #[arg(long, env = "MCDF_SERVER_BIND", default_value = "127.0.0.1:8080")]
    pub bind: SocketAddr,

    /// Public URL used in manifests/status responses.
    #[arg(long, env = "MCDF_PUBLIC_URL", default_value = "http://127.0.0.1:8080")]
    pub public_url: String,

    /// Persistent data directory for uploaded manifests, extracted file artifacts, and caches.
    #[arg(long, env = "MCDF_DATA_DIR", default_value = "./mcdf-registry-data")]
    pub data_dir: PathBuf,

    /// Optional bearer token required for upload/admin calls. Leave empty for local-only testing.
    #[arg(long, env = "MCDF_SERVER_AUTH_TOKEN")]
    pub server_auth_token: Option<String>,

    /// Storage mode. Use local for tests, ghcr-oras when GHCR publishing should be active.
    #[arg(long, env = "MCDF_STORAGE_MODE", default_value = "local")]
    pub storage_mode: RegistryStorageMode,

    /// GHCR owner/organization, for example thebigtree or dorbian.
    #[arg(long, env = "MCDF_GHCR_OWNER")]
    pub ghcr_owner: Option<String>,

    /// GHCR package prefix. Files become ghcr.io/<owner>/<prefix>-files:<hash>.
    #[arg(long, env = "MCDF_GHCR_PACKAGE_PREFIX", default_value = "mcdf")]
    pub ghcr_package_prefix: String,

    /// GitHub/GHCR username used for `oras login ghcr.io` when ghcr-oras is enabled.
    #[arg(long, env = "MCDF_GHCR_USERNAME")]
    pub ghcr_username: Option<String>,

    /// GitHub token/PAT with package write permissions. Never put this in the desktop client.
    #[arg(long, env = "MCDF_GHCR_TOKEN")]
    pub ghcr_token: Option<String>,

    /// Path to the ORAS binary used for GHCR pushes in ghcr-oras mode.
    #[arg(long, env = "MCDF_ORAS_BIN", default_value = "oras")]
    pub oras_bin: String,
}

#[derive(Debug, Clone)]
struct ServerState {
    args: Arc<ServerArgs>,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub public_url: String,
    pub storage_mode: RegistryStorageMode,
    pub ghcr_configured: bool,
    pub uploads_require_auth: bool,
}

#[derive(Debug, Deserialize)]
pub struct ProbeRequest {
    pub package_hash_blake3: String,
}

#[derive(Debug, Serialize)]
pub struct ProbeResponse {
    pub known: bool,
    pub package_hash_blake3: String,
    pub manifest_url: Option<String>,
    pub file_count: Option<usize>,
    pub archived_file_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryArtifactRef {
    pub storage_mode: RegistryStorageMode,
    pub local_path: String,
    pub oci_ref: Option<String>,
    pub pushed: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryFileRecord {
    pub index: usize,
    pub game_paths: Vec<String>,
    pub length: u32,
    pub mcdf_hash: String,
    pub payload_offset: u64,
    pub payload_blake3: String,
    pub media_type: String,
    pub artifact: RegistryArtifactRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryPackageManifest {
    pub schema_version: u32,
    pub created_at: DateTime<Utc>,
    pub package_hash_blake3: String,
    pub package_size: u64,
    pub canonical_rebuild_hash_blake3: String,
    pub original_filename: String,
    pub description: String,
    pub metadata: MareCharaFileData,
    pub files: Vec<RegistryFileRecord>,
    pub rebuild: RebuildMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebuildMetadata {
    pub strategy: String,
    pub manifest_artifact: Option<RegistryArtifactRef>,
    pub source_of_truth: String,
}

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub package_hash_blake3: String,
    pub package_size: u64,
    pub file_count: usize,
    pub archived_file_count: usize,
    pub deduplicated_file_count: usize,
    pub manifest_url: String,
    pub download_url: String,
    pub storage_mode: RegistryStorageMode,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RegistryStatusResponse {
    pub storage_mode: RegistryStorageMode,
    pub data_dir: String,
    pub package_count: usize,
    pub file_artifact_count: usize,
    pub ghcr_owner: Option<String>,
    pub ghcr_package_prefix: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: message.into() }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self { status: StatusCode::UNAUTHORIZED, message: message.into() }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: message.into() }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: message.into() }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorBody { error: self.message })).into_response()
    }
}

pub fn run_from_cli() -> Result<(), String> {
    let args = ServerArgs::parse();
    fs::create_dir_all(args.data_dir.join("files")).map_err(|error| error.to_string())?;
    fs::create_dir_all(args.data_dir.join("manifests")).map_err(|error| error.to_string())?;
    fs::create_dir_all(args.data_dir.join("rebuilds")).map_err(|error| error.to_string())?;

    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    runtime.block_on(run_server(args))
}

pub async fn run_server(args: ServerArgs) -> Result<(), String> {
    let bind = args.bind;
    let state = ServerState { args: Arc::new(args) };
    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/registry/status", get(registry_status))
        .route("/v1/packages/probe", post(probe_package))
        .route("/v1/packages/upload", post(upload_package))
        .route("/v1/packages/:package_hash/manifest", get(get_manifest))
        .route("/v1/packages/:package_hash/download", get(download_rebuilt_package))
        .with_state(state);

    let listener = TcpListener::bind(bind).await.map_err(|error| error.to_string())?;
    println!("mcdf-registry-server listening on http://{bind}");
    axum::serve(listener, app).await.map_err(|error| error.to_string())
}

async fn health(State(state): State<ServerState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy",
        public_url: state.args.public_url.clone(),
        storage_mode: state.args.storage_mode,
        ghcr_configured: state.args.ghcr_owner.is_some() && state.args.ghcr_token.is_some(),
        uploads_require_auth: state.args.server_auth_token.is_some(),
    })
}

async fn registry_status(State(state): State<ServerState>) -> Result<Json<RegistryStatusResponse>, AppError> {
    let package_count = count_json_files(&state.args.data_dir.join("manifests"))?;
    let file_artifact_count = count_files_with_extension(&state.args.data_dir.join("files"), "blob")?;
    Ok(Json(RegistryStatusResponse {
        storage_mode: state.args.storage_mode,
        data_dir: state.args.data_dir.to_string_lossy().to_string(),
        package_count,
        file_artifact_count,
        ghcr_owner: state.args.ghcr_owner.clone(),
        ghcr_package_prefix: state.args.ghcr_package_prefix.clone(),
    }))
}

async fn probe_package(
    State(state): State<ServerState>,
    Json(request): Json<ProbeRequest>,
) -> Result<Json<ProbeResponse>, AppError> {
    let manifest_path = manifest_path(&state.args.data_dir, &request.package_hash_blake3);
    if !manifest_path.exists() {
        return Ok(Json(ProbeResponse {
            known: false,
            package_hash_blake3: request.package_hash_blake3,
            manifest_url: None,
            file_count: None,
            archived_file_count: None,
        }));
    }

    let manifest = read_manifest_file(&manifest_path)?;
    Ok(Json(ProbeResponse {
        known: true,
        package_hash_blake3: manifest.package_hash_blake3.clone(),
        manifest_url: Some(format!("{}/v1/packages/{}/manifest", state.args.public_url, manifest.package_hash_blake3)),
        file_count: Some(manifest.files.len()),
        archived_file_count: Some(manifest.files.iter().filter(|file| file.artifact.local_path.len() > 0).count()),
    }))
}

async fn upload_package(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<UploadResponse>, AppError> {
    require_upload_auth(&state.args, &headers)?;
    if body.is_empty() {
        return Err(AppError::bad_request("empty upload body"));
    }

    let original_filename = headers
        .get("x-mcdf-filename")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("upload.mcdf")
        .to_string();

    let package_hash = blake3::hash(&body).to_hex().to_string();
    let package_size = body.len() as u64;
    let manifest_file = manifest_path(&state.args.data_dir, &package_hash);

    if manifest_file.exists() {
        let existing = read_manifest_file(&manifest_file)?;
        return Ok(Json(UploadResponse {
            package_hash_blake3: existing.package_hash_blake3.clone(),
            package_size: existing.package_size,
            file_count: existing.files.len(),
            archived_file_count: existing.files.len(),
            deduplicated_file_count: existing.files.len(),
            manifest_url: format!("{}/v1/packages/{}/manifest", state.args.public_url, existing.package_hash_blake3),
            download_url: format!("{}/v1/packages/{}/download", state.args.public_url, existing.package_hash_blake3),
            storage_mode: state.args.storage_mode,
            notes: vec!["Package already known; existing manifest reused.".to_string()],
        }));
    }

    let mut reader = BufReader::new(body.as_ref());
    let (metadata, binary_payload) = MCDFParser::parse(&mut reader)
        .map_err(|error| AppError::bad_request(format!("Failed to parse MCDF: {error}")))?;
    let payloads = MCDFParser::extract_file_payloads(&metadata, &binary_payload)
        .map_err(|error| AppError::bad_request(format!("Failed to extract MCDF files: {error}")))?;

    let mut deduplicated_file_count = 0usize;
    let mut file_records = Vec::new();

    for payload in &payloads {
        let file_path = file_artifact_path(&state.args.data_dir, &payload.info.blake3);
        let already_present = file_path.exists();
        if already_present {
            deduplicated_file_count += 1;
        } else {
            atomic_write(&file_path, &payload.bytes)?;
        }

        let artifact = publish_artifact(
            &state.args,
            "files",
            &payload.info.blake3,
            FILE_ARTIFACT_TYPE,
            &file_path,
        )?;

        file_records.push(RegistryFileRecord {
            index: payload.info.index,
            game_paths: payload.info.game_paths.clone(),
            length: payload.info.length,
            mcdf_hash: payload.info.hash.clone(),
            payload_offset: payload.info.offset,
            payload_blake3: payload.info.blake3.clone(),
            media_type: guess_media_type_from_paths(&payload.info.game_paths),
            artifact,
        });
    }

    let rebuild_slices: Vec<&[u8]> = payloads.iter().map(|payload| payload.bytes.as_slice()).collect();
    let mut canonical_rebuild = Vec::new();
    MCDFParser::rebuild(&mut canonical_rebuild, &metadata, &rebuild_slices)
        .map_err(|error| AppError::internal(format!("failed to compute canonical rebuild hash: {error}")))?;
    let canonical_rebuild_hash = blake3::hash(&canonical_rebuild).to_hex().to_string();

    let manifest = RegistryPackageManifest {
        schema_version: 1,
        created_at: Utc::now(),
        package_hash_blake3: package_hash.clone(),
        package_size,
        canonical_rebuild_hash_blake3: canonical_rebuild_hash,
        original_filename,
        description: metadata.description.clone(),
        metadata,
        files: file_records,
        rebuild: RebuildMetadata {
            strategy: "rebuild_from_extracted_full_files".to_string(),
            manifest_artifact: None,
            source_of_truth: "extracted_full_files".to_string(),
        },
    };

    write_manifest(&manifest_file, &manifest)?;
    let manifest_artifact = publish_artifact(
        &state.args,
        "manifests",
        &package_hash,
        MANIFEST_ARTIFACT_TYPE,
        &manifest_file,
    )?;

    let mut manifest = read_manifest_file(&manifest_file)?;
    manifest.rebuild.manifest_artifact = Some(manifest_artifact);
    write_manifest(&manifest_file, &manifest)?;

    Ok(Json(UploadResponse {
        package_hash_blake3: package_hash.clone(),
        package_size,
        file_count: manifest.files.len(),
        archived_file_count: manifest.files.len(),
        deduplicated_file_count,
        manifest_url: format!("{}/v1/packages/{package_hash}/manifest", state.args.public_url),
        download_url: format!("{}/v1/packages/{package_hash}/download", state.args.public_url),
        storage_mode: state.args.storage_mode,
        notes: vec!["Original MCDF was used as temporary input only; durable archive is the extracted full-file set plus rebuild manifest.".to_string()],
    }))
}

async fn get_manifest(
    State(state): State<ServerState>,
    Path(package_hash): Path<String>,
) -> Result<Json<RegistryPackageManifest>, AppError> {
    let path = manifest_path(&state.args.data_dir, &package_hash);
    if !path.exists() {
        return Err(AppError::not_found("package manifest not found"));
    }
    Ok(Json(read_manifest_file(&path)?))
}

async fn download_rebuilt_package(
    State(state): State<ServerState>,
    Path(package_hash): Path<String>,
) -> Result<Response, AppError> {
    let path = manifest_path(&state.args.data_dir, &package_hash);
    if !path.exists() {
        return Err(AppError::not_found("package manifest not found"));
    }
    let manifest = read_manifest_file(&path)?;
    let mut file_bytes = Vec::with_capacity(manifest.files.len());
    for file in &manifest.files {
        let bytes = fs::read(file_artifact_path(&state.args.data_dir, &file.payload_blake3))
            .map_err(|error| AppError::internal(format!("failed to read archived file {}: {error}", file.payload_blake3)))?;
        let actual_hash = blake3::hash(&bytes).to_hex().to_string();
        if actual_hash != file.payload_blake3 {
            return Err(AppError::internal(format!("archived file hash mismatch for {}", file.payload_blake3)));
        }
        file_bytes.push(bytes);
    }

    let slices: Vec<&[u8]> = file_bytes.iter().map(Vec::as_slice).collect();
    let mut rebuilt = Vec::new();
    MCDFParser::rebuild(&mut rebuilt, &manifest.metadata, &slices)
        .map_err(|error| AppError::internal(format!("failed to rebuild MCDF: {error}")))?;

    let rebuilt_hash = blake3::hash(&rebuilt).to_hex().to_string();
    if rebuilt_hash != manifest.canonical_rebuild_hash_blake3 {
        return Err(AppError::internal(format!(
            "rebuilt package hash mismatch: expected canonical {}, got {}",
            manifest.canonical_rebuild_hash_blake3, rebuilt_hash
        )));
    }

    let filename = safe_download_name(&manifest.original_filename);
    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    response_headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .map_err(|error| AppError::internal(error.to_string()))?,
    );
    response_headers.insert(
        "x-mcdf-package-blake3",
        HeaderValue::from_str(&manifest.package_hash_blake3)
            .map_err(|error| AppError::internal(error.to_string()))?,
    );
    Ok((response_headers, rebuilt).into_response())
}

fn require_upload_auth(args: &ServerArgs, headers: &HeaderMap) -> Result<(), AppError> {
    let Some(expected) = args.server_auth_token.as_ref() else {
        return Ok(());
    };
    let actual = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if actual == Some(expected.as_str()) {
        Ok(())
    } else {
        Err(AppError::unauthorized("missing or invalid upload bearer token"))
    }
}

fn publish_artifact(
    args: &ServerArgs,
    class: &str,
    hash: &str,
    artifact_type: &str,
    local_path: &FsPath,
) -> Result<RegistryArtifactRef, AppError> {
    let oci_ref = args.ghcr_owner.as_ref().map(|owner| {
        format!("ghcr.io/{owner}/{}-{class}:{}", args.ghcr_package_prefix, hash)
    });
    let mut notes = Vec::new();
    let mut pushed = false;

    match args.storage_mode {
        RegistryStorageMode::Local => notes.push("Stored in local artifact directory only.".to_string()),
        RegistryStorageMode::GhcrDryRun => notes.push("GHCR dry-run mode; artifact was not pushed.".to_string()),
        RegistryStorageMode::GhcrOras => {
            let Some(ref_name) = oci_ref.as_ref() else {
                return Err(AppError::internal("ghcr-oras mode requires --ghcr-owner"));
            };
            push_with_oras(args, ref_name, artifact_type, local_path)?;
            pushed = true;
            notes.push("Pushed to GHCR through ORAS.".to_string());
        }
    }

    Ok(RegistryArtifactRef {
        storage_mode: args.storage_mode,
        local_path: local_path.to_string_lossy().to_string(),
        oci_ref,
        pushed,
        notes,
    })
}

fn push_with_oras(args: &ServerArgs, ref_name: &str, artifact_type: &str, local_path: &FsPath) -> Result<(), AppError> {
    let username = args.ghcr_username.as_ref().ok_or_else(|| AppError::internal("ghcr-oras mode requires --ghcr-username"))?;
    let token = args.ghcr_token.as_ref().ok_or_else(|| AppError::internal("ghcr-oras mode requires --ghcr-token"))?;

    let login_status = Command::new(&args.oras_bin)
        .arg("login")
        .arg("ghcr.io")
        .arg("-u")
        .arg(username)
        .arg("-p")
        .arg(token)
        .status()
        .map_err(|error| AppError::internal(format!("failed to run oras login: {error}")))?;
    if !login_status.success() {
        return Err(AppError::internal("oras login ghcr.io failed"));
    }

    let file_name = local_path.file_name().and_then(|value| value.to_str()).unwrap_or("artifact.bin");
    let layer = format!("{}:{artifact_type}", local_path.to_string_lossy());
    let push_status = Command::new(&args.oras_bin)
        .arg("push")
        .arg(ref_name)
        .arg("--artifact-type")
        .arg(artifact_type)
        .arg("--annotation")
        .arg(format!("org.opencontainers.image.title={file_name}"))
        .arg(layer)
        .status()
        .map_err(|error| AppError::internal(format!("failed to run oras push: {error}")))?;
    if !push_status.success() {
        return Err(AppError::internal(format!("oras push failed for {ref_name}")));
    }
    Ok(())
}

fn manifest_path(data_dir: &FsPath, package_hash: &str) -> PathBuf {
    data_dir.join("manifests").join(format!("{package_hash}.json"))
}

fn file_artifact_path(data_dir: &FsPath, file_hash: &str) -> PathBuf {
    data_dir.join("files").join(format!("{file_hash}.blob"))
}

fn read_manifest_file(path: &FsPath) -> Result<RegistryPackageManifest, AppError> {
    let bytes = fs::read(path).map_err(|error| AppError::internal(error.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|error| AppError::internal(error.to_string()))
}

fn write_manifest(path: &FsPath, manifest: &RegistryPackageManifest) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| AppError::internal(error.to_string()))?;
    atomic_write(path, &bytes)
}

fn atomic_write(path: &FsPath, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| AppError::internal(error.to_string()))?;
    }
    let tmp = path.with_extension("tmp");
    let mut file = File::create(&tmp).map_err(|error| AppError::internal(error.to_string()))?;
    file.write_all(bytes).map_err(|error| AppError::internal(error.to_string()))?;
    file.sync_all().map_err(|error| AppError::internal(error.to_string()))?;
    fs::rename(&tmp, path).map_err(|error| AppError::internal(error.to_string()))
}

fn count_json_files(path: &FsPath) -> Result<usize, AppError> {
    count_files_with_extension(path, "json")
}

fn count_files_with_extension(path: &FsPath, extension: &str) -> Result<usize, AppError> {
    if !path.exists() {
        return Ok(0);
    }
    let mut count = 0usize;
    for entry in fs::read_dir(path).map_err(|error| AppError::internal(error.to_string()))? {
        let entry = entry.map_err(|error| AppError::internal(error.to_string()))?;
        if entry.path().extension().and_then(|value| value.to_str()) == Some(extension) {
            count += 1;
        }
    }
    Ok(count)
}

fn guess_media_type_from_paths(paths: &[String]) -> String {
    let joined = paths.join(" ").to_lowercase();
    let by_extension: BTreeMap<&str, &str> = BTreeMap::from([
        (".mdl", "application/vnd.mcdf.model.v1"),
        (".mtrl", "application/vnd.mcdf.material.v1"),
        (".tex", "application/vnd.mcdf.texture.v1"),
        (".atex", "application/vnd.mcdf.texture.v1"),
        (".sklb", "application/vnd.mcdf.skeleton.v1"),
        (".pap", "application/vnd.mcdf.animation.v1"),
        (".tmb", "application/vnd.mcdf.animation.v1"),
    ]);
    for (extension, media_type) in by_extension {
        if joined.ends_with(extension) || joined.contains(extension) {
            return media_type.to_string();
        }
    }
    "application/vnd.mcdf.file.v1".to_string()
}

fn safe_download_name(original: &str) -> String {
    let mut name = original
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() || ['.', '-', '_'].contains(&character) { character } else { '_' })
        .collect::<String>();
    if !name.to_lowercase().ends_with(".mcdf") {
        name.push_str(".mcdf");
    }
    name
}

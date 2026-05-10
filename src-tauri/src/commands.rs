use crate::mcdf::{ExtractedFile, MCDFParser, MareCharaFileData};
use std::fs::File;
use std::io::BufReader;
use tauri::command;

#[command]
pub fn scan_mcdf(path: String) -> Result<MareCharaFileData, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);

    let (metadata, _binary_payload) =
        MCDFParser::parse(&mut reader).map_err(|e| format!("Failed to parse MCDF: {}", e))?;

    Ok(metadata)
}

#[command]
pub fn extract_mcdf(path: String) -> Result<Vec<ExtractedFile>, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);

    let (metadata, binary_payload) =
        MCDFParser::parse(&mut reader).map_err(|e| format!("Failed to parse MCDF: {}", e))?;

    let files = MCDFParser::extract_files(&metadata, &binary_payload);

    Ok(files)
}

#[command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
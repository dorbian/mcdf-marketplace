//! MCDF file parser and builder
//! MCDF = MareCharaDataFile (FFXIV character format)
//!
//! File format:
//!   4 bytes: "MCDF" magic
//!   1 byte: version (currently 1)
//!   4 bytes: JSON metadata length (little-endian int32)
//!   N bytes: UTF-8 JSON metadata
//!   Remaining: binary payload (files concatenated sequentially)

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileData {
    pub game_paths: Vec<String>,
    pub length: u32,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MareCharaFileData {
    pub description: String,
    #[serde(default)]
    pub glamourer_data: String,
    #[serde(default)]
    pub customize_plus_data: String,
    #[serde(default)]
    pub manipulation_data: String,
    pub files: Vec<FileData>,
    #[serde(default)]
    pub file_swaps: Vec<FileSwap>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSwap {
    pub game_paths: Vec<String>,
    pub file_swap_path: String,
}

#[derive(Debug)]
pub struct MCDFError {
    pub message: String,
}

impl std::fmt::Display for MCDFError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MCDFError: {}", self.message)
    }
}

impl std::error::Error for MCDFError {}

impl From<std::io::Error> for MCDFError {
    fn from(e: std::io::Error) -> Self {
        MCDFError {
            message: e.to_string(),
        }
    }
}

impl From<serde_json::Error> for MCDFError {
    fn from(e: serde_json::Error) -> Self {
        MCDFError {
            message: format!("JSON parse error: {}", e),
        }
    }
}

pub struct MCDFParser;

impl MCDFParser {
    /// Parse an MCDF file and return the metadata + binary data
    pub fn parse<R: Read>(reader: &mut R) -> Result<(MareCharaFileData, Vec<u8>), MCDFError> {
        // Read magic (4 bytes)
        let mut magic = [0u8; 4];
        let n = reader.read(&mut magic).map_err(|e| MCDFError { message: e.to_string() })?;
        if n < 4 {
            return Err(MCDFError { message: format!("File too small ({} bytes)", n) });
        }

        // Check for gzip magic (files may be gzipped)
        if magic == [0x1f, 0x8b, 0x08, 0x00] || magic == [0x1f, 0x8b, 0x08, 0x08] {
            return Err(MCDFError {
                message: "File appears to be gzip-compressed. MCDF files should be decompressed before opening.".to_string(),
            });
        }


        if &magic != b"MCDF" {
            return Err(MCDFError {
                message: format!(
                    "Invalid magic bytes: {:02x?}{:02x?}{:02x?}{:02x?} (expected 4d434446 'MCDF')",
                    magic[0], magic[1], magic[2], magic[3]
                ),
            });
        }

        // Read version (1 byte)
        let mut version = [0u8; 1];
        reader.read_exact(&mut version)?;
        if version[0] != 1 {
            return Err(MCDFError {
                message: format!("Unsupported version: {}", version[0]),
            });
        }

        // Read JSON length (4 bytes, little-endian)
        let mut json_len_bytes = [0u8; 4];
        reader.read_exact(&mut json_len_bytes)?;
        let json_len = u32::from_le_bytes(json_len_bytes) as usize;

        // Read JSON metadata
        let mut json_data = vec![0u8; json_len];
        reader.read_exact(&mut json_data)?;
        let metadata: MareCharaFileData = serde_json::from_slice(&json_data)?;

        // Read remaining binary payload
        let mut binary_payload = Vec::new();
        reader.read_to_end(&mut binary_payload)?;

        Ok((metadata, binary_payload))
    }

    /// Extract individual files from the binary payload
    pub fn extract_files(
        metadata: &MareCharaFileData,
        binary_payload: &[u8],
    ) -> Vec<ExtractedFile> {
        let mut files = Vec::new();
        let mut offset = 0usize;

        for file_data in &metadata.files {
            let end = offset + file_data.length as usize;
            if end > binary_payload.len() {
                break; // Invalid or truncated
            }
            let data = binary_payload[offset..end].to_vec();
            files.push(ExtractedFile {
                game_paths: file_data.game_paths.clone(),
                data,
                hash: file_data.hash.clone(),
            });
            offset = end;
        }

        files
    }

    /// Rebuild MCDF from metadata + files
    pub fn rebuild<W: Write>(
        writer: &mut W,
        metadata: &MareCharaFileData,
        files_data: &[&[u8]],
    ) -> Result<(), MCDFError> {
        // Write header
        writer.write_all(b"MCDF")?;
        writer.write_all(&[1u8])?; // version

        // Serialize JSON
        let json_bytes = serde_json::to_vec(metadata)?;
        let json_len = json_bytes.len() as u32;

        // Write JSON length and JSON data
        writer.write_all(&json_len.to_le_bytes())?;
        writer.write_all(&json_bytes)?;

        // Write binary payload (files concatenated in order)
        for file_data in files_data {
            writer.write_all(file_data)?;
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedFile {
    pub game_paths: Vec<String>,
    pub data: Vec<u8>,
    pub hash: String,
}
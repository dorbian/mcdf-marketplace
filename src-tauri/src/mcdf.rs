//! MCDF file parser and builder
//! MCDF = MareCharaDataFile (FFXIV character format)
//!
//! File format:
//!   4 bytes: "MCDF" magic
//!   1 byte: version (currently 1)
//!   4 bytes: JSON metadata length (little-endian int32)
//!   N bytes: UTF-8 JSON metadata
//!   Remaining: binary payload (files concatenated sequentially)
//!
//! FFXIV on-disk files may be gzip-compressed; this parser auto-detects and decompresses them.

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::io::Write;

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
        MCDFError { message: e.to_string() }
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
    /// Parse an MCDF file, auto-detecting gzip compression used by FFXIV on-disk storage.
    pub fn parse<R: std::io::Read>(reader: &mut R) -> Result<(MareCharaFileData, Vec<u8>), MCDFError> {
        // Peek at the first 4 bytes to detect gzip compression
        let mut peek = [0u8; 4];
        let n = reader.read(&mut peek).map_err(|e| MCDFError { message: e.to_string() })?;
        if n < 4 {
            return Err(MCDFError {
                message: format!("File too small ({} bytes)", n),
            });
        }

        // If gzip-compressed (FFXIV stores MCDF gzipped on disk), decompress then parse
        if &peek[..3] == b"\x1f\x8b\x08" {
            let mut all_data = peek.to_vec();
            std::io::Read::read_to_end(reader, &mut all_data)
                .map_err(|e| MCDFError { message: e.to_string() })?;
            let mut gz = GzDecoder::new(&all_data[..]);
            let mut decompressed = Vec::new();
            std::io::Read::read_to_end(&mut gz, &mut decompressed)
                .map_err(|e| MCDFError {
                    message: format!("gzip decompression failed: {}", e),
                })?;
            return Self::parse_from_slice(&decompressed);
        }

        // Otherwise read rest of file and parse as raw MCDF
        let mut all_data = peek.to_vec();
        std::io::Read::read_to_end(reader, &mut all_data)
            .map_err(|e| MCDFError { message: e.to_string() })?;
        Self::parse_from_slice(&all_data)
    }

    /// Parse from an already-in-memory byte buffer (slice-based, no Read trait needed)
    fn parse_from_slice(data: &[u8]) -> Result<(MareCharaFileData, Vec<u8>), MCDFError> {
        if data.len() < 9 {
            return Err(MCDFError {
                message: format!("File too small ({} bytes, need at least 9)", data.len()),
            });
        }

        // Magic (4 bytes)
        let (rest, magic) = data.split_at(4);
        if magic != b"MCDF" {
            return Err(MCDFError {
                message: format!(
                    "Invalid magic bytes: {:02x?}{:02x?}{:02x?}{:02x?} (expected 4d434446 'MCDF')",
                    magic[0], magic[1], magic[2], magic[3]
                ),
            });
        }

        // Version (1 byte)
        let version = rest[0];
        if version != 1 {
            return Err(MCDFError {
                message: format!("Unsupported version: {}", version),
            });
        }

        // JSON length (4 bytes, little-endian)
        let json_len = u32::from_le_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        let rest = &rest[5..];

        if rest.len() < json_len {
            return Err(MCDFError {
                message: format!(
                    "File too small (JSON claims {} bytes, {} available)",
                    json_len,
                    rest.len()
                ),
            });
        }

        let (json_data, binary_payload) = rest.split_at(json_len);
        let metadata: MareCharaFileData = serde_json::from_slice(json_data)?;

        Ok((metadata, binary_payload.to_vec()))
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
                break;
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
        writer.write_all(b"MCDF")?;
        writer.write_all(&[1u8])?;

        let json_bytes = serde_json::to_vec(metadata)?;
        let json_len = json_bytes.len() as u32;

        writer.write_all(&json_len.to_le_bytes())?;
        writer.write_all(&json_bytes)?;

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

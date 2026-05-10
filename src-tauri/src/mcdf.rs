//! MCDF file parser and builder.
//!
//! MCDF = MareCharaDataFile.
//!
//! Format used by this parser:
//!   4 bytes: "MCDF" magic
//!   1 byte: version (currently 1)
//!   4 bytes: JSON metadata length (little-endian u32)
//!   N bytes: UTF-8 JSON metadata
//!   Remaining bytes: binary file payload, concatenated in metadata file order
//!
//! Some files may be gzip-compressed. The parser auto-detects gzip and parses the
//! decompressed data.

use flate2::read::GzDecoder;
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
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub glamourer_data: String,
    #[serde(default)]
    pub customize_plus_data: String,
    #[serde(default)]
    pub manipulation_data: String,
    #[serde(default)]
    pub files: Vec<FileData>,
    #[serde(default)]
    pub file_swaps: Vec<FileSwap>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSwap {
    pub game_paths: Vec<String>,
    pub file_swap_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedFileInfo {
    pub index: usize,
    pub game_paths: Vec<String>,
    pub length: u32,
    pub hash: String,
    pub offset: u64,
    pub blake3: String,
}

#[derive(Debug, thiserror::Error)]
pub enum MCDFError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("File too small ({actual} bytes, need at least {needed})")]
    TooSmall { actual: usize, needed: usize },

    #[error("Invalid MCDF magic bytes: {0}; expected MCDF")]
    InvalidMagic(String),

    #[error("Unsupported MCDF version: {0}")]
    UnsupportedVersion(u8),

    #[error("Invalid MCDF payload: {0}")]
    InvalidPayload(String),

    #[error("gzip decompression failed: {0}")]
    Gzip(String),
}

pub struct MCDFParser;

impl MCDFParser {
    pub fn parse<R: Read>(reader: &mut R) -> Result<(MareCharaFileData, Vec<u8>), MCDFError> {
        let mut all_data = Vec::new();
        reader.read_to_end(&mut all_data)?;

        if all_data.len() < 4 {
            return Err(MCDFError::TooSmall {
                actual: all_data.len(),
                needed: 4,
            });
        }

        if all_data.starts_with(&[0x1f, 0x8b, 0x08]) {
            let mut gz = GzDecoder::new(&all_data[..]);
            let mut decompressed = Vec::new();
            gz.read_to_end(&mut decompressed)
                .map_err(|e| MCDFError::Gzip(e.to_string()))?;
            return Self::parse_from_slice(&decompressed);
        }

        Self::parse_from_slice(&all_data)
    }

    pub(crate) fn parse_from_slice(
        data: &[u8],
    ) -> Result<(MareCharaFileData, Vec<u8>), MCDFError> {
        if data.len() < 9 {
            return Err(MCDFError::TooSmall {
                actual: data.len(),
                needed: 9,
            });
        }

        let (magic, rest) = data.split_at(4);
        if magic != b"MCDF" {
            return Err(MCDFError::InvalidMagic(format!(
                "{:02x?} {:02x?} {:02x?} {:02x?}",
                magic[0], magic[1], magic[2], magic[3]
            )));
        }

        let version = rest[0];
        if version != 1 {
            return Err(MCDFError::UnsupportedVersion(version));
        }

        let json_len = u32::from_le_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        let rest = &rest[5..];

        if rest.len() < json_len {
            return Err(MCDFError::InvalidPayload(format!(
                "JSON claims {json_len} bytes, but only {} bytes remain",
                rest.len()
            )));
        }

        let (json_data, binary_payload) = rest.split_at(json_len);
        let metadata: MareCharaFileData = serde_json::from_slice(json_data)?;

        let expected_payload_len: usize = metadata.files.iter().map(|f| f.length as usize).sum();
        if binary_payload.len() < expected_payload_len {
            return Err(MCDFError::InvalidPayload(format!(
                "metadata expects {expected_payload_len} payload bytes, but file has {} bytes",
                binary_payload.len()
            )));
        }

        Ok((metadata, binary_payload.to_vec()))
    }

    pub fn extract_file_infos(
        metadata: &MareCharaFileData,
        binary_payload: &[u8],
    ) -> Result<Vec<ExtractedFileInfo>, MCDFError> {
        let mut files = Vec::new();
        let mut offset = 0usize;

        for (index, file_data) in metadata.files.iter().enumerate() {
            let end = offset
                .checked_add(file_data.length as usize)
                .ok_or_else(|| MCDFError::InvalidPayload("file offset overflow".to_string()))?;

            if end > binary_payload.len() {
                return Err(MCDFError::InvalidPayload(format!(
                    "file #{index} exceeds payload length: end {end}, payload {}",
                    binary_payload.len()
                )));
            }

            let blake3 = blake3::hash(&binary_payload[offset..end]).to_hex().to_string();
            files.push(ExtractedFileInfo {
                index,
                game_paths: file_data.game_paths.clone(),
                length: file_data.length,
                hash: file_data.hash.clone(),
                offset: offset as u64,
                blake3,
            });
            offset = end;
        }

        Ok(files)
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_mcdf() {
        let metadata = MareCharaFileData {
            description: "test".to_string(),
            glamourer_data: String::new(),
            customize_plus_data: String::new(),
            manipulation_data: String::new(),
            files: vec![],
            file_swaps: vec![],
        };

        let json = serde_json::to_vec(&metadata).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"MCDF");
        bytes.push(1);
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&json);

        let (parsed, payload) = MCDFParser::parse_from_slice(&bytes).unwrap();
        assert_eq!(parsed.description, "test");
        assert!(payload.is_empty());
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bytes = b"BAD!".to_vec();
        bytes.push(1);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        assert!(MCDFParser::parse_from_slice(&bytes).is_err());
    }
}

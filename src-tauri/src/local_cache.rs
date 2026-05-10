use std::fs;
use std::path::PathBuf;

pub fn app_home() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("MCDF_MARKETPLACE_HOME") {
        let path = PathBuf::from(value);
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        return Ok(path);
    }

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "Unable to determine user home directory".to_string())?;

    let path = PathBuf::from(home).join(".mcdf-marketplace");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn blob_dir() -> Result<PathBuf, String> {
    let path = app_home()?.join("blobs");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn manifest_dir() -> Result<PathBuf, String> {
    let path = app_home()?.join("manifests");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn downloads_dir() -> Result<PathBuf, String> {
    let path = app_home()?.join("downloads");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn blob_path(hash: &str) -> Result<PathBuf, String> {
    if hash.len() < 2 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Invalid blob hash: {hash}"));
    }
    let prefix = &hash[0..2];
    let dir = blob_dir()?.join(prefix);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(hash))
}

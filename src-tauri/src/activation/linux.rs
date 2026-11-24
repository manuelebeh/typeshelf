use crate::model::Scope;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

/// fontconfig scans $XDG_DATA_HOME/fonts recursively, so links placed there are
/// picked up by every application once the cache is refreshed.
fn fonts_root() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("fonts")
}

fn dir(scope: Scope) -> PathBuf {
    match scope {
        Scope::Temporary => fonts_root().join("typeshelf-temporary"),
        _ => fonts_root().join("typeshelf"),
    }
}

/// Unique, stable link name for a source file.
fn link_name(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{:016x}-{file}", hasher.finish())
}

pub fn activate(path: &Path, scope: Scope) -> Result<(), String> {
    let target_dir = dir(scope);
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let link = target_dir.join(link_name(path));
    if link.symlink_metadata().is_ok() {
        fs::remove_file(&link).map_err(|e| e.to_string())?;
    }
    std::os::unix::fs::symlink(path, &link).map_err(|e| e.to_string())
}

pub fn deactivate(path: &Path, _previous: Scope) -> Result<(), String> {
    for scope in [Scope::Persistent, Scope::Temporary] {
        let link = dir(scope).join(link_name(path));
        if link.symlink_metadata().is_ok() {
            fs::remove_file(&link).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn finish_batch() {
    // Running applications see new fonts after fontconfig refreshes its cache.
    let _ = Command::new("fc-cache").arg("-f").arg(fonts_root()).spawn();
}

pub fn clean_temporary_leftovers() {
    let _ = fs::remove_dir_all(dir(Scope::Temporary));
}

pub fn system_scope(_path: &Path) -> Option<Scope> {
    None
}

/// Not known on this platform: callers fall back to the scanned font folders.
pub fn font_available(_ps_name: &str) -> Option<bool> {
    None
}

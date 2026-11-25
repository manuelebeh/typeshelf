//! The small JSON file that makes a folder a library. It is written once, so that two computers
//! sharing the folder never fight over it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// The package layout this build understands.
pub const FORMAT: u32 = 1;
pub const FILE: &str = "library.tslibrary";
/// Extension of the package folder.
pub const EXTENSION: &str = "typeshelf";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub id: String,
    pub created_at: i64,
    pub created_by: String,
    /// Asks every computer to open the library for reading only.
    #[serde(default)]
    pub read_only: bool,
}

pub fn read(root: &Path) -> Result<Manifest, String> {
    let path = root.join(FILE);
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn write(root: &Path, manifest: &Manifest) -> Result<(), String> {
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(root.join(FILE), text + "\n").map_err(|e| format!("{}: {e}", root.display()))
}

/// The library folder named by a path a person picked: the package itself, its manifest, or a
/// folder holding exactly one package.
pub fn resolve(path: &Path) -> Result<PathBuf, String> {
    let not_found = || format!("{} is not a Typeshelf library", path.display());
    if path.is_file() {
        return match path.parent() {
            Some(parent) if path.file_name().is_some_and(|n| n == FILE) => Ok(parent.to_path_buf()),
            _ => Err(not_found()),
        };
    }
    if path.join(FILE).is_file() {
        return Ok(path.to_path_buf());
    }
    let inside: Vec<PathBuf> = fs::read_dir(path)
        .map_err(|_| not_found())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == EXTENSION) && p.join(FILE).is_file())
        .collect();
    match inside.as_slice() {
        [one] => Ok(one.clone()),
        _ => Err(not_found()),
    }
}

/// Whether the OS may hand this path over to be opened as a library.
pub fn is_library_path(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == EXTENSION) || path.file_name().is_some_and(|n| n == FILE)
}

/// What people see: the folder name without its extension.
pub fn name_of(root: &Path) -> String {
    let name = if root.extension().is_some_and(|e| e == EXTENSION) { root.file_stem() } else { root.file_name() };
    name.map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_package_accepts_folder_manifest_or_parent() {
        let parent = std::env::temp_dir().join(format!("typeshelf-resolve-{}", uuid::Uuid::new_v4()));
        let root = parent.join("Team Fonts.typeshelf");
        fs::create_dir_all(&root).unwrap();
        assert!(resolve(&root).is_err());
        write(&root, &Manifest { format: FORMAT, id: "l1".into(), created_at: 1, created_by: "d".into(), read_only: false }).unwrap();
        for picked in [&root, &root.join(FILE), &parent] {
            assert_eq!(resolve(picked).unwrap(), root);
        }
        assert!(is_library_path(&root) && is_library_path(&root.join(FILE)) && !is_library_path(&parent));
        assert_eq!((read(&root).unwrap().id.as_str(), name_of(&root).as_str()), ("l1", "Team Fonts"));
        assert!(resolve(&parent.join("missing")).is_err());
        let _ = fs::remove_dir_all(parent);
    }
}

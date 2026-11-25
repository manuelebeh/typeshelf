//! Which libraries this computer knows and how one gets opened.

use super::{default_ops, manifest, OpenLibrary, Opener};
use crate::machine::{self, MachineDb};
use std::path::{Path, PathBuf};

type R<T> = Result<T, String>;

pub const DEFAULT_NAME: &str = "Typeshelf";

pub fn cache_path(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("Caches").join(format!("{id}.sqlite"))
}

/// Where the library every install starts with lives.
pub fn default_root(data_dir: &Path) -> PathBuf {
    data_dir.join("Libraries").join(format!("{DEFAULT_NAME}.{}", manifest::EXTENSION))
}

/// Opens the package at `root` and records it as known here.
pub fn open_at(data_dir: &Path, machine: &MachineDb, root: &Path, now: i64) -> R<OpenLibrary> {
    let id = manifest::read(root)?.id;
    let device_id = machine.library(&id)?.map_or_else(|| uuid::Uuid::new_v4().to_string(), |k| k.device_id);
    let device_name = machine.device_name()?;
    let cache = cache_path(data_dir, &id);
    let library = OpenLibrary::open(root, &Opener { device_id: &device_id, device_name: &device_name, cache: &cache })?;
    machine.remember(&library.id, root, &device_id, now)?;
    Ok(library)
}

/// Writes a new package, with the default collections and tags, and opens it.
pub fn create(data_dir: &Path, machine: &MachineDb, root: &Path, now: i64) -> R<OpenLibrary> {
    OpenLibrary::create_package(root, &machine.device_name()?, now)?;
    let library = open_at(data_dir, machine, root, now)?;
    library.lock().commit(default_ops(now))?;
    Ok(library)
}

/// The library to open at launch: the current one, else another known one, else the default one.
/// A library that is only unreachable stays the current one for the next launch.
pub fn startup(data_dir: &Path, machine: &MachineDb, now: i64) -> R<OpenLibrary> {
    let current = machine.setting(machine::CURRENT_LIBRARY)?;
    let mut known = machine.libraries()?;
    known.sort_by_key(|k| Some(&k.id) != current.as_ref());
    for library in &known {
        match open_at(data_dir, machine, &library.path, now) {
            Ok(library) => {
                if current.is_none() {
                    machine.set_setting(machine::CURRENT_LIBRARY, &library.id)?;
                }
                return Ok(library);
            }
            Err(e) => eprintln!("Cannot open {}: {e}", library.path.display()),
        }
    }
    let root = default_root(data_dir);
    let library =
        if root.join(manifest::FILE).is_file() { open_at(data_dir, machine, &root, now)? } else { create(data_dir, machine, &root, now)? };
    if current.is_none() {
        machine.set_setting(machine::CURRENT_LIBRARY, &library.id)?;
    }
    Ok(library)
}

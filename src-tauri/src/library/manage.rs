//! Which libraries this computer knows and how one gets opened.

use super::{default_ops, manifest, OpenLibrary, Opener};
use crate::activation::Activator;
use crate::machine::{self, MachineDb};
use crate::model::Scope;
use std::fs;
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

/// Where this computer already knows a library with the same id as the one at `root`: the two
/// folders are copies of each other.
pub fn duplicate_of(machine: &MachineDb, root: &Path) -> R<Option<PathBuf>> {
    let id = manifest::read(root)?.id;
    let same = |a: &Path, b: &Path| fs::canonicalize(a).ok() == fs::canonicalize(b).ok();
    Ok(machine.library(&id)?.map(|k| k.path).filter(|path| manifest::read(path).is_ok_and(|m| m.id == id) && !same(path, root)))
}

/// Gives a copied library its own identity.
pub fn make_separate(root: &Path) -> R<()> {
    let mut manifest = manifest::read(root)?;
    manifest.id = uuid::Uuid::new_v4().to_string();
    manifest::write(root, &manifest)
}

/// Moves a library folder into `parent`. Active fonts of the library are registered again at
/// their new path. Returns the new folder.
pub fn move_to(machine: &MachineDb, os: &Activator, id: &str, parent: &Path, now: i64) -> R<PathBuf> {
    let known = machine.library(id)?.ok_or("Library not found")?;
    let root = known.path;
    let name = root.file_name().ok_or("Library not found")?;
    let target = parent.join(name);
    if !parent.is_dir() || parent.starts_with(&root) {
        return Err(format!("A library cannot be moved to {}", parent.display()));
    }
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }

    let active: Vec<_> = machine.activation()?.into_iter().filter(|(path, _)| Path::new(path).starts_with(&root)).collect();
    for (path, scope) in &active {
        if let Err(e) = (os.off)(Path::new(path), *scope) {
            eprintln!("{e}");
        }
    }
    let moved = relocate(&root, &target);
    let now_at = if moved.is_ok() { &target } else { &root };
    for (path, scope) in &active {
        let Ok(rel) = Path::new(path).strip_prefix(&root) else { continue };
        let new = now_at.join(rel);
        machine.set_scope(path, Scope::None)?;
        match (os.on)(&new, *scope) {
            Ok(()) => machine.set_scope(&new.to_string_lossy(), *scope)?,
            Err(e) => eprintln!("{e}"),
        }
    }
    moved?;
    machine.remember(id, &target, &known.device_id, now)?;
    Ok(target)
}

/// A rename, or across volumes a verified copy whose original goes to the Trash.
fn relocate(from: &Path, to: &Path) -> R<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if let Err(e) = copy_folder(from, to) {
        let _ = fs::remove_dir_all(to);
        return Err(e);
    }
    trash::delete(from).map_err(|e| format!("The library was copied, but {} could not be moved to the Trash: {e}", from.display()))
}

fn copy_folder(from: &Path, to: &Path) -> R<()> {
    for entry in walkdir::WalkDir::new(from) {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.path().strip_prefix(from).map_err(|e| e.to_string())?);
        let fail = |e: std::io::Error| format!("{}: {e}", entry.path().display());
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(fail)?;
        } else if fs::copy(entry.path(), &target).map_err(fail)? != entry.metadata().map_err(|e| e.to_string())?.len() {
            return Err(format!("{}: incomplete copy", entry.path().display()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn sandbox() -> (PathBuf, MachineDb) {
        let data = std::env::temp_dir().join(format!("typeshelf-manage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&data).unwrap();
        let machine = MachineDb::open(&data.join("machine.sqlite")).unwrap();
        (data, machine)
    }

    #[test]
    fn move_library_rewrites_activation() {
        let (data, machine) = sandbox();
        let library = create(&data, &machine, &data.join("Brand.typeshelf"), 1).unwrap();
        let font = library.fonts_dir().join("a.ttf");
        fs::write(&font, b"font").unwrap();
        machine.set_scope(&font.to_string_lossy(), Scope::Temporary).unwrap();
        machine.set_scope("/elsewhere.ttf", Scope::Persistent).unwrap();

        let calls = RefCell::new(Vec::new());
        let record = |what: &str, path: &Path, scope: Scope| {
            calls.borrow_mut().push(format!("{what} {} {}", scope.as_str(), path.display()));
            Ok(())
        };
        let os = Activator { on: &|p, s| record("on", p, s), off: &|p, s| record("off", p, s) };
        let parent = data.join("moved");
        assert!(move_to(&machine, &os, &library.id, &parent, 2).is_err(), "the folder must exist");
        fs::create_dir_all(&parent).unwrap();
        let target = move_to(&machine, &os, &library.id, &parent, 2).unwrap();

        let moved = target.join("Fonts").join("a.ttf");
        assert!(moved.is_file() && !font.exists());
        assert_eq!(*calls.borrow(), [format!("off temporary {}", font.display()), format!("on temporary {}", moved.display())]);
        assert_eq!(machine.scope_of(&moved.to_string_lossy()).unwrap(), Scope::Temporary);
        assert_eq!(machine.scope_of("/elsewhere.ttf").unwrap(), Scope::Persistent);
        assert_eq!(machine.library(&library.id).unwrap().unwrap().path, target);
        assert_eq!(open_at(&data, &machine, &target, 3).unwrap().lock().collections().unwrap().len(), 4);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn copied_library_gets_a_new_identity() {
        let (data, machine) = sandbox();
        let original = data.join("A.typeshelf");
        let copy = data.join("A copy.typeshelf");
        let id = create(&data, &machine, &original, 1).unwrap().id;
        assert_eq!(duplicate_of(&machine, &original).unwrap(), None);
        copy_folder(&original, &copy).unwrap();
        assert_eq!(duplicate_of(&machine, &copy).unwrap(), Some(original.clone()));
        make_separate(&copy).unwrap();
        assert_eq!(duplicate_of(&machine, &copy).unwrap(), None);
        assert_ne!(open_at(&data, &machine, &copy, 2).unwrap().id, id);
        // The original moved away is no longer a copy of anything.
        fs::rename(&original, data.join("B.typeshelf")).unwrap();
        assert_eq!(duplicate_of(&machine, &data.join("B.typeshelf")).unwrap(), None);
        let _ = fs::remove_dir_all(data);
    }
}

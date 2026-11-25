//! Duplicates and conflicts: every file that carries the same font (PostScript name), and the
//! only way to remove the extra ones. Nothing is deleted unless the interface asks for it.

use crate::model::{Face, Scope};
use crate::{activation, fonts, invalidate_system, lock, machine, system_scan, AppState};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Where font files live, to tell what may be deleted.
pub struct Roots {
    pub library: PathBuf,
    pub user: Vec<PathBuf>,
    pub system: Vec<PathBuf>,
}

impl Roots {
    pub fn new(fonts_dir: &Path) -> Self {
        Roots { library: fonts_dir.to_path_buf(), user: fonts::user_font_dirs(), system: fonts::system_font_dirs() }
    }

    fn location(&self, path: &Path) -> Location {
        if path.starts_with(&self.library) {
            Location::Library
        } else if self.user.iter().any(|d| path.starts_with(d)) {
            Location::User
        } else if self.system.iter().any(|d| path.starts_with(d)) {
            Location::System
        } else {
            Location::Imported
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Location {
    /// Copied into the Typeshelf library.
    Library,
    /// Imported where it was.
    Imported,
    /// The user's own font folder.
    User,
    /// A font folder of the OS or shared by all users: never deleted.
    System,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCopy {
    pub path: String,
    pub face_index: u32,
    pub version: Option<String>,
    pub file_size: u64,
    pub modified: i64,
    pub location: Location,
    pub active: bool,
    pub scope: Scope,
    pub trashable: bool,
    pub faces_in_file: usize,
    /// Every font in this file also exists in another file, so removing it loses nothing.
    pub other_faces_redundant: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub ps_name: String,
    pub family: String,
    pub style: String,
    pub copies: Vec<FontCopy>,
    /// Several copies are active at once: applications may pick either one.
    pub conflict: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insights {
    /// Distinct fonts, library and system together.
    pub faces: usize,
    pub active_faces: usize,
    pub groups: Vec<Group>,
    pub extra_copies: usize,
    /// Approximate space taken by the files beyond the largest copy of each font.
    pub extra_bytes: u64,
}

pub fn collect(state: &AppState, roots: &Roots) -> Result<Insights, String> {
    let scan = system_scan(state);
    let library = lock(state).faces()?;
    let activation = machine(state).activation()?;
    Ok(compute(&library, &activation, &scan.all, roots))
}

pub fn compute(library: &[Face], activation: &HashMap<String, Scope>, system: &[Face], roots: &Roots) -> Insights {
    // The same file can be both imported in place and found in an OS folder, or reached
    // through a symbolic link: it is one copy.
    let mut canonical: HashMap<&str, Option<PathBuf>> = HashMap::new();
    let mut seen = HashSet::new();
    let mut by_name: BTreeMap<&str, Vec<&Face>> = BTreeMap::new();
    for face in library.iter().chain(system) {
        let real = canonical.entry(face.path.as_str()).or_insert_with(|| fs::canonicalize(&face.path).ok());
        // A file that is gone is not a copy anymore.
        let Some(real) = real.clone() else { continue };
        if seen.insert((real, face.face_index)) {
            by_name.entry(face.ps_name.as_str()).or_default().push(face);
        }
    }

    let is_active = |path: &str| {
        matches!(roots.location(Path::new(path)), Location::User | Location::System)
            || activation.get(path).is_some_and(|s| *s != Scope::None)
    };
    let faces = by_name.len();
    let active_faces = by_name.values().filter(|copies| copies.iter().any(|f| is_active(&f.path))).count();

    by_name.retain(|_, copies| copies.iter().map(|f| &f.path).collect::<HashSet<_>>().len() > 1);

    // Which fonts each file involved holds: the library only records the ones it imported,
    // so the file is read again.
    let mut contents: HashMap<String, BTreeSet<String>> = HashMap::new();
    for face in by_name.values().flatten() {
        contents.entry(face.path.clone()).or_insert_with(|| {
            let read = fonts::scan(Path::new(&face.path), 0).unwrap_or_default();
            read.into_iter().filter(|f| !f.family.starts_with('.')).map(|f| f.ps_name).collect()
        });
    }
    for face in library.iter().chain(system) {
        if let Some(names) = contents.get_mut(&face.path) {
            names.insert(face.ps_name.clone());
        }
    }

    let mut groups: Vec<Group> = by_name
        .iter()
        .map(|(name, found)| {
            let copies: Vec<FontCopy> = found
                .iter()
                .map(|face| {
                    let path = Path::new(&face.path);
                    let meta = fs::metadata(path).ok();
                    let location = roots.location(path);
                    let names = &contents[&face.path];
                    FontCopy {
                        path: face.path.clone(),
                        face_index: face.face_index,
                        version: face.version.clone(),
                        file_size: meta.as_ref().map_or(0, |m| m.len()),
                        modified: meta
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map_or(0, |d| d.as_secs() as i64),
                        location,
                        active: is_active(&face.path),
                        scope: activation.get(&face.path).copied().unwrap_or(Scope::None),
                        trashable: location != Location::System,
                        faces_in_file: names.len(),
                        other_faces_redundant: names.iter().all(|n| by_name.contains_key(n.as_str())),
                    }
                })
                .collect();
            Group {
                ps_name: name.to_string(),
                family: found[0].family.clone(),
                style: found[0].style.clone(),
                conflict: copies.iter().filter(|c| c.active).count() > 1,
                copies,
            }
        })
        .collect();
    groups.sort_by_cached_key(|g| (g.family.to_lowercase(), g.style.to_lowercase()));

    let extra_copies = groups.iter().map(|g| g.copies.len() - 1).sum();
    let kept: HashSet<&str> = groups.iter().filter_map(|g| g.copies.iter().max_by_key(|c| c.file_size)).map(|c| c.path.as_str()).collect();
    let extra: HashMap<&str, u64> =
        groups.iter().flat_map(|g| &g.copies).filter(|c| !kept.contains(c.path.as_str())).map(|c| (c.path.as_str(), c.file_size)).collect();
    let extra_bytes = extra.values().sum();

    Insights { faces, active_faces, groups, extra_copies, extra_bytes }
}

/// Moves font files to the Trash with `remove`. Returns one message per file left in place.
///
/// The paths come from the web view, so each one is checked again: only font files of the
/// library or of the user's font folder. Library entries of a removed file move to another
/// installed copy when there is one, and are dropped otherwise.
pub fn trash_copies(
    state: &AppState,
    roots: &Roots,
    paths: Vec<String>,
    remove: impl Fn(&Path) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let scan = system_scan(state);
    let requested: BTreeSet<String> = paths.into_iter().collect();
    let mut errors = Vec::new();
    let mut removed_installed = false;
    {
        let mut db = lock(state);
        let machine = machine(state);
        let library = db.faces()?;
        for path in &requested {
            let file = Path::new(path);
            let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let location = roots.location(file);
            let allowed = fonts::is_font_file(file)
                && !file.components().any(|c| c == Component::ParentDir)
                && match location {
                    Location::Library | Location::User => true,
                    Location::Imported => library.iter().any(|f| &f.path == path),
                    Location::System => false,
                };
            if !allowed {
                errors.push(format!("{name}: this file cannot be moved to the Trash"));
                continue;
            }
            if let Err(e) = activation::deactivate(file, machine.scope_of(path)?) {
                errors.push(e);
                continue;
            }
            machine.set_scope(path, Scope::None)?;
            if let Err(e) = remove(file) {
                errors.push(format!("{name}: {e}"));
                continue;
            }
            removed_installed |= location == Location::User;

            let mut dropped = Vec::new();
            for face in library.iter().filter(|f| &f.path == path) {
                let other =
                    scan.all.iter().find(|c| c.ps_name == face.ps_name && !requested.contains(&c.path) && Path::new(&c.path).exists());
                match other {
                    Some(copy) => db.repoint_face(&face.id, copy)?,
                    None => dropped.push(face.id.clone()),
                }
            }
            db.delete_faces(&dropped)?;
        }
    }
    activation::finish_batch();
    if removed_installed {
        invalidate_system(state);
    }
    Ok(errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SystemScan;
    use std::sync::Arc;

    struct Sandbox {
        root: PathBuf,
        roots: Roots,
    }

    impl Sandbox {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("typeshelf-insights-{}", uuid::Uuid::new_v4()));
            let dir = |name: &str| {
                let d = root.join(name);
                fs::create_dir_all(&d).unwrap();
                d
            };
            let (library, user, system) = (dir("library"), dir("user"), dir("system"));
            let roots = Roots { library, user: vec![user.clone()], system: vec![system, user] };
            Sandbox { root, roots }
        }

        /// A placeholder file (not a real font: only the faces given by the test count).
        fn face(&self, file: &str, name: &str, size: usize) -> Face {
            let path = self.root.join(file);
            fs::write(&path, vec![0u8; size]).unwrap();
            Face {
                id: uuid::Uuid::new_v4().to_string(),
                path: path.to_string_lossy().into_owned(),
                face_index: 0,
                ps_name: name.into(),
                family: name.into(),
                style: "Regular".into(),
                full_name: name.into(),
                weight: 400,
                width: 5,
                italic: false,
                mono: false,
                classification: "sans".into(),
                version: None,
                designer: None,
                manufacturer: None,
                license: None,
                copyright: None,
                glyph_count: 1,
                variable: false,
                features: Vec::new(),
                starred: false,
                added_at: 0,
            }
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn groups_duplicates_and_flags_conflicts() {
        let sandbox = Sandbox::new();
        let library = vec![sandbox.face("library/a.ttf", "A", 100), sandbox.face("library/b.ttf", "B", 100)];
        let system = vec![
            sandbox.face("user/a.ttf", "A", 300),
            sandbox.face("system/b.ttf", "B", 100),
            sandbox.face("system/alone.ttf", "Alone", 100),
        ];

        // Library copies are inactive: duplicates, but no conflict.
        let found = compute(&library, &HashMap::new(), &system, &sandbox.roots);
        assert_eq!((found.faces, found.active_faces, found.extra_copies), (3, 3, 2));
        assert_eq!(found.groups.iter().map(|g| g.ps_name.as_str()).collect::<Vec<_>>(), ["A", "B"]);
        assert!(found.groups.iter().all(|g| !g.conflict));
        assert_eq!(found.extra_bytes, 200);

        let active = HashMap::from([(library[0].path.clone(), Scope::Temporary)]);
        let found = compute(&library, &active, &system, &sandbox.roots);
        let a = &found.groups[0];
        assert!(a.conflict);
        assert_eq!(
            a.copies.iter().map(|c| (c.location, c.trashable)).collect::<Vec<_>>(),
            [(Location::Library, true), (Location::User, true)]
        );
        assert_eq!((found.groups[1].copies[1].location, found.groups[1].copies[1].trashable), (Location::System, false));
    }

    #[test]
    fn counts_one_file_once_and_protects_files_with_unique_faces() {
        let sandbox = Sandbox::new();
        let a = sandbox.face("user/a.ttf", "A", 100);
        // Imported in place: the same file is in the library and in the user folder.
        let found = compute(std::slice::from_ref(&a), &HashMap::new(), std::slice::from_ref(&a), &sandbox.roots);
        assert!(found.groups.is_empty());

        let collection = sandbox.face("user/family.ttc", "A", 100);
        let extra = Face { face_index: 1, ps_name: "OnlyHere".into(), ..collection.clone() };
        let found = compute(&[], &HashMap::new(), &[a, collection, extra], &sandbox.roots);
        let copies = &found.groups[0].copies;
        assert_eq!((copies[0].faces_in_file, copies[0].other_faces_redundant), (1, true));
        assert_eq!((copies[1].faces_in_file, copies[1].other_faces_redundant), (2, false));
    }

    #[test]
    fn trashes_only_allowed_files_and_keeps_the_library_entry() {
        let sandbox = Sandbox::new();
        let kept = sandbox.face("library/a.ttf", "A", 100);
        let gone = sandbox.face("library/b.ttf", "B", 100);
        let installed = sandbox.face("user/a.ttf", "A", 100);
        let protected = sandbox.face("system/b.ttf", "Other", 100);
        let outside = sandbox.face("outside.ttf", "Outside", 100);

        let state = AppState::for_tests(&sandbox.root.join("state"));
        {
            let mut db = lock(&state);
            db.insert_faces(&[kept.clone(), gone.clone()]).unwrap();
            db.set_starred("A", true).unwrap();
        }
        *state.system.write().unwrap() = Some(Arc::new(SystemScan::new(vec![installed.clone()])));

        let paths = vec![kept.path.clone(), gone.path.clone(), protected.path.clone(), outside.path.clone()];
        let errors = trash_copies(&state, &sandbox.roots, paths, |p| fs::remove_file(p).map_err(|e| e.to_string())).unwrap();
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(Path::new(&protected.path).exists() && Path::new(&outside.path).exists());
        assert!(!Path::new(&kept.path).exists() && !Path::new(&gone.path).exists());

        // "A" now points at the installed copy and is still a favourite; "B" had no other copy.
        let faces = lock(&state).faces().unwrap();
        assert_eq!(faces.len(), 1);
        assert_eq!((faces[0].id.as_str(), faces[0].path.as_str(), faces[0].starred), (kept.id.as_str(), installed.path.as_str(), true));
    }
}

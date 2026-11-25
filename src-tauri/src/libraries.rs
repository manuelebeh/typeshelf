//! Commands to create, open, switch, move and forget libraries.

use crate::library::{manage, manifest, OpenLibrary};
use crate::model::Scope;
use crate::{activation, current, machine, now, AppState, CmdResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub current: bool,
    /// The folder can be reached.
    pub connected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutcome {
    /// Set when nothing was opened: the folder is a copy of the library at this path.
    pub duplicate_of: Option<String>,
}

pub fn list(state: &AppState) -> CmdResult<Vec<LibraryInfo>> {
    let open = current(state).id.clone();
    let mut libraries: Vec<LibraryInfo> = machine(state)
        .libraries()?
        .into_iter()
        .map(|k| LibraryInfo {
            name: manifest::name_of(&k.path),
            connected: k.path.join(manifest::FILE).is_file(),
            current: k.id == open,
            path: k.path.to_string_lossy().into_owned(),
            id: k.id,
        })
        .collect();
    libraries.sort_by_cached_key(|l| (l.name.to_lowercase(), l.path.clone()));
    Ok(libraries)
}

fn show(state: &AppState, library: OpenLibrary) -> CmdResult<()> {
    machine(state).set_setting(crate::machine::CURRENT_LIBRARY, &library.id)?;
    *state.library.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(library);
    Ok(())
}

pub fn create(state: &AppState, path: PathBuf) -> CmdResult<()> {
    let path = match path.extension() {
        Some(e) if e == manifest::EXTENSION => path,
        _ => {
            let mut name = path.into_os_string();
            name.push(format!(".{}", manifest::EXTENSION));
            PathBuf::from(name)
        }
    };
    let library = manage::create(&state.data_dir, &machine(state), &path, now())?;
    show(state, library)
}

pub fn open(state: &AppState, path: &Path, as_copy: bool) -> CmdResult<OpenOutcome> {
    let root = manifest::resolve(path)?;
    let duplicate = manage::duplicate_of(&machine(state), &root)?;
    match duplicate {
        Some(original) if !as_copy => return Ok(OpenOutcome { duplicate_of: Some(original.to_string_lossy().into_owned()) }),
        Some(_) => manage::make_separate(&root)?,
        None => {}
    }
    let library = manage::open_at(&state.data_dir, &machine(state), &root, now())?;
    show(state, library)?;
    Ok(OpenOutcome { duplicate_of: None })
}

pub fn switch(state: &AppState, id: &str) -> CmdResult<()> {
    let known = machine(state).library(id)?.ok_or("Library not found")?;
    let library = manage::open_at(&state.data_dir, &machine(state), &known.path, now())?;
    show(state, library)
}

pub fn relocate(state: &AppState, id: &str, parent: &Path, os: &activation::Activator) -> CmdResult<()> {
    let open = current(state);
    let target = {
        // Nothing gets written to the library while its files move.
        let _writing = (open.id == id).then(|| open.lock());
        manage::move_to(&machine(state), os, id, parent, now())?
    };
    activation::finish_batch();
    if open.id == id {
        let library = manage::open_at(&state.data_dir, &machine(state), &target, now())?;
        show(state, library)?;
    }
    Ok(())
}

pub fn forget(state: &AppState, id: &str) -> CmdResult<()> {
    if current(state).id == id {
        return Err("The open library cannot be removed from the list".into());
    }
    machine(state).forget(id)?;
    let _ = std::fs::remove_file(manage::cache_path(&state.data_dir, id));
    let _ = std::fs::remove_file(manage::head_path(&state.data_dir, id));
    machine(state).set_setting(&manage::view_only_key(id), "0")?;
    Ok(())
}

/// Whether this computer only reads a library. Other computers are not affected.
pub fn view_only(state: &AppState, id: &str, view_only: bool) -> CmdResult<()> {
    machine(state).set_setting(&manage::view_only_key(id), if view_only { "1" } else { "0" })?;
    let open = current(state);
    if open.id == id {
        open.lock().set_view_only(view_only);
    }
    Ok(())
}

/// Takes in what other computers changed in the open library. Fonts they removed from it are
/// deactivated here. Returns whether anything changed.
pub fn sync(state: &AppState, os: &activation::Activator) -> CmdResult<bool> {
    let open = current(state);
    let mut session = open.lock();
    let Some(gone) = session.sync(&open.id)? else {
        return Ok(false);
    };
    let machine = machine(state);
    machine.set_device(&open.id, session.device_id())?;
    for path in gone {
        let scope = machine.scope_of(&path)?;
        if scope == Scope::None || session.path_in_use(&path)? {
            continue;
        }
        match (os.off)(Path::new(&path), scope) {
            Ok(()) => machine.set_scope(&path, Scope::None)?,
            Err(e) => eprintln!("{e}"),
        }
    }
    activation::finish_batch();
    Ok(true)
}

/// Runs a library change off the main thread: it reads or copies a whole folder.
async fn blocking<T: Send + 'static>(app: AppHandle, work: impl FnOnce(&AppState) -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<AppState>())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_libraries(app: AppHandle) -> CmdResult<Vec<LibraryInfo>> {
    blocking(app, list).await
}

#[tauri::command]
pub async fn create_library(app: AppHandle, path: String) -> CmdResult<()> {
    blocking(app, move |state| create(state, PathBuf::from(path))).await
}

#[tauri::command]
pub async fn open_library(app: AppHandle, path: String, as_copy: bool) -> CmdResult<OpenOutcome> {
    blocking(app, move |state| open(state, Path::new(&path), as_copy)).await
}

#[tauri::command]
pub async fn switch_library(app: AppHandle, id: String) -> CmdResult<()> {
    blocking(app, move |state| switch(state, &id)).await
}

#[tauri::command]
pub async fn move_library(app: AppHandle, id: String, parent: String) -> CmdResult<()> {
    blocking(app, move |state| relocate(state, &id, Path::new(&parent), &activation::Activator::SYSTEM)).await
}

#[tauri::command]
pub fn set_view_only(state: State<AppState>, id: String, enabled: bool) -> CmdResult<()> {
    view_only(&state, &id, enabled)
}

#[tauri::command]
pub async fn sync_library(app: AppHandle) -> CmdResult<bool> {
    blocking(app, |state| sync(state, &activation::Activator::SYSTEM)).await
}

/// Looks for changes from other computers every few seconds and tells the interface.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));
        match sync(&app.state::<AppState>(), &activation::Activator::SYSTEM) {
            Ok(true) => drop(app.emit("library-changed", ())),
            Ok(false) => {}
            Err(e) => eprintln!("{e}"),
        }
    });
}

#[tauri::command]
pub fn forget_library(state: State<AppState>, id: String) -> CmdResult<()> {
    forget(&state, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::journal::{self, Clock, Event, Op};
    use crate::library::tests::face;
    use std::cell::RefCell;

    #[test]
    fn remote_changes_are_picked_up_and_removed_fonts_deactivated() {
        let data = std::env::temp_dir().join(format!("typeshelf-sync-{}", uuid::Uuid::new_v4()));
        let state = AppState::for_tests(&data);
        let open = current(&state);
        open.lock().commit(vec![face("f", "Inter-Regular")]).unwrap();
        let path = open.lock().faces().unwrap()[0].path.clone();
        machine(&state).set_scope(&path, Scope::Persistent).unwrap();

        let calls = RefCell::new(Vec::new());
        let off = |p: &Path, _: Scope| {
            calls.borrow_mut().push(p.to_string_lossy().into_owned());
            Ok(())
        };
        let os = activation::Activator { on: &|_, _| Ok(()), off: &off };
        assert!(!sync(&state, &os).unwrap(), "our own changes are not news");

        let remote = Event { dev: "other".into(), seq: 1, t: Clock(u64::MAX / 2, 0), op: Op::FaceRemove { ids: vec!["f".into()] } };
        journal::append(&journal::path_for(&open.root, "other"), &[remote]).unwrap();
        assert!(sync(&state, &os).unwrap());
        assert!(open.lock().faces().unwrap().is_empty());
        assert_eq!(calls.borrow().as_slice(), std::slice::from_ref(&path));
        assert_eq!(machine(&state).scope_of(&path).unwrap(), Scope::None);
        assert!(!sync(&state, &os).unwrap());

        // Unplugged, then back.
        std::fs::rename(&open.root, data.join("away")).unwrap();
        assert!(sync(&state, &os).unwrap() && open.lock().read_only());
        assert!(!sync(&state, &os).unwrap());
        std::fs::rename(data.join("away"), &open.root).unwrap();
        assert!(sync(&state, &os).unwrap() && !open.lock().read_only());
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn activation_survives_switching_libraries() {
        let data = std::env::temp_dir().join(format!("typeshelf-switch-{}", uuid::Uuid::new_v4()));
        let state = AppState::for_tests(&data);
        let first = current(&state).id.clone();
        machine(&state).set_scope("/a.ttf", Scope::Persistent).unwrap();

        create(&state, data.join("Second")).unwrap();
        let second = current(&state).id.clone();
        assert_ne!(first, second);
        assert_eq!(machine(&state).scope_of("/a.ttf").unwrap(), Scope::Persistent);
        let listed = list(&state).unwrap();
        assert_eq!(listed.iter().map(|l| (l.name.as_str(), l.current)).collect::<Vec<_>>(), [("Second", true), ("Typeshelf", false)]);
        assert!(forget(&state, &second).is_err());

        switch(&state, &first).unwrap();
        assert_eq!(current(&state).id, first);
        // The next launch reopens the library last switched to.
        drop(state);
        let state = AppState::for_tests(&data);
        assert_eq!(current(&state).id, first);
        forget(&state, &second).unwrap();
        assert_eq!(list(&state).unwrap().len(), 1);
        assert!(data.join("Second.typeshelf").is_dir(), "forgetting never deletes the folder");
        let _ = std::fs::remove_dir_all(data);
    }
}

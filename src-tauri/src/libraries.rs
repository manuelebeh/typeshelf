//! Commands to create, open, switch, move and forget libraries.

use crate::library::{manage, manifest, OpenLibrary};
use crate::{activation, current, machine, now, AppState, CmdResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

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
    Ok(())
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
pub fn forget_library(state: State<AppState>, id: String) -> CmdResult<()> {
    forget(&state, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Scope;

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

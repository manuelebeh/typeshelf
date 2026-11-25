mod activation;
mod db;
mod fonts;
mod google;
mod insights;
mod libraries;
mod library;
mod machine;
mod model;
mod plugin_api;
mod plugin_install;

use library::journal::Op;
use library::{manage, OpenLibrary};
use machine::MachineDb;
use model::{Face, FaceDetails, ImportSummary, Library, Scope};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

struct AppState {
    data_dir: PathBuf,
    /// Activation and known libraries. Lock after a library session when both are needed.
    machine: Mutex<MachineDb>,
    library: RwLock<Arc<OpenLibrary>>,
    /// Fonts installed on the system, scanned in the background and cached.
    system: RwLock<Option<Arc<SystemScan>>>,
    /// Libraries the OS asked to open, until the interface takes them.
    pending_open: Mutex<Vec<String>>,
}

struct SystemScan {
    /// Every installed copy, for Insights.
    all: Vec<Face>,
    /// One face per PostScript name, for the library list and the plugins.
    unique: Vec<Face>,
}

impl SystemScan {
    fn new(all: Vec<Face>) -> Self {
        SystemScan { unique: fonts::unique_faces(&all), all }
    }
}

fn system_scan(state: &AppState) -> Arc<SystemScan> {
    if let Some(scan) = state.system.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
        return scan.clone();
    }
    // Holding the write lock while scanning keeps concurrent callers from scanning twice.
    let mut cache = state.system.write().unwrap_or_else(|p| p.into_inner());
    cache.get_or_insert_with(|| Arc::new(SystemScan::new(fonts::scan_system_all()))).clone()
}

/// Forgets the cached system fonts, after files were added to or removed from the OS folders.
fn invalidate_system(state: &AppState) {
    *state.system.write().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Library faces live in the database; system faces (`sys-…` ids) in memory.
fn lookup_face(state: &AppState, id: &str) -> Option<Face> {
    if id.starts_with("sys-") {
        system_scan(state).unique.iter().find(|f| f.id == id).cloned()
    } else {
        current(state).lock().face(id).ok().flatten()
    }
}

#[tauri::command]
async fn system_fonts(app: AppHandle) -> CmdResult<Vec<Face>> {
    tauri::async_runtime::spawn_blocking(move || system_scan(&app.state::<AppState>()).unique.clone()).await.map_err(|e| e.to_string())
}

type CmdResult<T> = Result<T, String>;

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// The open library. Holding it keeps it usable even if another one gets opened meanwhile.
fn current(state: &AppState) -> Arc<OpenLibrary> {
    state.library.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

fn machine(state: &AppState) -> std::sync::MutexGuard<'_, MachineDb> {
    state.machine.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl AppState {
    fn new(data_dir: PathBuf) -> CmdResult<AppState> {
        fs::create_dir_all(&data_dir).map_err(|e| format!("{}: {e}", data_dir.display()))?;
        let machine = MachineDb::open(&data_dir.join("machine.sqlite"))?;
        library::migrate::run(&data_dir, &machine, &activation::Activator::SYSTEM, now())?;
        activation::finish_batch();
        let library = manage::startup(&data_dir, &machine, now())?;
        Ok(AppState {
            data_dir,
            machine: Mutex::new(machine),
            library: RwLock::new(Arc::new(library)),
            system: RwLock::new(None),
            pending_open: Mutex::default(),
        })
    }

    /// A state over a throwaway library under `root`.
    #[cfg(test)]
    fn for_tests(root: &Path) -> Self {
        AppState::new(root.to_path_buf()).unwrap()
    }
}

// ---------------------------------------------------------------- library

#[tauri::command]
async fn load_library(app: AppHandle) -> CmdResult<Library> {
    // Off the main thread: every library file is checked, possibly on a network drive.
    tauri::async_runtime::spawn_blocking(move || library_blocking(&app.state::<AppState>())).await.map_err(|e| e.to_string())?
}

fn library_blocking(state: &AppState) -> CmdResult<Library> {
    let library = current(state);
    let mut content = {
        let session = library.lock();
        Library {
            id: library.id.clone(),
            name: library.name(),
            root: library.root.to_string_lossy().into_owned(),
            read_only: session.read_only(),
            faces: session.faces()?,
            collections: session.collections()?,
            membership: session.membership()?,
            tags: session.tags()?,
            tag_membership: session.tag_membership()?,
            smart_sets: session.smart_sets()?,
            activation: machine(state).activation()?,
            fonts_dir: library.fonts_dir().to_string_lossy().into_owned(),
        }
    };
    for face in &mut content.faces {
        face.available = Path::new(&face.path).exists();
    }
    Ok(content)
}

#[tauri::command]
async fn import_paths(app: AppHandle, paths: Vec<String>, copy: bool) -> CmdResult<ImportSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        import_blocking(&state, paths, copy)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn import_blocking(state: &AppState, paths: Vec<String>, copy: bool) -> CmdResult<ImportSummary> {
    let library = current(state);
    let mut known = {
        let session = library.lock();
        if session.read_only() {
            return Err("This library is view-only".into());
        }
        session.known_ps_names()?
    };
    let mut summary = ImportSummary::default();
    let mut pending = Vec::new();
    let added_at = now();
    let inputs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

    for file in fonts::font_files(&inputs) {
        let scanned = match fonts::scan(&file, added_at) {
            Ok(f) if !f.is_empty() => f,
            _ => {
                summary.failures.push(file_name(&file));
                continue;
            }
        };
        let mut fresh: Vec<_> = scanned.iter().filter(|f| !known.contains(&f.ps_name)).cloned().collect();
        summary.skipped += scanned.len() - fresh.len();
        if fresh.is_empty() {
            continue;
        }
        let final_path = if copy {
            match copy_into_library(&library.fonts_dir(), &file, &fresh[0].family) {
                Ok(p) => p,
                Err(_) => {
                    summary.failures.push(file_name(&file));
                    continue;
                }
            }
        } else {
            file.clone()
        };
        for face in &mut fresh {
            face.path = final_path.to_string_lossy().into_owned();
            known.insert(face.ps_name.clone());
        }
        pending.extend(fresh);
    }
    summary.imported = library.lock().add_faces(&pending)?;
    Ok(summary)
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn copy_into_library(root: &Path, file: &Path, family: &str) -> std::io::Result<PathBuf> {
    let safe: String = family.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '-' } else { c }).collect();
    let folder = root.join(if safe.trim().is_empty() { "Sans nom".into() } else { safe });
    fs::create_dir_all(&folder)?;
    let mut dest = folder.join(file.file_name().unwrap_or_default());
    let mut n = 2;
    while dest.exists() {
        let stem = file.file_stem().unwrap_or_default().to_string_lossy();
        let ext = file.extension().unwrap_or_default().to_string_lossy();
        dest = folder.join(format!("{stem} {n}.{ext}"));
        n += 1;
    }
    fs::copy(file, &dest)?;
    Ok(dest)
}

#[tauri::command]
fn remove_families(state: State<AppState>, families: Vec<String>) -> CmdResult<Vec<String>> {
    let library = current(&state);
    let mut session = library.lock();
    if session.read_only() {
        return Err("This library is view-only".into());
    }
    let faces = session.faces_of_families(&families)?;
    let paths: BTreeSet<String> = faces.iter().map(|f| f.path.clone()).collect();
    let mut errors = Vec::new();
    {
        let machine = machine(&state);
        for path in &paths {
            let previous = machine.scope_of(path)?;
            match activation::deactivate(Path::new(path), previous) {
                Ok(()) => machine.set_scope(path, Scope::None)?,
                Err(e) => errors.push(e),
            }
        }
    }
    activation::finish_batch();
    session.commit(vec![Op::FaceRemove { ids: faces.iter().map(|f| f.id.clone()).collect() }])?;
    // Files copied into the library go to the Trash once nothing references them.
    for path in &paths {
        if Path::new(path).starts_with(library.fonts_dir()) && Path::new(path).exists() && !session.path_in_use(path)? {
            if let Err(e) = trash::delete(path) {
                errors.push(format!("{}: {e}", file_name(Path::new(path))));
            }
        }
    }
    Ok(errors)
}

// ---------------------------------------------------------------- insights

/// Duplicates and conflicts. `refresh` rescans the OS font folders first.
#[tauri::command]
async fn insights(app: AppHandle, refresh: bool) -> CmdResult<insights::Insights> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if refresh {
            invalidate_system(&state);
        }
        insights::collect(&state, &insights::Roots::new(&current(&state).fonts_dir()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn trash_copies(app: AppHandle, paths: Vec<String>) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let roots = insights::Roots::new(&current(&state).fonts_dir());
        insights::trash_copies(&state, &roots, paths, |path| trash::delete(path).map_err(|e| e.to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- activation

#[tauri::command]
fn set_activation(state: State<AppState>, paths: Vec<String>, scope: Scope) -> CmdResult<Vec<String>> {
    let machine = machine(&state);
    let mut errors = Vec::new();
    for path in paths.into_iter().collect::<BTreeSet<_>>() {
        // Fonts in the OS folders are always active: nothing to (un)register.
        if fonts::is_system_path(Path::new(&path)) {
            continue;
        }
        let previous = machine.scope_of(&path)?;
        match activation::activate(Path::new(&path), scope, previous) {
            Ok(()) => machine.set_scope(&path, scope)?,
            Err(e) => errors.push(e),
        }
    }
    activation::finish_batch();
    Ok(errors)
}

/// Unregisters every font Typeshelf activated, whatever library it came from.
#[tauri::command]
fn deactivate_all(state: State<AppState>) -> CmdResult<Vec<String>> {
    let machine = machine(&state);
    let mut errors = Vec::new();
    for (path, scope) in machine.activation()? {
        match activation::deactivate(Path::new(&path), scope) {
            Ok(()) => machine.set_scope(&path, Scope::None)?,
            Err(e) => errors.push(e),
        }
    }
    activation::finish_batch();
    Ok(errors)
}

/// Undo temporary activations (called on quit and at startup after a crash).
fn reset_temporary(state: &AppState) {
    let machine = machine(state);
    if let Ok(map) = machine.activation() {
        for (path, scope) in map {
            if scope == Scope::Temporary {
                let _ = activation::deactivate(Path::new(&path), scope);
                let _ = machine.set_scope(&path, Scope::None);
            }
        }
    }
    activation::clean_temporary_leftovers();
    activation::finish_batch();
}

/// Where the OS can report registrations (macOS), drop records it no longer knows.
fn reconcile_with_system(state: &AppState) {
    let machine = machine(state);
    if let Ok(map) = machine.activation() {
        for (path, _) in map {
            if activation::system_scope(Path::new(&path)) == Some(Scope::None) {
                let _ = machine.set_scope(&path, Scope::None);
            }
        }
    }
}

// ---------------------------------------------------------------- favorites & collections

fn commit(state: &AppState, op: Op) -> CmdResult<()> {
    current(state).lock().commit(vec![op])
}

/// Applies `op` to the ids of every face of these families.
fn commit_faces(state: &AppState, families: &[String], op: impl FnOnce(Vec<String>) -> Op) -> CmdResult<()> {
    let library = current(state);
    let mut session = library.lock();
    let ids = session.faces_of_families(families)?.into_iter().map(|f| f.id).collect();
    session.commit(vec![op(ids)])
}

fn required(name: &str) -> CmdResult<String> {
    match name.trim() {
        "" => Err("The name cannot be empty".into()),
        name => Ok(name.into()),
    }
}

#[tauri::command]
fn set_starred(state: State<AppState>, family: String, starred: bool) -> CmdResult<()> {
    commit_faces(&state, &[family], |ids| Op::FaceStar { ids, starred })
}

#[tauri::command]
fn create_collection(state: State<AppState>, name: String) -> CmdResult<String> {
    let name = required(&name)?;
    let id = uuid::Uuid::new_v4().to_string();
    commit(&state, Op::CollectionCreate { id: id.clone(), name, created_at: now() })?;
    Ok(id)
}

#[tauri::command]
fn rename_collection(state: State<AppState>, id: String, name: String) -> CmdResult<()> {
    commit(&state, Op::CollectionRename { id, name: required(&name)? })
}

#[tauri::command]
fn delete_collection(state: State<AppState>, id: String) -> CmdResult<()> {
    commit(&state, Op::CollectionDelete { id })
}

#[tauri::command]
fn add_to_collection(state: State<AppState>, id: String, families: Vec<String>) -> CmdResult<()> {
    commit_faces(&state, &families, |faces| Op::CollectionAdd { id, faces })
}

#[tauri::command]
fn remove_from_collection(state: State<AppState>, id: String, families: Vec<String>) -> CmdResult<()> {
    commit_faces(&state, &families, |faces| Op::CollectionRemove { id, faces })
}

// ---------------------------------------------------------------- tags

const TAG_COLORS: &[&str] = &["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"];

fn validate_tag(name: &str, color: &str, rule: &Option<String>) -> CmdResult<()> {
    required(name)?;
    if !TAG_COLORS.contains(&color) {
        return Err(format!("Unknown color: {color}"));
    }
    if let Some(rule) = rule {
        serde_json::from_str::<serde_json::Value>(rule).map_err(|e| format!("Invalid rule: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn create_tag(state: State<AppState>, name: String, color: String, rule: Option<String>) -> CmdResult<String> {
    validate_tag(&name, &color, &rule)?;
    let id = uuid::Uuid::new_v4().to_string();
    commit(&state, Op::TagSave { id: id.clone(), name: name.trim().into(), color, rule, created_at: now() })?;
    Ok(id)
}

#[tauri::command]
fn update_tag(state: State<AppState>, id: String, name: String, color: String, rule: Option<String>) -> CmdResult<()> {
    validate_tag(&name, &color, &rule)?;
    let library = current(&state);
    let mut session = library.lock();
    let existing = session.tags()?.into_iter().find(|t| t.id == id).ok_or("Tag not found")?;
    session.commit(vec![Op::TagSave { id, name: name.trim().into(), color, rule, created_at: existing.created_at }])
}

#[tauri::command]
fn delete_tag(state: State<AppState>, id: String) -> CmdResult<()> {
    commit(&state, Op::TagDelete { id })
}

#[tauri::command]
fn set_tagged(state: State<AppState>, id: String, families: Vec<String>, tagged: bool) -> CmdResult<()> {
    tag_families(&state, id, &families, tagged)
}

fn tag_families(state: &AppState, id: String, families: &[String], tagged: bool) -> CmdResult<()> {
    let tag = current(state).lock().tags()?.into_iter().find(|t| t.id == id).ok_or("Tag not found")?;
    if tag.rule.is_some() {
        return Err("A smart tag fills itself".into());
    }
    commit_faces(state, families, |faces| Op::TagSet { id, faces, tagged })
}

// ---------------------------------------------------------------- smart sets

fn validate_smart_set(name: &str, query: &str) -> CmdResult<()> {
    required(name)?;
    serde_json::from_str::<serde_json::Value>(query).map_err(|e| format!("Invalid query: {e}"))?;
    Ok(())
}

#[tauri::command]
fn create_smart_set(state: State<AppState>, name: String, query: String) -> CmdResult<String> {
    validate_smart_set(&name, &query)?;
    let id = uuid::Uuid::new_v4().to_string();
    commit(&state, Op::SetCreate { id: id.clone(), name: name.trim().into(), query, created_at: now() })?;
    Ok(id)
}

#[tauri::command]
fn update_smart_set(state: State<AppState>, id: String, name: String, query: String) -> CmdResult<()> {
    change_smart_set(&state, id, &name, query)
}

fn change_smart_set(state: &AppState, id: String, name: &str, query: String) -> CmdResult<()> {
    validate_smart_set(name, &query)?;
    let library = current(state);
    let mut session = library.lock();
    if !session.smart_sets()?.iter().any(|s| s.id == id) {
        return Err("Smart set not found".into());
    }
    session.commit(vec![Op::SetUpdate { id, name: name.trim().into(), query }])
}

#[tauri::command]
fn delete_smart_set(state: State<AppState>, id: String) -> CmdResult<()> {
    commit(&state, Op::SetDelete { id })
}

// ---------------------------------------------------------------- details

#[tauri::command]
async fn face_details(app: AppHandle, id: String) -> CmdResult<FaceDetails> {
    tauri::async_runtime::spawn_blocking(move || {
        let face = lookup_face(&app.state::<AppState>(), &id).ok_or("Style not found")?;
        fonts::details(Path::new(&face.path), face.face_index)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- Google Fonts

fn google_cache(state: &AppState) -> PathBuf {
    state.data_dir.join("google-fonts.json")
}

#[tauri::command]
async fn google_catalog(app: AppHandle, refresh: bool) -> CmdResult<google::GoogleCatalog> {
    tauri::async_runtime::spawn_blocking(move || google::catalog(&google_cache(&app.state::<AppState>()), refresh, now()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleDownload {
    summary: ImportSummary,
    paths: Vec<String>,
}

/// Downloads a Google Fonts family into the library folder and imports it.
#[tauri::command]
async fn google_download(app: AppHandle, family: String) -> CmdResult<GoogleDownload> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let catalog = google::catalog(&google_cache(&state), false, now())?;
        let entry = catalog.families.iter().find(|f| f.family == family).ok_or("Family not in the Google Fonts catalog")?;
        let library = current(&state);
        if library.lock().read_only() {
            return Err("This library is view-only".into());
        }
        let files = google::download(entry, &library.fonts_dir().join("Google Fonts"))?;
        let paths: Vec<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let summary = import_blocking(&state, paths.clone(), false)?;
        Ok(GoogleDownload { summary, paths })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn language_support(app: AppHandle, id: String, samples: Vec<String>) -> CmdResult<Vec<bool>> {
    tauri::async_runtime::spawn_blocking(move || {
        let face = lookup_face(&app.state::<AppState>(), &id).ok_or("Style not found")?;
        fonts::supports(Path::new(&face.path), face.face_index, &samples)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Serves `tsfont://localhost/<face id>` so the web view can preview any face,
/// activated or not, including faces inside .ttc/.otc collections.
fn serve_font(app: &AppHandle, uri_path: &str) -> Response<Vec<u8>> {
    let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    let state = app.state::<AppState>();
    // `<library id>~<face id>`: two copies of a library share their face ids, not their files.
    let id = uri_path.trim_start_matches('/');
    let id = match id.split_once('~') {
        Some((library, face)) if library == current(&state).id => face,
        Some(_) => return not_found(),
        None => id,
    };
    let Some(face) = lookup_face(&state, id) else {
        return not_found();
    };
    let Some(bytes) = fonts::map(Path::new(&face.path)).ok().and_then(|d| fonts::face_bytes(&d, face.face_index)) else {
        return not_found();
    };
    let mime = if bytes.starts_with(b"OTTO") { "font/otf" } else { "font/ttf" };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        .body(bytes)
        .unwrap()
}

// ---------------------------------------------------------------- plugins

#[tauri::command]
fn plugin_api_status() -> plugin_api::ApiStatus {
    plugin_api::status()
}

#[tauri::command]
fn plugin_api_config(enabled: bool, google: bool) -> plugin_api::ApiStatus {
    plugin_api::configure(enabled, google)
}

fn plugin_env(app: &AppHandle) -> CmdResult<plugin_install::Env> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?.join("plugins");
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    plugin_install::Env::new(resources, data_dir).ok_or_else(|| "Plugins cannot be installed on this system".to_string())
}

/// The bundled plugins and whether each one is installed. Empty where none applies (Linux).
#[tauri::command]
async fn plugins_list(app: AppHandle) -> CmdResult<Vec<plugin_install::PluginState>> {
    tauri::async_runtime::spawn_blocking(move || Ok(plugin_env(&app).map(|env| plugin_install::list(&env)).unwrap_or_default()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn plugin_install(app: AppHandle, id: String) -> CmdResult<plugin_install::InstallOutcome> {
    tauri::async_runtime::spawn_blocking(move || plugin_install::install(&plugin_env(&app)?, &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn plugin_uninstall(app: AppHandle, id: String) -> CmdResult<plugin_install::PluginState> {
    tauri::async_runtime::spawn_blocking(move || plugin_install::uninstall(&plugin_env(&app)?, &id)).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- entry point

/// Keeps the libraries named by `paths` for the interface and tells it, when it listens already.
fn request_open(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let libraries: Vec<String> =
        paths.into_iter().filter(|p| library::manifest::is_library_path(p)).map(|p| p.to_string_lossy().into_owned()).collect();
    if libraries.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<AppState>() {
        state.pending_open.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).extend(libraries);
        let _ = app.emit("open-library", ());
    }
}

#[tauri::command]
fn take_pending_open(state: State<AppState>) -> Vec<String> {
    std::mem::take(&mut state.pending_open.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // First: a second launch hands its files to the running app and stops.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            request_open(app, args.iter().skip(1).map(|a| Path::new(&cwd).join(a)));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("tsfont", |ctx, request| serve_font(ctx.app_handle(), request.uri().path()))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::new(data_dir)?;
            reset_temporary(&state);
            reconcile_with_system(&state);
            app.manage(state);
            // Windows and Linux pass the file that was double-clicked as an argument.
            request_open(app.handle(), std::env::args_os().skip(1).map(PathBuf::from));
            // Warm the system font list so the sidebar fills quickly.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                system_scan(&handle.state::<AppState>());
            });
            plugin_api::start(app.handle().clone());
            libraries::watch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_library,
            system_fonts,
            insights,
            trash_copies,
            import_paths,
            remove_families,
            set_activation,
            deactivate_all,
            take_pending_open,
            libraries::list_libraries,
            libraries::create_library,
            libraries::open_library,
            libraries::switch_library,
            libraries::move_library,
            libraries::forget_library,
            libraries::set_view_only,
            libraries::sync_library,
            set_starred,
            create_collection,
            rename_collection,
            delete_collection,
            add_to_collection,
            remove_from_collection,
            create_tag,
            update_tag,
            delete_tag,
            set_tagged,
            create_smart_set,
            update_smart_set,
            delete_smart_set,
            face_details,
            language_support,
            google_catalog,
            google_download,
            plugin_api_status,
            plugin_api_config,
            plugins_list,
            plugin_install,
            plugin_uninstall,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Typeshelf");

    app.run(|handle, event| match event {
        RunEvent::Exit => reset_temporary(&handle.state::<AppState>()),
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => request_open(handle, urls.iter().filter_map(|u| u.to_file_path().ok())),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(kind: &str) -> PathBuf {
        std::env::temp_dir().join(format!("typeshelf-{kind}-{}", uuid::Uuid::new_v4()))
    }

    fn content(state: &AppState) -> serde_json::Value {
        serde_json::to_value(library_blocking(state).unwrap()).unwrap()
    }

    #[test]
    fn new_library_seeds_defaults_once() {
        let root = temp_root("seed");
        let state = AppState::for_tests(&root);
        let session = current(&state);
        assert_eq!(session.lock().collections().unwrap().len(), 4);
        let tags = session.lock().tags().unwrap();
        assert_eq!((tags.len(), tags.iter().filter(|t| t.rule.is_some()).count()), (7, 3));
        for tag in &tags {
            if let Some(rule) = &tag.rule {
                serde_json::from_str::<serde_json::Value>(rule).expect("valid default rule");
            }
        }
        commit(&state, Op::TagDelete { id: tags[0].id.clone() }).unwrap();
        drop((session, state));
        // Reopening must not bring back what the user deleted.
        assert_eq!(current(&AppState::for_tests(&root)).lock().tags().unwrap().len(), 6);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn replay_matches_direct_writes() {
        let root = temp_root("replay");
        let state = AppState::for_tests(&root);
        let col = create_collection_in(&state, "Brand");
        let set = SetIds::new(&state);
        commit(&state, Op::CollectionRename { id: col.clone(), name: "Brand 2".into() }).unwrap();
        change_smart_set(&state, set.0.clone(), "Heavy", r#"{"search":"x"}"#.into()).unwrap();
        let before = content(&state);
        drop(state);
        // The cache is only a cache.
        fs::remove_dir_all(root.join("Caches")).unwrap();
        assert_eq!(content(&AppState::for_tests(&root)), before);
        let _ = fs::remove_dir_all(&root);
    }

    fn create_collection_in(state: &AppState, name: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        commit(state, Op::CollectionCreate { id: id.clone(), name: name.into(), created_at: 1 }).unwrap();
        id
    }

    struct SetIds(String);

    impl SetIds {
        fn new(state: &AppState) -> Self {
            commit(state, Op::SetCreate { id: "s1".into(), name: "Bold".into(), query: "{}".into(), created_at: 1 }).unwrap();
            SetIds("s1".into())
        }
    }

    #[test]
    fn commands_refuse_invalid_input_before_journaling() {
        let root = temp_root("refuse");
        let state = AppState::for_tests(&root);
        let journal = || {
            let file = library::journal::files(&current(&state).root).unwrap().remove(0);
            fs::read_to_string(file).unwrap()
        };
        let before = journal();
        assert!(change_smart_set(&state, "missing".into(), "x", "{}".into()).is_err());
        assert!(tag_families(&state, "missing".into(), &[], true).is_err());
        let smart = current(&state).lock().tags().unwrap().into_iter().find(|t| t.rule.is_some()).unwrap();
        assert!(tag_families(&state, smart.id, &[], true).is_err());
        assert!(required("  ").is_err());
        assert!(validate_smart_set(" ", "{}").is_err());
        assert!(validate_smart_set("x", "{not json").is_err());
        assert!(validate_tag("x", "red", &Some("{pas du json".into())).is_err());
        assert!(validate_tag("x", "fuchsia", &None).is_err());
        assert_eq!(journal(), before);
        let _ = fs::remove_dir_all(&root);
    }

    /// Imports the fonts listed in TYPESHELF_TEST_FONTS (a folder) into a throwaway
    /// library, then activates and deactivates one of them for real.
    #[test]
    fn import_and_activate_round_trip() {
        let Some(source) = std::env::var_os("TYPESHELF_TEST_FONTS").map(PathBuf::from) else {
            eprintln!("TYPESHELF_TEST_FONTS not set: test skipped");
            return;
        };
        let root = temp_root("test");
        let state = AppState::for_tests(&root);
        let library = current(&state);

        let src = source.to_string_lossy().into_owned();
        let first = import_blocking(&state, vec![src.clone()], true).unwrap();
        assert!(first.imported > 0, "no style imported: {first:?}");
        assert!(first.failures.is_empty(), "{:?}", first.failures);

        // Re-importing the same folder must not duplicate anything.
        let second = import_blocking(&state, vec![src], true).unwrap();
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, first.imported);

        let faces = library.lock().faces().unwrap();
        assert!(faces.iter().all(|f| Path::new(&f.path).starts_with(library.fonts_dir())));
        assert!(faces.iter().any(|f| f.variable), "a variable font was expected");
        let collection_faces = faces.iter().filter(|f| f.path.ends_with(".ttc")).count();
        assert!(collection_faces > 1, "the styles of the .ttc must be imported separately");

        // Activation on the real OS, using a font that is not installed system-wide.
        {
            let face = faces.iter().find(|f| f.family.to_lowercase().contains("feather")).expect("the Feather test font is expected");
            let path = face.path.clone();
            let db = machine(&state);
            for scope in [Scope::Temporary, Scope::Persistent] {
                let previous = db.scope_of(&path).unwrap();
                activation::activate(Path::new(&path), scope, previous).unwrap();
                db.set_scope(&path, scope).unwrap();
                if let Some(seen) = activation::system_scope(Path::new(&path)) {
                    assert_eq!(seen, scope);
                }
            }
            activation::deactivate(Path::new(&path), Scope::Persistent).unwrap();
            db.set_scope(&path, Scope::None).unwrap();
            if let Some(seen) = activation::system_scope(Path::new(&path)) {
                assert_eq!(seen, Scope::None);
            }
        }

        // Collections and favourites.
        let family = faces[0].family.clone();
        let families = std::slice::from_ref(&family);
        let id = create_collection_in(&state, "Test");
        commit_faces(&state, families, |faces| Op::CollectionAdd { id: id.clone(), faces }).unwrap();
        commit_faces(&state, families, |ids| Op::FaceStar { ids, starred: true }).unwrap();
        {
            let session = library.lock();
            let members = session.faces_of_families(families).unwrap();
            assert_eq!(session.membership().unwrap()[&id].len(), members.len());
            assert!(members.iter().all(|f| f.starred));
        }

        // Manual and smart tags.
        let manual = Op::TagSave { id: "t1".into(), name: "Mine".into(), color: "red".into(), rule: None, created_at: now() };
        commit(&state, manual).unwrap();
        let ids: Vec<String> = faces.iter().take(2).map(|f| f.id.clone()).collect();
        let tagged = |tag: &str| library.lock().tag_membership().unwrap().get(tag).map_or(0, Vec::len);
        commit(&state, Op::TagSet { id: "t1".into(), faces: ids.clone(), tagged: true }).unwrap();
        assert_eq!(tagged("t1"), 2);
        commit(&state, Op::TagSet { id: "t1".into(), faces: ids[..1].to_vec(), tagged: false }).unwrap();
        assert_eq!(tagged("t1"), 1);

        // Turning it into a smart tag clears explicit members and refuses manual tagging.
        let rule = Some(r#"{"match":"all","conditions":[]}"#.to_string());
        commit(&state, Op::TagSave { id: "t1".into(), name: "Mine".into(), color: "red".into(), rule, created_at: now() }).unwrap();
        assert_eq!(tagged("t1"), 0);
        assert!(tag_families(&state, "t1".into(), families, true).is_err());

        // Deleting a face removes it from manual tags (foreign key cascade).
        commit(&state, Op::TagSave { id: "t2".into(), name: "Other".into(), color: "red".into(), rule: None, created_at: now() }).unwrap();
        commit(&state, Op::TagSet { id: "t2".into(), faces: ids.clone(), tagged: true }).unwrap();
        commit(&state, Op::FaceRemove { ids: ids[..1].to_vec() }).unwrap();
        assert_eq!(tagged("t2"), ids.len() - 1);

        // The tsfont protocol extracts a standalone font for each face of the collection.
        for face in faces.iter().filter(|f| f.path.ends_with(".ttc")) {
            let data = fs::read(&face.path).unwrap();
            let bytes = fonts::face_bytes(&data, face.face_index).unwrap();
            assert_eq!(ttf_parser::Face::parse(&bytes, 0).unwrap().number_of_glyphs(), face.glyph_count);
        }

        // System fonts: found by id (as the tsfont protocol does) and served as standalone fonts.
        if let Some(sys) = system_scan(&state).unique.iter().find(|f| f.path.ends_with(".ttc")) {
            let found = lookup_face(&state, &sys.id).expect("system font found by its id");
            let data = fonts::map(Path::new(&found.path)).unwrap();
            let bytes = fonts::face_bytes(&data, found.face_index).unwrap();
            assert_eq!(ttf_parser::Face::parse(&bytes, 0).unwrap().number_of_glyphs(), found.glyph_count);
            assert!(fonts::details(Path::new(&found.path), found.face_index).unwrap().characters.len() > 10);
        }
        assert!(lookup_face(&state, "sys-inconnu-0").is_none());

        let _ = fs::remove_dir_all(&root);
    }
}

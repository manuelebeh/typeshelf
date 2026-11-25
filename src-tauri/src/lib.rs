mod activation;
mod db;
mod fonts;
mod google;
mod insights;
mod model;
mod plugin_api;
mod plugin_install;

use db::Db;
use model::{Face, FaceDetails, ImportSummary, Library, Scope, SmartSet, Tag};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Manager, RunEvent, State};

struct AppState {
    db: Mutex<Db>,
    fonts_dir: PathBuf,
    /// Fonts installed on the system, scanned in the background and cached.
    system: RwLock<Option<Arc<SystemScan>>>,
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
        lock(state).face(id).ok().flatten()
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

fn lock(state: &AppState) -> std::sync::MutexGuard<'_, Db> {
    state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
impl AppState {
    /// A state over a throwaway library under `root`.
    fn for_tests(root: &Path) -> Self {
        let fonts_dir = root.join("Fonts");
        fs::create_dir_all(&fonts_dir).unwrap();
        AppState { db: Mutex::new(Db::open(&root.join("library.sqlite")).unwrap()), fonts_dir, system: RwLock::new(None) }
    }
}

// ---------------------------------------------------------------- library

#[tauri::command]
async fn load_library(app: AppHandle) -> CmdResult<Library> {
    // Off the main thread: after an upgrade, the first load reads every library file.
    tauri::async_runtime::spawn_blocking(move || library_blocking(&app.state::<AppState>())).await.map_err(|e| e.to_string())?
}

fn library_blocking(state: &AppState) -> CmdResult<Library> {
    let mut db = lock(state);
    db.backfill_metrics()?;
    Ok(Library {
        faces: db.faces()?,
        collections: db.collections()?,
        membership: db.membership()?,
        tags: db.tags()?,
        tag_membership: db.tag_membership()?,
        smart_sets: db.smart_sets()?,
        activation: db.activation()?,
        fonts_dir: state.fonts_dir.to_string_lossy().into_owned(),
    })
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
    let mut known = lock(state).known_ps_names()?;
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
            match copy_into_library(&state.fonts_dir, &file, &fresh[0].family) {
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
    summary.imported = lock(state).insert_faces(&pending)?;
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
    let mut db = lock(&state);
    let faces = db.faces_of_families(&families)?;
    let paths: BTreeSet<String> = faces.iter().map(|f| f.path.clone()).collect();
    let mut errors = Vec::new();
    for path in &paths {
        let previous = db.scope_of(path)?;
        match activation::deactivate(Path::new(path), previous) {
            Ok(()) => db.set_scope(path, Scope::None)?,
            Err(e) => errors.push(e),
        }
    }
    activation::finish_batch();
    db.delete_faces(&faces.iter().map(|f| f.id.clone()).collect::<Vec<_>>())?;
    // Files copied into the library go to the Trash once nothing references them.
    for path in &paths {
        if Path::new(path).starts_with(&state.fonts_dir) && !db.path_in_use(path)? {
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
        insights::collect(&state, &insights::Roots::new(&state.fonts_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn trash_copies(app: AppHandle, paths: Vec<String>) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let roots = insights::Roots::new(&state.fonts_dir);
        insights::trash_copies(&state, &roots, paths, |path| trash::delete(path).map_err(|e| e.to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- activation

#[tauri::command]
fn set_activation(state: State<AppState>, paths: Vec<String>, scope: Scope) -> CmdResult<Vec<String>> {
    let db = lock(&state);
    let mut errors = Vec::new();
    for path in paths.into_iter().collect::<BTreeSet<_>>() {
        // Fonts in the OS folders are always active: nothing to (un)register.
        if fonts::is_system_path(Path::new(&path)) {
            continue;
        }
        let previous = db.scope_of(&path)?;
        match activation::activate(Path::new(&path), scope, previous) {
            Ok(()) => db.set_scope(&path, scope)?,
            Err(e) => errors.push(e),
        }
    }
    activation::finish_batch();
    Ok(errors)
}

/// Undo temporary activations (called on quit and at startup after a crash).
fn reset_temporary(state: &AppState) {
    let db = lock(state);
    if let Ok(map) = db.activation() {
        for (path, scope) in map {
            if scope == Scope::Temporary {
                let _ = activation::deactivate(Path::new(&path), scope);
                let _ = db.set_scope(&path, Scope::None);
            }
        }
    }
    activation::clean_temporary_leftovers();
    activation::finish_batch();
}

/// Where the OS can report registrations (macOS), drop records it no longer knows.
fn reconcile_with_system(state: &AppState) {
    let db = lock(state);
    if let Ok(map) = db.activation() {
        for (path, _) in map {
            if activation::system_scope(Path::new(&path)) == Some(Scope::None) {
                let _ = db.set_scope(&path, Scope::None);
            }
        }
    }
}

// ---------------------------------------------------------------- favorites & collections

#[tauri::command]
fn set_starred(state: State<AppState>, family: String, starred: bool) -> CmdResult<()> {
    lock(&state).set_starred(&family, starred)
}

#[tauri::command]
fn create_collection(state: State<AppState>, name: String) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("The name cannot be empty".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    lock(&state).create_collection(&id, name, now())?;
    Ok(id)
}

#[tauri::command]
fn rename_collection(state: State<AppState>, id: String, name: String) -> CmdResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("The name cannot be empty".into());
    }
    lock(&state).rename_collection(&id, name)
}

#[tauri::command]
fn delete_collection(state: State<AppState>, id: String) -> CmdResult<()> {
    lock(&state).delete_collection(&id)
}

#[tauri::command]
fn add_to_collection(state: State<AppState>, id: String, families: Vec<String>) -> CmdResult<()> {
    let mut db = lock(&state);
    let ids: Vec<String> = db.faces_of_families(&families)?.into_iter().map(|f| f.id).collect();
    db.add_to_collection(&id, &ids)
}

#[tauri::command]
fn remove_from_collection(state: State<AppState>, id: String, families: Vec<String>) -> CmdResult<()> {
    let mut db = lock(&state);
    let ids: Vec<String> = db.faces_of_families(&families)?.into_iter().map(|f| f.id).collect();
    db.remove_from_collection(&id, &ids)
}

// ---------------------------------------------------------------- tags

const TAG_COLORS: &[&str] = &["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"];

fn validate_tag(name: &str, color: &str, rule: &Option<String>) -> CmdResult<()> {
    if name.trim().is_empty() {
        return Err("The name cannot be empty".into());
    }
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
    let tag = Tag { id: uuid::Uuid::new_v4().to_string(), name: name.trim().into(), color, rule, created_at: now() };
    lock(&state).save_tag(&tag)?;
    Ok(tag.id)
}

#[tauri::command]
fn update_tag(state: State<AppState>, id: String, name: String, color: String, rule: Option<String>) -> CmdResult<()> {
    validate_tag(&name, &color, &rule)?;
    let db = lock(&state);
    let existing = db.tags()?.into_iter().find(|t| t.id == id).ok_or("Tag not found")?;
    db.save_tag(&Tag { id, name: name.trim().into(), color, rule, created_at: existing.created_at })
}

#[tauri::command]
fn delete_tag(state: State<AppState>, id: String) -> CmdResult<()> {
    lock(&state).delete_tag(&id)
}

#[tauri::command]
fn set_tagged(state: State<AppState>, id: String, families: Vec<String>, tagged: bool) -> CmdResult<()> {
    let mut db = lock(&state);
    let ids: Vec<String> = db.faces_of_families(&families)?.into_iter().map(|f| f.id).collect();
    db.set_tagged(&id, &ids, tagged)
}

// ---------------------------------------------------------------- smart sets

fn validate_smart_set(name: &str, query: &str) -> CmdResult<()> {
    if name.trim().is_empty() {
        return Err("The name cannot be empty".into());
    }
    serde_json::from_str::<serde_json::Value>(query).map_err(|e| format!("Invalid query: {e}"))?;
    Ok(())
}

#[tauri::command]
fn create_smart_set(state: State<AppState>, name: String, query: String) -> CmdResult<String> {
    validate_smart_set(&name, &query)?;
    let set = SmartSet { id: uuid::Uuid::new_v4().to_string(), name: name.trim().into(), query, created_at: now() };
    lock(&state).create_smart_set(&set)?;
    Ok(set.id)
}

#[tauri::command]
fn update_smart_set(state: State<AppState>, id: String, name: String, query: String) -> CmdResult<()> {
    validate_smart_set(&name, &query)?;
    lock(&state).update_smart_set(&id, name.trim(), &query)
}

#[tauri::command]
fn delete_smart_set(state: State<AppState>, id: String) -> CmdResult<()> {
    lock(&state).delete_smart_set(&id)
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
    state.fonts_dir.parent().unwrap_or(&state.fonts_dir).join("google-fonts.json")
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
        let files = google::download(entry, &state.fonts_dir.join("Google Fonts"))?;
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
    let id = uri_path.trim_start_matches('/');
    let Some(face) = lookup_face(&app.state::<AppState>(), id) else {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("tsfont", |ctx, request| serve_font(ctx.app_handle(), request.uri().path()))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let fonts_dir = data_dir.join("Fonts");
            fs::create_dir_all(&fonts_dir)?;
            let db = Db::open(&data_dir.join("library.sqlite"))?;
            let state = AppState { db: Mutex::new(db), fonts_dir, system: RwLock::new(None) };
            reset_temporary(&state);
            reconcile_with_system(&state);
            app.manage(state);
            // Warm the system font list so the sidebar fills quickly.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                system_scan(&handle.state::<AppState>());
            });
            plugin_api::start(app.handle().clone());
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

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            reset_temporary(&handle.state::<AppState>());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_default_tags_and_collections_once() {
        let path = std::env::temp_dir().join(format!("typeshelf-seed-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Db::open(&path).unwrap();
        assert_eq!(db.collections().unwrap().len(), 4);
        let tags = db.tags().unwrap();
        assert_eq!(tags.len(), 7);
        assert_eq!(tags.iter().filter(|t| t.rule.is_some()).count(), 3);
        for tag in &tags {
            if let Some(rule) = &tag.rule {
                serde_json::from_str::<serde_json::Value>(rule).expect("valid default rule");
            }
        }
        db.delete_tag(&tags[0].id).unwrap();
        drop(db);
        // Reopening must not bring back what the user deleted.
        assert_eq!(Db::open(&path).unwrap().tags().unwrap().len(), 6);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn upgrades_a_first_release_database() {
        let path = std::env::temp_dir().join(format!("typeshelf-upgrade-{}.sqlite", uuid::Uuid::new_v4()));
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE face (
                 id TEXT PRIMARY KEY, path TEXT NOT NULL, face_index INTEGER NOT NULL DEFAULT 0,
                 ps_name TEXT NOT NULL UNIQUE, family TEXT NOT NULL, style TEXT NOT NULL, full_name TEXT NOT NULL,
                 weight INTEGER NOT NULL DEFAULT 400, italic INTEGER NOT NULL DEFAULT 0, mono INTEGER NOT NULL DEFAULT 0,
                 classification TEXT NOT NULL, version TEXT, designer TEXT, manufacturer TEXT, license TEXT, copyright TEXT,
                 glyph_count INTEGER NOT NULL DEFAULT 0, variable INTEGER NOT NULL DEFAULT 0,
                 starred INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL
             );
             INSERT INTO face (id, path, ps_name, family, style, full_name, classification, added_at)
             VALUES ('gone', '/nowhere/gone.ttf', 'Gone', 'Gone', 'Regular', 'Gone', 'sans', 0);
             PRAGMA user_version = 1;",
        )
        .unwrap();
        drop(conn);

        let mut db = Db::open(&path).unwrap();
        // Already seeded: upgrading must not add the defaults again.
        assert!(db.collections().unwrap().is_empty());
        db.backfill_metrics().unwrap();
        let face = db.face("gone").unwrap().unwrap();
        assert_eq!((face.width, face.features.len()), (5, 0));
        drop(db);
        assert_eq!(Db::open(&path).unwrap().faces().unwrap().len(), 1);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn saves_renames_and_deletes_smart_sets() {
        let path = std::env::temp_dir().join(format!("typeshelf-sets-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Db::open(&path).unwrap();
        let set = SmartSet { id: "s1".into(), name: "Bold".into(), query: "{}".into(), created_at: 1 };
        db.create_smart_set(&set).unwrap();
        db.update_smart_set("s1", "Heavy", r#"{"search":"x"}"#).unwrap();
        let sets = db.smart_sets().unwrap();
        assert_eq!((sets[0].name.as_str(), sets[0].query.as_str()), ("Heavy", r#"{"search":"x"}"#));
        assert!(db.update_smart_set("missing", "x", "{}").is_err());
        db.delete_smart_set("s1").unwrap();
        assert!(db.smart_sets().unwrap().is_empty());
        assert!(validate_smart_set(" ", "{}").is_err());
        assert!(validate_smart_set("x", "{not json").is_err());
        let _ = fs::remove_file(&path);
    }

    /// Imports the fonts listed in TYPESHELF_TEST_FONTS (a folder) into a throwaway
    /// library, then activates and deactivates one of them for real.
    #[test]
    fn import_and_activate_round_trip() {
        let Some(source) = std::env::var_os("TYPESHELF_TEST_FONTS").map(PathBuf::from) else {
            eprintln!("TYPESHELF_TEST_FONTS not set: test skipped");
            return;
        };
        let root = std::env::temp_dir().join(format!("typeshelf-test-{}", uuid::Uuid::new_v4()));
        let state = AppState::for_tests(&root);

        let src = source.to_string_lossy().into_owned();
        let first = import_blocking(&state, vec![src.clone()], true).unwrap();
        assert!(first.imported > 0, "no style imported: {first:?}");
        assert!(first.failures.is_empty(), "{:?}", first.failures);

        // Re-importing the same folder must not duplicate anything.
        let second = import_blocking(&state, vec![src], true).unwrap();
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, first.imported);

        let faces = lock(&state).faces().unwrap();
        assert!(faces.iter().all(|f| f.path.starts_with(state.fonts_dir.to_str().unwrap())));
        assert!(faces.iter().any(|f| f.variable), "a variable font was expected");
        let collection_faces = faces.iter().filter(|f| f.path.ends_with(".ttc")).count();
        assert!(collection_faces > 1, "the styles of the .ttc must be imported separately");

        // Activation on the real OS, using a font that is not installed system-wide.
        {
            let face = faces.iter().find(|f| f.family.to_lowercase().contains("feather")).expect("the Feather test font is expected");
            let path = face.path.clone();
            let db = lock(&state);
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
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut db = lock(&state);
            db.create_collection(&id, "Test", now()).unwrap();
            let ids: Vec<String> = db.faces_of_families(std::slice::from_ref(&family)).unwrap().into_iter().map(|f| f.id).collect();
            db.add_to_collection(&id, &ids).unwrap();
            assert_eq!(db.membership().unwrap()[&id].len(), ids.len());
            db.set_starred(&family, true).unwrap();
            assert!(db.faces_of_families(&[family]).unwrap().iter().all(|f| f.starred));
        }

        // Manual and smart tags.
        {
            let mut db = lock(&state);
            let manual = Tag { id: "t1".into(), name: "Headings".into(), color: "red".into(), rule: None, created_at: now() };
            db.save_tag(&manual).unwrap();
            let ids: Vec<String> = faces.iter().take(2).map(|f| f.id.clone()).collect();
            db.set_tagged("t1", &ids, true).unwrap();
            assert_eq!(db.tag_membership().unwrap()["t1"].len(), 2);
            db.set_tagged("t1", &ids[..1], false).unwrap();
            assert_eq!(db.tag_membership().unwrap()["t1"].len(), 1);

            // Turning it into a smart tag clears explicit members and refuses manual tagging.
            let smart = Tag { rule: Some(r#"{"match":"all","conditions":[]}"#.into()), ..manual };
            db.save_tag(&smart).unwrap();
            assert!(!db.tag_membership().unwrap().contains_key("t1"));
            assert!(db.set_tagged("t1", &ids, true).is_err());

            // Deleting a face removes it from manual tags (foreign key cascade).
            db.save_tag(&Tag { id: "t2".into(), rule: None, ..smart }).unwrap();
            db.set_tagged("t2", &ids, true).unwrap();
            db.delete_faces(&ids[..1]).unwrap();
            assert_eq!(db.tag_membership().unwrap()["t2"].len(), ids.len() - 1);
            assert!(validate_tag("x", "red", &Some("{pas du json".into())).is_err());
            assert!(validate_tag("x", "fuchsia", &None).is_err());
        }

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

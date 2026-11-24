//! Local HTTP API used by the design-app plugins (Photoshop, Illustrator…) to activate
//! the fonts a document needs, identified by their PostScript names.
//!
//! It listens on 127.0.0.1 only. Web pages cannot use it: requests must name one of our
//! own host names (no DNS rebinding), must not carry a web `Origin`, and activation needs
//! a custom header, which browsers only send after a CORS preflight that is never granted.

use crate::model::Scope;
use crate::{activation, fonts, google, google_cache, import_blocking, lock, now, system_faces, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const PORT: u16 = 47391;
const MAX_BODY: u64 = 64 * 1024;
const MAX_FONTS: usize = 500;

static ENABLED: AtomicBool = AtomicBool::new(true);
static ALLOW_GOOGLE: AtomicBool = AtomicBool::new(true);
static LISTENING: AtomicBool = AtomicBool::new(false);
static START_ERROR: Mutex<Option<String>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    port: u16,
    enabled: bool,
    listening: bool,
    error: Option<String>,
}

pub fn status() -> ApiStatus {
    ApiStatus {
        port: PORT,
        enabled: ENABLED.load(Ordering::Relaxed),
        listening: LISTENING.load(Ordering::Relaxed),
        error: START_ERROR.lock().ok().and_then(|e| e.clone()),
    }
}

pub fn configure(enabled: bool, allow_google: bool) -> ApiStatus {
    ENABLED.store(enabled, Ordering::Relaxed);
    ALLOW_GOOGLE.store(allow_google, Ordering::Relaxed);
    status()
}

/// What a plugin request changed, shown to the user by the main window.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    client: String,
    activated: Vec<String>,
    missing: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontResult {
    pub name: String,
    /// "system" | "active" | "activated" | "missing" | "error"
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// "library" or "google" for fonts activated by this request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl FontResult {
    fn new(name: &str, status: &'static str) -> Self {
        FontResult { name: name.to_string(), status, family: None, source: None, message: None }
    }
}

#[derive(Deserialize)]
struct StatusRequest {
    fonts: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontStatus {
    pub name: String,
    /// Any application can use it right now (installed, or active from any font manager).
    pub available: bool,
    /// Recorded in the Typeshelf library, so it can be activated without a download.
    pub in_library: bool,
}

#[derive(Deserialize)]
struct ActivateRequest {
    fonts: Vec<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default = "yes")]
    google: bool,
}

fn yes() -> bool {
    true
}

pub struct Request<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub host: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub client: Option<&'a str>,
    pub body: &'a str,
}

/// Starts the listeners in the background, on IPv4 and IPv6 loopback: plugins call
/// `localhost` (Photoshop only grants network access by host name), which may resolve to
/// either. A port already in use is reported in the settings.
pub fn start(app: AppHandle) {
    let mut errors = Vec::new();
    for address in [("127.0.0.1", PORT), ("::1", PORT)] {
        match tiny_http::Server::http(address) {
            Ok(server) => {
                LISTENING.store(true, Ordering::Relaxed);
                let app = app.clone();
                std::thread::spawn(move || serve(&app, server));
            }
            Err(e) => errors.push(format!("{}:{PORT} unavailable: {e}", address.0)),
        }
    }
    // IPv6 may simply be off: only report a failure when nothing listens.
    if !LISTENING.load(Ordering::Relaxed) {
        if let Ok(mut slot) = START_ERROR.lock() {
            *slot = Some(errors.join("; "));
        }
    }
}

fn serve(app: &AppHandle, server: tiny_http::Server) {
    for mut request in server.incoming_requests() {
        let header = |name: &'static str| request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string());
        let (host, origin, client) = (header("Host"), header("Origin"), header("X-Typeshelf-Client"));
        let method = request.method().as_str().to_string();
        let url = request.url().to_string();
        let mut body = String::new();
        let read = request.as_reader().take(MAX_BODY + 1).read_to_string(&mut body);
        let (code, value, activity) = if read.is_err() || body.len() as u64 > MAX_BODY {
            (413, error("Request too large"), None)
        } else {
            let state = app.state::<AppState>();
            route(
                &state,
                &Request {
                    method: &method,
                    url: &url,
                    host: host.as_deref(),
                    origin: origin.as_deref(),
                    client: client.as_deref(),
                    body: &body,
                },
            )
        };
        if let Some(activity) = activity {
            let _ = app.emit("plugin-activity", activity);
        }
        let content_type = tiny_http::Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap();
        let response = tiny_http::Response::from_string(value.to_string()).with_status_code(code).with_header(content_type);
        let _ = request.respond(response);
    }
}

fn error(message: &str) -> Value {
    json!({ "error": message })
}

/// Refuses anything a web page could send.
fn guard(req: &Request) -> Result<(), &'static str> {
    let own_host = req
        .host
        .is_some_and(|h| [format!("127.0.0.1:{PORT}"), format!("localhost:{PORT}"), format!("[::1]:{PORT}")].iter().any(|ok| ok == h));
    if !own_host {
        return Err("Host not allowed");
    }
    if req.origin.is_some_and(|o| o.starts_with("http://") || o.starts_with("https://")) {
        return Err("Web pages cannot use this API");
    }
    Ok(())
}

pub fn route(state: &AppState, req: &Request) -> (u16, Value, Option<Activity>) {
    if !ENABLED.load(Ordering::Relaxed) {
        return (503, error("Plugin API turned off in the Typeshelf settings"), None);
    }
    if let Err(e) = guard(req) {
        return (403, error(e), None);
    }
    let path = req.url.split('?').next().unwrap_or("");
    match (req.method, path) {
        ("GET", "/v1/status") => (200, json!({ "app": "Typeshelf", "version": env!("CARGO_PKG_VERSION"), "api": 1 }), None),
        ("POST", "/v1/fonts/status") => {
            if req.client.is_none_or(|c| c.trim().is_empty()) {
                return (403, error("Missing X-Typeshelf-Client header"), None);
            }
            let body: StatusRequest = match serde_json::from_str(req.body) {
                Ok(b) => b,
                Err(e) => return (400, error(&format!("Invalid JSON body: {e}")), None),
            };
            if body.fonts.len() > MAX_FONTS {
                return (400, error("Too many fonts in a single request"), None);
            }
            (200, json!({ "results": font_status(state, &body.fonts) }), None)
        }
        ("POST", "/v1/fonts/activate") => {
            let Some(client) = req.client.filter(|c| !c.trim().is_empty()) else {
                return (403, error("Missing X-Typeshelf-Client header"), None);
            };
            let body: ActivateRequest = match serde_json::from_str(req.body) {
                Ok(b) => b,
                Err(e) => return (400, error(&format!("Invalid JSON body: {e}")), None),
            };
            if body.fonts.len() > MAX_FONTS {
                return (400, error("Too many fonts in a single request"), None);
            }
            let scope = if body.scope.as_deref() == Some("persistent") { Scope::Persistent } else { Scope::Temporary };
            let google = body.google && ALLOW_GOOGLE.load(Ordering::Relaxed);
            let results = activate_fonts(state, &body.fonts, scope, google);
            let pick = |status: &str| results.iter().filter(|r| r.status == status).map(|r| r.name.clone()).collect::<Vec<_>>();
            let (activated, missing) = (pick("activated"), pick("missing"));
            let activity = (!activated.is_empty() || !missing.is_empty()).then(|| Activity {
                client: client.chars().take(60).collect(),
                activated,
                missing,
            });
            (200, json!({ "results": results }), activity)
        }
        ("OPTIONS", _) => (403, error("Browser requests refused"), None),
        _ => (404, error("Unknown route"), None),
    }
}

/// "PlayfairDisplay-BoldItalic" → "playfairdisplay": compared with catalogue names without spaces.
fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()
}

fn family_key(ps_name: &str) -> String {
    squash(ps_name.split('-').next().unwrap_or(ps_name))
}

/// Installed or active according to the OS, or found in the scanned font folders.
fn os_has(name: &str, system: &HashSet<&str>) -> bool {
    system.contains(name) || activation::font_available(name) == Some(true)
}

/// Read-only: which of these fonts can already be used, and which the library holds.
pub fn font_status(state: &AppState, names: &[String]) -> Vec<FontStatus> {
    let system: HashSet<&str> = system_faces(state).iter().map(|f| f.ps_name.as_str()).collect();
    let db = lock(state);
    let library = db.faces().unwrap_or_default();
    names
        .iter()
        .map(|name| {
            let face = library.iter().find(|f| f.ps_name.eq_ignore_ascii_case(name));
            let active =
                face.is_some_and(|f| fonts::is_system_path(Path::new(&f.path)) || db.scope_of(&f.path).is_ok_and(|s| s != Scope::None));
            FontStatus { name: name.clone(), available: active || os_has(name, &system), in_library: face.is_some() }
        })
        .collect()
}

fn activate_path(state: &AppState, path: &str, scope: Scope) -> Result<(), String> {
    let db = lock(state);
    let previous = db.scope_of(path)?;
    activation::activate(Path::new(path), scope, previous)?;
    db.set_scope(path, scope)
}

/// Resolves each PostScript name: installed on the system, already active, activated from
/// the library, or downloaded from Google Fonts when the family is in the catalogue.
pub fn activate_fonts(state: &AppState, names: &[String], scope: Scope, google: bool) -> Vec<FontResult> {
    let mut wanted: Vec<String> = Vec::new();
    for name in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        if !wanted.iter().any(|w| w == name) {
            wanted.push(name.to_string());
        }
    }
    let system: HashSet<&str> = system_faces(state).iter().map(|f| f.ps_name.as_str()).collect();
    let mut results: BTreeMap<String, FontResult> = BTreeMap::new();
    let mut to_activate: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut missing: Vec<String> = Vec::new();

    let library = lock(state).faces().unwrap_or_default();
    for name in &wanted {
        let face = library.iter().find(|f| &f.ps_name == name).or_else(|| library.iter().find(|f| f.ps_name.eq_ignore_ascii_case(name)));
        match face {
            Some(face) if fonts::is_system_path(Path::new(&face.path)) => {
                results.insert(name.clone(), FontResult { family: Some(face.family.clone()), ..FontResult::new(name, "system") });
            }
            Some(face) => {
                let current = lock(state).scope_of(&face.path).unwrap_or(Scope::None);
                let status = if current == Scope::None { "activated" } else { "active" };
                if current == Scope::None {
                    to_activate.entry(face.path.clone()).or_default().push(name.clone());
                }
                let source = (status == "activated").then_some("library");
                results.insert(name.clone(), FontResult { family: Some(face.family.clone()), source, ..FontResult::new(name, status) });
            }
            None if os_has(name, &system) => {
                results.insert(name.clone(), FontResult::new(name, "system"));
            }
            None => missing.push(name.clone()),
        }
    }

    for (path, names) in &to_activate {
        if let Err(e) = activate_path(state, path, scope) {
            for name in names {
                if let Some(r) = results.get_mut(name) {
                    r.status = "error";
                    r.source = None;
                    r.message = Some(e.clone());
                }
            }
        }
    }

    if google && !missing.is_empty() {
        missing = fetch_from_google(state, missing, scope, &mut results);
    }
    for name in missing {
        results.entry(name.clone()).or_insert_with(|| FontResult::new(&name, "missing"));
    }
    activation::finish_batch();
    wanted.iter().filter_map(|n| results.remove(n)).collect()
}

/// Downloads the Google families that match missing names; returns the names still missing.
fn fetch_from_google(state: &AppState, missing: Vec<String>, scope: Scope, results: &mut BTreeMap<String, FontResult>) -> Vec<String> {
    let Ok(catalog) = google::catalog(&google_cache(state), false, now()) else {
        return missing;
    };
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut still = Vec::new();
    for name in missing {
        let key = family_key(&name);
        match catalog.families.iter().find(|f| squash(&f.family) == key && !key.is_empty()) {
            Some(f) => groups.entry(f.family.clone()).or_default().push(name),
            None => still.push(name),
        }
    }
    for (family, names) in groups {
        let entry = catalog.families.iter().find(|f| f.family == family).expect("family from the catalog");
        let fetched = google::download(entry, &state.fonts_dir.join("Google Fonts")).and_then(|files| {
            let paths: Vec<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            import_blocking(state, paths.clone(), false)?;
            Ok(paths)
        });
        let paths = match fetched {
            Ok(p) => p,
            Err(e) => {
                for name in names {
                    results.insert(
                        name.clone(),
                        FontResult { family: Some(family.clone()), message: Some(e.clone()), ..FontResult::new(&name, "error") },
                    );
                }
                continue;
            }
        };
        let errors: Vec<String> = paths.iter().filter_map(|p| activate_path(state, p, scope).err()).collect();
        let library = lock(state).faces().unwrap_or_default();
        let known: BTreeSet<&str> = library.iter().filter(|f| paths.contains(&f.path)).map(|f| f.ps_name.as_str()).collect();
        for name in names {
            let found = known.contains(name.as_str()) || known.iter().any(|k| k.eq_ignore_ascii_case(&name));
            let result = if !errors.is_empty() {
                FontResult { family: Some(family.clone()), message: Some(errors.join("; ")), ..FontResult::new(&name, "error") }
            } else if found {
                FontResult { family: Some(family.clone()), source: Some("google"), ..FontResult::new(&name, "activated") }
            } else {
                FontResult {
                    family: Some(family.clone()),
                    message: Some(format!("{family} was downloaded and activated, but it has no such style")),
                    ..FontResult::new(&name, "missing")
                }
            };
            results.insert(name, result);
        }
    }
    still
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::sync::{Mutex, OnceLock};

    fn temp_state() -> AppState {
        let root = std::env::temp_dir().join(format!("typeshelf-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("Fonts")).unwrap();
        AppState { db: Mutex::new(Db::open(&root.join("library.sqlite")).unwrap()), fonts_dir: root.join("Fonts"), system: OnceLock::new() }
    }

    fn req<'a>(method: &'a str, url: &'a str, body: &'a str) -> Request<'a> {
        Request { method, url, host: Some("127.0.0.1:47391"), origin: None, client: Some("Test"), body }
    }

    #[test]
    fn refuses_web_pages_and_foreign_hosts() {
        let state = temp_state();
        assert_eq!(route(&state, &req("GET", "/v1/status", "")).0, 200);
        assert_eq!(route(&state, &Request { host: Some("localhost:47391"), ..req("GET", "/v1/status", "") }).0, 200);
        assert_eq!(route(&state, &Request { host: Some("[::1]:47391"), ..req("GET", "/v1/status", "") }).0, 200);
        assert_eq!(route(&state, &Request { host: Some("evil.example:47391"), ..req("GET", "/v1/status", "") }).0, 403);
        assert_eq!(route(&state, &Request { host: None, ..req("GET", "/v1/status", "") }).0, 403);
        assert_eq!(route(&state, &Request { origin: Some("https://evil.example"), ..req("GET", "/v1/status", "") }).0, 403);
        assert_eq!(route(&state, &req("OPTIONS", "/v1/fonts/activate", "")).0, 403);
        let body = r#"{"fonts":["X"],"google":false}"#;
        assert_eq!(route(&state, &Request { client: None, ..req("POST", "/v1/fonts/activate", body) }).0, 403);
        assert_eq!(route(&state, &req("POST", "/v1/fonts/activate", "{")).0, 400);
        assert_eq!(route(&state, &req("GET", "/nope", "")).0, 404);
    }

    #[test]
    fn reports_system_and_missing_fonts() {
        let state = temp_state();
        let installed = system_faces(&state).first().map(|f| f.ps_name.clone());
        let mut fonts = vec!["Nonexistent-Font-123".to_string(), "Nonexistent-Font-123".to_string()];
        fonts.extend(installed.clone());
        let body = json!({ "fonts": fonts, "google": false }).to_string();
        let (code, value, activity) = route(&state, &req("POST", "/v1/fonts/activate", &body));
        assert_eq!(code, 200);
        let results = value["results"].as_array().unwrap();
        assert_eq!(results.len(), 1 + usize::from(installed.is_some()), "duplicates removed");
        assert_eq!(results[0]["status"], "missing");
        if installed.is_some() {
            assert_eq!(results[1]["status"], "system");
        }
        assert_eq!(activity.unwrap().missing, ["Nonexistent-Font-123"]);
    }

    #[test]
    fn status_tells_installed_from_unknown_fonts() {
        let state = temp_state();
        let installed = system_faces(&state).first().map(|f| f.ps_name.clone()).expect("at least one system font");
        let body = json!({ "fonts": [installed, "Nonexistent-Font-123"] }).to_string();
        let (code, value, activity) = route(&state, &req("POST", "/v1/fonts/status", &body));
        assert_eq!(code, 200);
        assert!(activity.is_none(), "read-only");
        assert_eq!(value["results"][0]["available"], true);
        assert_eq!(value["results"][1]["available"], false);
        assert_eq!(value["results"][1]["inLibrary"], false);
        assert_eq!(route(&state, &Request { client: None, ..req("POST", "/v1/fonts/status", &body) }).0, 403);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn core_text_knows_installed_fonts() {
        assert_eq!(activation::font_available("Helvetica"), Some(true));
        assert_eq!(activation::font_available("Nonexistent-Font-123"), Some(false));
    }

    #[test]
    fn guesses_google_family_from_postscript_name() {
        assert_eq!(family_key("PlayfairDisplay-BoldItalic"), squash("Playfair Display"));
        assert_eq!(family_key("Inter"), "inter");
    }
}

//! Local HTTP API used by the design-app plugins (Photoshop, Illustrator…) to activate
//! the fonts a document needs, identified by their PostScript names. The same plugins poll
//! it for what Typeshelf wants done in their application (see `bridge`).
//!
//! It listens on 127.0.0.1 only. Web pages cannot use it: requests must name one of our
//! own host names (no DNS rebinding), must not carry a web `Origin`, and activation needs
//! a custom header, which browsers only send after a CORS preflight that is never granted.

use crate::bridge::{self, Outcome, Selection};
use crate::library::manage;
use crate::model::{Face, Scope};
use crate::{activation, current, fonts, google, google_cache, import_blocking, machine, now, system_scan, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

pub const PORT: u16 = 47391;
const MAX_BODY: u64 = 64 * 1024;
const MAX_FONTS: usize = 500;

static ENABLED: AtomicBool = AtomicBool::new(true);
static ALLOW_GOOGLE: AtomicBool = AtomicBool::new(true);
static LISTENING: AtomicBool = AtomicBool::new(false);
static START_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// Where `figma-token` lives (Typeshelf's data folder), set once at start.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Routes for Figma's plugin panel. Its iframe has no origin ("null"), which the usual routes
/// refuse to answer through CORS; these ones do, but only for a request that carries the token
/// Typeshelf wrote into the installed plugin.
const FIGMA_PREFIX: &str = "/v1/figma/";

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

/// What a request asks of the main window.
#[derive(Clone, Debug)]
pub enum Event {
    Activity(Activity),
    Bridge(Outcome),
}

#[derive(Deserialize)]
struct PollRequest {
    #[serde(default)]
    document: Option<String>,
    #[serde(default)]
    can: Vec<String>,
}

#[derive(Deserialize)]
struct OutcomeRequest {
    id: u64,
    kind: String,
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    count: u32,
    #[serde(default)]
    selection: Option<Selection>,
}

#[derive(Deserialize)]
struct SelectionRequest {
    selection: Selection,
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
    /// `X-Typeshelf-Token`, required by the `/v1/figma/…` routes only.
    pub token: Option<&'a str>,
    pub body: &'a str,
}

/// Starts the listeners in the background, on IPv4 and IPv6 loopback: plugins call
/// `localhost` (Photoshop only grants network access by host name), which may resolve to
/// either. A port already in use is reported in the settings.
pub fn start(app: AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = DATA_DIR.set(dir);
    }
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
        let token = header("X-Typeshelf-Token");
        let method = request.method().as_str().to_string();
        let url = request.url().to_string();
        let mut body = String::new();
        let read = request.as_reader().take(MAX_BODY + 1).read_to_string(&mut body);
        let (code, value, event) = if read.is_err() || body.len() as u64 > MAX_BODY {
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
                    token: token.as_deref(),
                    body: &body,
                },
            )
        };
        match event {
            Some(Event::Activity(activity)) => {
                let _ = app.emit("plugin-activity", activity);
            }
            Some(Event::Bridge(outcome)) => {
                // A selection sent from the plugin's panel is looked at in Typeshelf.
                if outcome.id.is_none() {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                let _ = app.emit("bridge-result", outcome);
            }
            None => {}
        }
        let content_type = tiny_http::Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap();
        let mut response = tiny_http::Response::from_string(if code == 204 { String::new() } else { value.to_string() })
            .with_status_code(code)
            .with_header(content_type);
        if url.starts_with(FIGMA_PREFIX) && origin.as_deref() == Some("null") {
            for (name, value) in cors_headers(&method) {
                response.add_header(tiny_http::Header::from_bytes(name, value).unwrap());
            }
        }
        let _ = request.respond(response);
    }
}

/// CORS answer for Figma's panel: any origin, because the token is what authenticates it.
fn cors_headers(method: &str) -> Vec<(&'static str, &'static str)> {
    let mut headers = vec![("Access-Control-Allow-Origin", "*")];
    if method == "OPTIONS" {
        headers.push(("Access-Control-Allow-Methods", "GET, POST, OPTIONS"));
        headers.push(("Access-Control-Allow-Headers", "Content-Type, X-Typeshelf-Client, X-Typeshelf-Token"));
        headers.push(("Access-Control-Max-Age", "600"));
    }
    headers
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

pub fn route(state: &AppState, req: &Request) -> (u16, Value, Option<Event>) {
    if !ENABLED.load(Ordering::Relaxed) {
        return (503, error("Plugin API turned off in the Typeshelf settings"), None);
    }
    if let Err(e) = guard(req) {
        return (403, error(e), None);
    }
    let path = req.url.split('?').next().unwrap_or("");
    if let Some(rest) = path.strip_prefix(FIGMA_PREFIX) {
        return route_figma(state, req, rest);
    }
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
            (200, json!({ "results": results }), activity.map(Event::Activity))
        }
        ("POST", "/v1/bridge/poll") => with_body(req, |client, body: PollRequest| {
            let commands = bridge::global().poll(Instant::now(), &client, body.document.as_deref(), &body.can);
            (200, json!({ "commands": commands }), None)
        }),
        ("POST", "/v1/bridge/result") => with_body(req, |client, body: OutcomeRequest| {
            let kind = match body.kind.as_str() {
                bridge::APPLY => bridge::APPLY,
                bridge::SELECTION => bridge::SELECTION,
                _ => return (400, error("Unknown command kind"), None),
            };
            let outcome = Outcome {
                client,
                id: Some(body.id),
                kind,
                ok: body.ok,
                error: body.error.map(|e| bridge::clip(&e, 300)),
                count: body.count,
                selection: body.selection.and_then(Selection::clean),
            };
            (200, json!({}), Some(Event::Bridge(outcome)))
        }),
        ("POST", "/v1/bridge/selection") => with_body(req, |client, body: SelectionRequest| {
            let Some(selection) = body.selection.clean() else {
                return (400, error("The selection has no text"), None);
            };
            let count = selection.count;
            let outcome = Outcome { client, id: None, kind: bridge::SELECTION, ok: true, error: None, count, selection: Some(selection) };
            (200, json!({}), Some(Event::Bridge(outcome)))
        }),
        ("OPTIONS", _) => (403, error("Browser requests refused"), None),
        _ => (404, error("Unknown route"), None),
    }
}

/// Reads a bridge request: it must name its client and carry a JSON body.
fn with_body<T: serde::de::DeserializeOwned>(
    req: &Request,
    handle: impl FnOnce(String, T) -> (u16, Value, Option<Event>),
) -> (u16, Value, Option<Event>) {
    let Some(client) = req.client.map(|c| bridge::clip(c, 60)).filter(|c| !c.is_empty()) else {
        return (403, error("Missing X-Typeshelf-Client header"), None);
    };
    match serde_json::from_str(req.body) {
        Ok(body) => handle(client, body),
        Err(e) => (400, error(&format!("Invalid JSON body: {e}")), None),
    }
}

/// Activates the font if need be, then asks the plugin to apply it. Returns the command's id.
pub fn apply_font(state: &AppState, client: &str, ps_name: &str) -> Result<u64, String> {
    // Nothing is activated for an application that cannot take the font.
    bridge::global().can(Instant::now(), client, bridge::APPLY)?;
    let result = activate_fonts(state, &[ps_name.to_string()], Scope::Temporary, false).pop().ok_or("No font given")?;
    match result.status {
        "missing" => Err(format!("{ps_name} is not on this computer")),
        "error" => Err(result.message.unwrap_or_else(|| format!("{ps_name} could not be activated"))),
        _ => bridge::global().enqueue(Instant::now(), client, bridge::APPLY, Some(result.name)),
    }
}

/// The token Typeshelf gave the installed Figma plugin, compared without stopping at the first difference.
fn token_ok(given: Option<&str>) -> bool {
    let Some(expected) = DATA_DIR.get().and_then(|dir| crate::plugin_install::figma_token(dir)) else {
        return false;
    };
    let given = given.unwrap_or("");
    given.len() == expected.len() && given.bytes().zip(expected.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

/// `/v1/figma/status`, `/v1/figma/fonts/status` and `/v1/figma/fonts/activate`: the usual routes,
/// reached from Figma's null-origin panel with the token. A preflight carries no token (browsers
/// never send custom headers on it), so it is answered for the null origin only; the request that
/// follows is what is authenticated.
fn route_figma(state: &AppState, req: &Request, rest: &str) -> (u16, Value, Option<Event>) {
    let null_origin = req.origin == Some("null");
    if req.method == "OPTIONS" {
        return if null_origin { (204, Value::Null, None) } else { (403, error("Browser requests refused"), None) };
    }
    if !token_ok(req.token) {
        return (401, error("Missing or wrong token: install the Figma plugin again from Typeshelf"), None);
    }
    let url = format!("/v1/{rest}");
    route(state, &Request { url: &url, ..*req })
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

/// The faces whose files are here, from every known library. The open one comes first.
fn library_faces(state: &AppState) -> Vec<Face> {
    let open = current(state);
    let mut faces = open.lock().faces().unwrap_or_default();
    faces.extend(manage::faces_elsewhere(&state.data_dir, &machine(state), &open.id).unwrap_or_default());
    faces.retain(|f| Path::new(&f.path).exists());
    faces
}

/// Read-only: which of these fonts can already be used, and which the library holds.
pub fn font_status(state: &AppState, names: &[String]) -> Vec<FontStatus> {
    let scan = system_scan(state);
    let system: HashSet<&str> = scan.unique.iter().map(|f| f.ps_name.as_str()).collect();
    let library = library_faces(state);
    let machine = machine(state);
    names
        .iter()
        .map(|name| {
            let face = library.iter().find(|f| f.ps_name.eq_ignore_ascii_case(name));
            let active = face
                .is_some_and(|f| fonts::is_system_path(Path::new(&f.path)) || machine.scope_of(&f.path).is_ok_and(|s| s != Scope::None));
            FontStatus { name: name.clone(), available: active || os_has(name, &system), in_library: face.is_some() }
        })
        .collect()
}

fn activate_path(state: &AppState, path: &str, scope: Scope) -> Result<(), String> {
    let machine = machine(state);
    let previous = machine.scope_of(path)?;
    activation::activate(Path::new(path), scope, previous)?;
    machine.set_scope(path, scope)
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
    let scan = system_scan(state);
    let system: HashSet<&str> = scan.unique.iter().map(|f| f.ps_name.as_str()).collect();
    let mut results: BTreeMap<String, FontResult> = BTreeMap::new();
    let mut to_activate: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut missing: Vec<String> = Vec::new();

    let library = library_faces(state);
    for name in &wanted {
        let face = library.iter().find(|f| &f.ps_name == name).or_else(|| library.iter().find(|f| f.ps_name.eq_ignore_ascii_case(name)));
        match face {
            Some(face) if fonts::is_system_path(Path::new(&face.path)) => {
                results.insert(name.clone(), FontResult { family: Some(face.family.clone()), ..FontResult::new(name, "system") });
            }
            Some(face) => {
                let current = machine(state).scope_of(&face.path).unwrap_or(Scope::None);
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
    // Downloads go into the open library.
    if current(state).lock().read_only() {
        for name in &missing {
            let message = Some("This library is view-only".into());
            results.insert(name.clone(), FontResult { message, ..FontResult::new(name, "error") });
        }
        return Vec::new();
    }
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
        let fetched = google::download(entry, &current(state).fonts_dir().join("Google Fonts")).and_then(|files| {
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
        let library = current(state).lock().faces().unwrap_or_default();
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

    fn temp_state() -> AppState {
        AppState::for_tests(&std::env::temp_dir().join(format!("typeshelf-api-{}", uuid::Uuid::new_v4())))
    }

    fn req<'a>(method: &'a str, url: &'a str, body: &'a str) -> Request<'a> {
        Request { method, url, host: Some("127.0.0.1:47391"), origin: None, client: Some("Test"), token: None, body }
    }

    const FIGMA_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    /// Points the API at a data folder holding a Figma token (once for the whole test run).
    fn with_figma_token() {
        DATA_DIR.get_or_init(|| {
            let dir = std::env::temp_dir().join(format!("typeshelf-figma-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("figma-token"), FIGMA_TOKEN).unwrap();
            dir
        });
    }

    fn activity(event: Option<Event>) -> Activity {
        match event {
            Some(Event::Activity(activity)) => activity,
            other => panic!("not an activity: {other:?}"),
        }
    }

    fn figma<'a>(method: &'a str, url: &'a str, body: &'a str) -> Request<'a> {
        Request { origin: Some("null"), token: Some(FIGMA_TOKEN), client: Some("Figma"), ..req(method, url, body) }
    }

    #[test]
    fn figma_needs_its_token_and_a_null_origin_preflight() {
        with_figma_token();
        let state = temp_state();
        // The preflight has no token: it is answered for the null origin only.
        assert_eq!(route(&state, &Request { token: None, ..figma("OPTIONS", "/v1/figma/fonts/status", "") }).0, 204);
        assert_eq!(
            route(&state, &Request { origin: Some("https://evil.example"), ..figma("OPTIONS", "/v1/figma/fonts/status", "") }).0,
            403
        );
        assert_eq!(route(&state, &Request { origin: None, ..figma("OPTIONS", "/v1/figma/fonts/status", "") }).0, 403);
        // The request itself is authenticated by the token.
        assert_eq!(route(&state, &figma("GET", "/v1/figma/status", "")).0, 200);
        assert_eq!(route(&state, &Request { token: None, ..figma("GET", "/v1/figma/status", "") }).0, 401);
        assert_eq!(route(&state, &Request { token: Some("wrong"), ..figma("GET", "/v1/figma/status", "") }).0, 401);
        assert_eq!(route(&state, &Request { token: Some(&FIGMA_TOKEN[1..]), ..figma("GET", "/v1/figma/status", "") }).0, 401);
        // A web page cannot pass for Figma, token or not; nor can another host name.
        assert_eq!(route(&state, &Request { origin: Some("https://evil.example"), ..figma("GET", "/v1/figma/status", "") }).0, 403);
        assert_eq!(route(&state, &Request { host: Some("evil.example:47391"), ..figma("GET", "/v1/figma/status", "") }).0, 403);
        // The usual routes still refuse OPTIONS, with or without a token.
        assert_eq!(route(&state, &figma("OPTIONS", "/v1/fonts/activate", "")).0, 403);
        // Fonts go through the same handlers as the other plugins.
        let body = json!({ "fonts": ["Nonexistent-Font-123"], "google": false }).to_string();
        let (code, value, event) = route(&state, &figma("POST", "/v1/figma/fonts/activate", &body));
        assert_eq!(code, 200);
        assert_eq!(value["results"][0]["status"], "missing");
        assert_eq!(activity(event).client, "Figma");
        assert_eq!(route(&state, &figma("POST", "/v1/figma/fonts/status", &body)).0, 200);
        assert_eq!(route(&state, &figma("GET", "/v1/figma/nope", "")).0, 404);
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
        let installed = system_scan(&state).unique.first().map(|f| f.ps_name.clone());
        let mut fonts = vec!["Nonexistent-Font-123".to_string(), "Nonexistent-Font-123".to_string()];
        fonts.extend(installed.clone());
        let body = json!({ "fonts": fonts, "google": false }).to_string();
        let (code, value, event) = route(&state, &req("POST", "/v1/fonts/activate", &body));
        assert_eq!(code, 200);
        let results = value["results"].as_array().unwrap();
        assert_eq!(results.len(), 1 + usize::from(installed.is_some()), "duplicates removed");
        assert_eq!(results[0]["status"], "missing");
        if installed.is_some() {
            assert_eq!(results[1]["status"], "system");
        }
        assert_eq!(activity(event).missing, ["Nonexistent-Font-123"]);
    }

    #[test]
    fn status_tells_installed_from_unknown_fonts() {
        let state = temp_state();
        let installed = system_scan(&state).unique.first().map(|f| f.ps_name.clone()).expect("at least one system font");
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

    #[test]
    fn plugins_poll_for_commands_and_report_back() {
        let state = temp_state();
        // The bridge is shared by every test: this name is only used here.
        let client = "Bridge route test";
        let named = |url, body| Request { client: Some(client), ..req("POST", url, body) };
        let poll = r#"{"document":"poster.psd","can":["apply"]}"#;

        for url in ["/v1/bridge/poll", "/v1/bridge/result", "/v1/bridge/selection"] {
            assert_eq!(route(&state, &Request { client: None, ..req("POST", url, "{}") }).0, 403);
            assert_eq!(route(&state, &named(url, "{")).0, 400);
        }
        assert!(apply_font(&state, client, "Helvetica").is_err(), "not connected yet");
        assert_eq!(route(&state, &named("/v1/bridge/poll", poll)).1["commands"], json!([]));
        assert!(apply_font(&state, client, "Nonexistent-Font-123").is_err());

        let installed = system_scan(&state).unique.first().map(|f| f.ps_name.clone()).expect("at least one system font");
        let id = apply_font(&state, client, &installed).unwrap();
        let commands = route(&state, &named("/v1/bridge/poll", poll)).1["commands"].clone();
        assert_eq!(commands, json!([{ "id": id, "kind": "apply", "font": installed }]));

        let done = json!({ "id": id, "kind": "apply", "ok": true, "count": 2 }).to_string();
        match route(&state, &named("/v1/bridge/result", &done)) {
            (200, _, Some(Event::Bridge(o))) => assert_eq!((o.id, o.ok, o.count, o.client.as_str()), (Some(id), true, 2, client)),
            other => panic!("unexpected {other:?}"),
        }
        let unknown = json!({ "id": id, "kind": "delete", "ok": true }).to_string();
        assert_eq!(route(&state, &named("/v1/bridge/result", &unknown)).0, 400);

        match route(&state, &named("/v1/bridge/selection", r##"{"selection":{"text":"Summer","color":"#ffcc00","count":1}}"##)) {
            (200, _, Some(Event::Bridge(o))) => assert_eq!((o.id, o.selection.unwrap().text.as_str()), (None, "Summer")),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(route(&state, &named("/v1/bridge/selection", r#"{"selection":{"text":""}}"#)).0, 400);
    }

    #[test]
    fn plugin_api_finds_fonts_in_other_libraries() {
        let data = std::env::temp_dir().join(format!("typeshelf-api-{}", uuid::Uuid::new_v4()));
        let state = AppState::for_tests(&data);
        let font = current(&state).fonts_dir().join("elsewhere.ttf");
        std::fs::write(&font, b"font").unwrap();
        let face: Face = serde_json::from_value(json!({
            "id": "f1", "path": font, "faceIndex": 0, "psName": "TypeshelfElsewhere-Regular", "family": "Typeshelf Elsewhere",
            "style": "Regular", "fullName": "Typeshelf Elsewhere", "weight": 400, "width": 5, "italic": false, "mono": false,
            "classification": "sans", "version": null, "designer": null, "manufacturer": null, "license": null,
            "copyright": null, "glyphCount": 1, "variable": false, "features": [], "starred": false, "addedAt": 0,
            "available": true, "importedOn": null
        }))
        .unwrap();
        current(&state).lock().add_faces(std::slice::from_ref(&face)).unwrap();
        crate::libraries::create(&state, data.join("Other")).unwrap();
        assert!(current(&state).lock().faces().unwrap().is_empty());

        let names = [face.ps_name.clone()];
        assert!(font_status(&state, &names)[0].in_library);
        // A file that is not there is as good as not in the library.
        std::fs::remove_file(&font).unwrap();
        assert!(!font_status(&state, &names)[0].in_library);
        let _ = std::fs::remove_dir_all(data);
    }
}

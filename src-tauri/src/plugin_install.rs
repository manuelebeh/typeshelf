//! Installs the plugins bundled with Typeshelf where each design application looks for them.
//!
//! | Plugin                   | macOS (`~/Library/Application Support/…`) and Windows (`%APPDATA%\…`) |
//! |--------------------------|------------------------------------------------------------------------|
//! | Photoshop (UXP)          | `Adobe/UXP/Plugins/External/<id>`, registered in `Adobe/UXP/PluginsInfo/v1/PS.json` |
//! | Illustrator, After Effects (CEP) | `Adobe/CEP/extensions/<id>`                                    |
//! | InDesign (CEP)           | `Adobe/CEP/extensions/dev.typeshelf.indesign`                          |
//! | Sketch (macOS only)      | `com.bohemiancoding.sketch3/Plugins/Typeshelf.sketchplugin`            |
//! | Figma                    | `<Typeshelf data folder>/figma-plugin`, imported once in Figma from its `manifest.json` |
//!
//! Adobe only loads an unsigned CEP extension in debug mode (`PlayerDebugMode`), so installing
//! one turns it on when the bundled extension carries no signature, and removing the last one
//! turns it back off for the versions Typeshelf changed.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Uxp,
    Cep,
    Sketch,
    /// Figma has no folder to drop a plugin into: it is imported from its manifest. The copy
    /// carries the token that lets its panel use the local API.
    Figma,
}

struct Plugin {
    id: &'static str,
    name: &'static str,
    kind: Kind,
    /// Folder inside the bundled `plugins` resources.
    source: &'static str,
    /// Folder name once installed.
    folder: &'static str,
    /// Start of the application's folder name in /Applications or Program Files.
    app: &'static str,
    /// Windows executable, to tell whether the application is running.
    #[cfg_attr(not(windows), allow(dead_code))]
    exe: &'static str,
}

const PLUGINS: [Plugin; 6] = [
    Plugin {
        id: "photoshop",
        name: "Photoshop",
        kind: Kind::Uxp,
        source: "photoshop",
        folder: "dev.typeshelf.photoshop",
        app: "Adobe Photoshop",
        exe: "Photoshop.exe",
    },
    Plugin {
        id: "illustrator",
        name: "Illustrator",
        kind: Kind::Cep,
        source: "illustrator",
        folder: "dev.typeshelf.illustrator",
        app: "Adobe Illustrator",
        exe: "Illustrator.exe",
    },
    Plugin {
        id: "after-effects",
        name: "After Effects",
        kind: Kind::Cep,
        source: "after-effects",
        folder: "dev.typeshelf.aftereffects",
        app: "Adobe After Effects",
        exe: "AfterFX.exe",
    },
    Plugin {
        id: "indesign",
        name: "InDesign",
        kind: Kind::Cep,
        source: "indesign",
        folder: "dev.typeshelf.indesign",
        app: "Adobe InDesign",
        exe: "InDesign.exe",
    },
    Plugin {
        id: "sketch",
        name: "Sketch",
        kind: Kind::Sketch,
        source: "sketch/Typeshelf.sketchplugin",
        folder: "Typeshelf.sketchplugin",
        app: "Sketch",
        exe: "",
    },
    Plugin { id: "figma", name: "Figma", kind: Kind::Figma, source: "figma", folder: "figma-plugin", app: "Figma", exe: "Figma.exe" },
];

/// CSXS versions whose debug mode Typeshelf may turn on: CEP 9 (2019) to CEP 12 (2021 and later),
/// plus the next one.
const CSXS_VERSIONS: std::ops::RangeInclusive<u32> = 9..=13;

const PHOTOSHOP_ID: &str = "dev.typeshelf.photoshop";

/// Replaced by the token in the Figma panel (`ui.html`) when it is installed.
const TOKEN_PLACEHOLDER: &str = "__TYPESHELF_TOKEN__";
const FIGMA_PANEL: &str = "ui.html";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub id: &'static str,
    pub name: &'static str,
    /// "installed" | "outdated" (an older copy) | "absent"
    pub state: &'static str,
    /// The application was found in its usual folder.
    pub app_found: bool,
    pub app_running: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub plugin: PluginState,
    /// The application is open and only sees the change after a restart.
    pub restart: bool,
    /// Where the plugin was copied (Figma imports it from there).
    pub path: String,
    /// Adobe's debug mode for unsigned extensions was turned on by this install.
    pub debug_mode: bool,
}

/// Where things are: the bundled plugins, the user's application support folder
/// (`~/Library/Application Support` or `%APPDATA%`) and Typeshelf's own data folder.
pub struct Env {
    pub resources: PathBuf,
    pub support: PathBuf,
    pub data_dir: PathBuf,
    /// Off in tests: they must not touch the real Adobe preferences or look for real apps.
    pub system: bool,
}

impl Env {
    pub fn new(resources: PathBuf, data_dir: PathBuf) -> Option<Env> {
        let support = if cfg!(target_os = "macos") {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
        } else if cfg!(windows) {
            std::env::var_os("APPDATA").map(PathBuf::from)
        } else {
            None
        }?;
        Some(Env { resources, support, data_dir, system: true })
    }

    fn source(&self, plugin: &Plugin) -> PathBuf {
        self.resources.join(plugin.source)
    }

    fn destination(&self, plugin: &Plugin) -> PathBuf {
        match plugin.kind {
            Kind::Uxp => self.support.join("Adobe/UXP/Plugins/External").join(plugin.folder),
            Kind::Cep => self.support.join("Adobe/CEP/extensions").join(plugin.folder),
            Kind::Sketch => self.support.join("com.bohemiancoding.sketch3/Plugins").join(plugin.folder),
            Kind::Figma => self.data_dir.join(plugin.folder),
        }
    }

    fn photoshop_registry(&self) -> PathBuf {
        self.support.join("Adobe/UXP/PluginsInfo/v1/PS.json")
    }

    fn token_path(&self) -> PathBuf {
        self.data_dir.join(FIGMA_TOKEN_FILE)
    }

    fn record_path(&self) -> PathBuf {
        self.data_dir.join("plugins.json")
    }
}

const FIGMA_TOKEN_FILE: &str = "figma-token";

/// The secret the Figma panel presents to the local API. Figma's plugin iframe has no origin, so
/// a web page could pass for it; only a file on this computer can know the token.
pub fn figma_token(data_dir: &Path) -> Option<String> {
    fs::read_to_string(data_dir.join(FIGMA_TOKEN_FILE)).ok().map(|t| t.trim().to_string()).filter(|t| t.len() >= 32)
}

fn ensure_figma_token(env: &Env) -> Result<String, String> {
    if let Some(token) = figma_token(&env.data_dir) {
        return Ok(token);
    }
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    fs::create_dir_all(&env.data_dir).map_err(|e| e.to_string())?;
    let path = env.token_path();
    fs::write(&path, &token).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

/// What a bundled file becomes once installed: only the Figma panel changes (it receives the token).
type Render<'a> = &'a dyn Fn(&Path, Vec<u8>) -> Vec<u8>;

fn renderer(plugin: &Plugin, token: Option<String>) -> impl Fn(&Path, Vec<u8>) -> Vec<u8> {
    let figma = plugin.kind == Kind::Figma;
    move |file: &Path, bytes: Vec<u8>| match (&token, figma && file == Path::new(FIGMA_PANEL)) {
        (token, true) => String::from_utf8_lossy(&bytes).replace(TOKEN_PLACEHOLDER, token.as_deref().unwrap_or("")).into_bytes(),
        _ => bytes,
    }
}

/// The plugins that can be installed on this system.
fn available() -> impl Iterator<Item = &'static Plugin> {
    PLUGINS.iter().filter(|p| cfg!(target_os = "macos") || (cfg!(windows) && p.kind != Kind::Sketch))
}

fn find(id: &str) -> Result<&'static Plugin, String> {
    available().find(|p| p.id == id).ok_or_else(|| format!("Unknown plugin: {id}"))
}

pub fn list(env: &Env) -> Vec<PluginState> {
    available().map(|p| state(env, p)).collect()
}

fn state(env: &Env, plugin: &Plugin) -> PluginState {
    let destination = env.destination(plugin);
    let installed = destination.exists() && (plugin.kind != Kind::Uxp || photoshop_registered(env));
    let state = if !installed {
        "absent"
    } else if same_tree(&env.source(plugin), &destination, &renderer(plugin, figma_token(&env.data_dir))) {
        "installed"
    } else {
        "outdated"
    };
    PluginState {
        id: plugin.id,
        name: plugin.name,
        state,
        app_found: env.system && app_found(plugin),
        app_running: env.system && app_running(plugin),
    }
}

pub fn install(env: &Env, id: &str) -> Result<InstallOutcome, String> {
    let plugin = find(id)?;
    let source = env.source(plugin);
    if !source.is_dir() {
        return Err(format!("The {} plugin is missing from this copy of Typeshelf", plugin.name));
    }
    let running = env.system && app_running(plugin);
    if plugin.kind == Kind::Uxp && running {
        return Err("Quit Photoshop, then install the plugin again: Photoshop rewrites its plugin list when it quits.".into());
    }
    let token = if plugin.kind == Kind::Figma { Some(ensure_figma_token(env)?) } else { None };
    let destination = env.destination(plugin);
    copy_tree(&source, &destination, &renderer(plugin, token)).map_err(|e| format!("Could not copy the {} plugin: {e}", plugin.name))?;
    let mut debug_mode = false;
    match plugin.kind {
        Kind::Uxp => register_photoshop(env, &source)?,
        Kind::Cep if !source.join("META-INF/signatures.xml").exists() => debug_mode = enable_debug_mode(env)?,
        _ => {}
    }
    Ok(InstallOutcome {
        plugin: state(env, plugin),
        // Figma imports the plugin from its folder: nothing has to be restarted.
        restart: running && plugin.kind != Kind::Figma,
        path: destination.display().to_string(),
        debug_mode,
    })
}

pub fn uninstall(env: &Env, id: &str) -> Result<PluginState, String> {
    let plugin = find(id)?;
    if plugin.kind == Kind::Uxp && env.system && app_running(plugin) {
        return Err("Quit Photoshop, then remove the plugin again: Photoshop rewrites its plugin list when it quits.".into());
    }
    remove(&env.destination(plugin)).map_err(|e| format!("Could not remove the {} plugin: {e}", plugin.name))?;
    if plugin.kind == Kind::Figma {
        // A new install gets a new token: the old panel stops working.
        let _ = fs::remove_file(env.token_path());
    }
    match plugin.kind {
        Kind::Uxp => unregister_photoshop(env)?,
        Kind::Cep if !available().any(|p| p.kind == Kind::Cep && env.destination(p).exists()) => restore_debug_mode(env)?,
        _ => {}
    }
    Ok(state(env, plugin))
}

// ---------------------------------------------------------------- files

/// Files of a plugin folder, without hidden ones (`.debug` opens a debugging port, `.DS_Store`).
fn files(root: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.path().strip_prefix(root).ok().map(Path::to_path_buf))
        .collect();
    files.sort();
    files
}

fn same_tree(source: &Path, destination: &Path, render: Render) -> bool {
    let wanted = files(source);
    !wanted.is_empty()
        && wanted == files(destination)
        && wanted.iter().all(|f| fs::read(source.join(f)).ok().map(|bytes| render(f, bytes)) == fs::read(destination.join(f)).ok())
}

/// Removes a plugin folder, or the link that stands for it (left by a development setup).
fn remove(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Copies into a temporary folder first, so a failed copy never leaves half a plugin.
fn copy_tree(source: &Path, destination: &Path, render: Render) -> std::io::Result<()> {
    let parent = destination.parent().ok_or_else(|| std::io::Error::other("no parent folder"))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".{}.typeshelf-tmp", destination.file_name().unwrap_or_default().to_string_lossy()));
    remove(&staging)?;
    for file in files(source) {
        let target = staging.join(&file);
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&target, render(&file, fs::read(source.join(&file))?))?;
    }
    remove(destination)?;
    fs::rename(&staging, destination)
}

// ---------------------------------------------------------------- Photoshop

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("{} is not valid JSON: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("no parent folder")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staging = path.with_extension("json.typeshelf-tmp");
    fs::write(&staging, value.to_string()).map_err(|e| e.to_string())?;
    fs::rename(&staging, path).map_err(|e| e.to_string())
}

fn photoshop_registered(env: &Env) -> bool {
    read_json(&env.photoshop_registry())
        .ok()
        .flatten()
        .and_then(|v| v["plugins"].as_array().map(|list| list.iter().any(|p| p["pluginId"] == PHOTOSHOP_ID)))
        .unwrap_or(false)
}

/// Adds Typeshelf to the plugins Photoshop loads, keeping every other entry as it is.
fn register_photoshop(env: &Env, source: &Path) -> Result<(), String> {
    let manifest = read_json(&source.join("manifest.json"))?.ok_or("manifest.json missing")?;
    let path = env.photoshop_registry();
    let mut registry = read_json(&path)?.unwrap_or_else(|| json!({ "plugins": [] }));
    let Some(plugins) = registry.get_mut("plugins").and_then(Value::as_array_mut) else {
        return Err(format!("{} has no plugin list", path.display()));
    };
    plugins.retain(|p| p["pluginId"] != PHOTOSHOP_ID);
    plugins.push(json!({
        "hostMinVersion": manifest["host"]["minVersion"],
        "name": manifest["name"],
        "path": format!("$localPlugins/External/{PHOTOSHOP_ID}"),
        "pluginId": PHOTOSHOP_ID,
        "status": "enabled",
        "type": "uxp",
        "versionString": manifest["version"],
    }));
    write_json(&path, &registry)
}

fn unregister_photoshop(env: &Env) -> Result<(), String> {
    let path = env.photoshop_registry();
    let Some(mut registry) = read_json(&path)? else {
        return Ok(());
    };
    if let Some(plugins) = registry.get_mut("plugins").and_then(Value::as_array_mut) {
        plugins.retain(|p| p["pluginId"] != PHOTOSHOP_ID);
    }
    write_json(&path, &registry)
}

// ---------------------------------------------------------------- CEP debug mode

/// The CSXS versions whose debug mode Typeshelf turned on, to turn them back off later.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(default)]
    debug_mode_versions: Vec<u32>,
}

fn load_record(env: &Env) -> Record {
    read_json(&env.record_path()).ok().flatten().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn save_record(env: &Env, record: &Record) -> Result<(), String> {
    write_json(&env.record_path(), &serde_json::to_value(record).map_err(|e| e.to_string())?)
}

/// Turns debug mode on where it is off. Returns whether anything changed.
fn enable_debug_mode(env: &Env) -> Result<bool, String> {
    let mut record = load_record(env);
    let mut changed = false;
    for version in CSXS_VERSIONS {
        if env.system && !debug_mode::is_on(version) {
            debug_mode::set(version, true)?;
            if !record.debug_mode_versions.contains(&version) {
                record.debug_mode_versions.push(version);
            }
            changed = true;
        }
    }
    save_record(env, &record)?;
    Ok(changed)
}

fn restore_debug_mode(env: &Env) -> Result<(), String> {
    let mut record = load_record(env);
    for version in std::mem::take(&mut record.debug_mode_versions) {
        if env.system {
            debug_mode::set(version, false)?;
        }
    }
    save_record(env, &record)
}

#[cfg(target_os = "macos")]
mod debug_mode {
    use std::process::Command;

    fn domain(version: u32) -> String {
        format!("com.adobe.CSXS.{version}")
    }

    pub fn is_on(version: u32) -> bool {
        Command::new("defaults")
            .args(["read", &domain(version), "PlayerDebugMode"])
            .output()
            .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "1")
    }

    pub fn set(version: u32, on: bool) -> Result<(), String> {
        let args: Vec<String> = if on {
            ["write", &domain(version), "PlayerDebugMode", "1"].map(String::from).to_vec()
        } else {
            ["delete", &domain(version), "PlayerDebugMode"].map(String::from).to_vec()
        };
        let status = Command::new("defaults").args(&args).status().map_err(|e| e.to_string())?;
        // Deleting a key that is already gone is fine.
        if status.success() || !on {
            Ok(())
        } else {
            Err(format!("could not change {}", domain(version)))
        }
    }
}

#[cfg(windows)]
mod debug_mode {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn key(version: u32) -> Vec<u16> {
        wide(&format!("Software\\Adobe\\CSXS.{version}"))
    }

    pub fn is_on(version: u32) -> bool {
        let mut buffer = [0u16; 8];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        let name = wide("PlayerDebugMode");
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key(version).as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        status == ERROR_SUCCESS && buffer[0] == u16::from(b'1') && buffer[1] == 0
    }

    pub fn set(version: u32, on: bool) -> Result<(), String> {
        let name = wide("PlayerDebugMode");
        if on {
            let value = wide("1");
            let status = unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    key(version).as_ptr(),
                    name.as_ptr(),
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                )
            };
            if status != ERROR_SUCCESS {
                return Err(format!("could not write to the registry (code {status})"));
            }
        } else {
            unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key(version).as_ptr(), name.as_ptr()) };
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod debug_mode {
    pub fn is_on(_version: u32) -> bool {
        true
    }

    pub fn set(_version: u32, _on: bool) -> Result<(), String> {
        Ok(())
    }
}

// ---------------------------------------------------------------- applications

fn app_found(plugin: &Plugin) -> bool {
    let mut roots: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        roots.push(PathBuf::from("/Applications"));
        roots.extend(std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Applications")));
    } else if cfg!(windows) {
        roots.extend(std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("Adobe")));
        // Figma installs per user.
        roots.extend(std::env::var_os("LOCALAPPDATA").map(PathBuf::from));
    }
    roots.iter().filter_map(|root| fs::read_dir(root).ok()).flatten().filter_map(Result::ok).any(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        if cfg!(target_os = "macos") && matches!(plugin.kind, Kind::Sketch | Kind::Figma) {
            name == format!("{}.app", plugin.app)
        } else {
            name.starts_with(plugin.app)
        }
    })
}

#[cfg(target_os = "macos")]
fn app_running(plugin: &Plugin) -> bool {
    let pattern = if matches!(plugin.kind, Kind::Sketch | Kind::Figma) {
        format!("/{}.app/Contents/MacOS/", plugin.app)
    } else {
        format!("/{}[^/]*\\.app/Contents/MacOS/", plugin.app)
    };
    std::process::Command::new("pgrep").args(["-f", &pattern]).output().is_ok_and(|o| o.status.success())
}

#[cfg(windows)]
fn app_running(plugin: &Plugin) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    !plugin.exe.is_empty()
        && std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {}", plugin.exe), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).to_ascii_lowercase().contains(&plugin.exe.to_ascii_lowercase()))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn app_running(_plugin: &Plugin) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_env() -> Env {
        let root = std::env::temp_dir().join(format!("typeshelf-plugins-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Env {
            resources: Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins"),
            support: root.join("support"),
            data_dir: root.join("data"),
            system: false,
        }
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn installs_updates_and_removes_every_plugin() {
        let env = temp_env();
        assert!(list(&env).iter().all(|p| p.state == "absent"));
        for plugin in available() {
            let outcome = install(&env, plugin.id).unwrap();
            assert_eq!(outcome.plugin.state, "installed", "{}", plugin.id);
            let destination = env.destination(plugin);
            assert!(!files(&destination).is_empty());
            assert!(!destination.join(".debug").exists(), "hidden files stay out");
            assert!(fs::read_dir(destination.parent().unwrap()).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with("tmp")));

            // A changed file makes it outdated, and installing again replaces it.
            let first = destination.join(&files(&destination)[0]);
            fs::write(&first, "changed").unwrap();
            assert_eq!(state(&env, plugin).state, "outdated");
            assert_eq!(install(&env, plugin.id).unwrap().plugin.state, "installed");
        }
        assert!(photoshop_registered(&env));

        for plugin in available() {
            assert_eq!(uninstall(&env, plugin.id).unwrap().state, "absent");
            assert!(!env.destination(plugin).exists());
        }
        assert!(!photoshop_registered(&env));
        assert!(install(&env, "nope").is_err());
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn figma_panel_gets_the_token_and_loses_it_on_removal() {
        let env = temp_env();
        let outcome = install(&env, "figma").unwrap();
        let token = figma_token(&env.data_dir).expect("token written");
        assert!(outcome.path.ends_with("figma-plugin"));
        let panel = fs::read_to_string(Path::new(&outcome.path).join("ui.html")).unwrap();
        assert!(panel.contains(&token) && !panel.contains(TOKEN_PLACEHOLDER));
        assert!(Path::new(&outcome.path).join("manifest.json").exists());
        // Installing again keeps the same token; the bundled panel stays a template.
        install(&env, "figma").unwrap();
        assert_eq!(figma_token(&env.data_dir), Some(token));
        assert!(fs::read_to_string(env.resources.join("figma/ui.html")).unwrap().contains(TOKEN_PLACEHOLDER));
        uninstall(&env, "figma").unwrap();
        assert_eq!(figma_token(&env.data_dir), None, "the old panel stops working");
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn keeps_other_photoshop_plugins() {
        let env = temp_env();
        let other = json!({ "pluginId": "com.example.other", "name": "Other", "status": "enabled", "type": "uxp" });
        write_json(&env.photoshop_registry(), &json!({ "plugins": [other.clone()], "extra": 1 })).unwrap();
        install(&env, "photoshop").unwrap();
        install(&env, "photoshop").unwrap();
        let registry = read_json(&env.photoshop_registry()).unwrap().unwrap();
        let plugins = registry["plugins"].as_array().unwrap();
        assert_eq!(plugins.len(), 2, "registered once");
        assert_eq!(plugins[0], other);
        assert_eq!(plugins[1]["path"], "$localPlugins/External/dev.typeshelf.photoshop");
        assert_eq!(plugins[1]["versionString"], env!("CARGO_PKG_VERSION"));
        assert_eq!(registry["extra"], 1);
        uninstall(&env, "photoshop").unwrap();
        let registry = read_json(&env.photoshop_registry()).unwrap().unwrap();
        assert_eq!(registry["plugins"], json!([other]));
    }

    #[cfg(unix)]
    #[test]
    fn replaces_a_development_link() {
        let env = temp_env();
        let Some(plugin) = available().find(|p| p.kind == Kind::Cep) else {
            return;
        };
        let destination = env.destination(plugin);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(env.source(plugin), &destination).unwrap();
        assert_eq!(state(&env, plugin).state, "installed");
        install(&env, plugin.id).unwrap();
        assert!(!fs::symlink_metadata(&destination).unwrap().file_type().is_symlink());
        assert!(env.source(plugin).join("index.html").exists(), "the linked folder is left alone");
    }
}

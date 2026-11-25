//! OS-specific font activation.
//!
//! | OS      | Persistent                                      | Temporary (until Typeshelf quits)        |
//! |---------|-------------------------------------------------|------------------------------------------|
//! | macOS   | CoreText, user scope                            | CoreText, session scope                  |
//! | Windows | AddFontResourceEx + HKCU\…\Fonts registry value | AddFontResourceEx only                   |
//! | Linux   | symlink in ~/.local/share/fonts/typeshelf       | symlink in …/fonts/typeshelf-temporary   |

use crate::model::Scope;
use std::path::Path;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

/// Registering and unregistering a file that is not recorded as active, so that moves can be
/// tested without touching the fonts of the system.
pub struct Activator<'a> {
    pub on: &'a dyn Fn(&Path, Scope) -> Result<(), String>,
    pub off: &'a dyn Fn(&Path, Scope) -> Result<(), String>,
}

impl Activator<'static> {
    pub const SYSTEM: Self = Activator { on: &|path, scope| activate(path, scope, Scope::None), off: &deactivate };
}

/// Registers `path` with `scope`. `previous` is the scope Typeshelf last recorded.
pub fn activate(path: &Path, scope: Scope, previous: Scope) -> Result<(), String> {
    if scope == Scope::None {
        return deactivate(path, previous);
    }
    if !path.exists() {
        return Err(format!("{}: file not found", display(path)));
    }
    if previous == scope {
        return Ok(());
    }
    if previous != Scope::None {
        platform::deactivate(path, previous).map_err(|e| format!("{}: {e}", display(path)))?;
    }
    platform::activate(path, scope).map_err(|e| format!("{}: {e}", display(path)))
}

pub fn deactivate(path: &Path, previous: Scope) -> Result<(), String> {
    if previous == Scope::None {
        return Ok(());
    }
    platform::deactivate(path, previous).map_err(|e| format!("{}: {e}", display(path)))
}

/// Notifies the OS once after a batch of changes (font cache refresh, broadcast…).
pub fn finish_batch() {
    platform::finish_batch();
}

/// Removes leftovers of temporary activations (e.g. after a crash).
pub fn clean_temporary_leftovers() {
    platform::clean_temporary_leftovers();
}

/// The scope the OS reports, when the platform can tell (macOS only).
pub fn system_scope(path: &Path) -> Option<Scope> {
    platform::system_scope(path)
}

fn display(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Whether the OS can already render a font with this PostScript name, when it can tell:
/// CoreText on macOS, fontconfig on Linux, GDI full names on Windows.
pub fn font_available(ps_name: &str) -> Option<bool> {
    platform::font_available(ps_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// The OS can take a moment to notice a change (fontconfig rescans, GDI broadcasts).
    fn becomes(expected: bool, ps_name: &str) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(30) {
            if font_available(ps_name) == Some(expected) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        false
    }

    /// Downloads a family the CI machines do not have, then activates and deactivates it for
    /// real, temporarily and permanently. CI runs it on macOS, Windows and Linux with
    /// `cargo test -- --ignored activates_a_font_for_real`.
    #[test]
    #[ignore = "downloads from Google Fonts and changes the fonts of this session"]
    fn activates_a_font_for_real() {
        let dir = std::env::temp_dir().join(format!("typeshelf-activation-{}", uuid::Uuid::new_v4()));
        let catalog = crate::google::catalog(&dir.join("cache.json"), true, 0).unwrap();
        let family = catalog.families.iter().find(|f| f.family == "Lora").expect("Lora in the catalog");
        let files = crate::google::download(family, &dir.join("fonts")).unwrap();
        let file = files.iter().find(|f| !f.to_string_lossy().contains("Italic")).unwrap_or(&files[0]);
        let face = crate::fonts::scan(file, 0).unwrap().remove(0);
        let ps_name = face.ps_name.as_str();
        assert_eq!(font_available(ps_name), Some(false), "{ps_name} must not be installed already");

        for scope in [Scope::Temporary, Scope::Persistent] {
            activate(file, scope, Scope::None).unwrap();
            finish_batch();
            assert!(becomes(true, ps_name), "{ps_name} active ({scope:?})");
            if let Some(reported) = system_scope(file) {
                assert_eq!(reported, scope);
            }
            activate(file, Scope::None, scope).unwrap();
            finish_batch();
            assert!(becomes(false, ps_name), "{ps_name} inactive again ({scope:?})");
        }
        clean_temporary_leftovers();
        let _ = std::fs::remove_dir_all(dir);
    }
}

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

/// Registers `path` with `scope`. `previous` is the scope Typeshelf last recorded.
pub fn activate(path: &Path, scope: Scope, previous: Scope) -> Result<(), String> {
    if scope == Scope::None {
        return deactivate(path, previous);
    }
    if !path.exists() {
        return Err(format!("{} : fichier introuvable", display(path)));
    }
    if previous == scope {
        return Ok(());
    }
    if previous != Scope::None {
        platform::deactivate(path, previous).map_err(|e| format!("{} : {e}", display(path)))?;
    }
    platform::activate(path, scope).map_err(|e| format!("{} : {e}", display(path)))
}

pub fn deactivate(path: &Path, previous: Scope) -> Result<(), String> {
    if previous == Scope::None {
        return Ok(());
    }
    platform::deactivate(path, previous).map_err(|e| format!("{} : {e}", display(path)))
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

/// Whether the OS can already render a font with this PostScript name, when it can tell.
pub fn font_available(ps_name: &str) -> Option<bool> {
    platform::font_available(ps_name)
}

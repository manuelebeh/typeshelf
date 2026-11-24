use crate::model::Scope;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Graphics::Gdi::{AddFontResourceExW, RemoveFontResourceExW};
use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_FONTCHANGE};

/// Per-user font registrations (Windows 10 1809+) are read from this key at logon.
const FONTS_KEY: &str = "Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Registry value name: unique per file so several Typeshelf fonts can coexist.
fn value_name(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{stem} (Typeshelf)")
}

pub fn activate(path: &Path, scope: Scope) -> Result<(), String> {
    let file = wide_path(path);
    let added = unsafe { AddFontResourceExW(file.as_ptr(), 0, std::ptr::null()) };
    if added == 0 {
        return Err("Windows a refusé de charger cette police".into());
    }
    if scope == Scope::Persistent {
        let key = wide(FONTS_KEY);
        let name = wide(&value_name(path));
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                file.as_ptr().cast(),
                (file.len() * 2) as u32,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("écriture du registre impossible (code {status})"));
        }
    }
    Ok(())
}

pub fn deactivate(path: &Path, previous: Scope) -> Result<(), String> {
    let file = wide_path(path);
    // Several AddFontResource calls stack up: remove until none are left.
    for _ in 0..8 {
        if unsafe { RemoveFontResourceExW(file.as_ptr(), 0, std::ptr::null()) } == 0 {
            break;
        }
    }
    if previous == Scope::Persistent {
        let key = wide(FONTS_KEY);
        let name = wide(&value_name(path));
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) };
    }
    Ok(())
}

pub fn finish_batch() {
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0, SMTO_ABORTIFHUNG, 1000, std::ptr::null_mut());
    }
}

/// Temporary registrations end with the session, so nothing is left behind on disk.
pub fn clean_temporary_leftovers() {}

pub fn system_scope(_path: &Path) -> Option<Scope> {
    None
}

/// Not known on this platform: callers fall back to the scanned font folders.
pub fn font_available(_ps_name: &str) -> Option<bool> {
    None
}

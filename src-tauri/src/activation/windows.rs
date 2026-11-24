use crate::model::Scope;
use std::collections::HashSet;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Foundation::LPARAM;
use windows_sys::Win32::Graphics::Gdi::{
    AddFontResourceExW, EnumFontFamiliesExW, GetDC, ReleaseDC, RemoveFontResourceExW, DEFAULT_CHARSET, ENUMLOGFONTEXW, LOGFONTW,
    TEXTMETRICW,
};
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
        return Err("Windows refused to load this font".into());
    }
    if scope == Scope::Persistent {
        let key = wide(FONTS_KEY);
        let name = wide(&value_name(path));
        let status = unsafe {
            RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, file.as_ptr().cast(), (file.len() * 2) as u32)
        };
        if status != ERROR_SUCCESS {
            return Err(format!("could not write to the registry (code {status})"));
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
    if let Ok(mut known) = KNOWN.lock() {
        *known = None;
    }
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0, SMTO_ABORTIFHUNG, 1000, std::ptr::null_mut());
    }
}

/// Temporary registrations end with the session, so nothing is left behind on disk.
pub fn clean_temporary_leftovers() {}

pub fn system_scope(_path: &Path) -> Option<Scope> {
    None
}

/// Full names of the fonts GDI can use, without spaces or punctuation, kept a few seconds:
/// a plugin asks for many names at once.
static KNOWN: Mutex<Option<(Instant, HashSet<String>)>> = Mutex::new(None);

fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

fn utf16(chars: &[u16]) -> String {
    let end = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
    String::from_utf16_lossy(&chars[..end])
}

unsafe extern "system" fn collect(font: *const LOGFONTW, _metrics: *const TEXTMETRICW, _kind: u32, found: LPARAM) -> i32 {
    // GDI passes an ENUMLOGFONTEXW, which starts with the LOGFONTW.
    let font = &*(font as *const ENUMLOGFONTEXW);
    let found = &mut *(found as *mut Vec<(String, String)>);
    found.push((utf16(&font.elfLogFont.lfFaceName), utf16(&font.elfFullName)));
    1
}

/// Every style of every family GDI knows: installed, or loaded with AddFontResource by
/// Typeshelf or another font manager.
fn gdi_full_names() -> Option<HashSet<String>> {
    unsafe {
        let dc = GetDC(std::ptr::null_mut());
        if dc.is_null() {
            return None;
        }
        let enumerate = |face: &str| {
            let mut wanted: LOGFONTW = std::mem::zeroed();
            wanted.lfCharSet = DEFAULT_CHARSET;
            for (slot, c) in wanted.lfFaceName.iter_mut().zip(face.encode_utf16().take(31)) {
                *slot = c;
            }
            let mut found: Vec<(String, String)> = Vec::new();
            EnumFontFamiliesExW(dc, &wanted, Some(collect), &mut found as *mut _ as LPARAM, 0);
            found
        };
        // An empty name lists one entry per family; a family name lists its styles.
        let families: HashSet<String> = enumerate("").into_iter().map(|(family, _)| family).filter(|f| !f.starts_with('@')).collect();
        let mut names = HashSet::new();
        for family in families {
            for (_, full) in enumerate(&family) {
                names.insert(squash(&full));
            }
        }
        ReleaseDC(std::ptr::null_mut(), dc);
        Some(names)
    }
}

/// Whether a font with this PostScript name can be used right now. GDI has no PostScript
/// names, but they are almost always the full name without spaces ("Lora-Bold" and "Lora Bold").
/// Callers also check the PostScript names of the scanned font folders.
pub fn font_available(ps_name: &str) -> Option<bool> {
    let mut known = KNOWN.lock().ok()?;
    if known.as_ref().is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(5)) {
        *known = Some((Instant::now(), gdi_full_names()?));
    }
    let wanted = squash(ps_name);
    let regular = wanted.strip_suffix("regular").unwrap_or(&wanted).to_string();
    known.as_ref().map(|(_, names)| names.contains(&wanted) || names.contains(&regular))
}

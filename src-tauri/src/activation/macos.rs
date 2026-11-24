use crate::model::Scope;
use core_foundation::base::{CFRelease, TCFType};
use core_foundation::error::{CFError, CFErrorRef};
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::{CFURLRef, CFURL};
use std::ffi::c_void;
use std::path::Path;

// CTFontManagerScope values.
const SCOPE_NONE: u32 = 0;
const SCOPE_USER: u32 = 2; // kCTFontManagerScopePersistent
const SCOPE_SESSION: u32 = 3;

// CTFontManagerError codes that only mean "already in the wanted state".
const ALREADY_REGISTERED: isize = 105;
const NOT_REGISTERED: isize = 201;

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontManagerRegisterFontsForURL(url: CFURLRef, scope: u32, error: *mut CFErrorRef) -> u8;
    fn CTFontManagerUnregisterFontsForURL(url: CFURLRef, scope: u32, error: *mut CFErrorRef) -> u8;
    fn CTFontManagerGetScopeForURL(url: CFURLRef) -> u32;
    fn CTFontCreateWithName(name: CFStringRef, size: f64, matrix: *const c_void) -> *const c_void;
    fn CTFontCopyPostScriptName(font: *const c_void) -> CFStringRef;
}

fn url(path: &Path) -> Result<CFURL, String> {
    CFURL::from_path(path, false).ok_or_else(|| "chemin invalide".to_string())
}

fn check(ok: u8, error: CFErrorRef) -> Result<(), String> {
    if ok != 0 || error.is_null() {
        return Ok(());
    }
    let error = unsafe { CFError::wrap_under_create_rule(error) };
    match error.code() {
        ALREADY_REGISTERED | NOT_REGISTERED => Ok(()),
        _ => Err(error.description().to_string()),
    }
}

fn os_scope(scope: Scope) -> u32 {
    match scope {
        Scope::Persistent => SCOPE_USER,
        Scope::Temporary => SCOPE_SESSION,
        Scope::None => SCOPE_NONE,
    }
}

pub fn activate(path: &Path, scope: Scope) -> Result<(), String> {
    let url = url(path)?;
    let current = unsafe { CTFontManagerGetScopeForURL(url.as_concrete_TypeRef()) };
    if current == os_scope(scope) {
        return Ok(());
    }
    if current != SCOPE_NONE {
        let mut error = std::ptr::null_mut();
        let ok = unsafe { CTFontManagerUnregisterFontsForURL(url.as_concrete_TypeRef(), current, &mut error) };
        check(ok, error)?;
    }
    let mut error = std::ptr::null_mut();
    let ok = unsafe { CTFontManagerRegisterFontsForURL(url.as_concrete_TypeRef(), os_scope(scope), &mut error) };
    check(ok, error)
}

pub fn deactivate(path: &Path, _previous: Scope) -> Result<(), String> {
    let url = url(path)?;
    let current = unsafe { CTFontManagerGetScopeForURL(url.as_concrete_TypeRef()) };
    if current == SCOPE_NONE {
        return Ok(());
    }
    let mut error = std::ptr::null_mut();
    let ok = unsafe { CTFontManagerUnregisterFontsForURL(url.as_concrete_TypeRef(), current, &mut error) };
    check(ok, error)
}

pub fn finish_batch() {}

pub fn clean_temporary_leftovers() {}

pub fn system_scope(path: &Path) -> Option<Scope> {
    let url = url(path).ok()?;
    Some(match unsafe { CTFontManagerGetScopeForURL(url.as_concrete_TypeRef()) } {
        SCOPE_NONE => Scope::None,
        SCOPE_SESSION | 1 => Scope::Temporary,
        _ => Scope::Persistent,
    })
}

/// Whether any application can use a font with this PostScript name right now: installed,
/// activated by Typeshelf or by another font manager (Adobe Fonts…). CoreText falls back
/// to another font when the name is unknown, so the name it returns is compared.
pub fn font_available(ps_name: &str) -> Option<bool> {
    let name = CFString::new(ps_name);
    unsafe {
        let font = CTFontCreateWithName(name.as_concrete_TypeRef(), 12.0, std::ptr::null());
        if font.is_null() {
            return Some(false);
        }
        let found = CFString::wrap_under_create_rule(CTFontCopyPostScriptName(font));
        CFRelease(font);
        Some(found.to_string().eq_ignore_ascii_case(ps_name))
    }
}

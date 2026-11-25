//! Font file parsing (portable: relies on ttf-parser, not on the OS font stack).

use crate::model::{Axis, Face, FaceDetails};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use ttf_parser::{name_id, PlatformId, Tag};

pub const EXTENSIONS: &[&str] = &["ttf", "otf", "ttc", "otc"];
const MAX_CHARACTERS: usize = 8000;

pub fn is_font_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// Expands files and folders into a flat list of font files.
pub fn font_files(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for path in paths {
        if path.is_dir() {
            for entry in walkdir::WalkDir::new(path).follow_links(true).into_iter().flatten() {
                let hidden = entry.file_name().to_string_lossy().starts_with('.');
                if entry.file_type().is_file() && !hidden && is_font_file(entry.path()) {
                    out.push(entry.into_path());
                }
            }
        } else if is_font_file(path) {
            out.push(path.clone());
        }
    }
    out
}

/// Maps a font file read-only: system collections can weigh tens of megabytes and only
/// a few tables are actually touched.
pub fn map(path: &Path) -> Result<memmap2::Mmap, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    // SAFETY: read-only mapping; a file modified while mapped only yields parse errors.
    unsafe { memmap2::Mmap::map(&file) }.map_err(|e| e.to_string())
}

/// Parses every face of a font file.
pub fn scan(path: &Path, added_at: i64) -> Result<Vec<Face>, String> {
    let data = map(path)?;
    let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
    let mut faces = Vec::new();
    for index in 0..count {
        let face = ttf_parser::Face::parse(&data, index).map_err(|e| e.to_string())?;
        let family = name(&face, &[name_id::TYPOGRAPHIC_FAMILY, name_id::FAMILY]).unwrap_or_else(|| file_stem(path));
        let style = name(&face, &[name_id::TYPOGRAPHIC_SUBFAMILY, name_id::SUBFAMILY]).unwrap_or_else(|| "Regular".into());
        let full_name = name(&face, &[name_id::FULL_NAME]).unwrap_or_else(|| format!("{family} {style}"));
        let ps_name = name(&face, &[name_id::POST_SCRIPT_NAME]).unwrap_or_else(|| format!("{family}-{style}").replace(' ', ""));

        faces.push(Face {
            id: uuid::Uuid::new_v4().to_string(),
            path: path.to_string_lossy().into_owned(),
            face_index: index,
            ps_name,
            classification: classify(&face, &family).into(),
            family,
            style,
            full_name,
            weight: face.weight().to_number(),
            italic: face.is_italic(),
            mono: face.is_monospaced(),
            version: name(&face, &[name_id::VERSION]),
            designer: name(&face, &[name_id::DESIGNER]),
            manufacturer: name(&face, &[name_id::MANUFACTURER]),
            license: name(&face, &[name_id::LICENSE]),
            copyright: name(&face, &[name_id::COPYRIGHT_NOTICE]),
            glyph_count: face.number_of_glyphs(),
            variable: face.is_variable(),
            starred: false,
            added_at,
        });
    }
    Ok(faces)
}

fn file_stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Looks up the first available name record among `ids`, preferring English.
fn name(face: &ttf_parser::Face, ids: &[u16]) -> Option<String> {
    for &id in ids {
        let mut fallback = None;
        for record in face.names() {
            if record.name_id != id {
                continue;
            }
            let value = record.to_string().or_else(|| {
                // Macintosh Roman records: ASCII subset is good enough for names.
                (record.platform_id == PlatformId::Macintosh && record.encoding_id == 0)
                    .then(|| record.name.iter().map(|&b| b as char).collect())
            });
            if let Some(value) = value.filter(|v: &String| !v.trim().is_empty()) {
                if record.language_id == 0x0409 || record.platform_id == PlatformId::Unicode {
                    return Some(value);
                }
                fallback.get_or_insert(value);
            }
        }
        if fallback.is_some() {
            return fallback;
        }
    }
    None
}

/// Classifies a face from OS/2 sFamilyClass / PANOSE, falling back on its name.
fn classify(face: &ttf_parser::Face, family: &str) -> &'static str {
    if face.is_monospaced() {
        return "mono";
    }
    if let Some(os2) = face.raw_face().table(Tag::from_bytes(b"OS/2")) {
        if os2.len() > 35 {
            let class = os2[30];
            match class {
                1 | 2 | 3 | 7 => return "serif",
                4 | 5 => return "slab",
                8 => return "sans",
                9 => return "display",
                10 => return "script",
                12 => return "symbol",
                _ => {}
            }
            match os2[32] {
                3 => return "script",
                4 => return "display",
                5 => return "symbol",
                _ => {}
            }
            if os2[35] == 9 {
                return "mono";
            }
        }
    }
    let n = family.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if has(&["mono", "code", "console"]) {
        "mono"
    } else if has(&["icon", "symbol", "dingbat", "emoji"]) {
        "symbol"
    } else if has(&["script", "hand", "brush"]) {
        "script"
    } else if has(&["slab"]) {
        "slab"
    } else if has(&["sans", "grotesk", "grotesque", "gothic"]) {
        "sans"
    } else if has(&["serif"]) {
        "serif"
    } else if has(&["display", "poster"]) {
        "display"
    } else {
        "other"
    }
}

/// Character map, OpenType features and variation axes for the detail panel.
pub fn details(path: &Path, index: u32) -> Result<FaceDetails, String> {
    let data = map(path)?;
    let face = ttf_parser::Face::parse(&data, index).map_err(|e| e.to_string())?;

    let mut chars = BTreeSet::new();
    if let Some(cmap) = face.tables().cmap {
        for subtable in cmap.subtables {
            if subtable.is_unicode() {
                subtable.codepoints(|cp| {
                    if is_visible(cp) {
                        chars.insert(cp);
                    }
                });
            }
        }
    }
    let truncated = chars.len() > MAX_CHARACTERS;
    let characters = chars.into_iter().take(MAX_CHARACTERS).collect();

    let mut features = BTreeSet::new();
    for table in [face.tables().gsub, face.tables().gpos].into_iter().flatten() {
        for feature in table.features {
            features.insert(String::from_utf8_lossy(&feature.tag.to_bytes()).into_owned());
        }
    }

    let axes = face
        .variation_axes()
        .into_iter()
        .filter(|a| !a.hidden)
        .map(|a| {
            let tag = String::from_utf8_lossy(&a.tag.to_bytes()).into_owned();
            Axis {
                name: name(&face, &[a.name_id]).unwrap_or_else(|| tag.clone()),
                tag,
                min: a.min_value,
                default: a.def_value,
                max: a.max_value,
            }
        })
        .collect();

    let format = if ttf_parser::fonts_in_collection(&data).is_some() {
        "Collection OpenType/TrueType"
    } else if data.starts_with(b"OTTO") {
        "OpenType (CFF)"
    } else {
        "TrueType"
    };

    Ok(FaceDetails {
        characters,
        characters_truncated: truncated,
        features: features.into_iter().collect(),
        axes,
        format: format.into(),
        file_size: data.len() as u64,
    })
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// Folders where the current user installs fonts, without administrator rights.
pub fn user_font_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        dirs.extend(home.map(|h| h.join("Library/Fonts")));
    } else if cfg!(windows) {
        dirs.extend(std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Microsoft\\Windows\\Fonts")));
    } else {
        let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| home.as_ref().map(|h| h.join(".local/share")));
        dirs.extend(data_home.map(|d| d.join("fonts")));
        dirs.extend(home.map(|h| h.join(".fonts")));
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// Folders where the OS and the user install fonts.
pub fn system_font_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        dirs.extend(["/System/Library/Fonts", "/Library/Fonts"].map(PathBuf::from));
    } else if cfg!(windows) {
        let windir = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        dirs.push(windir.join("Fonts"));
    } else {
        dirs.extend(["/usr/share/fonts", "/usr/local/share/fonts"].map(PathBuf::from));
    }
    dirs.retain(|d| d.is_dir());
    dirs.extend(user_font_dirs());
    dirs
}

/// Stable id for a system face, so previews keep working across rescans.
pub fn system_face_id(path: &Path, index: u32) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("sys-{:016x}-{index}", hasher.finish())
}

/// Every face installed on the system (read-only: Typeshelf does not manage them).
/// True for files that live in one of the OS font folders (already installed).
pub fn is_system_path(path: &Path) -> bool {
    !path.components().any(|c| c.as_os_str().to_string_lossy().starts_with("typeshelf"))
        && system_font_dirs().iter().any(|dir| path.starts_with(dir))
}

/// For each sample text, whether the face has a glyph for every letter it contains.
pub fn supports(path: &Path, index: u32, samples: &[String]) -> Result<Vec<bool>, String> {
    let data = map(path)?;
    let face = ttf_parser::Face::parse(&data, index).map_err(|e| e.to_string())?;
    Ok(samples.iter().map(|text| text.chars().filter(|c| c.is_alphanumeric()).all(|c| face.glyph_index(c).is_some())).collect())
}

/// Every installed copy of every face, including several files carrying the same font.
pub fn scan_system_all() -> Vec<Face> {
    let mut faces = Vec::new();
    for file in font_files(&system_font_dirs()) {
        // Links Typeshelf itself creates on Linux are library fonts, not system ones.
        if file.components().any(|c| c.as_os_str().to_string_lossy().starts_with("typeshelf")) {
            continue;
        }
        // System fonts carry their file date, shown as "added" in the interface.
        let modified = fs::metadata(&file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs() as i64);
        let Ok(scanned) = scan(&file, modified) else { continue };
        for mut face in scanned {
            // macOS hides its UI fonts behind a leading dot (".SF NS", …).
            if face.family.starts_with('.') {
                continue;
            }
            face.id = system_face_id(&file, face.face_index);
            faces.push(face);
        }
    }
    faces
}

/// One face per PostScript name, the first copy found.
pub fn unique_faces(faces: &[Face]) -> Vec<Face> {
    let mut seen = HashSet::new();
    faces.iter().filter(|f| seen.insert(f.ps_name.as_str())).cloned().collect()
}

fn is_visible(cp: u32) -> bool {
    !(cp < 0x20 || (0x7F..0xA0).contains(&cp) || (0xD800..0xE000).contains(&cp) || cp == 0xFEFF)
}

/// Returns a standalone font for face `index`. For collections, the face's tables
/// are copied into a fresh single-font file so web views can load them.
pub fn face_bytes(data: &[u8], index: u32) -> Option<Vec<u8>> {
    if ttf_parser::fonts_in_collection(data).is_none() {
        return Some(data.to_vec());
    }
    let u16_at = |o: usize| data.get(o..o + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    let u32_at = |o: usize| data.get(o..o + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));

    let start = u32_at(12 + 4 * index as usize)? as usize;
    let num_tables = u16_at(start + 4)? as usize;
    let header_len = 12 + 16 * num_tables;

    let mut out = data.get(start..start + 12)?.to_vec();
    let mut body = Vec::new();
    for i in 0..num_tables {
        let rec = start + 12 + 16 * i;
        let offset = u32_at(rec + 8)? as usize;
        let length = u32_at(rec + 12)? as usize;
        let new_offset = (header_len + body.len()) as u32;
        out.extend_from_slice(data.get(rec..rec + 8)?); // tag + checksum
        out.extend_from_slice(&new_offset.to_be_bytes());
        out.extend_from_slice(&(length as u32).to_be_bytes());
        body.extend_from_slice(data.get(offset..offset + length)?);
        while body.len() % 4 != 0 {
            body.push(0);
        }
    }
    out.extend_from_slice(&body);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_font(candidates: &[&str]) -> Option<PathBuf> {
        candidates.iter().map(PathBuf::from).find(|p| p.exists())
    }

    #[test]
    fn detects_language_support() {
        let Some(path) = system_font(&["/System/Library/Fonts/Supplemental/Arial.ttf", "C:\\Windows\\Fonts\\arial.ttf"]) else {
            return;
        };
        let samples = ["Portez ce vieux whisky au juge blond qui fume.", "いろはにほへと"].map(String::from);
        assert_eq!(supports(&path, 0, &samples).unwrap(), vec![true, false]);
        assert!(is_system_path(&path));
        assert!(!is_system_path(Path::new("/tmp/typeshelf/x.ttf")));
    }

    #[test]
    fn scans_single_font() {
        let Some(path) = system_font(&[
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "C:\\Windows\\Fonts\\arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]) else {
            return;
        };
        let faces = scan(&path, 0).unwrap();
        assert_eq!(faces.len(), 1);
        assert!(!faces[0].family.is_empty());
        assert!(!faces[0].ps_name.is_empty());
        let d = details(&path, 0).unwrap();
        assert!(d.characters.contains(&('A' as u32)));
    }

    #[test]
    fn lists_system_fonts() {
        if system_font_dirs().is_empty() {
            return;
        }
        let started = std::time::Instant::now();
        let all = scan_system_all();
        let faces = unique_faces(&all);
        eprintln!("{} system styles ({} copies) in {:?}", faces.len(), all.len(), started.elapsed());
        assert!(all.len() >= faces.len());
        assert!(!faces.is_empty());
        assert!(faces.iter().all(|f| f.id.starts_with("sys-") && !f.family.starts_with('.')));
        let unique: HashSet<_> = faces.iter().map(|f| &f.ps_name).collect();
        assert_eq!(unique.len(), faces.len(), "noms PostScript en double");
        // Ids are stable between scans.
        let again = unique_faces(&scan_system_all());
        assert_eq!(faces.first().map(|f| &f.id), again.first().map(|f| &f.id));
    }

    #[test]
    fn extracts_faces_from_collection() {
        let Some(path) = system_font(&["/System/Library/Fonts/Helvetica.ttc", "C:\\Windows\\Fonts\\cambria.ttc"]) else {
            return;
        };
        let faces = scan(&path, 0).unwrap();
        assert!(faces.len() > 1);
        let data = fs::read(&path).unwrap();
        for face in &faces {
            let single = face_bytes(&data, face.face_index).expect("extraction");
            let parsed = ttf_parser::Face::parse(&single, 0).expect("standalone face parses");
            assert_eq!(parsed.number_of_glyphs(), face.glyph_count);
            assert!(ttf_parser::fonts_in_collection(&single).is_none());
        }
    }
}

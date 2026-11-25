//! The change journal: one append-only JSON-lines file per computer in `journal/`. A library is
//! whatever replaying every journal gives, in the order of the events' hybrid logical clocks.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const FOLDER: &str = "journal";
const VERSION: u32 = 1;

/// Where a font file is, so that every computer can find it again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FileRef {
    /// Inside the package: `/` separators, NFC.
    Inside { rel: String },
    /// Imported where it was, on the computer `dev`. `system` marks a font of the OS folders.
    Outside {
        abs: String,
        dev: String,
        #[serde(default)]
        system: bool,
    },
}

impl FileRef {
    pub fn new(root: &Path, device: &str, path: &Path, system: bool) -> FileRef {
        match path.strip_prefix(root) {
            Ok(rel) => {
                let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().nfc().collect()).collect();
                FileRef::Inside { rel: parts.join("/") }
            }
            Err(_) => FileRef::Outside { abs: path.to_string_lossy().into_owned(), dev: device.into(), system },
        }
    }

    /// The path on this computer. It may not exist.
    pub fn resolve(&self, root: &Path) -> PathBuf {
        match self {
            FileRef::Outside { abs, .. } => PathBuf::from(abs),
            FileRef::Inside { rel } => {
                // `..` would escape the package: a journal is only data.
                let path = rel.split('/').filter(|p| !p.is_empty() && *p != "." && *p != "..").fold(root.to_path_buf(), |p, c| p.join(c));
                if path.exists() {
                    return path;
                }
                // macOS may have written the names decomposed.
                let decomposed = rel.split('/').filter(|p| !p.is_empty() && *p != "." && *p != "..");
                let decomposed = decomposed.fold(root.to_path_buf(), |p, c| p.join(c.nfd().collect::<String>()));
                if decomposed.exists() {
                    decomposed
                } else {
                    path
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceData {
    pub id: String,
    pub file: FileRef,
    pub face_index: u32,
    pub ps_name: String,
    pub family: String,
    pub style: String,
    pub full_name: String,
    pub weight: u16,
    pub width: u16,
    pub italic: bool,
    pub mono: bool,
    pub classification: String,
    pub version: Option<String>,
    pub designer: Option<String>,
    pub manufacturer: Option<String>,
    pub license: Option<String>,
    pub copyright: Option<String>,
    pub glyph_count: u16,
    pub variable: bool,
    pub features: Vec<String>,
    pub starred: bool,
    pub added_at: i64,
}

/// One change to a library.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", content = "data", rename_all_fields = "camelCase")]
pub enum Op {
    /// First line of a journal: which computer writes it.
    #[serde(rename = "device")]
    Device { name: String, os: String, app: String },
    #[serde(rename = "face.add")]
    FaceAdd(Box<FaceData>),
    #[serde(rename = "face.remove")]
    FaceRemove { ids: Vec<String> },
    #[serde(rename = "face.repoint")]
    FaceRepoint { id: String, file: FileRef, face_index: u32, version: Option<String>, glyph_count: u16, width: u16, features: Vec<String> },
    #[serde(rename = "face.star")]
    FaceStar { ids: Vec<String>, starred: bool },
    #[serde(rename = "collection.create")]
    CollectionCreate { id: String, name: String, created_at: i64 },
    #[serde(rename = "collection.rename")]
    CollectionRename { id: String, name: String },
    #[serde(rename = "collection.delete")]
    CollectionDelete { id: String },
    #[serde(rename = "collection.add")]
    CollectionAdd { id: String, faces: Vec<String> },
    #[serde(rename = "collection.remove")]
    CollectionRemove { id: String, faces: Vec<String> },
    #[serde(rename = "tag.save")]
    TagSave { id: String, name: String, color: String, rule: Option<String>, created_at: i64 },
    #[serde(rename = "tag.delete")]
    TagDelete { id: String },
    #[serde(rename = "tag.set")]
    TagSet { id: String, faces: Vec<String>, tagged: bool },
    #[serde(rename = "set.create")]
    SetCreate { id: String, name: String, query: String, created_at: i64 },
    #[serde(rename = "set.update")]
    SetUpdate { id: String, name: String, query: String },
    #[serde(rename = "set.delete")]
    SetDelete { id: String },
}

/// Hybrid logical clock: milliseconds, then a counter for events of the same millisecond.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Clock(pub u64, pub u32);

impl Clock {
    /// The clock of the next event written here, never behind one already seen.
    pub fn tick(self, now_ms: u64) -> Clock {
        if now_ms > self.0 {
            Clock(now_ms, 0)
        } else {
            Clock(self.0, self.1 + 1)
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub dev: String,
    /// Position in the journal of `dev`, from 1.
    pub seq: u64,
    pub t: Clock,
    pub op: Op,
}

impl Event {
    pub(super) fn to_line(&self) -> Result<String, String> {
        let mut value = serde_json::to_value(&self.op).map_err(|e| e.to_string())?;
        let map = value.as_object_mut().ok_or("Invalid event")?;
        map.insert("v".into(), VERSION.into());
        map.insert("dev".into(), self.dev.clone().into());
        map.insert("seq".into(), self.seq.into());
        map.insert("t".into(), serde_json::to_value(self.t).map_err(|e| e.to_string())?);
        serde_json::to_string(&value).map_err(|e| e.to_string())
    }
}

#[derive(Deserialize)]
struct Header {
    dev: String,
    seq: u64,
    t: Clock,
}

/// What one journal file holds.
#[derive(Debug, Default)]
pub struct Journal {
    pub events: Vec<Event>,
    /// Some lines are changes a newer Typeshelf wrote.
    pub newer: bool,
}

/// Reads complete lines only: a last line without its newline is still being written.
pub fn read(path: &Path) -> Result<Journal, String> {
    let data = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let end = data.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let mut journal = Journal::default();
    for line in data[..end].split(|&b| b == b'\n') {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        let Ok(header) = Header::deserialize(&value) else {
            continue;
        };
        match Op::deserialize(&value) {
            Ok(op) => journal.events.push(Event { dev: header.dev, seq: header.seq, t: header.t, op }),
            Err(_) => journal.newer = true,
        }
    }
    Ok(journal)
}

pub fn path_for(root: &Path, device: &str) -> PathBuf {
    root.join(FOLDER).join(format!("{device}.jsonl"))
}

/// The journal files of a library, sorted by name.
pub fn files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let folder = root.join(FOLDER);
    let entries = fs::read_dir(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "jsonl")).collect();
    files.sort();
    Ok(files)
}

/// Adds events at the end of a journal and flushes them to the disk.
pub fn append(path: &Path, events: &[Event]) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("{}: {e}", path.display());
    let mut file = fs::OpenOptions::new().read(true).append(true).create(true).open(path).map_err(fail)?;
    let mut text = String::new();
    // A line cut short by a crash must not swallow the next one.
    let len = file.seek(SeekFrom::End(0)).map_err(fail)?;
    if len > 0 {
        let mut last = [0];
        file.seek(SeekFrom::End(-1)).map_err(fail)?;
        file.read_exact(&mut last).map_err(fail)?;
        if last != *b"\n" {
            text.push('\n');
        }
    }
    for event in events {
        text.push_str(&event.to_line()?);
        text.push('\n');
    }
    file.write_all(text.as_bytes()).map_err(fail)?;
    file.sync_data().map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("typeshelf-journal-{}.jsonl", uuid::Uuid::new_v4()))
    }

    fn event(seq: u64, op: Op) -> Event {
        Event { dev: "d".into(), seq, t: Clock(10, seq as u32), op }
    }

    #[test]
    fn journal_round_trip_ignores_partial_last_line() {
        let path = temp();
        let events = vec![
            event(1, Op::Device { name: "Mac".into(), os: "macos".into(), app: "0.1.0".into() }),
            event(2, Op::CollectionCreate { id: "c1".into(), name: "Brand".into(), created_at: 5 }),
        ];
        append(&path, &events).unwrap();
        fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"v\":1,\"dev\":\"d\",\"se").unwrap();
        let journal = read(&path).unwrap();
        assert_eq!((journal.events.clone(), journal.newer), (events, false));

        // The next write starts on its own line, and the broken one is skipped.
        append(&path, &[event(3, Op::CollectionDelete { id: "c1".into() })]).unwrap();
        append(&path, &[]).unwrap();
        assert_eq!(read(&path).unwrap().events.len(), 3);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn unknown_ops_are_skipped_and_flag_newer_format() {
        let path = temp();
        fs::write(&path, "{\"v\":2,\"dev\":\"d\",\"seq\":1,\"t\":[1,0],\"op\":\"note.add\",\"data\":{}}\n").unwrap();
        let journal = read(&path).unwrap();
        assert!(journal.events.is_empty() && journal.newer);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn clocks_never_go_back() {
        assert_eq!(Clock(5, 2).tick(9), Clock(9, 0));
        assert_eq!(Clock(5, 2).tick(5), Clock(5, 3));
        assert_eq!(Clock(5, 2).tick(1), Clock(5, 3));
    }

    #[test]
    fn file_refs_stay_inside_the_package() {
        let root = Path::new("/lib/Team.typeshelf");
        let inside = FileRef::new(root, "d", &root.join("Fonts").join("Inter").join("a.ttf"), false);
        assert_eq!(inside, FileRef::Inside { rel: "Fonts/Inter/a.ttf".into() });
        assert_eq!(inside.resolve(Path::new("/else")), Path::new("/else").join("Fonts").join("Inter").join("a.ttf"));
        let escape = FileRef::Inside { rel: "../../etc/passwd".into() };
        assert!(escape.resolve(root).starts_with(root));
        let outside = FileRef::new(root, "d", Path::new("/Library/Fonts/x.ttf"), true);
        assert_eq!(outside, FileRef::Outside { abs: "/Library/Fonts/x.ttf".into(), dev: "d".into(), system: true });
    }
}

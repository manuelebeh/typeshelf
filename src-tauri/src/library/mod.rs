//! A library is a folder package, `Name.typeshelf/`: its manifest, the fonts copied into it and
//! one change journal per computer. What is read comes from a local cache rebuilt from the
//! journals; what is written goes through [`Session::commit`].

pub mod journal;
pub mod manage;
pub mod manifest;
pub mod migrate;

use crate::db::{Db, Here};
use crate::fonts;
use crate::model::Face;
use journal::{Clock, Event, FaceData, FileRef, Op};
use manifest::Manifest;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

type R<T> = Result<T, String>;

pub const FONTS: &str = "Fonts";

/// Who is opening: this computer's id in that library, its name and where the cache goes.
pub struct Opener<'a> {
    pub device_id: &'a str,
    pub device_name: &'a str,
    pub cache: &'a Path,
}

pub struct OpenLibrary {
    pub id: String,
    pub root: PathBuf,
    session: Mutex<Session>,
}

/// The cache of an open library and the means to change it. Reads go straight to [`Db`].
pub struct Session {
    db: Db,
    root: PathBuf,
    device_id: String,
    device_name: String,
    devices: HashMap<String, String>,
    /// Last position written in this computer's journal.
    seq: u64,
    clock: Clock,
    read_only: bool,
}

impl std::ops::Deref for Session {
    type Target = Db;

    fn deref(&self) -> &Db {
        &self.db
    }
}

impl OpenLibrary {
    /// Reads every journal and rebuilds the cache from them.
    pub fn open(root: &Path, who: &Opener) -> R<OpenLibrary> {
        let manifest = manifest::read(root)?;
        let mut events = Vec::new();
        let mut newer = manifest.format > manifest::FORMAT;
        for file in journal::files(root)? {
            let journal = journal::read(&file)?;
            newer |= journal.newer;
            events.extend(journal.events);
        }
        events.sort_by(|a, b| (a.t, &a.dev, a.seq).cmp(&(b.t, &b.dev, b.seq)));
        events.dedup_by(|a, b| a.dev == b.dev && a.seq == b.seq);

        let devices: HashMap<String, String> = events
            .iter()
            .filter_map(|e| match &e.op {
                Op::Device { name, .. } => Some((e.dev.clone(), name.clone())),
                _ => None,
            })
            .collect();
        let seq = events.iter().filter(|e| e.dev == who.device_id).map(|e| e.seq).max().unwrap_or(0);
        let clock = events.last().map(|e| e.t).unwrap_or_default();

        if let Some(parent) = who.cache.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let mut db = Db::open(who.cache)?;
        db.rebuild(&events, &Here { root, device_id: who.device_id, devices: &devices })?;

        let session = Session {
            db,
            root: root.to_path_buf(),
            device_id: who.device_id.into(),
            device_name: who.device_name.into(),
            devices,
            seq,
            clock,
            read_only: manifest.read_only || newer,
        };
        Ok(OpenLibrary { id: manifest.id, root: root.to_path_buf(), session: Mutex::new(session) })
    }

    /// Writes an empty package at `root`, which must not exist or be an empty folder.
    pub fn create_package(root: &Path, created_by: &str, now: i64) -> R<Manifest> {
        let fail = |e: std::io::Error| format!("{}: {e}", root.display());
        if root.exists() && fs::read_dir(root).map_err(fail)?.next().is_some() {
            return Err(format!("{} already exists", root.display()));
        }
        fs::create_dir_all(root.join(FONTS)).map_err(fail)?;
        fs::create_dir_all(root.join(journal::FOLDER)).map_err(fail)?;
        let manifest = Manifest {
            format: manifest::FORMAT,
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now,
            created_by: created_by.into(),
            read_only: false,
        };
        manifest::write(root, &manifest)?;
        Ok(manifest)
    }

    pub fn lock(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn name(&self) -> String {
        manifest::name_of(&self.root)
    }

    pub fn fonts_dir(&self) -> PathBuf {
        self.root.join(FONTS)
    }
}

impl Session {
    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// Records changes in this computer's journal, then applies them to the cache. Whatever they
    /// need must have been checked before: a journal line cannot be taken back.
    pub fn commit(&mut self, ops: Vec<Op>) -> R<()> {
        if self.read_only {
            return Err("This library is view-only".into());
        }
        if ops.is_empty() {
            return Ok(());
        }
        let path = journal::path_for(&self.root, &self.device_id);
        let header = (!path.exists()).then(|| Op::Device {
            name: self.device_name.clone(),
            os: std::env::consts::OS.into(),
            app: env!("CARGO_PKG_VERSION").into(),
        });
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let (mut seq, mut clock) = (self.seq, self.clock);
        let events: Vec<Event> = header
            .into_iter()
            .chain(ops)
            .map(|op| {
                seq += 1;
                clock = clock.tick(now);
                Event { dev: self.device_id.clone(), seq, t: clock, op }
            })
            .collect();
        journal::append(&path, &events)?;
        (self.seq, self.clock) = (seq, clock);
        self.devices.insert(self.device_id.clone(), self.device_name.clone());
        self.db.apply(&events, &Here { root: &self.root, device_id: &self.device_id, devices: &self.devices })
    }

    pub fn file_ref(&self, path: &Path) -> FileRef {
        FileRef::new(&self.root, &self.device_id, path, fonts::is_system_path(path))
    }

    /// Adds the faces whose PostScript name is new. Returns how many that was.
    pub fn add_faces(&mut self, faces: &[Face]) -> R<usize> {
        let mut known: HashSet<String> = self.known_ps_names()?;
        let ops: Vec<Op> = faces
            .iter()
            .filter(|f| known.insert(f.ps_name.clone()))
            .map(|f| Op::FaceAdd(Box::new(face_data(f, self.file_ref(Path::new(&f.path))))))
            .collect();
        let added = ops.len();
        self.commit(ops)?;
        Ok(added)
    }

    /// Points a library face at another copy of the same font. Its id is kept, and with it
    /// the favourite flag, collections and tags.
    pub fn repoint_op(&self, id: &str, copy: &Face) -> Op {
        Op::FaceRepoint {
            id: id.into(),
            file: self.file_ref(Path::new(&copy.path)),
            face_index: copy.face_index,
            version: copy.version.clone(),
            glyph_count: copy.glyph_count,
            width: copy.width,
            features: copy.features.clone(),
        }
    }
}

pub fn face_data(f: &Face, file: FileRef) -> FaceData {
    FaceData {
        id: f.id.clone(),
        file,
        face_index: f.face_index,
        ps_name: f.ps_name.clone(),
        family: f.family.clone(),
        style: f.style.clone(),
        full_name: f.full_name.clone(),
        weight: f.weight,
        width: f.width,
        italic: f.italic,
        mono: f.mono,
        classification: f.classification.clone(),
        version: f.version.clone(),
        designer: f.designer.clone(),
        manufacturer: f.manufacturer.clone(),
        license: f.license.clone(),
        copyright: f.copyright.clone(),
        glyph_count: f.glyph_count,
        variable: f.variable,
        features: f.features.clone(),
        starred: f.starred,
        added_at: f.added_at,
    }
}

/// The collections and tags a brand-new library starts from.
pub fn default_ops(now: i64) -> Vec<Op> {
    let id = || uuid::Uuid::new_v4().to_string();
    let mut ops: Vec<Op> = ["Projects", "Brand identity", "Web & screens", "To try"]
        .iter()
        .zip(now..)
        .map(|(name, created_at)| Op::CollectionCreate { id: id(), name: name.to_string(), created_at })
        .collect();
    let rule = |field: &str, op: &str, value: &str| {
        format!(r#"{{"match":"all","conditions":[{{"field":"{field}","op":"{op}","value":"{value}"}}]}}"#)
    };
    let tags: [(&str, &str, Option<String>); 7] = [
        ("Headings", "red", None),
        ("Body text", "blue", None),
        ("Handwritten", "purple", None),
        ("Fancy", "orange", None),
        ("Variable", "teal", Some(rule("variable", "isTrue", ""))),
        ("Monospace", "gray", Some(rule("mono", "isTrue", ""))),
        ("Script & calligraphy", "pink", Some(rule("classification", "is", "script"))),
    ];
    ops.extend(tags.into_iter().zip(now..).map(|((name, color, rule), created_at)| Op::TagSave {
        id: id(),
        name: name.into(),
        color: color.into(),
        rule,
        created_at,
    }));
    ops
}

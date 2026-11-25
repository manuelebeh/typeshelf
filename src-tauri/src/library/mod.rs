//! A library is a folder package, `Name.typeshelf/`: its manifest, the fonts copied into it and
//! one change journal per computer. What is read comes from a local cache rebuilt from the
//! journals; what is written goes through [`Session::commit`].

pub mod journal;
pub mod location;
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
    /// Where this computer notes how far it has written, to notice when someone else writes
    /// under its id.
    pub head: &'a Path,
    /// This computer asked to only read the library.
    pub view_only: bool,
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
    /// The library itself asks for it, or holds changes this version does not know.
    shared_read_only: bool,
    writable: bool,
    view_only: bool,
    /// The folder can be reached. Otherwise only the cache is left.
    connected: bool,
    head: PathBuf,
    /// Part of the library has not arrived on this computer yet.
    waiting: bool,
    /// The latest change made elsewhere: computer name and Unix time.
    last_change: Option<(String, i64)>,
    /// The files as they were when last read.
    stamp: journal::Stamp,
}

impl std::ops::Deref for Session {
    type Target = Db;

    fn deref(&self) -> &Db {
        &self.db
    }
}

/// Every change of every journal, in the one order all computers agree on. The same line found
/// twice (a copied journal) counts once; lines that only share a position are all kept.
fn merged(root: &Path) -> R<(Vec<Event>, bool)> {
    let mut lines = Vec::new();
    let mut newer = false;
    for file in journal::files(root)? {
        let journal = journal::read(&file)?;
        newer |= journal.newer;
        for event in journal.events {
            lines.push((event.to_line()?, event));
        }
    }
    lines.sort_by(|(x, a), (y, b)| (a.t, &a.dev, a.seq, x).cmp(&(b.t, &b.dev, b.seq, y)));
    lines.dedup_by(|a, b| a.0 == b.0);
    Ok((lines.into_iter().map(|(_, event)| event).collect(), newer))
}

fn read_head(path: &Path) -> Option<(String, u64)> {
    let text = fs::read_to_string(path).ok()?;
    let (device, seq) = text.trim().split_once(' ')?;
    Some((device.to_string(), seq.parse().ok()?))
}

/// Losing this only costs a new device id at the next opening.
fn write_head(path: &Path, device: &str, seq: u64) {
    let written = path.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::write(path, format!("{device} {seq}\n")));
    if let Err(e) = written {
        eprintln!("{}: {e}", path.display());
    }
}

impl OpenLibrary {
    /// Reads every journal and rebuilds the cache from them.
    pub fn open(root: &Path, who: &Opener) -> R<OpenLibrary> {
        let id = manifest::read(root)?.id;
        if let Some(parent) = who.cache.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let mut session = Session::new(root, who)?;
        session.load()?;
        Ok(OpenLibrary { id, root: root.to_path_buf(), session: Mutex::new(session) })
    }

    /// A library whose folder cannot be reached, as its cache last saw it.
    pub fn offline(id: &str, root: &Path, who: &Opener) -> R<OpenLibrary> {
        if !who.cache.is_file() {
            return Err(format!("{} cannot be reached", root.display()));
        }
        Ok(OpenLibrary { id: id.into(), root: root.to_path_buf(), session: Mutex::new(Session::new(root, who)?) })
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
    /// Over the cache as it is: nothing has been read from the library yet.
    fn new(root: &Path, who: &Opener) -> R<Session> {
        Ok(Session {
            db: Db::open(who.cache)?,
            root: root.to_path_buf(),
            device_id: who.device_id.into(),
            device_name: who.device_name.into(),
            devices: HashMap::new(),
            seq: 0,
            clock: Clock::default(),
            shared_read_only: false,
            writable: false,
            view_only: who.view_only,
            connected: false,
            head: who.head.to_path_buf(),
            waiting: false,
            last_change: None,
            stamp: journal::Stamp::new(),
        })
    }

    /// Takes in what other computers changed since the last reading. `None` when nothing did,
    /// else the font files that no entry uses anymore.
    pub fn sync(&mut self, id: &str) -> R<Option<Vec<String>>> {
        let Some(stamp) = journal::stamp(&self.root) else {
            let was_connected = std::mem::replace(&mut self.connected, false);
            return Ok(was_connected.then(Vec::new));
        };
        if self.connected && stamp == self.stamp {
            return Ok(None);
        }
        // Another library may have taken this place, for instance on a drive with the same name.
        if manifest::read(&self.root)?.id != id {
            let was_connected = std::mem::replace(&mut self.connected, false);
            return Ok(was_connected.then(Vec::new));
        }
        let before: HashSet<String> = self.db.faces()?.into_iter().map(|f| f.path).collect();
        self.load()?;
        let after: HashSet<String> = self.db.faces()?.into_iter().map(|f| f.path).collect();
        Ok(Some(before.difference(&after).cloned().collect()))
    }

    /// Brings the cache up to date with what the journals now hold.
    fn load(&mut self) -> R<()> {
        // Taken before reading: a change made meanwhile is seen next time.
        let stamp = journal::stamp(&self.root).unwrap_or_default();
        let manifest = manifest::read(&self.root)?;
        let (events, newer) = merged(&self.root)?;

        let mut positions: HashMap<&str, HashSet<u64>> = HashMap::new();
        let mut forked = HashSet::new();
        for event in &events {
            if !positions.entry(&event.dev).or_default().insert(event.seq) {
                forked.insert(event.dev.as_str());
            }
        }
        // A journal numbers its lines from 1: a hole is a part still on its way.
        let holes = positions.values().any(|seqs| seqs.iter().max().is_some_and(|&max| max > seqs.len() as u64));
        self.waiting = holes || journal::pending(&self.root);

        let mut seq = positions.get(self.device_id.as_str()).and_then(|s| s.iter().max().copied()).unwrap_or(0);
        // Another computer wrote under this id (a cloned or restored machine), or the journal is
        // not what was left: write a new one rather than number two changes alike.
        let written = read_head(&self.head).filter(|(device, _)| *device == self.device_id);
        if written.is_some_and(|(_, last)| last != seq || forked.contains(self.device_id.as_str())) {
            self.device_id = uuid::Uuid::new_v4().to_string();
            seq = 0;
        }

        self.devices = events
            .iter()
            .filter_map(|e| match &e.op {
                Op::Device { name, .. } => Some((e.dev.clone(), name.clone())),
                _ => None,
            })
            .collect();
        self.last_change = events
            .iter()
            .rev()
            .find(|e| e.dev != self.device_id && !matches!(e.op, Op::Device { .. }))
            .and_then(|e| Some((self.devices.get(&e.dev)?.clone(), (e.t.0 / 1000) as i64)));
        self.seq = seq;
        self.clock = events.last().map(|e| e.t).unwrap_or_default().max(self.clock);
        self.shared_read_only = manifest.read_only || newer || manifest.format > manifest::FORMAT;
        self.writable = journal::writable(&self.root, &self.device_id);
        self.connected = true;
        self.stamp = stamp;
        self.db.rebuild(&events, &Here { root: &self.root, device_id: &self.device_id, devices: &self.devices })
    }

    /// This computer's id in the library, which loading may have had to change.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn waiting(&self) -> bool {
        self.waiting
    }

    pub fn connected(&self) -> bool {
        self.connected
    }

    pub fn view_only_choice(&self) -> bool {
        self.view_only
    }

    pub fn last_change(&self) -> Option<(String, i64)> {
        self.last_change.clone()
    }

    pub fn read_only(&self) -> bool {
        !self.connected || !self.writable || self.shared_read_only || self.view_only
    }

    pub fn set_view_only(&mut self, view_only: bool) {
        self.view_only = view_only;
    }

    /// Records changes in this computer's journal, then applies them to the cache. Whatever they
    /// need must have been checked before: a journal line cannot be taken back.
    pub fn commit(&mut self, ops: Vec<Op>) -> R<()> {
        if self.read_only() {
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
        write_head(&self.head, &self.device_id, seq);
        // Our own writing is not news. Other files keep their old stamp, so nothing is missed.
        if let (Some(name), Some(mut now)) = (path.file_name().map(|n| n.to_string_lossy().into_owned()), journal::stamp(&self.root)) {
            if let Some(own) = now.remove(&name) {
                self.stamp.insert(name, own);
            }
        }
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::Face;

    /// A package that several pretend computers write into.
    pub(super) struct Shared {
        pub dir: PathBuf,
        pub root: PathBuf,
    }

    impl Shared {
        pub fn new() -> Shared {
            let dir = std::env::temp_dir().join(format!("typeshelf-shared-{}", uuid::Uuid::new_v4()));
            let root = dir.join("Team.typeshelf");
            OpenLibrary::create_package(&root, "a", 1).unwrap();
            Shared { dir, root }
        }

        pub fn open(&self, device: &str) -> OpenLibrary {
            let cache = self.dir.join(format!("{device}.sqlite"));
            let head = self.dir.join(format!("{device}.head"));
            let who = Opener { device_id: device, device_name: device, cache: &cache, head: &head, view_only: false };
            OpenLibrary::open(&self.root, &who).unwrap()
        }

        /// Writes lines into the journal of `device` with chosen clocks, as if made offline.
        pub fn write(&self, device: &str, events: &[(u64, u64, Op)]) {
            let events: Vec<Event> =
                events.iter().map(|(seq, ms, op)| Event { dev: device.into(), seq: *seq, t: Clock(*ms, 0), op: op.clone() }).collect();
            journal::append(&journal::path_for(&self.root, device), &events).unwrap();
        }
    }

    impl Drop for Shared {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    pub(crate) fn face(id: &str, ps_name: &str) -> Op {
        let face = Face {
            id: id.into(),
            path: String::new(),
            face_index: 0,
            ps_name: ps_name.into(),
            family: ps_name.into(),
            style: "Regular".into(),
            full_name: ps_name.into(),
            weight: 400,
            width: 5,
            italic: false,
            mono: false,
            classification: "sans".into(),
            version: None,
            designer: None,
            manufacturer: None,
            license: None,
            copyright: None,
            glyph_count: 1,
            variable: false,
            features: Vec::new(),
            starred: false,
            added_at: 1,
            available: true,
            imported_on: None,
        };
        Op::FaceAdd(Box::new(face_data(&face, FileRef::Inside { rel: format!("Fonts/{id}.ttf") })))
    }

    fn tag(id: &str, name: &str) -> Op {
        Op::TagSave { id: id.into(), name: name.into(), color: "red".into(), rule: None, created_at: 1 }
    }

    fn collection(id: &str, name: &str) -> Op {
        Op::CollectionCreate { id: id.into(), name: name.into(), created_at: 1 }
    }

    #[test]
    fn two_devices_converge_in_any_read_order() {
        let shared = Shared::new();
        shared.write("z", &[(1, 10, collection("c", "Brand")), (2, 30, Op::CollectionRename { id: "c".into(), name: "From z".into() })]);
        shared.write("a", &[(1, 20, Op::CollectionRename { id: "c".into(), name: "From a".into() })]);
        for device in ["a", "z", "new"] {
            // The latest change wins whatever the file order.
            assert_eq!(shared.open(device).lock().collections().unwrap()[0].name, "From z");
        }
        // A copy of a journal, as sync services make them, changes nothing.
        fs::copy(journal::path_for(&shared.root, "z"), shared.root.join(journal::FOLDER).join("z (conflicted copy).jsonl")).unwrap();
        assert_eq!(merged(&shared.root).unwrap().0.len(), 3);
        // Two different changes at the same position are both kept.
        let fork = shared.root.join(journal::FOLDER).join("a 2.jsonl");
        journal::append(&fork, &[Event { dev: "a".into(), seq: 1, t: Clock(25, 0), op: collection("d", "Fork") }]).unwrap();
        assert_eq!(shared.open("new").lock().collections().unwrap().len(), 2);
    }

    #[test]
    fn delete_wins_over_concurrent_edit() {
        let shared = Shared::new();
        shared.write(
            "a",
            &[
                (1, 10, tag("t", "Old")),
                (2, 11, collection("c", "Brand")),
                (3, 20, Op::TagDelete { id: "t".into() }),
                (4, 21, Op::CollectionDelete { id: "c".into() }),
            ],
        );
        // Made later, by someone who had not seen the deletions.
        shared.write("b", &[(1, 30, tag("t", "Renamed")), (2, 31, Op::CollectionRename { id: "c".into(), name: "Renamed".into() })]);
        let library = shared.open("c");
        assert!(library.lock().tags().unwrap().is_empty());
        assert!(library.lock().collections().unwrap().is_empty());
    }

    #[test]
    fn concurrent_import_of_same_font_is_aliased() {
        let shared = Shared::new();
        shared.write("a", &[(1, 10, face("one", "Inter-Regular"))]);
        shared.write(
            "b",
            &[
                (1, 11, face("two", "Inter-Regular")),
                (2, 12, collection("c", "Brand")),
                (3, 13, Op::CollectionAdd { id: "c".into(), faces: vec!["two".into()] }),
                (4, 14, Op::FaceStar { ids: vec!["two".into()], starred: true }),
            ],
        );
        let library = shared.open("c");
        let faces = library.lock().faces().unwrap();
        assert_eq!(faces.iter().map(|f| (f.id.as_str(), f.starred)).collect::<Vec<_>>(), [("one", true)]);
        assert_eq!(library.lock().membership().unwrap()["c"], ["one"]);
        library.lock().commit(vec![Op::FaceRemove { ids: vec!["two".into()] }]).unwrap();
        assert!(library.lock().faces().unwrap().is_empty());
    }

    #[test]
    fn cloned_or_truncated_journal_rotates_the_device_id() {
        let shared = Shared::new();
        let library = shared.open("a");
        library.lock().commit(vec![collection("c", "Mine")]).unwrap();
        assert_eq!(shared.open("a").lock().device_id(), "a");

        // A clone of this computer wrote the next line under the same id.
        shared.write("a", &[(3, u64::MAX / 2, collection("d", "Clone"))]);
        let reopened = shared.open("a");
        assert_ne!(reopened.lock().device_id(), "a");
        assert_eq!(reopened.lock().collections().unwrap().len(), 2);
        // Nothing is rewritten: the new id starts its own journal, after the clone's changes.
        reopened.lock().commit(vec![collection("e", "After")]).unwrap();
        assert_eq!(journal::files(&shared.root).unwrap().len(), 2);
        assert_eq!(merged(&shared.root).unwrap().0.last().unwrap().seq, 2);

        // A journal shorter than what was written is not continued either.
        let library = shared.open("b");
        library.lock().commit(vec![collection("f", "Lost")]).unwrap();
        fs::write(journal::path_for(&shared.root, "b"), "").unwrap();
        assert_ne!(shared.open("b").lock().device_id(), "b");
    }

    #[test]
    fn missing_lines_and_placeholders_mean_waiting() {
        let shared = Shared::new();
        shared.write("a", &[(1, 10, collection("c", "One"))]);
        assert!(!shared.open("x").lock().waiting());
        shared.write("a", &[(3, 30, collection("d", "Three"))]);
        assert!(shared.open("x").lock().waiting());
        shared.write("a", &[(2, 20, collection("e", "Two"))]);
        assert!(!shared.open("x").lock().waiting());
        fs::write(shared.root.join(journal::FOLDER).join(".b.jsonl.icloud"), "").unwrap();
        assert!(shared.open("x").lock().waiting());
    }
}

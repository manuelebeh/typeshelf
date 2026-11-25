//! Turns the single database of the first releases (`library.sqlite` and `Fonts/` in the app data
//! folder) into the default library package. Ids are kept, so nothing the user organised moves.
//!
//! The old database is renamed only at the very end: an interrupted migration starts again at the
//! next launch.

use super::journal::{self, Clock, Event, FileRef, Op};
use super::{face_data, manage, manifest};
use crate::activation::Activator;
use crate::fonts;
use crate::machine::{self, MachineDb};
use crate::model::{Face, Scope};
use rusqlite::{Connection, Row};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

type R<T> = Result<T, String>;

const DATABASE: &str = "library.sqlite";

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn fail(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

pub fn run(data_dir: &Path, machine: &MachineDb, os: &Activator, now: i64) -> R<()> {
    let database = data_dir.join(DATABASE);
    if !database.is_file() {
        return Ok(());
    }
    let old = Connection::open(&database).map_err(err)?;
    upgrade(&old)?;
    for (path, scope) in activation_rows(&old)? {
        machine.set_scope(&path, Scope::parse(&scope))?;
    }

    let old_fonts = data_dir.join("Fonts");
    let root = manage::default_root(data_dir);
    let partial = root.with_extension(format!("{}.partial", manifest::EXTENSION));
    let moved: Vec<(String, Scope)> = machine.activation()?.into_iter().filter(|(p, _)| Path::new(p).starts_with(&old_fonts)).collect();
    // The OS keeps the path of what it registered: unregister while the file is still there.
    let mut moved_on = Vec::new();
    for (path, scope) in &moved {
        if Path::new(path).exists() {
            if let Err(e) = (os.off)(Path::new(path), *scope) {
                eprintln!("{e}");
            }
        }
        if *scope == Scope::Persistent {
            moved_on.push(path.clone());
        } else {
            machine.set_scope(path, Scope::None)?;
        }
    }

    let package_fonts = root.join(super::FONTS);
    if !root.join(manifest::FILE).is_file() {
        write_package(&old, machine, &old_fonts, &root, &partial, now)?;
    }

    // Register the fonts again, wherever they ended up.
    for path in moved_on {
        let Ok(rel) = Path::new(&path).strip_prefix(&old_fonts) else { continue };
        let new = package_fonts.join(rel);
        let target = if new.exists() { new } else { PathBuf::from(&path) };
        machine.set_scope(&path, Scope::None)?;
        match (os.on)(&target, Scope::Persistent) {
            Ok(()) => machine.set_scope(&target.to_string_lossy(), Scope::Persistent)?,
            Err(e) => eprintln!("{e}"),
        }
    }

    drop(old);
    for suffix in ["", "-wal", "-shm"] {
        let file = data_dir.join(format!("{DATABASE}{suffix}"));
        if file.exists() {
            let backup = data_dir.join(format!("{DATABASE}.migrated{suffix}"));
            fs::rename(&file, &backup).map_err(fail(&file))?;
        }
    }
    Ok(())
}

/// Writes the package next to its final place, then renames it in one step.
fn write_package(old: &Connection, machine: &MachineDb, old_fonts: &Path, root: &Path, partial: &Path, now: i64) -> R<()> {
    // What an interrupted run left, apart from the fonts it already moved.
    let _ = fs::remove_dir_all(partial.join(journal::FOLDER));
    fs::create_dir_all(partial.join(journal::FOLDER)).map_err(fail(partial))?;
    let partial_fonts = partial.join(super::FONTS);
    if !partial_fonts.exists() && old_fonts.is_dir() {
        // On the same volume, so instant. If it fails the files stay where they are.
        if let Err(e) = fs::rename(old_fonts, &partial_fonts) {
            eprintln!("{}: {e}", old_fonts.display());
        }
    }
    fs::create_dir_all(&partial_fonts).map_err(fail(&partial_fonts))?;

    let device_id = uuid::Uuid::new_v4().to_string();
    let fonts_moved = !old_fonts.exists();
    let file_ref = |path: &str| {
        let path = Path::new(path);
        match path.strip_prefix(old_fonts) {
            Ok(rel) if fonts_moved => FileRef::new(root, &device_id, &root.join(super::FONTS).join(rel), false),
            _ => FileRef::new(root, &device_id, path, fonts::is_system_path(path)),
        }
    };
    let device = Op::Device { name: machine.device_name()?, os: std::env::consts::OS.into(), app: env!("CARGO_PKG_VERSION").into() };
    let mut ops = vec![device];
    ops.extend(faces(old)?.iter().map(|f| Op::FaceAdd(Box::new(face_data(f, file_ref(&f.path))))));
    ops.extend(organisation(old)?);

    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut clock = Clock::default();
    let events: Vec<Event> = ops
        .into_iter()
        .zip(1..)
        .map(|(op, seq)| {
            clock = clock.tick(millis);
            Event { dev: device_id.clone(), seq, t: clock, op }
        })
        .collect();
    journal::append(&journal::path_for(partial, &device_id), &events)?;

    let id = uuid::Uuid::new_v4().to_string();
    let manifest = manifest::Manifest {
        format: manifest::FORMAT,
        id: id.clone(),
        created_at: now,
        created_by: machine.device_name()?,
        read_only: false,
    };
    manifest::write(partial, &manifest)?;
    let _ = fs::remove_dir(root);
    fs::rename(partial, root).map_err(fail(root))?;
    machine.remember(&id, root, &device_id, now)?;
    machine.set_setting(machine::CURRENT_LIBRARY, &id)
}

/// The schema changes the first releases applied at startup, then what they read from the files.
fn upgrade(old: &Connection) -> R<()> {
    let version: i64 = old.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(err)?;
    if version < 2 {
        old.execute_batch(
            "BEGIN;
             ALTER TABLE face ADD COLUMN width INTEGER NOT NULL DEFAULT 5;
             ALTER TABLE face ADD COLUMN features TEXT;
             CREATE TABLE smart_set (id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, created_at INTEGER NOT NULL);
             PRAGMA user_version = 2;
             COMMIT;",
        )
        .map_err(err)?;
    }
    Ok(())
}

fn rows<T>(db: &Connection, sql: &str, map: impl FnMut(&Row) -> rusqlite::Result<T>) -> R<Vec<T>> {
    let mut stmt = db.prepare(sql).map_err(err)?;
    let rows = stmt.query_map([], map).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

fn activation_rows(old: &Connection) -> R<Vec<(String, String)>> {
    rows(old, "SELECT path, scope FROM activation", |r| Ok((r.get(0)?, r.get(1)?)))
}

fn faces(old: &Connection) -> R<Vec<Face>> {
    let mut faces = rows(old, "SELECT * FROM face ORDER BY path, face_index", |r| {
        let features: Option<String> = r.get("features")?;
        Ok(Face {
            id: r.get("id")?,
            path: r.get("path")?,
            face_index: r.get("face_index")?,
            ps_name: r.get("ps_name")?,
            family: r.get("family")?,
            style: r.get("style")?,
            full_name: r.get("full_name")?,
            weight: r.get("weight")?,
            width: r.get("width")?,
            italic: r.get("italic")?,
            mono: r.get("mono")?,
            classification: r.get("classification")?,
            version: r.get("version")?,
            designer: r.get("designer")?,
            manufacturer: r.get("manufacturer")?,
            license: r.get("license")?,
            copyright: r.get("copyright")?,
            glyph_count: r.get("glyph_count")?,
            variable: r.get("variable")?,
            // A NULL marks a row still to be read from its file.
            features: features.as_deref().map_or_else(|| vec![UNREAD.into()], |f| f.split_whitespace().map(str::to_owned).collect()),
            starred: r.get("starred")?,
            added_at: r.get("added_at")?,
            available: true,
            imported_on: None,
        })
    })?;
    for file in faces.chunk_by_mut(|a, b| a.path == b.path) {
        if file.iter().all(|f| f.features != [UNREAD]) {
            continue;
        }
        let data = fonts::map(Path::new(&file[0].path)).ok();
        for face in file.iter_mut().filter(|f| f.features == [UNREAD]) {
            let (width, features) = data.as_deref().and_then(|d| fonts::metrics(d, face.face_index)).unwrap_or((5, Vec::new()));
            (face.width, face.features) = (width, features);
        }
    }
    Ok(faces)
}

/// Not a feature tag: tags are four characters at most.
const UNREAD: &str = "unread";

/// Collections, tags and smart sets with their members, under their ids.
fn organisation(old: &Connection) -> R<Vec<Op>> {
    let members = |sql: &str| -> R<BTreeMap<String, Vec<String>>> {
        let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (key, face) in rows(old, sql, |r| Ok((r.get(0)?, r.get(1)?)))? {
            map.entry(key).or_default().push(face);
        }
        Ok(map)
    };
    let mut ops = rows(old, "SELECT id, name, created_at FROM collection", |r| {
        Ok(Op::CollectionCreate { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? })
    })?;
    ops.extend(
        members("SELECT collection_id, face_id FROM collection_face")?.into_iter().map(|(id, faces)| Op::CollectionAdd { id, faces }),
    );
    ops.extend(rows(old, "SELECT id, name, color, rule, created_at FROM tag", |r| {
        Ok(Op::TagSave { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, rule: r.get(3)?, created_at: r.get(4)? })
    })?);
    ops.extend(members("SELECT tag_id, face_id FROM face_tag")?.into_iter().map(|(id, faces)| Op::TagSet { id, faces, tagged: true }));
    ops.extend(rows(old, "SELECT id, name, query, created_at FROM smart_set", |r| {
        Ok(Op::SetCreate { id: r.get(0)?, name: r.get(1)?, query: r.get(2)?, created_at: r.get(3)? })
    })?);
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A data folder as the first release left it: version 1, one copied font and one outside.
    fn legacy() -> (PathBuf, PathBuf, PathBuf) {
        let data = std::env::temp_dir().join(format!("typeshelf-legacy-{}", uuid::Uuid::new_v4()));
        let copied = data.join("Fonts").join("Inter").join("inter.ttf");
        let outside = data.join("elsewhere.ttf");
        fs::create_dir_all(copied.parent().unwrap()).unwrap();
        fs::write(&copied, b"not a real font").unwrap();
        fs::write(&outside, b"nor this one").unwrap();
        let db = Connection::open(data.join(DATABASE)).unwrap();
        db.execute_batch(
            "CREATE TABLE face (
                 id TEXT PRIMARY KEY, path TEXT NOT NULL, face_index INTEGER NOT NULL DEFAULT 0,
                 ps_name TEXT NOT NULL UNIQUE, family TEXT NOT NULL, style TEXT NOT NULL, full_name TEXT NOT NULL,
                 weight INTEGER NOT NULL DEFAULT 400, italic INTEGER NOT NULL DEFAULT 0, mono INTEGER NOT NULL DEFAULT 0,
                 classification TEXT NOT NULL, version TEXT, designer TEXT, manufacturer TEXT, license TEXT, copyright TEXT,
                 glyph_count INTEGER NOT NULL DEFAULT 0, variable INTEGER NOT NULL DEFAULT 0,
                 starred INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL
             );
             CREATE TABLE collection (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE collection_face (collection_id TEXT, face_id TEXT);
             CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, rule TEXT, created_at INTEGER NOT NULL);
             CREATE TABLE face_tag (tag_id TEXT, face_id TEXT);
             CREATE TABLE activation (path TEXT PRIMARY KEY, scope TEXT NOT NULL);
             INSERT INTO collection VALUES ('default-col-0', 'Projects', 1);
             INSERT INTO collection_face VALUES ('default-col-0', 'f1');
             INSERT INTO tag VALUES ('t1', 'Mine', 'red', NULL, 1);
             INSERT INTO face_tag VALUES ('t1', 'f2');
             PRAGMA user_version = 1;",
        )
        .unwrap();
        for (id, path, name, starred) in [("f1", &copied, "Inter", 1), ("f2", &outside, "Else", 0)] {
            db.execute(
                "INSERT INTO face (id, path, ps_name, family, style, full_name, classification, starred, added_at)
                 VALUES (?1, ?2, ?3, ?3, 'Regular', ?3, 'sans', ?4, 7)",
                rusqlite::params![id, path.to_string_lossy(), name, starred],
            )
            .unwrap();
        }
        for path in [&copied, &outside] {
            db.execute("INSERT INTO activation VALUES (?1, 'persistent')", [path.to_string_lossy()]).unwrap();
        }
        (data, copied, outside)
    }

    fn migrate(data: &Path, machine: &MachineDb) -> Vec<String> {
        let calls = RefCell::new(Vec::new());
        let record = |what: &str, path: &Path| {
            calls.borrow_mut().push(format!("{what} {}", path.display()));
            Ok(())
        };
        let os = Activator { on: &|path, _| record("on", path), off: &|path, _| record("off", path) };
        run(data, machine, &os, 10).unwrap();
        drop(os);
        calls.into_inner()
    }

    #[test]
    fn migrates_legacy_library() {
        let (data, copied, outside) = legacy();
        let machine = MachineDb::open(&data.join("machine.sqlite")).unwrap();
        let calls = migrate(&data, &machine);

        let root = manage::default_root(&data);
        let moved = root.join("Fonts").join("Inter").join("inter.ttf");
        assert!(moved.is_file() && !copied.exists());
        assert_eq!(calls, [format!("off {}", copied.display()), format!("on {}", moved.display())]);
        assert!(data.join("library.sqlite.migrated").is_file() && !data.join(DATABASE).exists());

        let activation = machine.activation().unwrap();
        assert_eq!(activation.len(), 2);
        assert!(activation.contains_key(moved.to_string_lossy().as_ref()));
        assert!(activation.contains_key(outside.to_string_lossy().as_ref()));

        let library = manage::startup(&data, &machine, 20).unwrap();
        assert_eq!(library.root, root);
        let session = library.lock();
        let mut faces = session.faces().unwrap();
        faces.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            (faces[0].id.as_str(), faces[0].path.as_str(), faces[0].starred, faces[0].added_at),
            ("f1", moved.to_str().unwrap(), true, 7)
        );
        assert_eq!((faces[1].id.as_str(), faces[1].path.as_str()), ("f2", outside.to_str().unwrap()));
        assert_eq!((faces[0].width, faces[0].features.len()), (5, 0));
        // Nothing is seeded on top of what the user had.
        assert_eq!(session.collections().unwrap().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["default-col-0"]);
        assert_eq!(session.membership().unwrap()["default-col-0"], ["f1"]);
        assert_eq!(session.tag_membership().unwrap()["t1"], ["f2"]);

        // A second launch does nothing.
        assert!(migrate(&data, &machine).is_empty());
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn resumes_an_interrupted_migration() {
        let (data, copied, _) = legacy();
        let machine = MachineDb::open(&data.join("machine.sqlite")).unwrap();
        // Stopped after the fonts moved, with half a journal written.
        let root = manage::default_root(&data);
        let partial = root.with_extension("typeshelf.partial");
        fs::create_dir_all(partial.join("journal")).unwrap();
        fs::write(partial.join("journal").join("half.jsonl"), b"{\"v\":1").unwrap();
        fs::rename(data.join("Fonts"), partial.join("Fonts")).unwrap();

        migrate(&data, &machine);
        assert!(!partial.exists() && !copied.exists());
        assert!(root.join("Fonts").join("Inter").join("inter.ttf").is_file());
        assert_eq!(journal::files(&root).unwrap().len(), 1);
        assert_eq!(manage::startup(&data, &machine, 20).unwrap().lock().faces().unwrap().len(), 2);
        let _ = fs::remove_dir_all(data);
    }
}

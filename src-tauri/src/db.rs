//! The local SQLite cache of one library. It is never written to directly: every row comes from
//! replaying the library's journals, so it can be thrown away at any time.

use crate::library::journal::{Event, FaceData, FileRef, Op};
use crate::model::{Collection, Face, SmartSet, Tag};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row, Transaction};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

pub struct Db {
    conn: Connection,
}

type R<T> = Result<T, String>;

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

const SCHEMA: &str = "
    CREATE TABLE face (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        face_index INTEGER NOT NULL,
        ps_name TEXT NOT NULL UNIQUE,
        family TEXT NOT NULL,
        style TEXT NOT NULL,
        full_name TEXT NOT NULL,
        weight INTEGER NOT NULL,
        width INTEGER NOT NULL,
        italic INTEGER NOT NULL,
        mono INTEGER NOT NULL,
        classification TEXT NOT NULL,
        version TEXT, designer TEXT, manufacturer TEXT, license TEXT, copyright TEXT,
        glyph_count INTEGER NOT NULL,
        variable INTEGER NOT NULL,
        features TEXT NOT NULL,
        starred INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        imported_on TEXT
    );
    CREATE INDEX face_family ON face(family);
    CREATE INDEX face_path ON face(path);
    CREATE TABLE collection (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE collection_face (
        collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
        face_id TEXT NOT NULL REFERENCES face(id) ON DELETE CASCADE,
        PRIMARY KEY (collection_id, face_id)
    );
    CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, rule TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE face_tag (
        tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
        face_id TEXT NOT NULL REFERENCES face(id) ON DELETE CASCADE,
        PRIMARY KEY (tag_id, face_id)
    );
    CREATE TABLE smart_set (id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE deleted_tag (id TEXT PRIMARY KEY);
    CREATE TABLE face_alias (alias TEXT PRIMARY KEY, id TEXT NOT NULL);
";

const TABLES: &[&str] = &["collection_face", "face_tag", "face", "collection", "tag", "smart_set", "deleted_tag", "face_alias"];

/// What replaying needs to know about this computer.
pub struct Here<'a> {
    pub root: &'a Path,
    pub device_id: &'a str,
    /// device id → computer name
    pub devices: &'a HashMap<String, String>,
}

impl Db {
    pub fn open(path: &Path) -> R<Db> {
        let conn = Connection::open(path).map_err(err)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;").map_err(err)?;
        Ok(Db { conn })
    }

    /// The cache of a library that is not open, as it was last time.
    pub fn open_read_only(path: &Path) -> R<Db> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
        Ok(Db { conn })
    }

    /// Replaces the whole content with the replay of `events`, in one transaction: other readers
    /// see either the old library or the new one.
    pub fn rebuild(&mut self, events: &[Event], here: &Here) -> R<()> {
        let tx = self.conn.transaction().map_err(err)?;
        for table in TABLES {
            tx.execute_batch(&format!("DROP TABLE IF EXISTS {table}")).map_err(err)?;
        }
        tx.execute_batch(SCHEMA).map_err(err)?;
        for event in events {
            apply(&tx, &event.op, here).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    pub fn apply(&mut self, events: &[Event], here: &Here) -> R<()> {
        let tx = self.conn.transaction().map_err(err)?;
        for event in events {
            apply(&tx, &event.op, here).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    // ---- Faces ----

    pub fn faces(&self) -> R<Vec<Face>> {
        let mut stmt = self.conn.prepare("SELECT * FROM face").map_err(err)?;
        let rows = stmt.query_map([], face_from_row).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn face(&self, id: &str) -> R<Option<Face>> {
        let mut stmt = self.conn.prepare("SELECT * FROM face WHERE id = ?1").map_err(err)?;
        let mut rows = stmt.query_map([id], face_from_row).map_err(err)?;
        rows.next().transpose().map_err(err)
    }

    pub fn known_ps_names(&self) -> R<HashSet<String>> {
        let mut stmt = self.conn.prepare("SELECT ps_name FROM face").map_err(err)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn faces_of_families(&self, families: &[String]) -> R<Vec<Face>> {
        Ok(self.faces()?.into_iter().filter(|f| families.contains(&f.family)).collect())
    }

    pub fn path_in_use(&self, path: &str) -> R<bool> {
        self.conn.query_row("SELECT EXISTS(SELECT 1 FROM face WHERE path = ?1)", [path], |r| r.get(0)).map_err(err)
    }

    // ---- Collections, tags, smart sets ----

    pub fn collections(&self) -> R<Vec<Collection>> {
        let mut stmt = self.conn.prepare("SELECT id, name, created_at FROM collection ORDER BY name COLLATE NOCASE").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok(Collection { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? })).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn membership(&self) -> R<HashMap<String, Vec<String>>> {
        self.pairs("SELECT collection_id, face_id FROM collection_face")
    }

    pub fn tags(&self) -> R<Vec<Tag>> {
        let mut stmt = self.conn.prepare("SELECT id, name, color, rule, created_at FROM tag ORDER BY name COLLATE NOCASE").map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, rule: r.get(3)?, created_at: r.get(4)? }))
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn tag_membership(&self) -> R<HashMap<String, Vec<String>>> {
        self.pairs("SELECT tag_id, face_id FROM face_tag")
    }

    fn pairs(&self, sql: &str) -> R<HashMap<String, Vec<String>>> {
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            let (key, face) = row.map_err(err)?;
            map.entry(key).or_default().push(face);
        }
        Ok(map)
    }

    pub fn smart_sets(&self) -> R<Vec<SmartSet>> {
        let mut stmt = self.conn.prepare("SELECT id, name, query, created_at FROM smart_set ORDER BY name COLLATE NOCASE").map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok(SmartSet { id: r.get(0)?, name: r.get(1)?, query: r.get(2)?, created_at: r.get(3)? }))
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }
}

/// The entry a face id stands for: two computers that imported the same font gave it two ids.
fn entry(tx: &Transaction, id: &str) -> rusqlite::Result<String> {
    let aliased = tx.prepare_cached("SELECT id FROM face_alias WHERE alias = ?1")?.query_row([id], |r| r.get(0)).optional()?;
    Ok(aliased.unwrap_or_else(|| id.to_string()))
}

/// One change. Changes to something that is gone do nothing: deleting wins over editing.
fn apply(tx: &Transaction, op: &Op, here: &Here) -> rusqlite::Result<()> {
    match op {
        Op::Device { .. } => {}
        Op::FaceAdd(face) => insert_face(tx, face, here)?,
        Op::FaceRemove { ids } => {
            for id in ids {
                tx.execute("DELETE FROM face WHERE id = ?1", [entry(tx, id)?])?;
            }
        }
        Op::FaceRepoint { id, file, face_index, version, glyph_count, width, features } => {
            tx.execute(
                "UPDATE face SET path = ?1, face_index = ?2, version = ?3, glyph_count = ?4, width = ?5, features = ?6,
                     imported_on = ?7 WHERE id = ?8",
                params![
                    file.resolve(here.root).to_string_lossy(),
                    face_index,
                    version,
                    glyph_count,
                    width,
                    features.join(" "),
                    imported_on(file, here),
                    entry(tx, id)?
                ],
            )?;
        }
        Op::FaceStar { ids, starred } => {
            for id in ids {
                tx.execute("UPDATE face SET starred = ?1 WHERE id = ?2", params![starred, entry(tx, id)?])?;
            }
        }
        Op::CollectionCreate { id, name, created_at } => {
            tx.execute("INSERT OR IGNORE INTO collection (id, name, created_at) VALUES (?1, ?2, ?3)", params![id, name, created_at])?;
        }
        Op::CollectionRename { id, name } => {
            tx.execute("UPDATE collection SET name = ?1 WHERE id = ?2", params![name, id])?;
        }
        Op::CollectionDelete { id } => {
            tx.execute("DELETE FROM collection WHERE id = ?1", [id])?;
        }
        Op::CollectionAdd { id, faces } => {
            for face in faces {
                tx.execute(
                    "INSERT OR IGNORE INTO collection_face (collection_id, face_id)
                     SELECT c.id, f.id FROM collection c, face f WHERE c.id = ?1 AND f.id = ?2",
                    params![id, entry(tx, face)?],
                )?;
            }
        }
        Op::CollectionRemove { id, faces } => {
            for face in faces {
                tx.execute("DELETE FROM collection_face WHERE collection_id = ?1 AND face_id = ?2", params![id, entry(tx, face)?])?;
            }
        }
        Op::TagSave { id, name, color, rule, created_at } => {
            tx.execute(
                "INSERT INTO tag (id, name, color, rule, created_at)
                 SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM deleted_tag WHERE id = ?1)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, rule = excluded.rule",
                params![id, name, color, rule, created_at],
            )?;
            if rule.is_some() {
                // A smart tag has no explicit members.
                tx.execute("DELETE FROM face_tag WHERE tag_id = ?1", [id])?;
            }
        }
        Op::TagDelete { id } => {
            tx.execute("DELETE FROM tag WHERE id = ?1", [id])?;
            // Saving a tag creates it: without this, a concurrent edit would bring it back.
            tx.execute("INSERT OR IGNORE INTO deleted_tag (id) VALUES (?1)", [id])?;
        }
        Op::TagSet { id, faces, tagged } => {
            for face in faces {
                let sql = if *tagged {
                    "INSERT OR IGNORE INTO face_tag (tag_id, face_id)
                     SELECT t.id, f.id FROM tag t, face f WHERE t.id = ?1 AND f.id = ?2 AND t.rule IS NULL"
                } else {
                    "DELETE FROM face_tag WHERE tag_id = ?1 AND face_id = ?2"
                };
                tx.execute(sql, params![id, entry(tx, face)?])?;
            }
        }
        Op::SetCreate { id, name, query, created_at } => {
            tx.execute(
                "INSERT OR IGNORE INTO smart_set (id, name, query, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, query, created_at],
            )?;
        }
        Op::SetUpdate { id, name, query } => {
            tx.execute("UPDATE smart_set SET name = ?1, query = ?2 WHERE id = ?3", params![name, query, id])?;
        }
        Op::SetDelete { id } => {
            tx.execute("DELETE FROM smart_set WHERE id = ?1", [id])?;
        }
    }
    Ok(())
}

/// The computer a font was imported on, when that is not this one and the file stayed there.
fn imported_on(file: &FileRef, here: &Here) -> Option<String> {
    match file {
        FileRef::Outside { dev, system: false, .. } if dev != here.device_id => here.devices.get(dev).cloned(),
        _ => None,
    }
}

fn insert_face(tx: &Transaction, face: &FaceData, here: &Here) -> rusqlite::Result<()> {
    // One entry per PostScript name: the first import wins, and later ids stand for it.
    let existing: Option<String> =
        tx.prepare_cached("SELECT id FROM face WHERE ps_name = ?1")?.query_row([&face.ps_name], |r| r.get(0)).optional()?;
    if let Some(existing) = existing {
        if existing != face.id {
            tx.execute("INSERT OR REPLACE INTO face_alias (alias, id) VALUES (?1, ?2)", params![face.id, existing])?;
        }
        return Ok(());
    }
    tx.prepare_cached(
        "INSERT OR IGNORE INTO face (id, path, face_index, ps_name, family, style, full_name, weight, width, italic, mono,
             classification, version, designer, manufacturer, license, copyright, glyph_count, variable, features,
             starred, added_at, imported_on)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
    )?
    .execute(params![
        face.id,
        face.file.resolve(here.root).to_string_lossy(),
        face.face_index,
        face.ps_name,
        face.family,
        face.style,
        face.full_name,
        face.weight,
        face.width,
        face.italic,
        face.mono,
        face.classification,
        face.version,
        face.designer,
        face.manufacturer,
        face.license,
        face.copyright,
        face.glyph_count,
        face.variable,
        face.features.join(" "),
        face.starred,
        face.added_at,
        imported_on(&face.file, here),
    ])?;
    Ok(())
}

fn face_from_row(r: &Row) -> rusqlite::Result<Face> {
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
        features: r.get::<_, String>("features")?.split_whitespace().map(str::to_owned).collect(),
        starred: r.get("starred")?,
        added_at: r.get("added_at")?,
        available: true,
        imported_on: r.get("imported_on")?,
    })
}

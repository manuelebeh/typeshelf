use crate::fonts;
use crate::model::{Collection, Face, SmartSet, Tag};
use rusqlite::{params, Connection, Row};
use std::collections::HashMap;
use std::path::Path;

pub struct Db {
    conn: Connection,
}

type R<T> = Result<T, String>;

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

impl Db {
    pub fn open(path: &Path) -> R<Db> {
        let conn = Connection::open(path).map_err(err)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS face (
                 id TEXT PRIMARY KEY,
                 path TEXT NOT NULL,
                 face_index INTEGER NOT NULL DEFAULT 0,
                 ps_name TEXT NOT NULL UNIQUE,
                 family TEXT NOT NULL,
                 style TEXT NOT NULL,
                 full_name TEXT NOT NULL,
                 weight INTEGER NOT NULL DEFAULT 400,
                 italic INTEGER NOT NULL DEFAULT 0,
                 mono INTEGER NOT NULL DEFAULT 0,
                 classification TEXT NOT NULL,
                 version TEXT, designer TEXT, manufacturer TEXT, license TEXT, copyright TEXT,
                 glyph_count INTEGER NOT NULL DEFAULT 0,
                 variable INTEGER NOT NULL DEFAULT 0,
                 starred INTEGER NOT NULL DEFAULT 0,
                 added_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS face_family ON face(family);
             CREATE INDEX IF NOT EXISTS face_path ON face(path);
             CREATE TABLE IF NOT EXISTS collection (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS collection_face (
                 collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
                 face_id TEXT NOT NULL REFERENCES face(id) ON DELETE CASCADE,
                 PRIMARY KEY (collection_id, face_id)
             );
             CREATE TABLE IF NOT EXISTS tag (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 color TEXT NOT NULL,
                 rule TEXT,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS face_tag (
                 tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                 face_id TEXT NOT NULL REFERENCES face(id) ON DELETE CASCADE,
                 PRIMARY KEY (tag_id, face_id)
             );
             CREATE TABLE IF NOT EXISTS activation (
                 path TEXT PRIMARY KEY,
                 scope TEXT NOT NULL
             );",
        )
        .map_err(err)?;
        let db = Db { conn };
        db.seed_defaults()?;
        db.migrate()?;
        Ok(db)
    }

    /// Rows of the activation table, which now lives in the machine database.
    pub fn take_activation(&self) -> R<Vec<(String, String)>> {
        let rows = {
            let mut stmt = self.conn.prepare("SELECT path, scope FROM activation").map_err(err)?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
            rows.collect::<Result<Vec<(String, String)>, _>>().map_err(err)?
        };
        self.conn.execute("DELETE FROM activation", []).map_err(err)?;
        Ok(rows)
    }

    fn version(&self) -> R<i64> {
        self.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(err)
    }

    /// Schema changes since the first release, one step per `user_version` (1 is the
    /// seeded first schema). A new database goes through the same steps.
    fn migrate(&self) -> R<()> {
        if self.version()? < 2 {
            // A NULL `features` marks a row still to be read from its file.
            self.conn
                .execute_batch(
                    "BEGIN;
                     ALTER TABLE face ADD COLUMN width INTEGER NOT NULL DEFAULT 5;
                     ALTER TABLE face ADD COLUMN features TEXT;
                     CREATE TABLE smart_set (
                         id TEXT PRIMARY KEY,
                         name TEXT NOT NULL,
                         query TEXT NOT NULL,
                         created_at INTEGER NOT NULL
                     );
                     PRAGMA user_version = 2;
                     COMMIT;",
                )
                .map_err(err)?;
        }
        Ok(())
    }

    /// Reads width and features from the files of faces imported before version 2.
    /// An unreadable file gets an empty list, so it is not retried at every launch.
    pub fn backfill_metrics(&mut self) -> R<()> {
        let pending: Vec<(String, String, u32)> = {
            let mut stmt = self.conn.prepare("SELECT id, path, face_index FROM face WHERE features IS NULL ORDER BY path").map_err(err)?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(err)?;
            rows.collect::<Result<_, _>>().map_err(err)?
        };
        if pending.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction().map_err(err)?;
        for file in pending.chunk_by(|a, b| a.1 == b.1) {
            let data = fonts::map(Path::new(&file[0].1)).ok();
            for (id, _, index) in file {
                let (width, features) = data.as_deref().and_then(|d| fonts::metrics(d, *index)).unwrap_or((5, Vec::new()));
                tx.execute("UPDATE face SET width = ?1, features = ?2 WHERE id = ?3", params![width, features.join(" "), id])
                    .map_err(err)?;
            }
        }
        tx.commit().map_err(err)
    }

    /// First launch: a few collections and tags to start from. Runs once (user_version),
    /// so whatever the user later deletes stays deleted.
    fn seed_defaults(&self) -> R<()> {
        if self.version()? >= 1 {
            return Ok(());
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let collections = ["Projects", "Brand identity", "Web & screens", "To try"];
        for (i, name) in collections.iter().enumerate() {
            self.conn
                .execute(
                    "INSERT INTO collection (id, name, created_at) SELECT ?1, ?2, ?3
                     WHERE NOT EXISTS (SELECT 1 FROM collection WHERE name = ?2)",
                    params![format!("default-col-{i}"), name, now + i as i64],
                )
                .map_err(err)?;
        }
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
        for (i, (name, color, rule)) in tags.iter().enumerate() {
            self.conn
                .execute(
                    "INSERT INTO tag (id, name, color, rule, created_at) SELECT ?1, ?2, ?3, ?4, ?5
                     WHERE NOT EXISTS (SELECT 1 FROM tag WHERE name = ?2)",
                    params![format!("default-tag-{i}"), name, color, rule, now + i as i64],
                )
                .map_err(err)?;
        }
        self.conn.execute_batch("PRAGMA user_version = 1").map_err(err)
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

    pub fn known_ps_names(&self) -> R<std::collections::HashSet<String>> {
        let mut stmt = self.conn.prepare("SELECT ps_name FROM face").map_err(err)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn insert_faces(&mut self, faces: &[Face]) -> R<usize> {
        let tx = self.conn.transaction().map_err(err)?;
        let mut inserted = 0;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO face (id, path, face_index, ps_name, family, style, full_name, weight,
                        italic, mono, classification, version, designer, manufacturer, license, copyright,
                        glyph_count, variable, starred, added_at, width, features)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
                )
                .map_err(err)?;
            for f in faces {
                inserted += stmt
                    .execute(params![
                        f.id,
                        f.path,
                        f.face_index,
                        f.ps_name,
                        f.family,
                        f.style,
                        f.full_name,
                        f.weight,
                        f.italic,
                        f.mono,
                        f.classification,
                        f.version,
                        f.designer,
                        f.manufacturer,
                        f.license,
                        f.copyright,
                        f.glyph_count,
                        f.variable,
                        f.starred,
                        f.added_at,
                        f.width,
                        f.features.join(" ")
                    ])
                    .map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
        Ok(inserted)
    }

    pub fn faces_of_families(&self, families: &[String]) -> R<Vec<Face>> {
        Ok(self.faces()?.into_iter().filter(|f| families.contains(&f.family)).collect())
    }

    pub fn delete_faces(&mut self, ids: &[String]) -> R<()> {
        let tx = self.conn.transaction().map_err(err)?;
        for id in ids {
            tx.execute("DELETE FROM face WHERE id = ?1", [id]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    /// Points a library face at another copy of the same font. Its id is kept, and with it
    /// the favourite flag, collections and tags.
    pub fn repoint_face(&self, id: &str, copy: &Face) -> R<()> {
        self.conn
            .execute(
                "UPDATE face SET path = ?1, face_index = ?2, version = ?3, glyph_count = ?4, width = ?5, features = ?6 WHERE id = ?7",
                params![copy.path, copy.face_index, copy.version, copy.glyph_count, copy.width, copy.features.join(" "), id],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn path_in_use(&self, path: &str) -> R<bool> {
        self.conn.query_row("SELECT EXISTS(SELECT 1 FROM face WHERE path = ?1)", [path], |r| r.get(0)).map_err(err)
    }

    pub fn set_starred(&self, family: &str, starred: bool) -> R<()> {
        self.conn.execute("UPDATE face SET starred = ?1 WHERE family = ?2", params![starred, family]).map(|_| ()).map_err(err)
    }

    // ---- Collections ----

    pub fn collections(&self) -> R<Vec<Collection>> {
        let mut stmt = self.conn.prepare("SELECT id, name, created_at FROM collection ORDER BY name COLLATE NOCASE").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok(Collection { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? })).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn membership(&self) -> R<HashMap<String, Vec<String>>> {
        let mut stmt = self.conn.prepare("SELECT collection_id, face_id FROM collection_face").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            let (c, f) = row.map_err(err)?;
            map.entry(c).or_default().push(f);
        }
        Ok(map)
    }

    pub fn create_collection(&self, id: &str, name: &str, now: i64) -> R<()> {
        self.conn
            .execute("INSERT INTO collection (id, name, created_at) VALUES (?1, ?2, ?3)", params![id, name, now])
            .map(|_| ())
            .map_err(err)
    }

    pub fn rename_collection(&self, id: &str, name: &str) -> R<()> {
        self.conn.execute("UPDATE collection SET name = ?1 WHERE id = ?2", params![name, id]).map(|_| ()).map_err(err)
    }

    pub fn delete_collection(&self, id: &str) -> R<()> {
        self.conn.execute("DELETE FROM collection WHERE id = ?1", [id]).map(|_| ()).map_err(err)
    }

    pub fn add_to_collection(&mut self, id: &str, face_ids: &[String]) -> R<()> {
        let tx = self.conn.transaction().map_err(err)?;
        for face in face_ids {
            tx.execute("INSERT OR IGNORE INTO collection_face (collection_id, face_id) VALUES (?1, ?2)", params![id, face]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    pub fn remove_from_collection(&mut self, id: &str, face_ids: &[String]) -> R<()> {
        let tx = self.conn.transaction().map_err(err)?;
        for face in face_ids {
            tx.execute("DELETE FROM collection_face WHERE collection_id = ?1 AND face_id = ?2", params![id, face]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    // ---- Tags ----

    pub fn tags(&self) -> R<Vec<Tag>> {
        let mut stmt = self.conn.prepare("SELECT id, name, color, rule, created_at FROM tag ORDER BY name COLLATE NOCASE").map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, rule: r.get(3)?, created_at: r.get(4)? }))
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn tag_membership(&self) -> R<HashMap<String, Vec<String>>> {
        let mut stmt = self.conn.prepare("SELECT tag_id, face_id FROM face_tag").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            let (t, f) = row.map_err(err)?;
            map.entry(t).or_default().push(f);
        }
        Ok(map)
    }

    pub fn save_tag(&self, tag: &Tag) -> R<()> {
        self.conn
            .execute(
                "INSERT INTO tag (id, name, color, rule, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, rule = excluded.rule",
                params![tag.id, tag.name, tag.color, tag.rule, tag.created_at],
            )
            .map_err(err)?;
        if tag.rule.is_some() {
            // A smart tag has no explicit members.
            self.conn.execute("DELETE FROM face_tag WHERE tag_id = ?1", [&tag.id]).map_err(err)?;
        }
        Ok(())
    }

    pub fn delete_tag(&self, id: &str) -> R<()> {
        self.conn.execute("DELETE FROM tag WHERE id = ?1", [id]).map(|_| ()).map_err(err)
    }

    pub fn set_tagged(&mut self, id: &str, face_ids: &[String], tagged: bool) -> R<()> {
        let is_smart: bool = self
            .conn
            .query_row("SELECT rule IS NOT NULL FROM tag WHERE id = ?1", [id], |r| r.get(0))
            .map_err(|_| "Tag not found".to_string())?;
        if is_smart {
            return Err("Un tag intelligent se remplit automatiquement".into());
        }
        let tx = self.conn.transaction().map_err(err)?;
        for face in face_ids {
            if tagged {
                tx.execute("INSERT OR IGNORE INTO face_tag (tag_id, face_id) VALUES (?1, ?2)", params![id, face])
            } else {
                tx.execute("DELETE FROM face_tag WHERE tag_id = ?1 AND face_id = ?2", params![id, face])
            }
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    // ---- Smart sets ----

    pub fn smart_sets(&self) -> R<Vec<SmartSet>> {
        let mut stmt = self.conn.prepare("SELECT id, name, query, created_at FROM smart_set ORDER BY name COLLATE NOCASE").map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok(SmartSet { id: r.get(0)?, name: r.get(1)?, query: r.get(2)?, created_at: r.get(3)? }))
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn create_smart_set(&self, set: &SmartSet) -> R<()> {
        self.conn
            .execute(
                "INSERT INTO smart_set (id, name, query, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![set.id, set.name, set.query, set.created_at],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn update_smart_set(&self, id: &str, name: &str, query: &str) -> R<()> {
        let changed =
            self.conn.execute("UPDATE smart_set SET name = ?1, query = ?2 WHERE id = ?3", params![name, query, id]).map_err(err)?;
        if changed == 0 {
            return Err("Smart set not found".into());
        }
        Ok(())
    }

    pub fn delete_smart_set(&self, id: &str) -> R<()> {
        self.conn.execute("DELETE FROM smart_set WHERE id = ?1", [id]).map(|_| ()).map_err(err)
    }
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
        features: r.get::<_, Option<String>>("features")?.unwrap_or_default().split_whitespace().map(str::to_owned).collect(),
        starred: r.get("starred")?,
        added_at: r.get("added_at")?,
    })
}

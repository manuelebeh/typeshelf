//! What belongs to this computer and never travels with a library: which files are activated,
//! which libraries are known here and a few settings.

use crate::model::Scope;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

type R<T> = Result<T, String>;

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

pub const CURRENT_LIBRARY: &str = "current_library";
pub const DEVICE_NAME: &str = "device_name";

/// A library this computer has opened.
#[derive(Debug, Clone)]
pub struct KnownLibrary {
    pub id: String,
    pub path: PathBuf,
    /// Names this computer's journal in that library.
    pub device_id: String,
}

pub struct MachineDb {
    conn: Connection,
}

impl MachineDb {
    pub fn open(path: &Path) -> R<MachineDb> {
        let conn = Connection::open(path).map_err(err)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS activation (path TEXT PRIMARY KEY, scope TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS library (
                 id TEXT PRIMARY KEY,
                 path TEXT NOT NULL,
                 device_id TEXT NOT NULL,
                 last_opened INTEGER NOT NULL
             );",
        )
        .map_err(err)?;
        Ok(MachineDb { conn })
    }

    // ---- Activation ----

    pub fn activation(&self) -> R<HashMap<String, Scope>> {
        let mut stmt = self.conn.prepare("SELECT path, scope FROM activation").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, Scope::parse(&r.get::<_, String>(1)?)))).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn scope_of(&self, path: &str) -> R<Scope> {
        let scope: Option<String> =
            self.conn.query_row("SELECT scope FROM activation WHERE path = ?1", [path], |r| r.get(0)).optional().map_err(err)?;
        Ok(scope.map_or(Scope::None, |s| Scope::parse(&s)))
    }

    pub fn set_scope(&self, path: &str, scope: Scope) -> R<()> {
        if scope == Scope::None {
            self.conn.execute("DELETE FROM activation WHERE path = ?1", [path])
        } else {
            self.conn.execute(
                "INSERT INTO activation (path, scope) VALUES (?1, ?2)
                 ON CONFLICT(path) DO UPDATE SET scope = excluded.scope",
                params![path, scope.as_str()],
            )
        }
        .map(|_| ())
        .map_err(err)
    }

    // ---- Settings ----

    pub fn setting(&self, key: &str) -> R<Option<String>> {
        self.conn.query_row("SELECT value FROM setting WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(err)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> R<()> {
        self.conn
            .execute(
                "INSERT INTO setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// The name other computers see next to what this one imported.
    pub fn device_name(&self) -> R<String> {
        if let Some(name) = self.setting(DEVICE_NAME)? {
            return Ok(name);
        }
        let host = gethostname::gethostname().to_string_lossy().into_owned();
        let name = host.strip_suffix(".local").unwrap_or(&host).to_string();
        let name = if name.is_empty() { "Computer".into() } else { name };
        self.set_setting(DEVICE_NAME, &name)?;
        Ok(name)
    }

    // ---- Known libraries ----

    /// Most recently opened first.
    pub fn libraries(&self) -> R<Vec<KnownLibrary>> {
        let mut stmt = self.conn.prepare("SELECT id, path, device_id FROM library ORDER BY last_opened DESC, path").map_err(err)?;
        let rows = stmt.query_map([], known_from_row).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn library(&self, id: &str) -> R<Option<KnownLibrary>> {
        self.conn.query_row("SELECT id, path, device_id FROM library WHERE id = ?1", [id], known_from_row).optional().map_err(err)
    }

    /// Records that a library was opened at `path`, keeping its device id if it is known.
    pub fn remember(&self, id: &str, path: &Path, device_id: &str, now: i64) -> R<()> {
        self.conn
            .execute(
                "INSERT INTO library (id, path, device_id, last_opened) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET path = excluded.path, last_opened = excluded.last_opened",
                params![id, path.to_string_lossy(), device_id, now],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn set_device(&self, id: &str, device_id: &str) -> R<()> {
        self.conn.execute("UPDATE library SET device_id = ?1 WHERE id = ?2", params![device_id, id]).map(|_| ()).map_err(err)
    }

    pub fn forget(&self, id: &str) -> R<()> {
        self.conn.execute("DELETE FROM library WHERE id = ?1", [id]).map(|_| ()).map_err(err)
    }
}

fn known_from_row(r: &rusqlite::Row) -> rusqlite::Result<KnownLibrary> {
    Ok(KnownLibrary { id: r.get(0)?, path: PathBuf::from(r.get::<_, String>(1)?), device_id: r.get(2)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> MachineDb {
        MachineDb::open(&std::env::temp_dir().join(format!("typeshelf-machine-{}.sqlite", uuid::Uuid::new_v4()))).unwrap()
    }

    #[test]
    fn keeps_activation_settings_and_libraries() {
        let db = temp();
        db.set_scope("/a.ttf", Scope::Temporary).unwrap();
        db.set_scope("/a.ttf", Scope::Persistent).unwrap();
        assert_eq!(db.scope_of("/a.ttf").unwrap(), Scope::Persistent);
        db.set_scope("/a.ttf", Scope::None).unwrap();
        assert!(db.activation().unwrap().is_empty());

        assert_eq!(db.setting("x").unwrap(), None);
        db.set_setting("x", "1").unwrap();
        db.set_setting("x", "2").unwrap();
        assert_eq!(db.setting("x").unwrap().as_deref(), Some("2"));
        assert!(!db.device_name().unwrap().is_empty());

        db.remember("l1", Path::new("/one"), "d1", 1).unwrap();
        db.remember("l2", Path::new("/two"), "d2", 2).unwrap();
        // Reopening elsewhere keeps the device id.
        db.remember("l1", Path::new("/moved"), "other", 3).unwrap();
        let again = db.library("l1").unwrap().unwrap();
        assert_eq!((again.device_id.as_str(), again.path), ("d1", PathBuf::from("/moved")));
        assert_eq!(db.libraries().unwrap().iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["l1", "l2"]);
        db.forget("l1").unwrap();
        assert!(db.library("l1").unwrap().is_none());
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One face (style) inside a font file. Collections (.ttc/.otc) hold several.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Face {
    pub id: String,
    pub path: String,
    pub face_index: u32,
    pub ps_name: String,
    pub family: String,
    pub style: String,
    pub full_name: String,
    pub weight: u16,
    /// OS/2 usWidthClass, 1 (ultra-condensed) to 9 (ultra-expanded).
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
    /// GSUB and GPOS feature tags, sorted.
    pub features: Vec<String>,
    pub starred: bool,
    pub added_at: i64,
}

/// A label applied to families. Manual tags list their faces explicitly; smart tags
/// carry a `rule` (JSON, evaluated by the interface) and have no stored members.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub rule: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

/// A saved search: its `query` (JSON, evaluated by the interface) picks the families.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartSet {
    pub id: String,
    pub name: String,
    pub query: String,
    pub created_at: i64,
}

/// How a font file is made available to other applications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Not registered.
    None,
    /// Registered until Typeshelf quits.
    Temporary,
    /// Registered across restarts.
    Persistent,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::None => "none",
            Scope::Temporary => "temporary",
            Scope::Persistent => "persistent",
        }
    }

    pub fn parse(s: &str) -> Scope {
        match s {
            "temporary" => Scope::Temporary,
            "persistent" => Scope::Persistent,
            _ => Scope::None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub faces: Vec<Face>,
    pub collections: Vec<Collection>,
    /// collection id → face ids
    pub membership: HashMap<String, Vec<String>>,
    pub tags: Vec<Tag>,
    /// manual tag id → face ids
    pub tag_membership: HashMap<String, Vec<String>>,
    pub smart_sets: Vec<SmartSet>,
    /// file path → activation scope (only active files are listed)
    pub activation: HashMap<String, Scope>,
    pub fonts_dir: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: usize,
    pub skipped: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Axis {
    pub tag: String,
    pub name: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceDetails {
    pub characters: Vec<u32>,
    pub characters_truncated: bool,
    pub features: Vec<String>,
    pub axes: Vec<Axis>,
    pub format: String,
    pub file_size: u64,
}

//! Google Fonts: public catalogue (cached on disk) and download of TrueType files.
//!
//! Only two public endpoints are used, without any key or account:
//! - the catalogue metadata (`fonts.google.com/metadata/fonts`);
//! - the CSS API, which serves TrueType URLs to clients that are not web browsers.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const CATALOG_URL: &str = "https://fonts.google.com/metadata/fonts";
const CSS_URL: &str = "https://fonts.googleapis.com/css2";
const FILES_HOST: &str = "https://fonts.gstatic.com/";
/// A non-browser user agent makes the CSS API answer with TrueType files (not WOFF2).
const USER_AGENT: &str = "Typeshelf";
const CACHE_DAYS: i64 = 7;
const CJK: [&str; 5] = ["chinese-simplified", "chinese-traditional", "chinese-hongkong", "japanese", "korean"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GoogleFamily {
    pub family: String,
    pub category: String,
    /// Catalogue style keys: "400", "700i"…
    pub styles: Vec<String>,
    pub axes: Vec<GoogleAxis>,
    pub designers: Vec<String>,
    pub subsets: Vec<String>,
    pub popularity: u32,
    pub date_added: String,
    /// Chinese, Japanese or Korean family (large downloads).
    pub cjk: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GoogleAxis {
    pub tag: String,
    pub min: f32,
    pub max: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCatalog {
    pub fetched_at: i64,
    pub families: Vec<GoogleFamily>,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .user_agent(USER_AGENT)
        .build()
        .into()
}

fn get_text(url: &str) -> Result<String, String> {
    agent()
        .get(url)
        .call()
        .map_err(|e| format!("Google Fonts injoignable : {e}"))?
        .body_mut()
        .with_config()
        .limit(20 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())
}

/// Returns the cached catalogue when it is recent, otherwise downloads it again.
/// When the network fails, an older cache is better than nothing.
pub fn catalog(cache: &Path, refresh: bool, now: i64) -> Result<GoogleCatalog, String> {
    let cached = fs::read(cache).ok().and_then(|b| serde_json::from_slice::<GoogleCatalog>(&b).ok());
    if let Some(c) = &cached {
        if !refresh && now - c.fetched_at < CACHE_DAYS * 86400 {
            return Ok(c.clone());
        }
    }
    match get_text(CATALOG_URL).and_then(|text| parse_catalog(&text, now)) {
        Ok(fresh) => {
            if let Ok(bytes) = serde_json::to_vec(&fresh) {
                let _ = fs::write(cache, bytes);
            }
            Ok(fresh)
        }
        Err(e) => cached.ok_or(e),
    }
}

#[derive(Deserialize)]
struct RawCatalog {
    #[serde(rename = "familyMetadataList")]
    families: Vec<RawFamily>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFamily {
    family: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    fonts: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    axes: Vec<GoogleAxis>,
    #[serde(default)]
    designers: Vec<String>,
    #[serde(default)]
    subsets: Vec<String>,
    #[serde(default)]
    popularity: Option<u32>,
    #[serde(default)]
    date_added: Option<String>,
}

pub fn parse_catalog(text: &str, now: i64) -> Result<GoogleCatalog, String> {
    // The response may start with an anti-JSON-hijacking prefix.
    let start = text.find('{').ok_or("Catalogue Google Fonts illisible")?;
    let raw: RawCatalog = serde_json::from_str(&text[start..]).map_err(|e| format!("Catalogue Google Fonts illisible : {e}"))?;
    let families = raw
        .families
        .into_iter()
        .filter(|f| !f.fonts.is_empty())
        .map(|f| {
            let mut styles: Vec<String> = f.fonts.into_keys().filter(|k| parse_style(k).is_some()).collect();
            styles.sort_by_key(|k| parse_style(k));
            GoogleFamily {
                cjk: f.subsets.iter().any(|s| CJK.contains(&s.as_str())),
                family: f.family,
                category: f.category,
                styles,
                axes: f.axes,
                designers: f.designers,
                subsets: f.subsets.into_iter().filter(|s| s != "menu").collect(),
                popularity: f.popularity.unwrap_or(u32::MAX),
                date_added: f.date_added.unwrap_or_default(),
            }
        })
        .collect();
    Ok(GoogleCatalog { fetched_at: now, families })
}

/// "700i" → (1, 700)
fn parse_style(key: &str) -> Option<(u8, u16)> {
    let (weight, italic) = key.strip_suffix('i').map_or((key, 0), |w| (w, 1));
    weight.parse().ok().filter(|w| (1..=1000).contains(w)).map(|w| (italic, w))
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b' ' => "+".to_string(),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// CSS API URL asking for every style of the family.
pub fn css_url(family: &GoogleFamily) -> String {
    let tuples: BTreeSet<(u8, u16)> = family.styles.iter().filter_map(|s| parse_style(s)).collect();
    let spec = tuples.iter().map(|(i, w)| format!("{i},{w}")).collect::<Vec<_>>().join(";");
    format!("{CSS_URL}?family={}:ital,wght@{spec}", encode(&family.family))
}

/// (italic, weight, url) for each @font-face block, first source only.
pub fn parse_css(css: &str) -> Vec<(bool, u16, String)> {
    let mut seen = BTreeSet::new();
    css.split("@font-face")
        .skip(1)
        .filter_map(|block| {
            let value = |prop: &str| {
                let rest = &block[block.find(prop)? + prop.len()..];
                Some(rest[..rest.find(';')?].trim().trim_start_matches(':').trim().to_string())
            };
            let italic = value("font-style").is_some_and(|s| s == "italic");
            let weight = value("font-weight")?.split_whitespace().next()?.parse().ok()?;
            let rest = &block[block.find("url(")? + 4..];
            let url = rest[..rest.find(')')?].trim_matches(['\'', '"']).to_string();
            (url.starts_with(FILES_HOST) && seen.insert((italic, weight))).then_some((italic, weight, url))
        })
        .collect()
}

fn safe_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '-' } else { c })
        .collect();
    if s.trim().is_empty() || s.starts_with('.') { "Sans nom".into() } else { s }
}

/// Downloads every style of `family` into `root/<family>/` and returns the files written.
pub fn download(family: &GoogleFamily, root: &Path) -> Result<Vec<PathBuf>, String> {
    let faces = parse_css(&get_text(&css_url(family))?);
    if faces.is_empty() {
        return Err(format!("{} : aucun fichier proposé par Google Fonts", family.family));
    }
    let name = safe_name(&family.family);
    let folder = root.join(&name);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let agent = agent();
    let mut written = Vec::new();
    for (italic, weight, url) in faces {
        let ext = if url.ends_with(".otf") { "otf" } else { "ttf" };
        let path = folder.join(format!("{name}-{weight}{}.{ext}", if italic { "Italic" } else { "" }));
        let bytes = agent
            .get(&url)
            .call()
            .map_err(|e| format!("Téléchargement impossible : {e}"))?
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        if ttf_parser::Face::parse(&bytes, 0).is_err() {
            return Err(format!("{} : fichier reçu illisible", family.family));
        }
        fs::write(&path, bytes).map_err(|e| e.to_string())?;
        written.push(path);
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_catalog_and_css() {
        let text = r#")]}'
{"familyMetadataList":[
 {"family":"Demo Sans","category":"Sans Serif","fonts":{"700i":{},"400":{},"400i":{},"menu":{}},
  "axes":[{"tag":"wght","min":400,"max":700,"defaultValue":400}],"designers":["A"],
  "subsets":["menu","latin"],"popularity":3,"dateAdded":"2020-01-01"},
 {"family":"Demo JP","category":"Serif","fonts":{"400":{}},"subsets":["japanese"]}
]}"#;
        let cat = parse_catalog(text, 10).unwrap();
        assert_eq!(cat.families.len(), 2);
        let demo = &cat.families[0];
        assert_eq!(demo.styles, ["400", "400i", "700i"]);
        assert_eq!(demo.subsets, ["latin"]);
        assert!(!demo.cjk && cat.families[1].cjk);
        assert_eq!(css_url(demo), "https://fonts.googleapis.com/css2?family=Demo+Sans:ital,wght@0,400;1,400;1,700");

        let css = "@font-face {\n  font-family: 'Demo Sans';\n  font-style: italic;\n  font-weight: 700;\n  src: url(https://fonts.gstatic.com/s/demo/v1/a.ttf) format('truetype');\n}\n\
                   @font-face {\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://evil.example/b.ttf) format('truetype');\n}";
        assert_eq!(parse_css(css), vec![(true, 700, "https://fonts.gstatic.com/s/demo/v1/a.ttf".to_string())]);
    }

    /// Hits the network: run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn downloads_a_family() {
        let dir = std::env::temp_dir().join(format!("typeshelf-gf-{}", uuid::Uuid::new_v4()));
        let cat = catalog(&dir.join("cache.json"), true, 0).unwrap();
        assert!(cat.families.len() > 1000);
        let family = cat.families.iter().find(|f| f.family == "Inter").unwrap();
        let files = download(family, &dir).unwrap();
        assert!(files.len() >= 2);
        let _ = fs::remove_dir_all(dir);
    }
}

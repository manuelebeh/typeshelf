//! What Typeshelf asks of the design applications. A plugin cannot be called: it polls
//! (see `plugin_api`), picks up the commands queued for it and posts the outcome back.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// A plugin that has not polled for this long is gone. Plugins poll every second.
const ALIVE: Duration = Duration::from_secs(5);
/// A command nobody picked up in time is dropped: applying a font much later would surprise.
const COMMAND_TTL: Duration = Duration::from_secs(10);
const MAX_CLIENTS: usize = 16;
const MAX_QUEUE: usize = 8;
const MAX_TEXT: usize = 1000;
const MAX_NAME: usize = 200;

pub const APPLY: &str = "apply";
pub const SELECTION: &str = "selection";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: u64,
    /// `APPLY` or `SELECTION`.
    pub kind: &'static str,
    /// PostScript name of the font to apply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedApp {
    pub name: String,
    pub document: Option<String>,
    pub can: Vec<&'static str>,
}

/// The selected text of a document and the style of its first character.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub text: String,
    /// PostScript name.
    #[serde(default)]
    pub font: Option<String>,
    /// In the document's own unit.
    #[serde(default)]
    pub size: Option<f64>,
    /// `#rrggbb`.
    #[serde(default)]
    pub color: Option<String>,
    /// Thousandths of an em.
    #[serde(default)]
    pub tracking: Option<f64>,
    /// Text objects selected.
    #[serde(default)]
    pub count: u32,
}

impl Selection {
    /// What a plugin sent, made safe to show: these values end up in the interface's CSS.
    /// `None` when there is no text.
    pub fn clean(self) -> Option<Selection> {
        // Applications end lines with "\r" or the "end of text" control character.
        let text: String = self
            .text
            .replace("\r\n", "\n")
            .chars()
            .map(|c| if matches!(c, '\r' | '\u{3}') { '\n' } else { c })
            .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
            .take(MAX_TEXT)
            .collect();
        if text.trim().is_empty() {
            return None;
        }
        let hex = |c: &String| c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit());
        Some(Selection {
            text,
            font: self.font.map(|f| clip(&f, MAX_NAME)).filter(|f| !f.is_empty()),
            size: self.size.filter(|s| s.is_finite() && *s > 0.0),
            color: self.color.filter(hex),
            tracking: self.tracking.filter(|t| t.is_finite()).map(|t| t.clamp(-1000.0, 10_000.0)),
            count: self.count,
        })
    }
}

/// The outcome of a command, or a selection the plugin sent on its own (`id` is then `None`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub client: String,
    pub id: Option<u64>,
    pub kind: &'static str,
    pub ok: bool,
    /// "no_document", "no_selection", "font_unavailable", or the application's own message.
    pub error: Option<String>,
    /// Text objects changed.
    pub count: u32,
    pub selection: Option<Selection>,
}

/// Trims and cuts a string received from a plugin.
pub fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

struct Client {
    last_seen: Instant,
    document: Option<String>,
    can: Vec<&'static str>,
    queue: VecDeque<(Instant, Command)>,
}

#[derive(Default)]
struct Inner {
    last_id: u64,
    clients: BTreeMap<String, Client>,
}

/// The connected plugins and what is waiting for each. Callers give the time, for the tests.
#[derive(Default)]
pub struct Bridge {
    inner: Mutex<Inner>,
}

/// The bridge shared by the local API and the interface.
pub fn global() -> &'static Bridge {
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    BRIDGE.get_or_init(Bridge::default)
}

impl Bridge {
    /// Locks, after forgetting the plugins that stopped polling and the stale commands.
    fn live(&self, now: Instant) -> MutexGuard<'_, Inner> {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.clients.retain(|_, c| now.saturating_duration_since(c.last_seen) < ALIVE);
        for client in inner.clients.values_mut() {
            client.queue.retain(|(at, _)| now.saturating_duration_since(*at) < COMMAND_TTL);
        }
        inner
    }

    /// A plugin saying it is there, with what it can do; returns what is waiting for it.
    pub fn poll(&self, now: Instant, name: &str, document: Option<&str>, can: &[String]) -> Vec<Command> {
        let mut inner = self.live(now);
        if !inner.clients.contains_key(name) && inner.clients.len() >= MAX_CLIENTS {
            return Vec::new();
        }
        let client = inner.clients.entry(name.to_string()).or_insert_with(|| Client {
            last_seen: now,
            document: None,
            can: Vec::new(),
            queue: VecDeque::new(),
        });
        client.last_seen = now;
        client.document = document.map(|d| clip(d, MAX_NAME)).filter(|d| !d.is_empty());
        client.can = [APPLY, SELECTION].into_iter().filter(|k| can.iter().any(|c| c == k)).collect();
        client.queue.drain(..).map(|(_, command)| command).collect()
    }

    pub fn connected(&self, now: Instant) -> Vec<ConnectedApp> {
        self.live(now)
            .clients
            .iter()
            .map(|(name, c)| ConnectedApp { name: name.clone(), document: c.document.clone(), can: c.can.clone() })
            .collect()
    }

    pub fn can(&self, now: Instant, name: &str, kind: &str) -> Result<(), String> {
        match self.live(now).clients.get(name) {
            None => Err(format!("{name} is not connected")),
            Some(c) if !c.can.contains(&kind) => Err(format!("{name} cannot do this")),
            Some(_) => Ok(()),
        }
    }

    /// Queues a command for a connected plugin and returns its id.
    pub fn enqueue(&self, now: Instant, name: &str, kind: &'static str, font: Option<String>) -> Result<u64, String> {
        self.can(now, name, kind)?;
        let mut inner = self.live(now);
        inner.last_id += 1;
        let id = inner.last_id;
        let client = inner.clients.get_mut(name).ok_or_else(|| format!("{name} is not connected"))?;
        if client.queue.len() >= MAX_QUEUE {
            client.queue.pop_front();
        }
        client.queue.push_back((now, Command { id, kind, font }));
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<String> {
        vec![APPLY.into(), SELECTION.into()]
    }

    #[test]
    fn queued_commands_are_delivered_once() {
        let (bridge, now) = (Bridge::default(), Instant::now());
        assert!(bridge.poll(now, "Photoshop", Some("poster.psd"), &all()).is_empty());
        let first = bridge.enqueue(now, "Photoshop", APPLY, Some("Lora-Bold".into())).unwrap();
        let second = bridge.enqueue(now, "Photoshop", SELECTION, None).unwrap();
        let commands = bridge.poll(now, "Photoshop", None, &all());
        assert_eq!(commands.iter().map(|c| c.id).collect::<Vec<_>>(), [first, second]);
        assert_eq!(commands[0].font.as_deref(), Some("Lora-Bold"));
        assert!(bridge.poll(now, "Photoshop", None, &all()).is_empty());
    }

    #[test]
    fn refuses_unknown_apps_and_missing_capabilities() {
        let (bridge, now) = (Bridge::default(), Instant::now());
        assert!(bridge.enqueue(now, "Photoshop", APPLY, None).is_err());
        bridge.poll(now, "InDesign", None, &["apply".to_string(), "format-disk".to_string()]);
        assert_eq!(bridge.connected(now)[0].can, [APPLY]);
        assert!(bridge.enqueue(now, "InDesign", SELECTION, None).is_err());
    }

    #[test]
    fn forgets_silent_apps_and_stale_commands() {
        let (bridge, start) = (Bridge::default(), Instant::now());
        bridge.poll(start, "Photoshop", None, &all());
        bridge.enqueue(start, "Photoshop", APPLY, None).unwrap();
        // Still polling, but too late for the command.
        let mut now = start;
        while now < start + COMMAND_TTL {
            now += ALIVE / 2;
            bridge.live(now).clients.get_mut("Photoshop").unwrap().last_seen = now;
        }
        assert!(bridge.poll(now, "Photoshop", None, &all()).is_empty());
        assert!(bridge.connected(now + ALIVE).is_empty());
    }

    #[test]
    fn cleans_the_selection() {
        let raw = Selection {
            text: "Summer\rSounds\u{3}Live\u{0}".into(),
            font: Some("  ".into()),
            size: Some(f64::NAN),
            color: Some("red;background:url(x)".into()),
            tracking: Some(1e9),
            count: 1,
        };
        let clean = raw.clone().clean().unwrap();
        assert_eq!(clean.text, "Summer\nSounds\nLive");
        assert_eq!((clean.font, clean.size, clean.color, clean.tracking), (None, None, None, Some(10_000.0)));
        let kept = Selection { color: Some("#E8c14a".into()), size: Some(72.0), ..raw.clone() }.clean().unwrap();
        assert_eq!((kept.color.as_deref(), kept.size), (Some("#E8c14a"), Some(72.0)));
        assert!(Selection { text: " \r ".into(), ..raw.clone() }.clean().is_none());
        assert_eq!(Selection { text: "é".repeat(5000), ..raw }.clean().unwrap().text.chars().count(), MAX_TEXT);
    }
}

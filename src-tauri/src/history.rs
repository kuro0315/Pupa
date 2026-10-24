//! Platform-independent history and clipboard lifecycle. All tests use synthetic text.
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::OnceLock};
use uuid::Uuid;

pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_TOTAL_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ICON_DATA_URL_BYTES: usize = 48 * 1024;
const COLORS: [&str; 4] = ["lavender", "mint", "rose", "butter"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub shortcut: String,
    pub system_shortcut_enabled: bool,
    pub history_limit: usize,
    pub persistence: bool,
    pub hide_after_copy: bool,
    pub source_app: bool,
    pub fan_spread: u32,
    pub fan_distance: u32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: "CommandOrControl+Shift+Space".into(),
            system_shortcut_enabled: false,
            history_limit: 60,
            persistence: false,
            hide_after_copy: true,
            source_app: true,
            fan_spread: 72,
            fan_distance: 0,
        }
    }
}
impl Settings {
    pub fn patched(&self, patch: &Value) -> Result<Self, String> {
        let object = patch.as_object().ok_or("設定の形式が正しくありません。")?;
        let mut result = self.clone();
        for (key, value) in object {
            match key.as_str() {
                "shortcut" => {
                    let shortcut = value
                        .as_str()
                        .ok_or("ショートカットの形式が正しくありません。")?;
                    if !valid_shortcut(shortcut) {
                        return Err(
                            "修飾キーと Space・英数字・F キーを組み合わせてください。".into()
                        );
                    }
                    result.shortcut = shortcut.into();
                }
                "historyLimit" => match value.as_u64() {
                    Some(n @ (30 | 60 | 100)) => result.history_limit = n as usize,
                    _ => return Err("履歴件数は 30・60・100 から選んでください。".into()),
                },
                "fanSpread" | "fanDistance" => {
                    let (min, max) = if key == "fanSpread" {
                        (20, 84)
                    } else {
                        (0, 90)
                    };
                    let number = value
                        .as_u64()
                        .filter(|n| (min..=max).contains(n))
                        .ok_or("カードの開き方は設定範囲内で指定してください。")?
                        as u32;
                    if key == "fanSpread" {
                        result.fan_spread = number;
                    } else {
                        result.fan_distance = number;
                    }
                }
                "persistence" | "hideAfterCopy" | "sourceApp" | "systemShortcutEnabled" => {
                    let boolean = value.as_bool().ok_or("設定の値が正しくありません。")?;
                    match key.as_str() {
                        "persistence" => result.persistence = boolean,
                        "hideAfterCopy" => result.hide_after_copy = boolean,
                        "systemShortcutEnabled" => result.system_shortcut_enabled = boolean,
                        _ => result.source_app = boolean,
                    }
                }
                _ => return Err("この設定は変更できません。".into()),
            }
        }
        Ok(result)
    }
}
pub fn valid_shortcut(value: &str) -> bool {
    static SHAPE: OnceLock<Regex> = OnceLock::new();
    static MODIFIER: OnceLock<Regex> = OnceLock::new();
    value.len() <= 100
        && SHAPE.get_or_init(|| Regex::new(r"(?i)^(?:(?:CommandOrControl|Command|Control|Ctrl|Alt|Option|Shift|Super)\+)+(?:Space|[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$").unwrap()).is_match(value)
        && MODIFIER.get_or_init(|| Regex::new(r"(?i)(Command|Control|Ctrl|Alt|Option|Super)").unwrap()).is_match(value)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntrySource {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}
pub fn sanitize_source(mut source: EntrySource) -> Option<EntrySource> {
    if source.kind != "foreground" {
        return None;
    }
    source.name = source
        .name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect::<String>()
        .trim()
        .into();
    if source.name.is_empty() || source.name.chars().count() > 120 {
        return None;
    }
    source.icon = source.icon.filter(|icon| {
        if icon.len() > MAX_ICON_DATA_URL_BYTES {
            return false;
        }
        let Some(encoded) = icon.strip_prefix("data:image/png;base64,") else {
            return false;
        };
        let Ok(bytes) = STANDARD.decode(encoded) else {
            return false;
        };
        if bytes.len() < 33
            || bytes.len() > 32768
            || STANDARD.encode(&bytes) != encoded
            || bytes[8..12] != [0, 0, 0, 13]
            || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
            || &bytes[12..16] != b"IHDR"
        {
            return false;
        }
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        (1..=256).contains(&width) && (1..=256).contains(&height)
    });
    Some(source)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub text: String,
    pub kind: String,
    pub color: String,
    pub created_at: u64,
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<EntrySource>,
    #[serde(skip)]
    pub revision: u64,
}
impl Entry {
    pub fn bytes(&self) -> usize {
        self.text.len()
            + self
                .source
                .as_ref()
                .map_or(0, |s| s.name.len() + s.icon.as_ref().map_or(0, String::len))
    }
}
pub fn valid_text(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES
}
pub fn kind_of(text: &str) -> String {
    static LINK: OnceLock<Regex> = OnceLock::new();
    static CODE: OnceLock<Regex> = OnceLock::new();
    if LINK
        .get_or_init(|| Regex::new(r"(?i)^https?://[^\s]+$").unwrap())
        .is_match(text.trim())
    {
        return "link".into();
    }
    if CODE.get_or_init(|| Regex::new(r"(?m)(?:^|\n)\s*(?:const |let |var |function |import |export |class |def |SELECT |\{\s*$)|=>|</?[a-z][^>]*>").unwrap()).is_match(text) { return "code".into(); }
    "text".into()
}
#[derive(Debug)]
pub struct History {
    pub entries: Vec<Entry>,
    pub limit: usize,
    revision: u64,
}
impl History {
    pub fn new(limit: usize) -> Self {
        Self {
            entries: vec![],
            limit: limit.clamp(1, 100),
            revision: 0,
        }
    }
    pub fn add(&mut self, text: String, now: u64) -> bool {
        if !valid_text(&text) {
            return false;
        }
        self.revision = self.revision.wrapping_add(1);
        let mut entry = if let Some(index) = self.entries.iter().position(|e| e.text == text) {
            self.entries.remove(index)
        } else {
            Entry {
                id: Uuid::new_v4().to_string(),
                kind: kind_of(&text),
                text,
                color: COLORS[self.entries.len() % COLORS.len()].into(),
                created_at: now,
                pinned: false,
                source: None,
                revision: 0,
            }
        };
        entry.created_at = now;
        entry.revision = self.revision;
        entry.source = None;
        self.entries.insert(0, entry);
        self.trim();
        true
    }
    pub fn restore(&mut self, values: &Value, now: u64) {
        let Some(values) = values.as_array() else {
            return;
        };
        let mut entries = vec![];
        let mut seen = HashSet::new();
        for value in values.iter().take(100) {
            let Some(text) = value
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| valid_text(s))
            else {
                continue;
            };
            if !seen.insert(digest(text)) {
                continue;
            }
            self.revision = self.revision.wrapping_add(1);
            let color = value
                .get("color")
                .and_then(Value::as_str)
                .filter(|s| COLORS.contains(s))
                .unwrap_or("lavender");
            let source = value
                .get("source")
                .and_then(|s| serde_json::from_value::<EntrySource>(s.clone()).ok())
                .and_then(sanitize_source);
            entries.push(Entry {
                id: Uuid::new_v4().to_string(),
                text: text.into(),
                kind: kind_of(text),
                color: color.into(),
                created_at: value
                    .get("createdAt")
                    .and_then(Value::as_u64)
                    .filter(|n| *n > 0)
                    .unwrap_or(now)
                    .min(now),
                pinned: value
                    .get("pinned")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                source,
                revision: self.revision,
            });
        }
        self.entries = entries;
        self.trim();
    }
    pub fn trim(&mut self) {
        let mut bytes: usize = self.entries.iter().map(Entry::bytes).sum();
        while self.entries.len() > self.limit || bytes > MAX_TOTAL_BYTES {
            let index = self
                .entries
                .iter()
                .rposition(|e| !e.pinned)
                .unwrap_or(self.entries.len() - 1);
            bytes -= self.entries.remove(index).bytes();
        }
    }
    pub fn set_source(&mut self, id: &str, revision: u64, source: EntrySource) -> bool {
        let Some(source) = sanitize_source(source) else {
            return false;
        };
        let Some(entry) = self
            .entries
            .iter_mut()
            .find(|e| e.id == id && e.revision == revision)
        else {
            return false;
        };
        entry.source = Some(source);
        self.trim();
        true
    }
    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id && id.len() <= 100)
    }
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        before != self.entries.len()
    }
    pub fn toggle_pin(&mut self, id: &str) -> bool {
        let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) else {
            return false;
        };
        entry.pinned = !entry.pinned;
        true
    }
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}
fn digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

/// Begin/complete tokens let async clipboard reads be invalidated without retaining
/// any prelaunch, paused, locked, suspended or copy-in-progress clipboard content.
#[derive(Default, Debug)]
pub struct ClipboardMonitor {
    baseline: Option<Option<[u8; 32]>>,
    paused: bool,
    busy: bool,
    epoch: u64,
}
impl ClipboardMonitor {
    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        self.reset_baseline();
    }
    pub fn reset_baseline(&mut self) {
        self.baseline = None;
        self.epoch = self.epoch.wrapping_add(1);
    }
    pub fn note_copied(&mut self, text: &str) {
        self.baseline = Some(Some(digest(text)));
        self.epoch = self.epoch.wrapping_add(1);
    }
    pub fn begin_read(&mut self) -> Option<u64> {
        if self.paused || self.busy {
            return None;
        }
        self.busy = true;
        Some(self.epoch)
    }
    pub fn complete_read(&mut self, token: u64, text: Option<String>) -> Option<String> {
        self.busy = false;
        if self.paused || token != self.epoch {
            return None;
        }
        let hash = text.as_ref().map(|s| digest(s));
        let old = self.baseline.replace(hash);
        if old.is_none() || old == Some(hash) {
            return None;
        }
        text.filter(|s| valid_text(s))
    }
    pub fn fail_read(&mut self, token: u64) -> bool {
        self.busy = false;
        if token != self.epoch || self.paused {
            return false;
        }
        // After an access gap we cannot know when clipboard content was copied.
        self.reset_baseline();
        true
    }
}

/// Independent user/session/copy reasons, so one resume cannot undo another pause.
#[derive(Default, Debug)]
pub struct CaptureLifecycle {
    pub paused: bool,
    pub locked: bool,
    pub suspended: bool,
    pub copying: bool,
    pub quitting: bool,
    pub source_epoch: u64,
    pub monitor: ClipboardMonitor,
}
impl CaptureLifecycle {
    pub fn blocked(&self) -> bool {
        self.paused || self.locked || self.suspended || self.copying || self.quitting
    }
    pub fn invalidate_source(&mut self) {
        self.source_epoch = self.source_epoch.wrapping_add(1);
    }
    pub fn reconcile(&mut self) {
        self.invalidate_source();
        self.monitor.set_paused(self.blocked());
    }
    pub fn source_is_current(&self, epoch: u64) -> bool {
        self.source_epoch == epoch && !self.blocked()
    }
}

/// A copy can dismiss only the same window presentation that initiated it, and
/// only after the native clipboard write has succeeded. The renderer receives
/// no token before success. Consuming a token is shared by animation completion
/// and the safety fallback, making their ordering immaterial.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CopyAttempt {
    token: String,
    window_generation: u64,
}
#[derive(Default, Debug)]
pub struct CopyDismissal {
    window_generation: u64,
    writing: Option<CopyAttempt>,
    pending: Option<CopyAttempt>,
}
impl CopyDismissal {
    /// Show, hide, Escape, lock and quit cancel dismissal, not an in-flight write.
    /// Keeping `writing` blocks a second OS write until the first one finishes.
    pub fn invalidate(&mut self) {
        self.window_generation = self.window_generation.wrapping_add(1);
        self.pending = None;
    }
    pub fn begin_write(&mut self) -> Option<CopyAttempt> {
        if self.writing.is_some() || self.pending.is_some() {
            return None;
        }
        let attempt = CopyAttempt {
            token: Uuid::new_v4().to_string(),
            window_generation: self.window_generation,
        };
        self.writing = Some(attempt.clone());
        Some(attempt)
    }
    pub fn finish_write(
        &mut self,
        attempt: CopyAttempt,
        copied: bool,
        visible: bool,
    ) -> Option<String> {
        if self.writing.as_ref() != Some(&attempt) {
            return None;
        }
        self.writing = None;
        if !copied || !visible || attempt.window_generation != self.window_generation {
            return None;
        }
        let token = attempt.token.clone();
        self.pending = Some(attempt);
        Some(token)
    }
    pub fn consume(&mut self, token: &str) -> bool {
        let matches = self.pending.as_ref().is_some_and(|pending| {
            pending.token == token && pending.window_generation == self.window_generation
        });
        if matches {
            self.pending = None;
        }
        matches
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn read(m: &mut ClipboardMonitor, text: Option<&str>) -> Option<String> {
        let token = m.begin_read()?;
        m.complete_read(token, text.map(String::from))
    }
    fn source() -> EntrySource {
        EntrySource {
            name: "Synthetic Editor".into(),
            kind: "foreground".into(),
            icon: None,
        }
    }
    #[test]
    fn copy_dismissal_issues_token_only_after_a_successful_write() {
        let mut dismissal = CopyDismissal::default();
        let attempt = dismissal.begin_write().unwrap();
        assert!(
            !dismissal.consume(&attempt.token),
            "a started write cannot dismiss"
        );
        assert!(dismissal.finish_write(attempt, false, true).is_none());
        assert!(!dismissal.consume("invented-token"));
        let attempt = dismissal.begin_write().unwrap();
        let token = dismissal.finish_write(attempt, true, true).unwrap();
        assert!(dismissal.consume(&token));
    }
    #[test]
    fn duplicate_copy_is_blocked_during_write_and_dismissal() {
        let mut dismissal = CopyDismissal::default();
        let attempt = dismissal.begin_write().unwrap();
        assert!(dismissal.begin_write().is_none());
        let token = dismissal.finish_write(attempt, true, true).unwrap();
        assert!(dismissal.begin_write().is_none());
        assert!(dismissal.consume(&token));
        assert!(dismissal.begin_write().is_some());
    }
    #[test]
    fn completion_and_fallback_can_consume_success_only_once() {
        for animation_first in [true, false] {
            let mut dismissal = CopyDismissal::default();
            let attempt = dismissal.begin_write().unwrap();
            let token = dismissal.finish_write(attempt, true, true).unwrap();
            assert!(
                !dismissal.consume("wrong-token"),
                "wrong completion does not cancel the fallback"
            );
            assert!(
                dismissal.consume(&token),
                "first completion (animation={animation_first}) hides"
            );
            assert!(!dismissal.consume(&token), "second completion is a no-op");
        }
    }
    #[test]
    fn reopened_window_rejects_old_completion_and_old_fallback() {
        let mut dismissal = CopyDismissal::default();
        let attempt = dismissal.begin_write().unwrap();
        let old_token = dismissal.finish_write(attempt, true, true).unwrap();
        dismissal.invalidate(); // Hide / Escape.
        dismissal.invalidate(); // Reopen, tray Show or shortcut.
        assert!(!dismissal.consume(&old_token));
        let next = dismissal.begin_write().unwrap();
        let new_token = dismissal.finish_write(next, true, true).unwrap();
        assert_ne!(old_token, new_token);
        assert!(
            !dismissal.consume(&old_token),
            "old fallback must not consume the new dismissal"
        );
        assert!(dismissal.consume(&new_token));
    }
    #[test]
    fn presentation_change_during_native_write_suppresses_animation_and_hide() {
        for visible in [false, true] {
            let mut dismissal = CopyDismissal::default();
            let attempt = dismissal.begin_write().unwrap();
            dismissal.invalidate(); // Hide, show, lock or quit while the OS is writing.
            assert!(
                dismissal.begin_write().is_none(),
                "do not overlap the old OS write"
            );
            assert!(dismissal.finish_write(attempt, true, visible).is_none());
            assert!(dismissal.begin_write().is_some());
        }
    }
    #[test]
    fn hidden_success_has_no_dismissal_and_repeated_write_completion_is_ignored() {
        let mut dismissal = CopyDismissal::default();
        let attempt = dismissal.begin_write().unwrap();
        assert!(dismissal
            .finish_write(attempt.clone(), true, false)
            .is_none());
        assert!(dismissal.finish_write(attempt, true, true).is_none());
        assert!(dismissal.begin_write().is_some());
    }
    #[test]
    fn limits_measure_utf8_without_normalizing() {
        assert!(valid_text(&"🐛".repeat(MAX_TEXT_BYTES / 4)));
        assert!(!valid_text(&"🐛".repeat(MAX_TEXT_BYTES / 4 + 1)));
        assert!(!valid_text(" \n\t "));
        let mut h = History::new(60);
        h.add("  exact\n text\t".into(), 1);
        assert_eq!(h.entries[0].text, "  exact\n text\t");
    }
    #[test]
    fn exact_dedup_preserves_id_pin_color_but_invalidates_attribution() {
        let mut h = History::new(60);
        h.add("first".into(), 10);
        let old = h.entries[0].clone();
        h.toggle_pin(&old.id);
        h.set_source(&old.id, old.revision, source());
        h.add("second".into(), 20);
        h.add("first".into(), 10); // Same clock millisecond must still invalidate.
        assert_eq!(h.entries[0].id, old.id);
        assert!(h.entries[0].pinned);
        assert_eq!(h.entries[0].color, old.color);
        assert!(h.entries[0].source.is_none());
        assert!(!h.set_source(&old.id, old.revision, source()));
        h.add(" first".into(), 30);
        h.add("FIRST".into(), 31);
        assert_eq!(h.entries.len(), 4);
    }
    #[test]
    fn pins_do_not_exceed_hard_count_or_metadata_budget() {
        let mut h = History::new(100);
        for n in 0..35 {
            h.add(format!("{n:04}{}", "x".repeat(MAX_TEXT_BYTES - 4)), n);
            h.entries[0].pinned = true;
        }
        assert_eq!(h.entries.len(), 32);
        let first = h.entries[0].clone();
        h.set_source(&first.id, first.revision, source());
        assert_eq!(h.entries.len(), 31);
        assert!(h.entries.iter().map(Entry::bytes).sum::<usize>() <= MAX_TOTAL_BYTES);
        h.limit = 30;
        h.trim();
        assert_eq!(h.entries.len(), 30);
    }
    #[test]
    fn evicts_oldest_unpinned_first() {
        let mut h = History::new(3);
        h.add("old pin".into(), 1);
        h.entries[0].pinned = true;
        for (n, s) in ["old", "recent", "new"].iter().enumerate() {
            h.add((*s).into(), n as u64 + 2);
        }
        assert_eq!(
            h.entries
                .iter()
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>(),
            vec!["new", "recent", "old pin"]
        );
    }
    #[test]
    fn restore_is_bounded_sanitized_and_new_identity() {
        let mut h = History::new(60);
        h.restore(&json!([{ "id":"untrusted", "text":"a", "createdAt":99999, "pinned":true, "kind":"html", "color":"invalid" }, {"text":"a"}, {"text":" "}, {"text":"b","source":{"name":"App","kind":"foreground","icon":"https://invalid"}}]), 100);
        assert_eq!(h.entries.len(), 2);
        assert_ne!(h.entries[0].id, "untrusted");
        assert_eq!(h.entries[0].created_at, 100);
        assert_eq!(h.entries[0].color, "lavender");
        assert_eq!(h.entries[0].kind, "text");
        assert!(h.entries[1].source.as_ref().unwrap().icon.is_none());
        h.restore(&json!({}), 200);
        assert_eq!(h.entries.len(), 2);
    }
    #[test]
    fn settings_are_strict_private_and_bounded() {
        let s = Settings::default();
        assert!(!s.persistence);
        assert_eq!(s.history_limit, 60);
        for patch in [
            json!(null),
            json!([]),
            json!({"extra":true}),
            json!({"historyLimit":31}),
            json!({"historyLimit":"60"}),
            json!({"sourceApp":1}),
            json!({"fanSpread":30.5}),
            json!({"fanDistance":91}),
        ] {
            assert!(s.patched(&patch).is_err(), "{patch}");
        }
        assert_eq!(
            s.patched(&json!({"historyLimit":100}))
                .unwrap()
                .history_limit,
            100
        );
        for key in [
            "Alt+A",
            "Control+9",
            "Super+F24",
            "Command+Option+Space",
            "ctrl+shift+f1",
        ] {
            assert!(valid_shortcut(key));
        }
        for key in [
            "Space",
            "Shift+Space",
            "Alt+F25",
            "Alt+Enter",
            "Alt+A+B",
            "Control+ A",
        ] {
            assert!(!valid_shortcut(key));
        }
    }
    #[test]
    fn classify_without_interpreting() {
        assert_eq!(kind_of("  HTTP://example.invalid  "), "link");
        assert_eq!(kind_of("https://example.invalid words"), "text");
        for s in [
            "const x = 1;",
            "() => 1",
            "<script>alert(1)</script>",
            "def example():\n  pass",
        ] {
            assert_eq!(kind_of(s), "code");
        }
    }
    #[test]
    fn baseline_never_stores_launch_or_resume_text() {
        let mut m = ClipboardMonitor::default();
        assert!(read(&mut m, Some("prelaunch")).is_none());
        assert_eq!(read(&mut m, Some("fresh")), Some("fresh".into()));
        assert!(read(&mut m, Some("fresh")).is_none());
        m.set_paused(true);
        assert!(m.begin_read().is_none());
        m.set_paused(false);
        assert!(read(&mut m, Some("during pause")).is_none());
        assert_eq!(read(&mut m, Some("after")), Some("after".into()));
    }
    #[test]
    fn inflight_pause_clear_and_copy_are_invalidated() {
        let mut m = ClipboardMonitor::default();
        read(&mut m, Some("initial"));
        let token = m.begin_read().unwrap();
        assert!(m.begin_read().is_none());
        m.set_paused(true);
        m.set_paused(false);
        assert!(m.complete_read(token, Some("stale".into())).is_none());
        assert!(read(&mut m, Some("resume")).is_none());
        let token = m.begin_read().unwrap();
        m.reset_baseline();
        assert!(m.complete_read(token, Some("cleared".into())).is_none());
        read(&mut m, Some("new baseline"));
        let token = m.begin_read().unwrap();
        m.note_copied("own copy");
        assert!(m
            .complete_read(token, Some("old clipboard".into()))
            .is_none());
        assert!(read(&mut m, Some("own copy")).is_none());
        assert_eq!(
            read(&mut m, Some("external copy")),
            Some("external copy".into())
        );
    }
    #[test]
    fn read_errors_reset_baseline_and_do_not_leak_gap_content() {
        let mut m = ClipboardMonitor::default();
        read(&mut m, Some("baseline"));
        let token = m.begin_read().unwrap();
        assert!(m.fail_read(token));
        assert!(read(&mut m, Some("copied during error")).is_none());
        assert_eq!(read(&mut m, Some("next")), Some("next".into()));
    }
    #[test]
    fn independent_pause_reasons_and_source_generation() {
        let mut life = CaptureLifecycle::default();
        let epoch = life.source_epoch;
        life.locked = true;
        life.reconcile();
        assert!(!life.source_is_current(epoch));
        life.paused = true;
        life.reconcile();
        life.locked = false;
        life.reconcile();
        assert!(life.monitor.begin_read().is_none());
        life.paused = false;
        life.suspended = true;
        life.reconcile();
        assert!(life.blocked());
        life.suspended = false;
        life.copying = true;
        life.reconcile();
        assert!(life.blocked());
        life.copying = false;
        life.reconcile();
        assert!(!life.blocked());
        assert!(read(&mut life.monitor, Some("resume baseline")).is_none());
        life.quitting = true;
        life.reconcile();
        assert!(life.monitor.begin_read().is_none());
    }
    #[test]
    fn source_rejects_external_icons_and_invalid_png_dimensions() {
        let s = EntrySource {
            name: " \0App\u{202e} ".into(),
            kind: "foreground".into(),
            icon: Some("https://example.invalid/icon.png".into()),
        };
        assert_eq!(
            sanitize_source(s).unwrap(),
            EntrySource {
                name: "App".into(),
                kind: "foreground".into(),
                icon: None
            }
        );
        assert!(sanitize_source(EntrySource {
            name: "x".repeat(121),
            ..source()
        })
        .is_none());
        assert!(sanitize_source(EntrySource {
            kind: "owner".into(),
            ..source()
        })
        .is_none());
        let png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNuoAAAAASUVORK5CYII=";
        assert_eq!(
            sanitize_source(EntrySource {
                icon: Some(png.into()),
                ..source()
            })
            .unwrap()
            .icon
            .as_deref(),
            Some(png)
        );
    }
    #[test]
    fn actions_do_not_resurrect_deleted_entries() {
        let mut h = History::new(60);
        h.add("text".into(), 1);
        let e = h.entries[0].clone();
        assert!(h.remove(&e.id));
        assert!(!h.remove(&e.id));
        assert!(!h.toggle_pin(&e.id));
        assert!(!h.set_source(&e.id, e.revision, source()));
        h.add("next".into(), 2);
        h.clear();
        assert!(h.entries.is_empty());
    }
}

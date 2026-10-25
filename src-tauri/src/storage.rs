//! Opt-in, atomic plaintext storage; memory-only boot removes any previous history.
use crate::history::{Entry, Settings, MAX_TOTAL_BYTES};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Storage {
    pub directory: PathBuf,
    pub settings_path: PathBuf,
    pub history_path: PathBuf,
}
pub struct Loaded {
    pub settings: Settings,
    pub entries: Value,
    pub warning: Option<String>,
}
impl Storage {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            settings_path: directory.join("settings.json"),
            history_path: directory.join("history.json"),
            directory,
        }
    }
    fn read(&self, path: &Path, maximum: u64) -> io::Result<Option<Value>> {
        let file = match File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if file.metadata()?.len() > maximum {
            return Err(io::Error::other("file too large"));
        }
        // Also bound reads in case a file grows after metadata is obtained.
        let mut bytes = Vec::new();
        file.take(maximum + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > maximum {
            return Err(io::Error::other("file too large"));
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other)
    }
    pub fn load(&self) -> Loaded {
        let mut loaded = Loaded {
            settings: Settings::default(),
            entries: json!([]),
            warning: None,
        };
        match self.read(&self.settings_path, 4096) {
            Ok(Some(value)) => match loaded.settings.patched(&value) {
                Ok(settings) => loaded.settings = settings,
                Err(_) => {
                    loaded.warning =
                        Some("設定を読み込めなかったため、安全な初期設定で起動しました。".into())
                }
            },
            Err(_) => {
                loaded.warning =
                    Some("設定を読み込めなかったため、安全な初期設定で起動しました。".into())
            }
            _ => (),
        }
        if self.erase_history_temps().is_err() {
            loaded.warning = Some(
                "以前の履歴の一時ファイルを削除できませんでした。保存先の権限を確認してください。"
                    .into(),
            );
        }
        if loaded.settings.persistence {
            match self.read(&self.history_path, (MAX_TOTAL_BYTES * 7) as u64) {
                Ok(Some(value))
                    if value.get("version").and_then(Value::as_u64) == Some(1)
                        && value.get("entries").is_some_and(Value::is_array) =>
                {
                    loaded.entries = value["entries"].clone()
                }
                Ok(None) => (),
                _ => {
                    loaded.warning = Some(
                        "保存された履歴を読み込めませんでした。新しい履歴は引き続き使えます。"
                            .into(),
                    )
                }
            }
        } else if self.erase_history().is_err() {
            loaded.warning = Some(
                "以前の履歴ファイルを削除できませんでした。保存先の権限を確認してください。".into(),
            );
        }
        loaded
    }
    fn atomic<T: Serialize>(&self, path: &Path, data: &T) -> io::Result<()> {
        let bytes = serde_json::to_vec(data).map_err(io::Error::other)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder.create(&self.directory)?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(&self.directory)?;
        // A private, unique same-directory temporary avoids symlink attacks and
        // preserves the old file on write/rename errors. Persist atomically replaces
        // an existing destination on both POSIX and Windows.
        let mut file = tempfile::Builder::new()
            .prefix(if path == self.history_path {
                ".pupa-history-"
            } else {
                ".pupa-settings-"
            })
            .tempfile_in(&self.directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|e| e.error)?;
        // Rename has already committed at this point. A directory fsync failure
        // cannot be reported as an uncommitted write or callers may roll back the
        // in-memory opt-in while the new setting is already on disk. File contents
        // were fsynced above; directory-entry crash durability is best effort.
        #[cfg(unix)]
        if let Ok(directory) = File::open(&self.directory) {
            let _ = directory.sync_all();
        }
        Ok(())
    }
    pub fn save_settings(&self, settings: &Settings) -> io::Result<()> {
        self.atomic(&self.settings_path, settings)
    }
    pub fn save_history(&self, entries: &[Entry]) -> io::Result<()> {
        self.atomic(&self.history_path, &json!({"version":1,"entries":entries}))
    }
    fn erase_history_temps(&self) -> io::Result<()> {
        let files = match fs::read_dir(&self.directory) {
            Ok(files) => files,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut failure = None;
        for file in files {
            let file = file?;
            let name = file.file_name();
            let name = name.to_string_lossy();
            // Our old unclassified prefix is recognized only for this unreleased
            // storage format. Keep settings temporaries separate from clipboard data.
            if name.starts_with(".pupa-") && !name.starts_with(".pupa-settings-") {
                // remove_file unlinks a symlink itself, never its target. Never
                // recurse into directories, even when their names match a prefix.
                if let Err(error) = fs::remove_file(file.path()) {
                    if error.kind() != io::ErrorKind::NotFound && failure.is_none() {
                        failure = Some(error);
                    }
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub fn erase_history(&self) -> io::Result<()> {
        let mut error = self.erase_history_temps().err();
        for path in [&self.history_path, &self.directory.join("history.json.tmp")] {
            if let Err(e) = fs::remove_file(path) {
                if e.kind() != io::ErrorKind::NotFound && error.is_none() {
                    error = Some(e);
                }
            }
        }
        match error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::History;
    fn fixture() -> (tempfile::TempDir, Storage) {
        let root = tempfile::tempdir().unwrap();
        let s = Storage::new(root.path().join("data"));
        (root, s)
    }
    #[test]
    fn missing_storage_is_memory_only_and_read_only() {
        let (_root, s) = fixture();
        let loaded = s.load();
        assert_eq!(loaded.settings, Settings::default());
        assert_eq!(loaded.entries, json!([]));
        assert!(loaded.warning.is_none());
        assert!(!s.directory.exists());
    }
    #[test]
    fn memory_mode_removes_stale_plaintext_and_legacy_partial_file() {
        let (_root, s) = fixture();
        s.save_history(&[]).unwrap();
        fs::write(s.directory.join("history.json.tmp"), "partial").unwrap();
        assert!(!s.load().settings.persistence);
        assert!(!s.history_path.exists());
        assert!(!s.directory.join("history.json.tmp").exists());
    }
    #[test]
    fn opt_in_atomic_unicode_round_trip_and_replacement() {
        let (_root, s) = fixture();
        let settings = Settings {
            persistence: true,
            history_limit: 100,
            visible_cards: 4,
            visual_effects: "light".into(),
            ..Settings::default()
        };
        s.save_settings(&settings).unwrap();
        let mut h = History::new(100);
        h.add("こんにちは 🐛\n\"quote\"\t\\slash\0".into(), 123);
        h.entries[0].pinned = true;
        s.save_history(&h.entries).unwrap();
        let loaded = s.load();
        assert_eq!(loaded.settings, settings);
        assert_eq!(loaded.entries[0]["text"], h.entries[0].text);
        assert!(loaded.warning.is_none());
        s.save_settings(&Settings::default()).unwrap();
        assert!(!s.load().settings.persistence);
        assert!(!s.history_path.exists());
        assert!(fs::read_dir(&s.directory).unwrap().all(|p| !p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".pupa-")));
    }
    #[cfg(unix)]
    #[test]
    fn private_directory_and_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (_root, s) = fixture();
        s.save_settings(&Settings::default()).unwrap();
        s.save_history(&[]).unwrap();
        assert_eq!(
            fs::metadata(&s.directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for path in [&s.settings_path, &s.history_path] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn corrupt_settings_fail_private_and_erase_history() {
        for input in [
            "{bad",
            "[]",
            "\"bad\"",
            "{\"unknown\":true}",
            "{\"persistence\":\"true\"}",
        ] {
            let (_root, s) = fixture();
            s.save_history(&[]).unwrap();
            fs::write(&s.settings_path, input).unwrap();
            let loaded = s.load();
            assert_eq!(loaded.settings, Settings::default());
            assert!(loaded.warning.is_some());
            assert!(!s.history_path.exists());
        }
    }
    #[test]
    fn invalid_history_never_loses_valid_settings() {
        for input in [
            "{bad",
            "{}",
            "[]",
            "{\"version\":2,\"entries\":[]}",
            "{\"version\":1,\"entries\":{}}",
        ] {
            let (_root, s) = fixture();
            s.save_settings(&Settings {
                persistence: true,
                ..Settings::default()
            })
            .unwrap();
            fs::write(&s.history_path, input).unwrap();
            let loaded = s.load();
            assert!(loaded.settings.persistence);
            assert_eq!(loaded.entries, json!([]));
            assert!(loaded.warning.is_some());
        }
    }
    #[test]
    fn oversized_files_are_bounded_before_parsing() {
        let (_root, s) = fixture();
        s.save_settings(&Settings {
            persistence: true,
            ..Settings::default()
        })
        .unwrap();
        File::create(&s.history_path)
            .unwrap()
            .set_len((MAX_TOTAL_BYTES * 7 + 1) as u64)
            .unwrap();
        assert!(s.load().warning.is_some());
        fs::write(&s.settings_path, "x".repeat(4097)).unwrap();
        assert!(!s.load().settings.persistence);
        assert!(!s.history_path.exists());
    }
    #[test]
    fn crash_leftover_history_temps_are_removed_even_when_persistence_enabled() {
        let (_root, s) = fixture();
        s.save_settings(&Settings {
            persistence: true,
            ..Settings::default()
        })
        .unwrap();
        fs::write(s.directory.join(".pupa-history-crash"), "synthetic secret").unwrap();
        fs::write(s.directory.join(".pupa-legacy-crash"), "synthetic secret").unwrap();
        fs::write(s.directory.join(".pupa-settings-crash"), "settings only").unwrap();
        assert!(s.load().warning.is_none());
        assert!(!s.directory.join(".pupa-history-crash").exists());
        assert!(!s.directory.join(".pupa-legacy-crash").exists());
        assert!(s.directory.join(".pupa-settings-crash").exists());
    }
    #[cfg(unix)]
    #[test]
    fn temp_cleanup_unlinks_symlinks_without_touching_their_targets() {
        use std::os::unix::fs::symlink;
        let (root, s) = fixture();
        s.save_settings(&Settings::default()).unwrap();
        let target = root.path().join("unrelated");
        fs::write(&target, "untouched").unwrap();
        symlink(&target, s.directory.join(".pupa-history-link")).unwrap();
        s.erase_history().unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
        assert!(!s.directory.join(".pupa-history-link").exists());
    }
    #[test]
    fn missing_opt_in_history_is_not_an_error() {
        let (_root, s) = fixture();
        s.save_settings(&Settings {
            persistence: true,
            ..Settings::default()
        })
        .unwrap();
        assert!(s.load().warning.is_none());
    }
    #[test]
    fn failed_replace_preserves_destination_and_cleans_temp() {
        let (_root, s) = fixture();
        fs::create_dir_all(&s.settings_path).unwrap();
        fs::write(s.settings_path.join("sentinel"), "unchanged").unwrap();
        assert!(s.save_settings(&Settings::default()).is_err());
        assert_eq!(
            fs::read_to_string(s.settings_path.join("sentinel")).unwrap(),
            "unchanged"
        );
        assert_eq!(fs::read_dir(&s.directory).unwrap().count(), 1);
    }
    #[test]
    fn failed_delete_is_visible_and_storage_never_falls_back() {
        let (root, s) = fixture();
        fs::create_dir_all(&s.history_path).unwrap();
        assert!(s.erase_history().is_err());
        assert!(s.load().warning.is_some());
        let blocked = root.path().join("file");
        fs::write(&blocked, "unchanged").unwrap();
        let bad = Storage::new(blocked.clone());
        assert!(bad.save_settings(&Settings::default()).is_err());
        assert_eq!(fs::read_to_string(blocked).unwrap(), "unchanged");
    }
}

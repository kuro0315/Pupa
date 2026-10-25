//! Local file references only. File contents are never read or copied into Pupa.
use sha2::{Digest, Sha256};
use std::path::Path;

pub const MAX_FILES: usize = 100;
pub const MAX_FILE_PATH_BYTES: usize = 64 * 1024;

pub fn sanitize_paths(paths: Vec<String>) -> Option<Vec<String>> {
    if paths.is_empty() || paths.len() > MAX_FILES
        || paths.iter().map(String::len).sum::<usize>() > MAX_FILE_PATH_BYTES
        || paths.iter().any(|p| p.len() > 4096 || p.contains('\0') || !Path::new(p).is_absolute()) {
        return None;
    }
    let mut unique = Vec::new();
    for path in paths { if !unique.contains(&path) { unique.push(path); } }
    Some(unique)
}

pub fn label(paths: &[String]) -> String {
    paths.iter().map(|path| Path::new(path).file_name().unwrap_or_else(|| Path::new(path).as_os_str()).to_string_lossy())
        .collect::<Vec<_>>().join("\n")
}

#[derive(Clone, Debug)]
pub enum ClipboardContent { Text(String), Files(Vec<String>) }
impl ClipboardContent {
    pub fn key(&self) -> String {
        let (domain, bytes) = match self {
            Self::Text(text) => ("text", text.as_bytes().to_vec()),
            Self::Files(paths) => ("files", serde_json::to_vec(paths).unwrap_or_default()),
        };
        format!("{domain}:{:x}", Sha256::digest(bytes))
    }
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
pub mod native {
    use super::*;
    use gtk::{gdk, gio, Clipboard, TargetEntry, TargetFlags};
    use gtk::gio::prelude::*;
    use std::{sync::mpsc, time::Duration};
    use tauri::AppHandle;

    const TIMEOUT: Duration = Duration::from_millis(1200);
    pub fn read(app: &AppHandle) -> Result<Option<Vec<String>>, String> {
        let (sender, receiver) = mpsc::channel();
        app.run_on_main_thread(move || {
            Clipboard::get(&gdk::SELECTION_CLIPBOARD).request_uris(move |_, uris| {
                let paths: Option<Vec<_>> = uris.iter().map(|uri| {
                    // A web link or remote share is not a local file reference.
                    if !uri.starts_with("file:///") && !uri.starts_with("file://localhost/") { return None; }
                    gio::File::for_uri(uri).path()?.to_str().map(str::to_owned)
                }).collect();
                let _ = sender.send(paths.and_then(sanitize_paths));
            });
        }).map_err(|_| "ファイルのクリップボードを読み取れませんでした。".to_string())?;
        receiver.recv_timeout(TIMEOUT).map_err(|_| "ファイルのクリップボードから応答がありません。".into())
    }

    pub fn write(app: &AppHandle, paths: Vec<String>) -> Result<(), String> {
        let paths = sanitize_paths(paths).ok_or("ファイル情報が正しくありません。")?;
        if paths.iter().any(|path| std::fs::symlink_metadata(path).is_err()) {
            return Err("元のファイルが見つからないか、アクセスできません。移動・削除されていないか確認してください。".into());
        }
        let (sender, receiver) = mpsc::channel();
        app.run_on_main_thread(move || {
            use gtk::gio::prelude::*;
            let uris: Vec<String> = paths.iter().map(|p| gio::File::for_path(p).uri().to_string()).collect();
            let targets = [TargetEntry::new("text/uri-list", TargetFlags::empty(), 0),
                TargetEntry::new("x-special/gnome-copied-files", TargetFlags::empty(), 1)];
            let ok = Clipboard::get(&gdk::SELECTION_CLIPBOARD).set_with_data(&targets, move |_, selection, target| {
                if target == 1 {
                    let bytes = format!("copy\n{}", uris.join("\n"));
                    selection.set(&gdk::Atom::intern("x-special/gnome-copied-files"), 8, bytes.as_bytes());
                } else {
                    let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
                    selection.set_uris(&refs);
                }
            });
            let _ = sender.send(ok);
        }).map_err(|_| "ファイルをコピーできませんでした。".to_string())?;
        match receiver.recv_timeout(TIMEOUT) {
            Ok(true) => Ok(()),
            _ => Err("ファイルをコピーできませんでした。もう一度お試しください。".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_empty_relative_remote_and_oversized_paths() {
        for paths in [vec![], vec!["relative.txt".into()], vec!["https://example.com/a".into()],
            vec!["/tmp/a\0b".into()], vec![format!("/{}", "a".repeat(4096))], vec!["/tmp/a".into(); 101]] {
            assert!(sanitize_paths(paths).is_none());
        }
    }
    #[test]
    fn keys_separate_file_references_from_text_and_preserve_unicode() {
        let root = std::env::temp_dir();
        let path = root.join("架空の資料 #1.txt").to_string_lossy().into_owned();
        let paths = sanitize_paths(vec![path.clone(), path.clone()]).unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(label(&paths), "架空の資料 #1.txt");
        assert_ne!(ClipboardContent::Files(paths).key(), ClipboardContent::Text(path).key());
    }
}

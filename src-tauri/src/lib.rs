pub mod history;
pub mod power;
pub mod source_app;
pub mod storage;
#[cfg(feature = "desktop")]
pub use desktop::{run, set_session_blocked};
#[cfg(feature = "desktop")]
mod desktop {
    use crate::{
        history::{CaptureLifecycle, CopyDismissal, Entry, History, Settings, MAX_TEXT_BYTES},
        storage::Storage,
    };
    use serde::Serialize;
    use serde_json::Value;
    use std::{
        sync::{Mutex, MutexGuard},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
    };
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    const MISSING_ENTRY: &str = "このカードは見つかりませんでした。";
    const STORAGE_ERROR: &str =
        "履歴の保存・削除ができませんでした。保存先の権限や空き容量を確認してください。";
    const SHORTCUT_ERROR: &str =
        "このショートカットは登録できません。他のアプリとの重複や OS の設定を確認してください。";
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        shortcut_registered: bool,
        storage_warning: Option<String>,
        platform: &'static str,
        wayland: bool,
        version: String,
    }
    #[derive(Clone, Serialize)]
    struct Snapshot {
        revision: u64,
        entries: Vec<Entry>,
        settings: Settings,
        paused: bool,
        status: Status,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ActionResult {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dismiss_token: Option<String>,
    }
    impl ActionResult {
        fn from(result: Result<(), String>) -> Self {
            match result {
                Ok(()) => Self {
                    ok: true,
                    error: None,
                    dismiss_token: None,
                },
                Err(error) => Self {
                    ok: false,
                    error: Some(error),
                    dismiss_token: None,
                },
            }
        }
    }
    struct Core {
        history: History,
        settings: Settings,
        lifecycle: CaptureLifecycle,
        copy_dismissal: CopyDismissal,
        status: Status,
        settings_busy: bool,
        source_busy: bool,
        visible: bool,
        shown_at: Instant,
        blur_generation: u64,
        snapshot_revision: u64,
    }
    impl Core {
        fn snapshot(&mut self) -> Snapshot {
            self.snapshot_revision = self.snapshot_revision.saturating_add(1);
            Snapshot {
                revision: self.snapshot_revision,
                entries: self.history.entries.clone(),
                settings: self.settings.clone(),
                paused: self.lifecycle.paused,
                status: self.status.clone(),
            }
        }
    }
    struct Backend {
        core: Mutex<Core>,
        storage: Storage,
        synthetic: bool,
        synthetic_clipboard: Mutex<Option<String>>,
        _test_directory: Option<tempfile::TempDir>,
    }
    impl Backend {
        fn core(&self) -> MutexGuard<'_, Core> {
            self.core.lock().unwrap_or_else(|e| e.into_inner())
        }
        fn persist(&self, core: &mut Core) {
            let result = if core.settings.persistence {
                self.storage.save_history(&core.history.entries)
            } else {
                self.storage.erase_history()
            };
            if result.is_err() {
                core.status.storage_warning = Some(STORAGE_ERROR.into());
            }
        }
    }
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64
    }
    fn synthetic_mode() -> bool {
        if cfg!(feature = "smoke-test") {
            return true;
        }
        #[cfg(debug_assertions)]
        {
            return std::env::var("PUPA_TEST_MODE").as_deref() == Ok("1");
        }
        #[cfg(not(debug_assertions))]
        false
    }
    fn local_url(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
        if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
            return true;
        }
        if url.scheme() == "http" && url.host_str() == Some("tauri.localhost") {
            return true;
        }
        #[cfg(debug_assertions)]
        if let Some(dev) = dev_url {
            return url.origin() == dev.origin();
        }
        let _ = dev_url;
        false
    }
    fn authorize(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
        if window.label() != "main"
            || !window
                .url()
                .is_ok_and(|url| local_url(&url, app.config().build.dev_url.as_ref()))
        {
            return Err("この操作は許可されていません。".into());
        }
        Ok(())
    }
    fn publish(app: &AppHandle) {
        let backend = app.state::<Backend>();
        let snapshot = backend.core().snapshot();
        let _ = app.emit_to("main", "pupa-state", &snapshot);
        refresh_tray(app, snapshot.paused);
    }
    fn tray_menu(app: &AppHandle, paused: bool) -> tauri::Result<Menu<tauri::Wry>> {
        let show = MenuItem::with_id(app, "show", "カードをひらく", true, None::<&str>)?;
        let pause = MenuItem::with_id(
            app,
            "pause",
            if paused {
                "履歴の記録を再開"
            } else {
                "履歴の記録を一時停止"
            },
            true,
            None::<&str>,
        )?;
        let settings = MenuItem::with_id(app, "settings", "設定", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "Pupa を終了", true, None::<&str>)?;
        Menu::with_items(app, &[&show, &pause, &settings, &separator, &quit])
    }
    fn refresh_tray(app: &AppHandle, paused: bool) {
        if let Some(tray) = app.tray_by_id("pupa-tray") {
            let _ = tray.set_tooltip(Some(if paused {
                "Pupa · 履歴を一時停止中"
            } else {
                "Pupa · ひとつ前の、つづき。"
            }));
            if let Ok(menu) = tray_menu(app, paused) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
    fn position_window(window: &WebviewWindow) {
        let monitor = window
            .cursor_position()
            .ok()
            .and_then(|p| window.monitor_from_point(p.x, p.y).ok().flatten())
            .or_else(|| window.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten());
        if let Some(monitor) = monitor {
            let area = monitor.work_area();
            let width = (780.0 * monitor.scale_factor())
                .round()
                .min(area.size.width as f64) as u32;
            let _ = window.set_size(tauri::PhysicalSize::new(width, area.size.height));
            let _ = window.set_position(tauri::PhysicalPosition::new(
                area.position.x + area.size.width as i32 - width as i32,
                area.position.y,
            ));
        }
    }
    fn show_now(app: &AppHandle) {
        let Some(backend) = app.try_state::<Backend>() else {
            return;
        };
        {
            let mut core = backend.core();
            if core.lifecycle.locked || core.lifecycle.suspended || core.lifecycle.quitting {
                return;
            }
            core.lifecycle.invalidate_source();
            core.copy_dismissal.invalidate();
            core.blur_generation = core.blur_generation.wrapping_add(1);
            core.shown_at = Instant::now();
            core.visible = true;
        }
        if let Some(window) = app.get_webview_window("main") {
            position_window(&window);
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("pupa-shown", ());
        }
    }
    fn show(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || show_now(&handle));
    }
    fn hide_now(app: &AppHandle) {
        if let Some(backend) = app.try_state::<Backend>() {
            let mut core = backend.core();
            core.visible = false;
            core.copy_dismissal.invalidate();
            core.blur_generation = core.blur_generation.wrapping_add(1);
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }
    fn hide_window(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || hide_now(&handle));
    }
    fn toggle(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let visible = handle
                .try_state::<Backend>()
                .is_some_and(|backend| backend.core().visible);
            if visible {
                hide_now(&handle);
            } else {
                show_now(&handle);
            }
        });
    }
    fn pause(app: &AppHandle, value: bool) {
        {
            let backend = app.state::<Backend>();
            let mut core = backend.core();
            core.lifecycle.paused = value;
            core.lifecycle.reconcile();
        }
        publish(app);
    }
    pub fn set_session_blocked(app: &AppHandle, locked: Option<bool>, suspended: Option<bool>) {
        let Some(backend) = app.try_state::<Backend>() else {
            return;
        };
        let blocked = {
            let mut core = backend.core();
            if let Some(value) = locked {
                core.lifecycle.locked = value;
            }
            if let Some(value) = suspended {
                core.lifecycle.suspended = value;
            }
            core.lifecycle.reconcile();
            let blocked = core.lifecycle.locked || core.lifecycle.suspended;
            if blocked {
                core.copy_dismissal.invalidate();
            }
            blocked
        };
        if blocked {
            hide_window(app);
        }
    }
    fn finish(app: &AppHandle) {
        if let Some(backend) = app.try_state::<Backend>() {
            let mut core = backend.core();
            core.lifecycle.quitting = true;
            core.copy_dismissal.invalidate();
            core.lifecycle.reconcile();
        }
        let _ = app.global_shortcut().unregister_all();
        app.exit(0);
    }
    fn session_safe() -> bool {
        let state = crate::power::clipboard_session_safe();
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            state == Some(true)
        } else {
            state != Some(false)
        }
    }
    fn read_clipboard(app: &AppHandle, backend: &Backend) -> Result<Option<String>, String> {
        if backend.synthetic {
            return Ok(backend
                .synthetic_clipboard
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone());
        }
        if !session_safe() {
            set_session_blocked(app, Some(true), None);
            return Ok(None);
        }
        if crate::power::clipboard_is_sensitive() != Some(false) {
            backend.core().lifecycle.monitor.reset_baseline();
            return Ok(None);
        }
        // Query again immediately before the payload read; marker lookup can race a lock.
        if !session_safe() {
            set_session_blocked(app, Some(true), None);
            return Ok(None);
        }
        // No clipboard permission is granted to JS. Native results stay in Rust.
        let result = app.clipboard().read_text();
        if !session_safe() {
            set_session_blocked(app, Some(true), None);
            return Ok(None);
        }
        if crate::power::clipboard_is_sensitive() != Some(false) {
            backend.core().lifecycle.monitor.reset_baseline();
            return Ok(None);
        }
        match result {
            Ok(text) if text.len() <= MAX_TEXT_BYTES => Ok(Some(text)),
            Ok(_) => Ok(None),
            Err(error) => {
                let message = error.to_string().to_lowercase();
                if message.contains("content")
                    && (message.contains("not available") || message.contains("unavailable"))
                {
                    Ok(None)
                } else {
                    Err("クリップボードを読み取れません。OS の権限や Linux のセッションを確認してください。".into())
                }
            }
        }
    }
    fn poll(app: &AppHandle) {
        let backend = app.state::<Backend>();
        if !backend.synthetic {
            let safe = session_safe();
            {
                let changed = {
                    let core = backend.core();
                    core.lifecycle.locked == safe
                };
                if changed {
                    set_session_blocked(app, Some(!safe), None);
                }
                if !safe {
                    return;
                }
            }
        }
        let token = {
            let mut core = backend.core();
            if core.lifecycle.quitting {
                return;
            }
            core.lifecycle.monitor.begin_read()
        };
        let Some(token) = token else {
            return;
        };
        let result = read_clipboard(app, &backend);
        let mut request = None;
        let mut changed = false;
        {
            let mut core = backend.core();
            match result {
                Ok(text) => {
                    if let Some(text) = core.lifecycle.monitor.complete_read(token, text) {
                        core.history.add(text, now_ms());
                        backend.persist(&mut core);
                        changed = true;
                        if !backend.synthetic
                            && core.settings.source_app
                            && !core.source_busy
                            && !core.visible
                        {
                            if let Some(entry) = core.history.entries.first() {
                                request = Some((
                                    entry.id.clone(),
                                    entry.revision,
                                    core.lifecycle.source_epoch,
                                    core.status.wayland,
                                ));
                                core.source_busy = true;
                            }
                        }
                    }
                }
                Err(error) => {
                    if core.lifecycle.monitor.fail_read(token)
                        && core.status.storage_warning.is_none()
                    {
                        core.status.storage_warning = Some(error);
                        changed = true;
                    }
                }
            }
        }
        if changed {
            publish(app);
        }
        if let Some((id, revision, epoch, wayland)) = request {
            let handle = app.clone();
            thread::spawn(move || {
                let source = crate::source_app::detect_source_app(wayland);
                let backend = handle.state::<Backend>();
                let changed = {
                    let mut core = backend.core();
                    core.source_busy = false;
                    if core.settings.source_app && core.lifecycle.source_is_current(epoch) {
                        if let Some(source) =
                            source.filter(|s| !s.name.eq_ignore_ascii_case("pupa"))
                        {
                            if core.history.set_source(&id, revision, source) {
                                backend.persist(&mut core);
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };
                if changed {
                    publish(&handle);
                }
            });
        }
    }
    #[tauri::command]
    async fn get_state(app: AppHandle, window: WebviewWindow) -> Result<Snapshot, String> {
        authorize(&app, &window)?;
        let backend = app.state::<Backend>();
        let snapshot = backend.core().snapshot();
        Ok(snapshot)
    }
    /// Both animation completion and fallback are checked on the GUI thread,
    /// together with hiding. A queued completion cannot close a newer show.
    fn dismiss_copy(app: &AppHandle, token: String) -> Result<(), String> {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let Some(backend) = handle.try_state::<Backend>() else {
                return;
            };
            let should_hide = {
                let mut core = backend.core();
                core.visible && core.copy_dismissal.consume(&token)
            };
            if should_hide {
                hide_now(&handle);
            }
        })
        .map_err(|_| "カードを閉じられませんでした。Esc キーを押してください。".to_string())
    }
    #[tauri::command]
    async fn copy_entry(app: AppHandle, window: WebviewWindow, id: String) -> ActionResult {
        let result = (|| -> Result<Option<String>, String> {
            authorize(&app, &window)?;
            let backend = app.state::<Backend>();
            let (text, attempt) = {
                let mut core = backend.core();
                let text = core.history.get(&id).ok_or(MISSING_ENTRY)?.text.clone();
                let attempt = core
                    .copy_dismissal
                    .begin_write()
                    .ok_or("コピーしています。少し待ってお試しください。")?;
                core.lifecycle.copying = true;
                core.lifecycle.reconcile();
                (text, attempt)
            };
            let copied = if backend.synthetic {
                *backend
                    .synthetic_clipboard
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(text.clone());
                Ok(())
            } else {
                app.clipboard().write_text(text.clone()).map_err(|_| {
                    "コピーできませんでした。クリップボードへのアクセスを確認してください。"
                        .to_string()
                })
            };
            let dismiss_token = {
                let mut core = backend.core();
                core.lifecycle.copying = false;
                core.lifecycle.reconcile();
                if copied.is_ok() {
                    core.lifecycle.monitor.note_copied(&text);
                }
                let visible = core.visible;
                core.copy_dismissal
                    .finish_write(attempt, copied.is_ok(), visible)
            };
            copied?;
            if let Some(token) = dismiss_token.clone() {
                let handle = app.clone();
                // Renderer normally finishes in ~240 ms. A lost event, frozen
                // animation, or renderer error must not leave a copied hand open.
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(650));
                    let _ = dismiss_copy(&handle, token);
                });
            }
            Ok(dismiss_token)
        })();
        match result {
            Ok(dismiss_token) => ActionResult {
                ok: true,
                error: None,
                dismiss_token,
            },
            Err(error) => ActionResult::from(Err(error)),
        }
    }
    #[tauri::command]
    async fn complete_copy_dismissal(
        app: AppHandle,
        window: WebviewWindow,
        token: String,
    ) -> ActionResult {
        ActionResult::from((|| {
            authorize(&app, &window)?;
            if token.len() > 100 {
                return Err("コピーの完了情報が正しくありません。".into());
            }
            // Unknown, already-consumed and stale tokens are intentionally no-ops.
            // The renderer cannot mint a successful native write by completing.
            dismiss_copy(&app, token)
        })())
    }
    #[tauri::command]
    async fn delete_entry(app: AppHandle, window: WebviewWindow, id: String) -> ActionResult {
        ActionResult::from((|| {
            authorize(&app, &window)?;
            {
                let backend = app.state::<Backend>();
                let mut core = backend.core();
                core.history.get(&id).ok_or(MISSING_ENTRY)?;
                core.history.remove(&id);
                backend.persist(&mut core);
            }
            publish(&app);
            Ok(())
        })())
    }
    #[tauri::command]
    async fn toggle_pin(app: AppHandle, window: WebviewWindow, id: String) -> ActionResult {
        ActionResult::from((|| {
            authorize(&app, &window)?;
            {
                let backend = app.state::<Backend>();
                let mut core = backend.core();
                core.history.get(&id).ok_or(MISSING_ENTRY)?;
                core.history.toggle_pin(&id);
                backend.persist(&mut core);
            }
            publish(&app);
            Ok(())
        })())
    }
    #[tauri::command]
    async fn clear_history(app: AppHandle, window: WebviewWindow) -> ActionResult {
        ActionResult::from((|| {
            authorize(&app, &window)?;
            {
                let backend = app.state::<Backend>();
                let mut core = backend.core();
                core.lifecycle.invalidate_source();
                core.lifecycle.monitor.reset_baseline();
                core.history.clear();
                backend.persist(&mut core);
            }
            publish(&app);
            Ok(())
        })())
    }
    #[tauri::command]
    async fn set_paused(app: AppHandle, window: WebviewWindow, paused: bool) -> ActionResult {
        ActionResult::from(authorize(&app, &window).map(|()| pause(&app, paused)))
    }
    #[tauri::command]
    async fn update_settings(
        app: AppHandle,
        window: WebviewWindow,
        mut patch: Value,
    ) -> ActionResult {
        if let Err(error) = authorize(&app, &window) {
            return ActionResult::from(Err(error));
        }
        let backend = app.state::<Backend>();
        let previous = {
            let mut core = backend.core();
            if core.settings_busy {
                return ActionResult::from(Err(
                    "設定を保存しています。少し待ってお試しください。".into()
                ));
            }
            core.settings_busy = true;
            core.settings.clone()
        };
        let mut registered_new: Option<Shortcut> = None;
        let result = (|| {
            let object = patch
                .as_object_mut()
                .ok_or("設定の形式が正しくありません。")?;
            let confirmed = object
                .remove("confirmHistoryReduction")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let next = previous.patched(&patch)?;
            {
                let core = backend.core();
                if next.history_limit < core.history.entries.len() && !confirmed {
                    return Err("履歴の上限を減らすと古い履歴が削除されます。ピン留めも削除対象になる場合があります。確認してから保存してください。".into());
                }
            }
            let old_shortcut = previous
                .shortcut
                .parse::<Shortcut>()
                .map_err(|_| SHORTCUT_ERROR)?;
            let new_shortcut = next
                .shortcut
                .parse::<Shortcut>()
                .map_err(|_| SHORTCUT_ERROR)?;
            let changed = old_shortcut != new_shortcut;
            if changed {
                app.global_shortcut()
                    .register(new_shortcut)
                    .map_err(|_| SHORTCUT_ERROR)?;
                registered_new = Some(new_shortcut);
            }
            {
                let mut core = backend.core();
                // Capture may have added another entry while the OS registered the
                // shortcut. Recheck destructive reduction under the commit lock.
                if next.history_limit < core.history.entries.len() && !confirmed {
                    return Err("履歴の上限を減らすと古い履歴が削除されます。ピン留めも削除対象になる場合があります。確認してから保存してください。".into());
                }
                if next.persistence && !previous.persistence {
                    backend
                        .storage
                        .save_history(&core.history.entries)
                        .map_err(|_| STORAGE_ERROR)?;
                }
                if backend.storage.save_settings(&next).is_err() {
                    if next.persistence
                        && !previous.persistence
                        && backend.storage.erase_history().is_err()
                    {
                        core.status.storage_warning=Some("設定の保存に失敗し、平文の履歴ファイルも削除できませんでした。保存をオフにしていても履歴ファイルが残っています。".into());
                    }
                    return Err(
                        "設定を保存できませんでした。保存先の権限や空き容量を確認してください。"
                            .into(),
                    );
                }
                if core.settings.source_app != next.source_app {
                    core.lifecycle.invalidate_source();
                }
                core.settings = next;
                core.history.limit = core.settings.history_limit;
                core.history.trim();
                core.status.storage_warning = None;
                if changed {
                    core.status.shortcut_registered = true;
                }
                backend.persist(&mut core);
            }
            if changed {
                let _ = app.global_shortcut().unregister(old_shortcut);
            }
            Ok(())
        })();
        if result.is_err() {
            if let Some(shortcut) = registered_new {
                let _ = app.global_shortcut().unregister(shortcut);
            }
        }
        backend.core().settings_busy = false;
        publish(&app);
        ActionResult::from(result)
    }
    #[tauri::command]
    async fn hide(app: AppHandle, window: WebviewWindow) -> ActionResult {
        ActionResult::from(authorize(&app, &window).map(|()| hide_window(&app)))
    }
    #[tauri::command]
    async fn quit(app: AppHandle, window: WebviewWindow) -> ActionResult {
        ActionResult::from(authorize(&app, &window).map(|()| finish(&app)))
    }
    #[cfg(any(debug_assertions, feature = "smoke-test"))]
    fn authorize_smoke(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
        authorize(app, window)?;
        if !app.state::<Backend>().synthetic {
            return Err("Synthetic test mode is disabled".into());
        }
        Ok(())
    }
    #[cfg(any(debug_assertions, feature = "smoke-test"))]
    #[tauri::command]
    async fn smoke_set_clipboard(
        app: AppHandle,
        window: WebviewWindow,
        text: Option<String>,
    ) -> Result<(), String> {
        authorize_smoke(&app, &window)?;
        *app.state::<Backend>()
            .synthetic_clipboard
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = text;
        Ok(())
    }
    #[cfg(any(debug_assertions, feature = "smoke-test"))]
    #[tauri::command]
    async fn smoke_tick(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
        authorize_smoke(&app, &window)?;
        poll(&app);
        Ok(())
    }
    #[cfg(any(debug_assertions, feature = "smoke-test"))]
    #[tauri::command]
    async fn smoke_toggle(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
        authorize_smoke(&app, &window)?;
        toggle(&app);
        Ok(())
    }
    #[cfg(any(debug_assertions, feature = "smoke-test"))]
    #[tauri::command]
    async fn smoke_state(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
        authorize_smoke(&app, &window)?;
        let backend = app.state::<Backend>();
        let mut core = backend.core();
        Ok(
            serde_json::json!({"state":core.snapshot(),"visible":core.visible,"syntheticClipboard":backend.synthetic_clipboard.lock().unwrap_or_else(|e|e.into_inner()).clone(),"dataDir":backend.storage.directory}),
        )
    }
    #[cfg(feature = "smoke-test")]
    #[tauri::command]
    async fn smoke_native_clipboard_roundtrip(
        app: AppHandle,
        window: WebviewWindow,
    ) -> ActionResult {
        ActionResult::from((|| {
            authorize_smoke(&app, &window)?;
            if !cfg!(target_os = "linux")
                || std::env::var("CI").is_err()
                || std::env::var("DISPLAY").is_err()
                || std::env::var("PUPA_ISOLATED_DESKTOP").as_deref() != Ok("1")
            {
                return Err("Native smoke requires an isolated Linux CI display".into());
            }
            let synthetic = "Pupa synthetic native clipboard verification\n日本語 🐛";
            // Never inspect the preexisting clipboard: known synthetic data is written first.
            app.clipboard()
                .write_text(synthetic.to_string())
                .map_err(|_| "Native synthetic write failed")?;
            let read = app
                .clipboard()
                .read_text()
                .map_err(|_| "Native synthetic read failed");
            let _ = app.clipboard().clear();
            if read? != synthetic {
                return Err("Native synthetic roundtrip differed".into());
            }
            Ok(())
        })())
    }
    pub fn run() {
        let builder=tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app,_,_|show(app)))
            .plugin(tauri_plugin_clipboard_manager::init())
            .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app,_,event|{if event.state()==ShortcutState::Pressed{toggle(app);}}).build())
            .on_permission_request(|_,_|tauri::webview::PermissionResponse::Deny)
            .on_window_event(|window,event|{
                if window.label()!="main"{return;}
                let app=window.app_handle();let Some(backend)=app.try_state::<Backend>()else{return;};
                match event {
                    WindowEvent::CloseRequested{api,..}=>{if !backend.core().lifecycle.quitting{api.prevent_close();hide_window(app);}},
                    WindowEvent::Focused(focused)=>{
                        let (generation,wait)={let mut core=backend.core();core.blur_generation=core.blur_generation.wrapping_add(1);(core.blur_generation,Duration::from_millis(300).saturating_sub(core.shown_at.elapsed()))};
                        if !focused {let handle=app.clone();thread::spawn(move||{thread::sleep(wait);let ui=handle.clone();let _=handle.run_on_main_thread(move||{
                            let current={let backend=ui.state::<Backend>();let core=backend.core();core.visible&&core.blur_generation==generation};
                            if current&&ui.get_webview_window("main").is_some_and(|w|!w.is_focused().unwrap_or(true)){hide_now(&ui);}
                        });});}
                    },
                    WindowEvent::ScaleFactorChanged{..}=>{if backend.core().visible{if let Some(window)=app.get_webview_window("main"){position_window(&window);}}},
                    _=>(),
                }
            })
            .setup(|app|{
                let synthetic=synthetic_mode();
                let test_directory=if synthetic{Some(tempfile::Builder::new().prefix("pupa-test-").tempdir()?)}else{None};
                let directory=match &test_directory{Some(temp)=>temp.path().to_path_buf(),None=>app.path().app_data_dir()?};
                let storage=Storage::new(directory);let first_run=!storage.settings_path.exists();let loaded=storage.load();
                let mut history=History::new(loaded.settings.history_limit);history.restore(&loaded.entries,now_ms());let mut warning=loaded.warning;
                if storage.save_settings(&loaded.settings).is_err(){warning=Some("設定を保存できませんでした。この起動中はメモリだけで動作します。".into());}
                let wayland=cfg!(target_os="linux")&&(std::env::var_os("WAYLAND_DISPLAY").is_some()||std::env::var("XDG_SESSION_TYPE").as_deref()==Ok("wayland"));
                let status=Status{shortcut_registered:false,storage_warning:warning,platform:if cfg!(target_os="macos"){"darwin"}else if cfg!(target_os="windows"){"win32"}else{"linux"},wayland,version:app.package_info().version.to_string()};
                app.manage(Backend{core:Mutex::new(Core{history,settings:loaded.settings,lifecycle:CaptureLifecycle::default(),copy_dismissal:CopyDismissal::default(),status,settings_busy:false,source_busy:false,visible:false,shown_at:Instant::now(),blur_generation:0,snapshot_revision:0}),storage,synthetic,synthetic_clipboard:Mutex::new(None),_test_directory:test_directory});
                let config=app.config().app.windows.iter().find(|w|w.label=="main").ok_or("Missing main window configuration")?;
                let dev_url=app.config().build.dev_url.clone();
                tauri::WebviewWindowBuilder::from_config(app,config)?.on_navigation(move|url|local_url(url,dev_url.as_ref()))
                    .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny).build()?;
                #[cfg(target_os="macos")] app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let handle=app.handle();let backend=handle.state::<Backend>();let shortcut=backend.core().settings.shortcut.clone();
                let shortcut_registered=handle.global_shortcut().register(shortcut.as_str()).is_ok();backend.core().status.shortcut_registered=shortcut_registered;
                let tray_result=(||->tauri::Result<tauri::tray::TrayIcon>{
                    let bytes=if cfg!(target_os="macos"){include_bytes!("../../assets/trayTemplate.png").as_slice()}else{include_bytes!("../../assets/tray.png").as_slice()};
                    TrayIconBuilder::with_id("pupa-tray").icon(tauri::image::Image::from_bytes(bytes)?).icon_as_template(cfg!(target_os="macos"))
                        .tooltip("Pupa · ひとつ前の、つづき。").menu(&tray_menu(handle,false)?).show_menu_on_left_click(false)
                        .on_menu_event(|app,event|match event.id.as_ref(){"show"=>show(app),"pause"=>{let paused=app.state::<Backend>().core().lifecycle.paused;pause(app,!paused);},"settings"=>{show(app);let _=app.emit_to("main","pupa-open-settings",());},"quit"=>finish(app),_=>()})
                        .on_tray_icon_event(|tray,event|{if let TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}=event{toggle(tray.app_handle());}}).build(handle)
                })();
                if tray_result.is_err(){backend.core().status.storage_warning=Some("トレイアイコンを表示できません。ショートカット、または Pupa の再起動でカードをひらけます。".into());}
                if !synthetic {if let Err(warning)=crate::source_app::start_session_monitor(handle.clone()){backend.core().status.storage_warning=Some(warning);}}
                // Synthetic startup has no OS clipboard calls. Native reads must
                // stay off the GUI thread (required by the Linux clipboard plugin).
                if synthetic { poll(handle); }
                if first_run||tray_result.is_err()||!shortcut_registered||synthetic{show_now(handle);}
                if !synthetic {
                    let handle=handle.clone();thread::spawn(move||{
                        poll(&handle); // Baseline only, before collection starts.
                        let mut gap=crate::power::PollGapGuard::default();
                        loop {thread::sleep(Duration::from_millis(700));let backend=handle.state::<Backend>();
                            {let mut core=backend.core();if core.lifecycle.quitting{break;}if gap.check(){core.lifecycle.invalidate_source();core.lifecycle.monitor.reset_baseline();}}
                            poll(&handle);
                        }
                    });
                }
                Ok(())
            });
        #[cfg(feature = "smoke-test")]
        let builder = builder.invoke_handler(tauri::generate_handler![
            get_state,
            copy_entry,
            complete_copy_dismissal,
            delete_entry,
            toggle_pin,
            clear_history,
            set_paused,
            update_settings,
            hide,
            quit,
            smoke_set_clipboard,
            smoke_tick,
            smoke_toggle,
            smoke_state,
            smoke_native_clipboard_roundtrip
        ]);
        #[cfg(all(debug_assertions, not(feature = "smoke-test")))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            get_state,
            copy_entry,
            complete_copy_dismissal,
            delete_entry,
            toggle_pin,
            clear_history,
            set_paused,
            update_settings,
            hide,
            quit,
            smoke_set_clipboard,
            smoke_tick,
            smoke_toggle,
            smoke_state
        ]);
        #[cfg(all(not(debug_assertions), not(feature = "smoke-test")))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            get_state,
            copy_entry,
            complete_copy_dismissal,
            delete_entry,
            toggle_pin,
            clear_history,
            set_paused,
            update_settings,
            hide,
            quit
        ]);
        let app = builder
            .build(tauri::generate_context!())
            .expect("Pupa could not start. Reinstall the app or inspect local file permissions.");
        app.run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                if let Some(backend) = app.try_state::<Backend>() {
                    if !backend.core().lifecycle.quitting {
                        api.prevent_exit();
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show(app),
            tauri::RunEvent::Exit => {
                if let Some(backend) = app.try_state::<Backend>() {
                    let mut core = backend.core();
                    core.lifecycle.quitting = true;
                    core.lifecycle.reconcile();
                }
                let _ = app.global_shortcut().unregister_all();
            }
            _ => (),
        });
    }
}

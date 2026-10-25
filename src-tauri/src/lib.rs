pub mod geometry;
pub mod history;
pub mod files;
pub mod power;
pub mod shortcuts;
pub mod source_app;
pub mod storage;
#[cfg(feature = "desktop")]
pub use desktop::{run, set_session_blocked};
#[cfg(feature = "desktop")]
mod desktop {
    use crate::{
        geometry::{self, Extent, MonitorGeometry, Placement, Point, Rect},
        history::{CaptureLifecycle, CopyDismissal, Entry, History, Settings, MAX_TEXT_BYTES},
        storage::Storage,
    };
    use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
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
    use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState};
    const MISSING_ENTRY: &str = "このカードは見つかりませんでした。";
    const STORAGE_ERROR: &str =
        "履歴の保存・削除ができませんでした。保存先の権限や空き容量を確認してください。";
    const SHORTCUT_ERROR: &str =
        "このショートカットは登録できません。他のアプリとの重複や OS の設定を確認してください。";
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        shortcut_registered: bool,
        shortcut_available: bool,
        shortcut_backend: &'static str,
        shortcut_state: &'static str,
        shortcut_trigger: Option<String>,
        shortcut_warning: Option<String>,
        storage_warning: Option<String>,
        position_warning: Option<String>,
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
    #[derive(Clone)]
    struct PlacementState {
        generation: u64,
        backend: &'static str,
        monitor: Option<MonitorGeometry>,
        requested: Option<Placement>,
        scheduled: bool,
        attempts: u8,
        ready: bool,
        last_error: Option<String>,
    }
    impl Default for PlacementState {
        fn default() -> Self {
            Self {
                generation: 0,
                backend: "unknown",
                monitor: None,
                requested: None,
                scheduled: false,
                attempts: 0,
                ready: false,
                last_error: None,
            }
        }
    }
    struct Core {
        history: History,
        settings: Settings,
        lifecycle: CaptureLifecycle,
        copy_dismissal: CopyDismissal,
        placement: PlacementState,
        status: Status,
        settings_busy: bool,
        source_busy: bool,
        portal_dialog_open: bool,
        portal_focus_deadline: Option<Instant>,
        portal_request_busy: bool,
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
    const POSITION_RETRIES: u8 = 6;
    const WAYLAND_POSITION_WARNING: &str = "このアプリはネイティブ Wayland で動作しているため、ウィンドウを画面の右端へ配置できません。XWayland が利用できる環境ではアプリが自動で優先します。明示した GDK_BACKEND 設定がある場合は、その設定を優先しています。";
    const POSITION_FAILED_WARNING: &str = "画面の右端への配置を確認できませんでした。デスクトップ環境が移動を制限している可能性があります。もう一度カードをひらいてください。";
    fn backend_name(window: &WebviewWindow) -> &'static str {
        match window.display_handle().map(|handle| handle.as_raw()) {
            Ok(RawDisplayHandle::Xlib(_)) | Ok(RawDisplayHandle::Xcb(_)) => "x11",
            Ok(RawDisplayHandle::Wayland(_)) => "wayland",
            Ok(_) => "native",
            Err(_) => "unknown",
        }
    }
    fn monitor_geometry(monitor: &tauri::Monitor) -> MonitorGeometry {
        let position = monitor.position();
        let size = monitor.size();
        let work = monitor.work_area();
        MonitorGeometry {
            name: monitor.name().cloned(),
            bounds: Rect {
                position: Point {
                    x: position.x,
                    y: position.y,
                },
                size: Extent {
                    width: size.width,
                    height: size.height,
                },
            },
            work_area: Rect {
                position: Point {
                    x: work.position.x,
                    y: work.position.y,
                },
                size: Extent {
                    width: work.size.width,
                    height: work.size.height,
                },
            },
            scale_factor: monitor.scale_factor(),
        }
    }
    #[cfg(target_os = "linux")]
    fn compositor_pointer() -> Option<(f64, f64)> {
        // XWayland may retain the last pointer position over an X11 surface.
        // Query the existing optional Shell bridge once per show, never poll it.
        use gtk::gio;
        if std::env::var_os("WAYLAND_DISPLAY").is_none()
            && std::env::var("XDG_SESSION_TYPE").as_deref() != Ok("wayland")
        {
            return None;
        }
        let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).ok()?;
        let reply = connection.call_sync(
            Some("org.gnome.Shell"),
            "/jp/kuro0315/Pupa/SourceApp",
            "jp.kuro0315.Pupa.SourceApp",
            "GetPointer",
            None,
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            150,
            gio::Cancellable::NONE,
        ).ok()?;
        let (json,) = reply.get::<(String,)>()?;
        let point: serde_json::Value = serde_json::from_str(&json).ok()?;
        let x = point.get("x")?.as_f64()?;
        let y = point.get("y")?.as_f64()?;
        (x.is_finite() && y.is_finite()).then_some((x, y))
    }
    fn selected_monitor(
        window: &WebviewWindow,
        previous: Option<&MonitorGeometry>,
        backend: &str,
    ) -> Option<MonitorGeometry> {
        let mut monitors: Vec<_> = window
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(monitor_geometry)
            .collect();
        let current = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|m| monitor_geometry(&m));
        let primary = window
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| monitor_geometry(&m));
        if monitors.is_empty() {
            monitors.extend(current.clone().or(primary.clone()));
        }
        // Keep this show on the selected monitor. Pointer movement must not make
        // post-map or resize corrections jump between displays.
        if let Some(index) = previous.and_then(|p| geometry::matching_monitor(&monitors, p)) {
            return Some(monitors[index].clone());
        }
        let current_index = current
            .as_ref()
            .and_then(|m| geometry::matching_monitor(&monitors, m));
        let primary_index = primary
            .as_ref()
            .and_then(|m| geometry::matching_monitor(&monitors, m));
        // GTK pointer coordinates are logical. Resolve the monitor before
        // converting its origin using that monitor's scale, rather than the
        // default root window's scale (which can belong to another display).
        #[cfg(target_os = "linux")]
        if previous.is_none() && backend == "x11" {
            use gtk::gdk;
            use gtk::prelude::*;
            if let Some(display) = gdk::Display::default() {
                if let Some(pointer) = display.default_seat().and_then(|seat| seat.pointer()) {
                    let (x, y) = compositor_pointer().unwrap_or_else(|| {
                        let (_, x, y) = pointer.position_double();
                        (x, y)
                    });
                    if let Some(target) = display.monitor_at_point(x.floor() as i32, y.floor() as i32) {
                        let bounds = target.geometry();
                        let scale = target.scale_factor();
                        let origin = Point {
                            x: bounds.x().saturating_mul(scale),
                            y: bounds.y().saturating_mul(scale),
                        };
                        if let Some(monitor) = monitors.iter().find(|m| {
                            m.bounds.position == origin
                                && m.name.as_deref() == target.model().as_deref()
                        }) {
                            return Some(monitor.clone());
                        }
                    }
                }
            }
        }
        let cursor = if let Some(previous) = previous {
            // After a display disappears, prefer the OS's current monitor. If
            // unavailable, use the former target's center, not a moving pointer.
            if current_index.is_none() {
                Some((
                    f64::from(previous.bounds.position.x)
                        + f64::from(previous.bounds.size.width) / 2.0,
                    f64::from(previous.bounds.position.y)
                        + f64::from(previous.bounds.size.height) / 2.0,
                ))
            } else {
                None
            }
        } else if backend == "wayland" {
            None
        } else {
            window.cursor_position().ok().map(|p| (p.x, p.y))
        };
        geometry::select_monitor(&monitors, cursor, current_index, primary_index)
            .map(|i| monitors[i].clone())
    }
    fn update_position_warning(app: &AppHandle, warning: Option<String>) {
        let changed = {
            let backend = app.state::<Backend>();
            let mut core = backend.core();
            if core.status.position_warning == warning {
                false
            } else {
                core.status.position_warning = warning;
                true
            }
        };
        if changed {
            publish(app);
        }
    }
    fn begin_placement(window: &WebviewWindow) {
        let backend_name = backend_name(window);
        let monitor = selected_monitor(window, None, backend_name);
        {
            let backend = window.app_handle().state::<Backend>();
            let mut core = backend.core();
            let generation = core.placement.generation.wrapping_add(1);
            core.placement = PlacementState {
                generation,
                backend: backend_name,
                monitor,
                ..PlacementState::default()
            };
        }
        position_window(window);
    }
    /// Called on the GUI thread. Native set_size/set_position may enqueue work,
    /// so map/resize events and bounded delayed checks verify actual OS geometry.
    fn position_window(window: &WebviewWindow) {
        let app = window.app_handle();
        let previous = {
            let backend = app.state::<Backend>();
            let core = backend.core();
            if !core.visible {
                return;
            }
            core.placement.clone()
        };
        let supported = matches!(previous.backend, "x11" | "native");
        let monitor = selected_monitor(window, previous.monitor.as_ref(), previous.backend);
        let Some((monitor, desired, area)) = monitor.and_then(|m| {
            Some((
                m.clone(),
                geometry::desired_placement(&m)?,
                m.usable_area()?,
            ))
        }) else {
            let warning = "画面のサイズを取得できず、右端への配置を確認できませんでした。";
            {
                let backend = app.state::<Backend>();
                let mut core = backend.core();
                core.placement.ready = false;
                core.placement.last_error = Some(warning.into());
            }
            update_position_warning(app, Some(warning.into()));
            return;
        };
        if !supported {
            // Wayland forbids global positioning, not fitting to the display.
            // Avoid retaining the configured 900px height on a smaller screen.
            if window.inner_size().ok().map(|s| (s.width, s.height))
                != Some((desired.size.width, desired.size.height))
            {
                let _ = window.set_size(tauri::PhysicalSize::new(
                    desired.size.width,
                    desired.size.height,
                ));
            }
            let warning = if previous.backend == "wayland" {
                WAYLAND_POSITION_WARNING
            } else {
                POSITION_FAILED_WARNING
            };
            {
                let backend = app.state::<Backend>();
                let mut core = backend.core();
                core.placement.monitor = Some(monitor);
                core.placement.requested = Some(desired);
                core.placement.ready = false;
                core.placement.last_error = Some(warning.into());
            }
            update_position_warning(app, Some(warning.into()));
            return;
        }
        let inner = window.inner_size().ok().map(|s| Extent {
            width: s.width,
            height: s.height,
        });
        let outer = window.outer_size().ok().map(|s| Extent {
            width: s.width,
            height: s.height,
        });
        let origin = window
            .outer_position()
            .ok()
            .map(|p| Point { x: p.x, y: p.y });
        let ready = match (inner, outer, origin) {
            (Some(i), Some(o), Some(p)) => geometry::placement_matches(area, desired, p, o, i),
            _ => false,
        };
        let monitor_changed = previous.monitor.as_ref() != Some(&monitor);
        let attempts = if ready || monitor_changed {
            0
        } else {
            previous.attempts
        };
        let mut error = None;
        let mut attempted = false;
        if !ready && attempts < POSITION_RETRIES {
            attempted = true;
            if inner != Some(desired.size) {
                if let Err(e) = window.set_size(tauri::PhysicalSize::new(
                    desired.size.width,
                    desired.size.height,
                )) {
                    error = Some(e.to_string());
                }
            }
            let actual_outer = outer
                .filter(|s| s.width > 0 && s.height > 0)
                .unwrap_or(desired.size);
            let target = geometry::anchored_origin(area, actual_outer);
            if origin != Some(target) {
                if let Err(e) =
                    window.set_position(tauri::PhysicalPosition::new(target.x, target.y))
                {
                    error = Some(e.to_string());
                }
            }
        }
        let attempts = if attempted { attempts + 1 } else { attempts };
        let exhausted = !ready && attempts >= POSITION_RETRIES;
        {
            let backend = app.state::<Backend>();
            let mut core = backend.core();
            if core.placement.generation != previous.generation || !core.visible {
                return;
            }
            core.placement.monitor = Some(monitor);
            core.placement.requested = Some(desired);
            core.placement.ready = ready;
            core.placement.attempts = attempts;
            core.placement.last_error = if ready {
                None
            } else {
                error.or_else(|| exhausted.then(|| POSITION_FAILED_WARNING.into()))
            };
        }
        update_position_warning(app, exhausted.then(|| POSITION_FAILED_WARNING.into()));
        if !ready && !exhausted {
            schedule_placement_check(app);
        }
    }
    fn schedule_placement_check(app: &AppHandle) {
        let generation = {
            let Some(backend) = app.try_state::<Backend>() else {
                return;
            };
            let mut core = backend.core();
            if !core.visible || core.placement.scheduled {
                return;
            }
            core.placement.scheduled = true;
            core.placement.generation
        };
        let handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            let ui = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                {
                    let backend = ui.state::<Backend>();
                    let mut core = backend.core();
                    if !core.visible || core.placement.generation != generation {
                        return;
                    }
                    core.placement.scheduled = false;
                }
                if let Some(window) = ui.get_webview_window("main") {
                    position_window(&window);
                }
            });
        });
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
            begin_placement(&window);
            let _ = window.show();
            // The WM can override a pre-map placement. Always verify after map.
            schedule_placement_check(app);
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
            core.portal_dialog_open = false;
            core.portal_focus_deadline = None;
            core.placement.generation = core.placement.generation.wrapping_add(1);
            core.placement.scheduled = false;
            core.placement.ready = false;
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
    fn shortcut_manager(app: &AppHandle) -> Option<tauri::State<'_, GlobalShortcut<tauri::Wry>>> {
        // The plugin can legitimately be unavailable (e.g. no X11 connection).
        // GlobalShortcutExt::global_shortcut would panic without its state.
        app.try_state::<GlobalShortcut<tauri::Wry>>()
    }
    #[cfg(target_os = "linux")]
    fn setup_portal_shortcut(app: &AppHandle) {
        use crate::shortcuts::portal::{Controller, Event};
        let handle = app.clone();
        let (controller, worker) = Controller::new(move |event| {
            let backend = handle.state::<Backend>();
            if backend.core().lifecycle.quitting {
                return;
            }
            match event {
                Event::Status(status) => {
                    {
                        let mut core = backend.core();
                        core.status.shortcut_registered = status.registered();
                        core.status.shortcut_available = status.state != "unavailable";
                        core.status.shortcut_state = status.state;
                        core.status.shortcut_trigger = status.trigger;
                        core.status.shortcut_warning = status.warning;
                    }
                    publish(&handle);
                }
                Event::RestorePreference(enabled) => {
                    let mut core = backend.core();
                    // Persist opt-in only after a successful, usable portal binding.
                    let mut settings = core.settings.clone();
                    settings.system_shortcut_enabled = enabled;
                    if core.settings.system_shortcut_enabled == enabled {
                        return;
                    }
                    if backend.storage.save_settings(&settings).is_ok() {
                        core.settings = settings;
                    } else {
                        core.status.storage_warning =
                            Some("ショートカットの次回起動用の設定を保存できませんでした。".into());
                    }
                    drop(core);
                    publish(&handle);
                }
                Event::Activated(token) => {
                    let ui = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if ui.state::<Backend>().core().visible {
                            hide_now(&ui);
                        } else {
                            if let (Some(token), Some(window)) =
                                (token, ui.get_webview_window("main"))
                            {
                                // GTK consumes the compositor-provided activation token;
                                // do not set a process-global environment variable.
                                use gtk::prelude::GtkWindowExt;
                                if let Ok(window) = window.gtk_window() {
                                    window.set_startup_id(&token);
                                }
                            }
                            show_now(&ui);
                        }
                    });
                }
            }
        });
        app.manage(controller.clone());
        tauri::async_runtime::spawn(worker);
        let restore = {
            let backend = app.state::<Backend>();
            let core = backend.core();
            core.settings
                .system_shortcut_enabled
                .then(|| core.settings.shortcut.clone())
        };
        if let Some(preferred) = restore {
            // A previously successful opt-in authorizes normal portal restoration.
            // GNOME may ask again if its saved grant was revoked. Never accept it.
            tauri::async_runtime::spawn(async move {
                let _ = controller.request(preferred, None, true).await;
            });
        }
    }
    #[tauri::command]
    async fn request_system_shortcut(app: AppHandle, window: WebviewWindow) -> ActionResult {
        if let Err(error) = authorize(&app, &window) {
            return ActionResult::from(Err(error));
        }
        #[cfg(target_os = "linux")]
        {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            let preferred = {
                let backend = app.state::<Backend>();
                let core = backend.core();
                if core.status.shortcut_backend != "portal" || core.lifecycle.quitting {
                    return ActionResult::from(Err(
                        "この環境では通常のショートカット設定を使ってください。".into(),
                    ));
                }
                core.settings.shortcut.clone()
            };
            let parent = match window.window_handle().map(|handle| handle.as_raw()) {
                Ok(RawWindowHandle::Xlib(handle)) => Some(handle.window as u64),
                Ok(RawWindowHandle::Xcb(handle)) => Some(handle.window.get() as u64),
                // A missing parent is explicitly supported by the portal. Never
                // reinterpret a Wayland surface pointer as an X11 window id.
                _ => None,
            };
            let Some(controller) = app.try_state::<crate::shortcuts::portal::Controller>() else {
                return ActionResult::from(Err(crate::shortcuts::CLOSED.into()));
            };
            {
                let backend = app.state::<Backend>();
                let mut core = backend.core();
                if core.portal_request_busy {
                    return ActionResult::from(Err(
                        "システムのショートカット設定を待っています。".into()
                    ));
                }
                core.portal_request_busy = true;
            }
            let result = controller.request(preferred, parent, false).await;
            {
                let backend = app.state::<Backend>();
                let mut core = backend.core();
                core.portal_request_busy = false;
                if matches!(
                    result,
                    Ok(crate::shortcuts::portal::RequestOutcome::ConfigurationOpened)
                ) {
                    // Configure returns before focus transfers. Allow one delayed
                    // handoff, then retain the parent until focus comes back.
                    if !core.portal_dialog_open {
                        core.portal_focus_deadline = Some(Instant::now() + Duration::from_secs(5));
                    }
                } else {
                    core.portal_dialog_open = false;
                    core.portal_focus_deadline = None;
                }
            }
            ActionResult::from(result.map(|_| ()))
        }
        #[cfg(not(target_os = "linux"))]
        ActionResult::from(Err(
            "この環境では通常のショートカット設定を使ってください。".into(),
        ))
    }
    fn finish(app: &AppHandle) {
        if let Some(backend) = app.try_state::<Backend>() {
            let mut core = backend.core();
            core.lifecycle.quitting = true;
            core.copy_dismissal.invalidate();
            core.lifecycle.reconcile();
        }
        if let Some(manager) = shortcut_manager(app) {
            let _ = manager.unregister_all();
        }
        #[cfg(target_os = "linux")]
        if let Some(controller) = app.try_state::<crate::shortcuts::portal::Controller>() {
            let controller = controller.inner().clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                controller.shutdown_and_wait().await;
                app.exit(0);
            });
            return;
        }
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
    fn read_clipboard(app: &AppHandle, backend: &Backend) -> Result<Option<crate::files::ClipboardContent>, String> {
        use crate::files::ClipboardContent;
        if backend.synthetic {
            return Ok(backend
                .synthetic_clipboard
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone().map(ClipboardContent::Text));
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
        #[cfg(target_os = "linux")]
        let files = crate::files::native::read(app)?;
        #[cfg(not(target_os = "linux"))]
        let files: Option<Vec<String>> = None;
        let result = if files.is_some() { Ok(String::new()) } else { app.clipboard().read_text() };
        if !session_safe() {
            set_session_blocked(app, Some(true), None);
            return Ok(None);
        }
        if crate::power::clipboard_is_sensitive() != Some(false) {
            backend.core().lifecycle.monitor.reset_baseline();
            return Ok(None);
        }
        if let Some(paths) = files { return Ok(Some(ClipboardContent::Files(paths))); }
        match result {
            Ok(text) if text.len() <= MAX_TEXT_BYTES => Ok(Some(ClipboardContent::Text(text))),
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
                Ok(content) => {
                    let key = content.as_ref().map(crate::files::ClipboardContent::key);
                    if core.lifecycle.monitor.complete_read(token, key).is_some() {
                        let Some(content) = content else { return; };
                        let added = match content {
                            crate::files::ClipboardContent::Text(text) => core.history.add(text, now_ms()),
                            crate::files::ClipboardContent::Files(paths) => core.history.add_files(paths, now_ms()),
                        };
                        if !added { return; }
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
    fn restore_source_icons(app: &AppHandle) {
        if !cfg!(target_os = "linux") {
            return;
        }
        let names: std::collections::BTreeSet<String> = {
            let backend = app.state::<Backend>();
            let core = backend.core();
            if !core.settings.source_app { return; }
            core.history.entries.iter().filter_map(|entry| entry.source.as_ref())
                .filter(|source| source.icon.is_none()).map(|source| source.name.clone()).collect()
        };
        let app = app.clone();
        thread::spawn(move || {
            for name in names {
                let backend = app.state::<Backend>();
                { let core = backend.core(); if core.lifecycle.quitting || !core.settings.source_app { break; } }
                let Some(icon) = crate::source_app::resolve_local_icon(&name) else { continue; };
                let changed = {
                    let mut core = backend.core();
                    if core.lifecycle.quitting || !core.settings.source_app { break; }
                    let updates: Vec<_> = core.history.entries.iter().filter_map(|entry| {
                        let mut source = entry.source.clone()?;
                        if source.name != name || source.icon.is_some() { return None; }
                        source.icon = Some(icon.clone());
                        Some((entry.id.clone(), entry.revision, source))
                    }).collect();
                    let mut changed = false;
                    for (id, revision, source) in updates { changed |= core.history.set_source(&id, revision, source); }
                    if changed { backend.persist(&mut core); }
                    changed
                };
                if changed { publish(&app); }
            }
        });
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
            let (content, attempt) = {
                let mut core = backend.core();
                let entry = core.history.get(&id).ok_or(MISSING_ENTRY)?;
                let content = if entry.files.is_empty() { crate::files::ClipboardContent::Text(entry.text.clone()) }
                    else { crate::files::ClipboardContent::Files(entry.files.clone()) };
                let attempt = core
                    .copy_dismissal
                    .begin_write()
                    .ok_or("コピーしています。少し待ってお試しください。")?;
                core.lifecycle.copying = true;
                core.lifecycle.reconcile();
                (content, attempt)
            };
            let copied = if backend.synthetic && matches!(&content, crate::files::ClipboardContent::Files(_)) {
                Err("Synthetic file copying is disabled outside the isolated native probe".into())
            } else if let crate::files::ClipboardContent::Files(paths) = &content {
                #[cfg(target_os = "linux")]
                { crate::files::native::write(&app, paths.clone()) }
                #[cfg(not(target_os = "linux"))]
                { let _ = paths; Err("この OS ではファイルの再コピーにまだ対応していません。".into()) }
            } else if backend.synthetic {
                *backend
                    .synthetic_clipboard
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(match &content { crate::files::ClipboardContent::Text(text) => text.clone(), _ => unreachable!() });
                Ok(())
            } else {
                let crate::files::ClipboardContent::Text(text) = &content else { unreachable!() };
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
                    core.lifecycle.monitor.note_copied(&content.key());
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
            // Portal opt-in is set only after successful system approval, never
            // by an arbitrary renderer settings patch.
            if object.contains_key("systemShortcutEnabled") {
                return Err(
                    "システムショートカットは専用の設定ボタンから変更してください。".into(),
                );
            }
            let confirmed = object
                .remove("confirmHistoryReduction")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut next = previous.patched(&patch)?;
            let portal = backend.core().status.shortcut_backend == "portal";
            if portal && previous.shortcut != next.shortcut {
                return Err("Wayland のショートカットはシステム設定で変更してください。".into());
            }
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
            let changed = !portal && old_shortcut != new_shortcut;
            if changed {
                shortcut_manager(&app)
                    .ok_or(SHORTCUT_ERROR)?
                    .register(new_shortcut)
                    .map_err(|_| SHORTCUT_ERROR)?;
                registered_new = Some(new_shortcut);
            }
            {
                let mut core = backend.core();
                // Capture may have added another entry while the OS registered the
                // shortcut. Recheck destructive reduction under the commit lock.
                // A portal request can also finish while settings are being saved.
                next.system_shortcut_enabled = core.settings.system_shortcut_enabled;
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
                    core.status.shortcut_state = "registered";
                    core.status.shortcut_trigger = Some(core.settings.shortcut.clone());
                }
                backend.persist(&mut core);
            }
            if changed {
                if let Some(manager) = shortcut_manager(&app) {
                    let _ = manager.unregister(old_shortcut);
                }
            }
            Ok(())
        })();
        if result.is_err() {
            if let Some(shortcut) = registered_new {
                if let Some(manager) = shortcut_manager(&app) {
                    let _ = manager.unregister(shortcut);
                }
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
    #[cfg(any(debug_assertions, feature = "smoke-test"))]
    #[tauri::command]
    async fn smoke_geometry(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
        authorize_smoke(&app, &window)?;
        let (placement, visible) = {
            let backend = app.state::<Backend>();
            let core = backend.core();
            (core.placement.clone(), core.visible)
        };
        // Never hold Core while asking the native event loop for window data.
        let inner_position = window
            .inner_position()
            .ok()
            .map(|p| Point { x: p.x, y: p.y });
        let outer_position = window
            .outer_position()
            .ok()
            .map(|p| Point { x: p.x, y: p.y });
        let inner_size = window.inner_size().ok().map(|s| Extent {
            width: s.width,
            height: s.height,
        });
        let outer_size = window.outer_size().ok().map(|s| Extent {
            width: s.width,
            height: s.height,
        });
        let scale = window.scale_factor().ok();
        let supported = matches!(placement.backend, "x11" | "native");
        let area = placement
            .monitor
            .as_ref()
            .and_then(MonitorGeometry::usable_area);
        let error = match (area, outer_position, outer_size) {
            (Some(a), Some(p), Some(s)) => Some(geometry::right_edge_error(a, p, s)),
            _ => None,
        };
        let actual_matches = match (
            area,
            placement.requested,
            outer_position,
            outer_size,
            inner_size,
        ) {
            (Some(a), Some(d), Some(p), Some(o), Some(i)) => {
                geometry::placement_matches(a, d, p, o, i)
            }
            _ => false,
        };
        let still_current = {
            let backend = app.state::<Backend>();
            let core = backend.core();
            core.visible && core.placement.generation == placement.generation
        };
        Ok(serde_json::json!({
            "backend":placement.backend,"positioningSupported":supported,"visible":visible,
            "generation":placement.generation,"selectedMonitor":placement.monitor,"requested":placement.requested,
            "actual":{"outerPosition":outer_position,"outerSize":outer_size,"innerPosition":inner_position,"innerSize":inner_size,"scaleFactor":scale},
            "rightEdgeErrorPx":error,"ready":supported&&still_current&&actual_matches,"lastError":placement.last_error,
            "placementAttempts":placement.attempts
        }))
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
            #[cfg(target_os = "linux")]
            {
                let directory = tempfile::tempdir().map_err(|_| "Cannot create synthetic files")?;
                let file = directory.path().join("架空の資料 #1.txt");
                let folder = directory.path().join("架空のフォルダー");
                std::fs::write(&file, "Synthetic file clipboard content").map_err(|_| "Cannot write synthetic file")?;
                std::fs::create_dir(&folder).map_err(|_| "Cannot create synthetic folder")?;
                let paths = vec![file.to_string_lossy().into_owned(), folder.to_string_lossy().into_owned()];
                crate::files::native::write(&app, paths.clone())?;
                if crate::files::native::read(&app)? != Some(paths.clone()) {
                    return Err("Native file URI roundtrip differed".into());
                }
                // Recopy must not alter the actual file or folder.
                if std::fs::read_to_string(&file).map_err(|_| "Synthetic file disappeared")? != "Synthetic file clipboard content" || !folder.is_dir() {
                    return Err("Native file recopy changed its source".into());
                }
                std::fs::remove_file(&file).map_err(|_| "Cannot remove synthetic file")?;
                if crate::files::native::write(&app, paths).is_ok() {
                    return Err("Native file copy accepted a deleted source".into());
                }
                app.clipboard().clear().map_err(|_| "Cannot clear synthetic clipboard")?;
            }
            Ok(())
        })())
    }
    pub fn run() {
        // Must run before GTK/Tauri starts any threads or initializes a display.
        // This selects only this process's backend and respects explicit choices.
        #[cfg(target_os = "linux")]
        if std::env::var_os("GDK_BACKEND").is_none() {
            if let Some(preference) =
                geometry::linux_backend_preference(std::env::var("DISPLAY").ok().as_deref(), None)
            {
                std::env::set_var("GDK_BACKEND", preference);
            }
        }
        let builder=tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app,_,_|show(app)))
            .plugin(tauri_plugin_clipboard_manager::init())
            .on_permission_request(|_,_|tauri::webview::PermissionResponse::Deny)
            .on_window_event(|window,event|{
                if window.label()!="main"{return;}
                let app=window.app_handle();let Some(backend)=app.try_state::<Backend>()else{return;};
                match event {
                    WindowEvent::CloseRequested{api,..}=>{if !backend.core().lifecycle.quitting{api.prevent_close();hide_window(app);}},
                    WindowEvent::Focused(focused)=>{
                        let (generation,wait)={let mut core=backend.core();core.blur_generation=core.blur_generation.wrapping_add(1);if *focused {core.portal_dialog_open=false;core.portal_focus_deadline=None;}else if core.portal_request_busy||core.portal_focus_deadline.is_some_and(|deadline|Instant::now()<deadline){core.portal_dialog_open=true;core.portal_focus_deadline=None;}(core.blur_generation,Duration::from_millis(300).saturating_sub(core.shown_at.elapsed()))};
                        if !focused {let handle=app.clone();thread::spawn(move||{thread::sleep(wait);let ui=handle.clone();let _=handle.run_on_main_thread(move||{
                            let current={let backend=ui.state::<Backend>();let core=backend.core();core.visible&&!core.portal_dialog_open&&!core.portal_request_busy&&core.blur_generation==generation};
                            if current&&ui.get_webview_window("main").is_some_and(|w|!w.is_focused().unwrap_or(true)){hide_now(&ui);}
                        });});}
                    },
                    WindowEvent::ScaleFactorChanged{..}|WindowEvent::Resized(_)|WindowEvent::Moved(_)=>{schedule_placement_check(app);},
                    _=>(),
                }
            })
            .setup(|app|{
                let synthetic=synthetic_mode();
                let test_directory=if synthetic{Some(tempfile::Builder::new().prefix("pupa-test-").tempdir()?)}else{None};
                let directory=match &test_directory{Some(temp)=>temp.path().to_path_buf(),None=>app.path().app_data_dir()?};
                let storage=Storage::new(directory);let first_run=!storage.settings_path.exists();let loaded=storage.load();
                #[cfg(feature="smoke-test")]
                let loaded = { let mut loaded=loaded;
                    if synthetic&&std::env::var("CI").is_ok()&&std::env::var("PUPA_ISOLATED_DESKTOP").as_deref()==Ok("1")&&std::env::var("PUPA_SMOKE_PORTAL_RESTORE").as_deref()==Ok("1") {
                        loaded.settings.system_shortcut_enabled=true;
                    }
                    loaded
                };
                let mut history=History::new(loaded.settings.history_limit);history.restore(&loaded.entries,now_ms());let mut warning=loaded.warning;
                if storage.save_settings(&loaded.settings).is_err(){warning=Some("設定を保存できませんでした。この起動中はメモリだけで動作します。".into());}
                let wayland=cfg!(target_os="linux")&&(std::env::var_os("WAYLAND_DISPLAY").is_some()||std::env::var("XDG_SESSION_TYPE").as_deref()==Ok("wayland"));
                let status=Status{shortcut_registered:false,shortcut_available:wayland,shortcut_backend:if wayland{"portal"}else{"native"},shortcut_state:if wayland{"needs-approval"}else{"unavailable"},shortcut_trigger:None,shortcut_warning:if wayland{Some(crate::shortcuts::NEEDS_APPROVAL.into())}else{None},storage_warning:warning,position_warning:None,platform:if cfg!(target_os="macos"){"darwin"}else if cfg!(target_os="windows"){"win32"}else{"linux"},wayland,version:app.package_info().version.to_string()};
                app.manage(Backend{core:Mutex::new(Core{history,settings:loaded.settings,lifecycle:CaptureLifecycle::default(),copy_dismissal:CopyDismissal::default(),placement:PlacementState::default(),status,settings_busy:false,source_busy:false,portal_dialog_open:false,portal_focus_deadline:None,portal_request_busy:false,visible:false,shown_at:Instant::now(),blur_generation:0,snapshot_revision:0}),storage,synthetic,synthetic_clipboard:Mutex::new(None),_test_directory:test_directory});
                let config=app.config().app.windows.iter().find(|w|w.label=="main").ok_or("Missing main window configuration")?;
                let dev_url=app.config().build.dev_url.clone();
                tauri::WebviewWindowBuilder::from_config(app,config)?.on_navigation(move|url|local_url(url,dev_url.as_ref()))
                    .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny).build()?;
                #[cfg(target_os="macos")] app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let handle=app.handle();let backend=handle.state::<Backend>();let shortcut=backend.core().settings.shortcut.clone();
                // X11 grabs are not compositor-wide on Wayland. Never report an
                // XWayland registration as success or use it as a portal fallback.
                let shortcut_available=!wayland&&handle.plugin(tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app,_,event|{if event.state()==ShortcutState::Pressed{toggle(app);}}).build()).is_ok();
                let shortcut_registered=shortcut_available&&shortcut_manager(handle).is_some_and(|manager|manager.register(shortcut.as_str()).is_ok());
                if !wayland {let mut core=backend.core();core.status.shortcut_available=shortcut_available;core.status.shortcut_registered=shortcut_registered;core.status.shortcut_state=if shortcut_registered{"registered"}else if shortcut_available{"error"}else{"unavailable"};core.status.shortcut_trigger=shortcut_registered.then_some(shortcut);}
                let restoring_portal=wayland&&backend.core().settings.system_shortcut_enabled;
                #[cfg(target_os="linux")]
                if wayland { setup_portal_shortcut(handle); }
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
                if !synthetic { restore_source_icons(handle); }
                if first_run||tray_result.is_err()||(!shortcut_registered&&!restoring_portal)||synthetic{show_now(handle);}
                // Work-area changes (panels, resolution, disconnected displays)
                // need not generate a window resize. Only query them while shown.
                { let handle=handle.clone();thread::spawn(move||loop {
                    thread::sleep(Duration::from_secs(1));
                    let (visible,quitting)={let backend=handle.state::<Backend>();let core=backend.core();(core.visible,core.lifecycle.quitting)};
                    if quitting{break;}if visible{schedule_placement_check(&handle);}
                }); }
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
            request_system_shortcut,
            hide,
            quit,
            smoke_set_clipboard,
            smoke_tick,
            smoke_toggle,
            smoke_state,
            smoke_geometry,
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
            request_system_shortcut,
            hide,
            quit,
            smoke_set_clipboard,
            smoke_tick,
            smoke_toggle,
            smoke_state,
            smoke_geometry
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
            request_system_shortcut,
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
                #[cfg(target_os = "linux")]
                if let Some(controller) = app.try_state::<crate::shortcuts::portal::Controller>() {
                    controller.shutdown();
                }
                if let Some(backend) = app.try_state::<Backend>() {
                    let mut core = backend.core();
                    core.lifecycle.quitting = true;
                    core.lifecycle.reconcile();
                }
                if let Some(manager) = shortcut_manager(app) {
                    let _ = manager.unregister_all();
                }
            }
            _ => (),
        });
    }
}

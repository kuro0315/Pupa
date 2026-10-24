//! Compositor-wide shortcuts. The Linux portal is deliberately independent of GTK.
//! No process is spawned, permission store edited, or permission dialog accepted.

pub const ACTION_ID: &str = "toggle-pupa";
pub const APP_ID: &str = "jp.kuro0315.pupa";
pub const NEEDS_APPROVAL: &str = "Wayland のショートカットはシステム側で設定します。「システムで設定」を押して、表示される画面で許可してください。";
pub const CLOSED: &str =
    "システムとのショートカット接続が終了しました。設定ボタンから再接続できます。";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortalStatus {
    pub state: &'static str,
    pub trigger: Option<String>,
    pub warning: Option<String>,
}

impl PortalStatus {
    pub fn new(state: &'static str, warning: Option<&str>) -> Self {
        Self {
            state,
            trigger: None,
            warning: warning.map(str::to_owned),
        }
    }

    pub fn bound(trigger: &str) -> Self {
        let trigger: String = trigger
            .chars()
            .filter(|c| !c.is_control())
            .take(256)
            .collect();
        if trigger.trim().is_empty() {
            return Self::new("needs-approval", Some("ショートカットにキーが割り当てられていません。システム設定でキーを指定してください。"));
        }
        Self {
            state: "registered",
            trigger: Some(trigger),
            warning: None,
        }
    }

    pub fn registered(&self) -> bool {
        self.state == "registered" && self.trigger.is_some()
    }
}

/// The XDG shortcut grammar is not Tauri's accelerator grammar.
pub fn preferred_trigger(shortcut: &str) -> Option<String> {
    if !crate::history::valid_shortcut(shortcut) {
        return None;
    }
    let mut pieces: Vec<_> = shortcut.split('+').collect();
    let key = pieces.pop()?.to_ascii_lowercase();
    let mut mods = Vec::new();
    for piece in pieces {
        let modifier = match piece.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "control" | "ctrl" => "CTRL",
            "command" | "super" => "LOGO",
            "alt" | "option" => "ALT",
            "shift" => "SHIFT",
            _ => return None,
        };
        if !mods.contains(&modifier) {
            mods.push(modifier);
        }
    }
    let key = if key.starts_with('f') && key.len() > 1 {
        key.to_ascii_uppercase()
    } else {
        key
    };
    Some(format!("{}+{key}", mods.join("+")))
}

#[derive(Default, Debug)]
pub struct ActivationGate {
    held: bool,
}
impl ActivationGate {
    pub fn activate(
        &mut self,
        expected: &str,
        session: &str,
        action: &str,
        registered: bool,
    ) -> bool {
        if expected != session || action != ACTION_ID || !registered || self.held {
            return false;
        }
        self.held = true;
        true
    }
    pub fn release(&mut self, expected: &str, session: &str, action: &str) {
        if expected == session && action == ACTION_ID {
            self.held = false;
        }
    }
    pub fn reset(&mut self) {
        self.held = false;
    }
}

#[cfg(all(target_os = "linux", feature = "portal"))]
pub mod portal {
    use super::*;
    use ashpd::{
        desktop::{
            global_shortcuts::{Activated, Deactivated, GlobalShortcuts, NewShortcut},
            ResponseError, Session,
        },
        zbus, Error, PortalError, WindowIdentifier,
    };
    use futures_util::StreamExt;
    use std::{
        future::{pending, Future},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::sync::{mpsc, oneshot, watch};

    const CALL_TIMEOUT: Duration = Duration::from_secs(15);
    // A bound protects against a missing provider response, not against human deliberation.
    const BIND_TIMEOUT: Duration = Duration::from_secs(300);

    pub enum Event {
        Status(PortalStatus),
        Activated(Option<String>),
        RestorePreference(bool),
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum RequestOutcome {
        Bound,
        ConfigurationOpened,
    }
    type Callback = Arc<dyn Fn(Event) + Send + Sync>;
    struct Request {
        preferred: String,
        parent: Option<u64>,
        restore: bool,
        result: oneshot::Sender<Result<RequestOutcome, String>>,
    }
    #[derive(Clone)]
    pub struct Controller {
        sender: mpsc::UnboundedSender<Request>,
        stop: watch::Sender<bool>,
        busy: Arc<AtomicBool>,
        stopped: watch::Receiver<bool>,
    }
    impl Controller {
        /// Constructing the actor does not contact D-Bus or request any permission.
        pub fn new(
            callback: impl Fn(Event) + Send + Sync + 'static,
        ) -> (Self, impl Future<Output = ()> + Send) {
            let (sender, receiver) = mpsc::unbounded_channel();
            let (stop, shutdown) = watch::channel(false);
            let busy = Arc::new(AtomicBool::new(false));
            let (finished, stopped) = watch::channel(false);
            let controller = Self {
                sender,
                stop,
                busy: busy.clone(),
                stopped,
            };
            (controller, async move {
                run(receiver, shutdown, busy, Arc::new(callback)).await;
                let _ = finished.send(true);
            })
        }
        pub async fn request(
            &self,
            preferred: String,
            parent: Option<u64>,
            restore: bool,
        ) -> Result<RequestOutcome, String> {
            if self
                .busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return Err("システムのショートカット設定を待っています。".into());
            }
            let (result, received) = oneshot::channel();
            if self
                .sender
                .send(Request {
                    preferred,
                    parent,
                    restore,
                    result,
                })
                .is_err()
            {
                self.busy.store(false, Ordering::Release);
                return Err(CLOSED.into());
            }
            // The actor owns the busy flag even if the caller closes its window.
            received.await.unwrap_or_else(|_| Err(CLOSED.into()))
        }
        pub fn shutdown(&self) {
            let _ = self.stop.send(true);
        }
        pub async fn shutdown_and_wait(&self) {
            self.shutdown();
            let mut stopped = self.stopped.clone();
            if !*stopped.borrow() {
                let _ = tokio::time::timeout(Duration::from_secs(2), stopped.changed()).await;
            }
        }
    }

    struct Live {
        proxy: GlobalShortcuts,
        session: Session<GlobalShortcuts>,
        path: String,
        events: zbus::proxy::SignalStream<'static>,
        closed: zbus::proxy::SignalStream<'static>,
        owner: zbus::proxy::OwnerChangedStream<'static>,
        gate: ActivationGate,
        status: PortalStatus,
    }
    type RawChange = (
        zbus::zvariant::OwnedObjectPath,
        Vec<(
            String,
            std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
        )>,
    );
    enum Incoming {
        Activated(Activated),
        Deactivated(Deactivated),
        Changed(RawChange),
        Closed,
    }

    async fn bounded<T>(future: impl Future<Output = Result<T, Error>>) -> Result<T, PortalStatus> {
        match tokio::time::timeout(CALL_TIMEOUT, future).await {
            Ok(result) => result.map_err(classify),
            Err(_) => Err(PortalStatus::new("unavailable", Some("システムのショートカット機能から応答がありません。トレイから開くか、後でもう一度お試しください。"))),
        }
    }
    pub fn classify(error: Error) -> PortalStatus {
        match error {
            Error::Response(ResponseError::Cancelled) | Error::Portal(PortalError::Cancelled(_)) => PortalStatus::new("cancelled", Some("ショートカットの設定は許可されなかったか、キャンセルされました。必要なときにもう一度設定できます。")),
            Error::Portal(PortalError::NotAllowed(_)) => PortalStatus::new("error", Some("システムがショートカットの設定を許可しませんでした。システムのアプリ権限を確認してください。")),
            Error::PortalNotFound(_) | Error::Zbus(_) | Error::IO(_) => PortalStatus::new("unavailable", Some("この環境のシステムショートカット機能に接続できません。トレイまたはランチャーから Pupa を開いてください。")),
            _ => PortalStatus::new("error", Some("システムのショートカット設定を完了できませんでした。トレイから開くか、設定ボタンでもう一度お試しください。")),
        }
    }

    impl Live {
        async fn connect() -> Result<Self, PortalStatus> {
            let connection =
                bounded(async { zbus::Connection::session().await.map_err(Error::from) }).await?;
            // This dedicated connection ensures registration precedes portal calls,
            // including when other libraries use portals independently.
            let id = APP_ID.parse().map_err(|_| {
                PortalStatus::new("error", Some("アプリ識別情報が正しくありません。"))
            })?;
            if let Err(error) = bounded(ashpd::register_host_app_with_connection(
                connection.clone(),
                id,
            ))
            .await
            {
                // Never impersonate another desktop application or install a launcher.
                return Err(PortalStatus::new(error.state, Some("Pupa のアプリ識別情報をシステムへ登録できませんでした。Ubuntu では deb 版をインストールしてお試しください。")));
            }
            let proxy = bounded(GlobalShortcuts::with_connection(connection.clone())).await?;
            let owner =
                bounded(async { proxy.receive_owner_changed().await.map_err(Error::from) }).await?;
            // One stream preserves press/release/change order, including bursts
            // buffered while a permission/configuration call is pending. A select
            // over per-signal streams can consume release before press.
            let events =
                bounded(async { proxy.receive_all_signals().await.map_err(Error::from) }).await?;
            let session = bounded(proxy.create_session(Default::default())).await?;
            // Session is serializable as its D-Bus object path; ashpd intentionally
            // keeps its internal proxy private.
            let path: String = serde_json::from_value(
                serde_json::to_value(&session)
                    .map_err(|_| PortalStatus::new("error", Some(CLOSED)))?,
            )
            .map_err(|_| PortalStatus::new("error", Some(CLOSED)))?;
            let session_proxy = bounded(async {
                zbus::Proxy::new_owned(
                    connection,
                    "org.freedesktop.portal.Desktop",
                    path.clone(),
                    "org.freedesktop.portal.Session",
                )
                .await
                .map_err(Error::from)
            })
            .await?;
            let closed = bounded(async {
                session_proxy
                    .receive_signal("Closed")
                    .await
                    .map_err(Error::from)
            })
            .await?;
            Ok(Self {
                proxy,
                session,
                path,
                events,
                closed,
                owner,
                gate: ActivationGate::default(),
                status: PortalStatus::new("needs-approval", Some(NEEDS_APPROVAL)),
            })
        }
        async fn bind(&mut self, preferred: &str, parent: Option<u64>) -> Result<(), PortalStatus> {
            let trigger = preferred_trigger(preferred).unwrap_or_else(|| "CTRL+SHIFT+space".into());
            let descriptors = [NewShortcut::new(ACTION_ID, "Pupa を開く / 閉じる")
                .preferred_trigger(trigger.as_str())];
            let parent = parent.map(|id| WindowIdentifier::from_xid(id as _));
            // GNOME 50 restores saved shortcuts by app/action identity during Bind.
            // Its pre-Bind ListShortcuts is empty even for saved grants, so it is
            // not a valid restoration preflight. A revoked grant may show consent
            // again; we never accept it or retry it automatically.
            let response = tokio::select! {
                _ = self.closed.next() => return Err(PortalStatus::new("closed", Some(CLOSED))),
                _ = self.owner.next() => return Err(PortalStatus::new("closed", Some(CLOSED))),
                result = tokio::time::timeout(BIND_TIMEOUT, self.proxy.bind_shortcuts(&self.session, &descriptors, parent.as_ref(), Default::default())) => result
                    .map_err(|_| PortalStatus::new("error", Some("システムの設定が完了しなかったため、接続を閉じました。もう一度設定できます。")))?
                    .map_err(classify)?.response().map_err(classify)?,
            };
            self.status = response.shortcuts().iter().find(|s| s.id() == ACTION_ID)
                .map(|s| PortalStatus::bound(s.trigger_description()))
                .unwrap_or_else(|| PortalStatus::new("cancelled", Some("Pupa のショートカットは設定されませんでした。必要なときにもう一度設定できます。")));
            if self.status.registered() {
                Ok(())
            } else {
                Err(self.status.clone())
            }
        }
        async fn configure(&mut self, parent: Option<u64>) -> Result<(), String> {
            if self.proxy.version() < 2 {
                return Err("このシステムではアプリからキー変更画面を開けません。システム設定の「アプリ」から Pupa のショートカットを変更してください。".into());
            }
            let parent = parent.map(|id| WindowIdentifier::from_xid(id as _));
            bounded(self.proxy.configure_shortcuts(
                &self.session,
                parent.as_ref(),
                Default::default(),
            ))
            .await
            .map_err(|s| s.warning.unwrap_or_else(|| CLOSED.into()))
        }
        async fn next(&mut self) -> Incoming {
            loop {
                let message = tokio::select! {
                    value = self.events.next() => match value { Some(message) => message, None => return Incoming::Closed },
                    _ = self.closed.next() => return Incoming::Closed,
                    _ = self.owner.next() => return Incoming::Closed,
                };
                let header = message.header();
                let Some(member) = header.member() else {
                    continue;
                };
                // GNOME's disabled shortcut omits trigger_description; the typed
                // ashpd Shortcut requires it and would silently drop this signal.
                let event = match member.as_str() {
                    "Activated" => message
                        .body()
                        .deserialize::<Activated>()
                        .ok()
                        .map(Incoming::Activated),
                    "Deactivated" => message
                        .body()
                        .deserialize::<Deactivated>()
                        .ok()
                        .map(Incoming::Deactivated),
                    "ShortcutsChanged" => message
                        .body()
                        .deserialize::<RawChange>()
                        .ok()
                        .map(Incoming::Changed),
                    _ => continue,
                };
                return event.unwrap_or(Incoming::Closed);
            }
        }
        async fn close(self) {
            let _ = tokio::time::timeout(Duration::from_secs(1), self.session.close()).await;
        }
    }

    async fn run(
        mut requests: mpsc::UnboundedReceiver<Request>,
        mut shutdown: watch::Receiver<bool>,
        busy: Arc<AtomicBool>,
        callback: Callback,
    ) {
        let mut live: Option<Live> = None;
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                request = requests.recv() => {
                    let Some(request) = request else { break; };
                    if let Some(active) = live.as_mut() {
                        let result = tokio::select! {
                            _ = shutdown.changed() => { let _ = request.result.send(Err(CLOSED.into())); break; },
                            result = active.configure(request.parent) => result,
                        };
                        if let Err(message) = &result { active.status.warning = Some(message.clone()); }
                        else { active.status.warning = None; }
                        callback(Event::Status(active.status.clone()));
                        busy.store(false, Ordering::Release);
                        let _ = request.result.send(result.map(|_| RequestOutcome::ConfigurationOpened));
                        continue;
                    }
                    callback(Event::Status(PortalStatus::new("requesting", Some("システムのショートカット設定を待っています。表示された画面を確認してください。"))));
                    let connected = tokio::select! {
                        _ = shutdown.changed() => { let _ = request.result.send(Err(CLOSED.into())); break; },
                        result = Live::connect() => result,
                    };
                    let outcome = match connected {
                        Ok(mut new) => {
                            let result = tokio::select! {
                                _ = shutdown.changed() => { new.close().await; let _ = request.result.send(Err(CLOSED.into())); break; },
                                result = new.bind(&request.preferred, request.parent) => result,
                            };
                            match result {
                                Ok(()) => {
                                    callback(Event::Status(new.status.clone()));
                                    if !request.restore { callback(Event::RestorePreference(true)); }
                                    live = Some(new);
                                    Ok(())
                                },
                                Err(status) => { new.close().await; Err(status) }
                            }
                        },
                        Err(status) => Err(status),
                    };
                    let result = match outcome {
                        Ok(()) => Ok(RequestOutcome::Bound),
                        Err(status) => {
                            let message = status.warning.clone().unwrap_or_else(|| CLOSED.into());
                            // An opted-in startup must not repeatedly ask after a
                            // cancelled/declined/disabled response. This only clears
                            // Pupa's preference, never changes any OS grant.
                            if matches!(status.state, "cancelled" | "error" | "needs-approval") { callback(Event::RestorePreference(false)); }
                            callback(Event::Status(status));
                            Err(message)
                        }
                    };
                    busy.store(false, Ordering::Release);
                    let _ = request.result.send(result);
                },
                event = async { match live.as_mut() { Some(active) => active.next().await, None => pending().await } } => {
                    let Some(active) = live.as_mut() else { continue; };
                    match event {
                        Incoming::Activated(event) => {
                            if active.gate.activate(&active.path, event.session_handle().as_str(), event.shortcut_id(), active.status.registered()) {
                                let token = event.options().get("activation_token").and_then(|v| v.downcast_ref::<&str>().ok()).filter(|s| s.len() <= 4096 && !s.contains('\0')).map(str::to_owned);
                                callback(Event::Activated(token));
                            }
                        },
                        Incoming::Deactivated(event) => active.gate.release(&active.path, event.session_handle().as_str(), event.shortcut_id()),
                        Incoming::Changed(event) => {
                            if event.0.as_str() == active.path {
                                let changed = event.1.iter().find(|(id, _)| id == ACTION_ID);
                                if changed.is_none() && !event.1.is_empty() { continue; }
                                active.gate.reset();
                                active.status = changed.map(|(_, info)| PortalStatus::bound(info.get("trigger_description").and_then(|v| v.downcast_ref::<&str>().ok()).unwrap_or(""))).unwrap_or_else(|| PortalStatus::new("needs-approval", Some(NEEDS_APPROVAL)));
                                callback(Event::RestorePreference(active.status.registered()));
                                callback(Event::Status(active.status.clone()));
                            }
                        },
                        Incoming::Closed => {
                            if let Some(closed) = live.take() { closed.close().await; }
                            callback(Event::Status(PortalStatus::new("closed", Some(CLOSED))));
                        }
                    }
                }
            }
        }
        if let Some(active) = live.take() {
            active.close().await;
        }
        busy.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translates_only_supported_shortcut_grammar() {
        assert_eq!(
            preferred_trigger("CommandOrControl+Shift+Space").as_deref(),
            Some("CTRL+SHIFT+space")
        );
        assert_eq!(
            preferred_trigger("Ctrl+Control+Alt+F24").as_deref(),
            Some("CTRL+ALT+F24")
        );
        assert_eq!(
            preferred_trigger("Super+Option+A").as_deref(),
            Some("LOGO+ALT+a")
        );
        for value in [
            "Space",
            "Shift+Space",
            "Ctrl+F25",
            "Ctrl+Return",
            "Ctrl+A;exec",
            "",
        ] {
            assert!(preferred_trigger(value).is_none(), "{value}");
        }
    }
    #[test]
    fn only_actual_nonempty_bindings_are_registered() {
        for state in [
            "needs-approval",
            "requesting",
            "cancelled",
            "unavailable",
            "closed",
            "error",
        ] {
            assert!(!PortalStatus::new(state, None).registered());
        }
        assert!(!PortalStatus::bound("  ").registered());
        assert!(!PortalStatus::bound("\0\n").registered());
        assert!(PortalStatus::bound("Ctrl + Shift + Space").registered());
        assert_eq!(
            PortalStatus::bound("Ctrl\nSpace").trigger.as_deref(),
            Some("CtrlSpace")
        );
        assert_eq!(
            PortalStatus::bound(&"A".repeat(500)).trigger.unwrap().len(),
            256
        );
    }
    #[test]
    fn activation_requires_correct_session_action_binding_and_release() {
        let mut gate = ActivationGate::default();
        assert!(!gate.activate("/one", "/two", ACTION_ID, true));
        assert!(!gate.activate("/one", "/one", "other", true));
        assert!(!gate.activate("/one", "/one", ACTION_ID, false));
        assert!(gate.activate("/one", "/one", ACTION_ID, true));
        assert!(!gate.activate("/one", "/one", ACTION_ID, true));
        gate.release("/one", "/two", ACTION_ID);
        assert!(!gate.activate("/one", "/one", ACTION_ID, true));
        gate.release("/one", "/one", ACTION_ID);
        assert!(gate.activate("/one", "/one", ACTION_ID, true));
        gate.reset();
        assert!(gate.activate("/one", "/one", ACTION_ID, true));
    }
    #[test]
    fn ordered_buffered_press_release_burst_does_not_lose_next_press() {
        let mut gate = ActivationGate::default();
        let mut activations = 0;
        for pressed in [true, false, true, false, true, false] {
            if pressed {
                activations += usize::from(gate.activate("/one", "/one", ACTION_ID, true));
            } else {
                gate.release("/one", "/one", ACTION_ID);
            }
        }
        assert_eq!(activations, 3);
    }
    #[test]
    fn portal_opt_in_is_private_by_default_and_round_trips_locally() {
        let temp = tempfile::tempdir().unwrap();
        let storage = crate::storage::Storage::new(temp.path().to_path_buf());
        let mut settings = crate::history::Settings::default();
        assert!(!settings.system_shortcut_enabled);
        assert!(
            !settings
                .patched(&serde_json::json!({"shortcut":"Ctrl+Space"}))
                .unwrap()
                .system_shortcut_enabled
        );
        assert!(settings
            .patched(&serde_json::json!({"systemShortcutEnabled":"true"}))
            .is_err());
        settings.system_shortcut_enabled = true;
        storage.save_settings(&settings).unwrap();
        assert!(storage.load().settings.system_shortcut_enabled);
        settings.system_shortcut_enabled = false;
        storage.save_settings(&settings).unwrap();
        assert!(!storage.load().settings.system_shortcut_enabled);
    }
    #[cfg(all(target_os = "linux", feature = "portal"))]
    #[tokio::test(flavor = "current_thread")]
    async fn repeated_requests_are_rejected_without_starting_a_second_actor_request() {
        let (controller, worker) =
            portal::Controller::new(|_| panic!("No actor may run in this unit test"));
        // Never poll the worker: this test cannot connect to a real session bus.
        let caller = controller.clone();
        let first =
            tokio::spawn(async move { caller.request("Ctrl+Space".into(), None, false).await });
        tokio::task::yield_now().await;
        assert!(controller
            .request("Ctrl+Space".into(), None, false)
            .await
            .unwrap_err()
            .contains("待っています"));
        drop(worker);
        assert!(first.await.unwrap().is_err());
    }
    #[cfg(all(target_os = "linux", feature = "portal"))]
    #[test]
    fn portal_failures_are_not_success_or_silent_fallback() {
        use ashpd::{desktop::ResponseError, Error, PortalError};
        assert_eq!(
            portal::classify(Error::Response(ResponseError::Cancelled)).state,
            "cancelled"
        );
        assert_eq!(
            portal::classify(Error::Response(ResponseError::Other)).state,
            "error"
        );
        assert_eq!(
            portal::classify(Error::Portal(PortalError::NotAllowed("denied".into()))).state,
            "error"
        );
        assert_eq!(portal::classify(Error::NoResponse).state, "error");
    }
}

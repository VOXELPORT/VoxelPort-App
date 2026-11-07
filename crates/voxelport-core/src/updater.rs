//! The auto-update behaviour of the app, separate from how an update is found and installed. Ported from `updater.js`.
//!
//! An update downloads in the background, but applying it (quitting and relaunching into the new version) is never automatic: it always
//! takes an explicit call to [`Updater::install`], so the caller can first check "is a server running / is the tunnel public right now"
//! and ask before disrupting either.
//!
//! How an update is found, verified and run is a [`Backend`] (in the app: Tauri's updater, which checks a minisign signature against a
//! public key built into the app). This module is the state machine around it: it checks shortly after start and then every four hours,
//! shares one check between presses of the "Check for updates" button and the background check, reports what happened, and remembers a
//! downloaded update until it is installed.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// How an update is found and applied.
pub trait Backend: Send + Sync + 'static {
    /// The version of a newer release, or `None` when this is the newest.
    fn check(&self) -> BoxFut<Result<Option<String>, String>>;
    /// Downloads and verifies the release the last `check` found. `on_progress` gets whole percents.
    fn download(&self, on_progress: Arc<dyn Fn(u8) + Send + Sync>) -> BoxFut<Result<(), String>>;
    /// Runs the downloaded update (which ends this app). Only called after a successful `download`.
    fn install(&self) -> Result<(), String>;
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Checking,
    Available(String),
    NotAvailable,
    Progress(u8),
    Downloaded(String),
    Error(String),
}

/// What the "Check for updates" button learns.
#[derive(Clone, Debug, PartialEq)]
pub struct CheckResult {
    /// `unsupported` (this build cannot update itself), `up-to-date`, `available` (it is downloading), `downloaded` (ready to install)
    /// or `error`.
    pub status: &'static str,
    pub version: Option<String>,
    pub reason: Option<&'static str>,
}

impl CheckResult {
    fn plain(status: &'static str) -> Self {
        Self { status, version: None, reason: None }
    }
    fn with_version(status: &'static str, version: String) -> Self {
        Self { status, version: Some(version), reason: None }
    }
    pub fn to_json(&self) -> Value {
        let mut v = json!({ "status": self.status });
        if let Some(version) = &self.version {
            v["version"] = json!(version);
        }
        if let Some(reason) = self.reason {
            v["reason"] = json!(reason);
        }
        v
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Phase {
    Idle,
    Checking,
    Downloading(String),
    Ready(String),
}

struct Inner {
    phase: Phase,
    timer: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct Updater {
    backend: Option<Arc<dyn Backend>>,
    /// Why this build cannot update itself: `store`, `dev`, `platform` or `not-configured`.
    unsupported: Option<&'static str>,
    emit: Arc<dyn Fn(Event) + Send + Sync>,
    events: broadcast::Sender<Event>,
    inner: Arc<Mutex<Inner>>,
}

impl Updater {
    /// `backend` is `None` exactly when `unsupported` is `Some`.
    pub fn new(backend: Option<Arc<dyn Backend>>, unsupported: Option<&'static str>, emit: impl Fn(Event) + Send + Sync + 'static) -> Self {
        let unsupported = if backend.is_none() { Some(unsupported.unwrap_or("dev")) } else { None };
        Self { backend, unsupported, emit: Arc::new(emit), events: broadcast::channel(64).0, inner: Arc::new(Mutex::new(Inner { phase: Phase::Idle, timer: None })) }
    }

    pub fn unsupported(&self) -> Option<&'static str> {
        self.unsupported
    }

    pub fn ready_to_install(&self) -> bool {
        matches!(self.inner.lock().unwrap().phase, Phase::Ready(_))
    }

    fn publish(&self, event: Event) {
        (self.emit)(event.clone());
        let _ = self.events.send(event);
    }

    /// Checks shortly after start (let the window finish loading first), then now and then: an update published while the app is open
    /// should still surface within a reasonable time, not only on the next launch. Does nothing where updating is not supported.
    pub fn start(&self, first_after: Duration, every: Duration) {
        if self.backend.is_none() {
            return;
        }
        let me = self.clone();
        let mut next = tokio::time::Instant::now() + first_after; // measured from now, not from whenever the task first runs
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep_until(next).await;
                me.check().await;
                next = tokio::time::Instant::now() + every;
            }
        });
        self.inner.lock().unwrap().timer = Some(task);
    }

    pub fn stop(&self) {
        if let Some(t) = self.inner.lock().unwrap().timer.take() {
            t.abort();
        }
    }

    /// Moves Idle to Checking. False when a check is already running or an update is already waiting to be installed.
    fn begin(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.phase == Phase::Idle {
            inner.phase = Phase::Checking;
            true
        } else {
            false
        }
    }

    fn set(&self, phase: Phase) {
        self.inner.lock().unwrap().phase = phase;
    }

    /// A background check: looks, and downloads what it finds. Failures are reported as events and never stop the next check.
    pub async fn check(&self) {
        if self.begin() {
            self.drive().await;
        }
    }

    /// The check itself, once `begin` has said it is ours.
    async fn drive(&self) {
        let Some(backend) = self.backend.clone() else { return self.set(Phase::Idle) };
        self.publish(Event::Checking);
        match backend.check().await {
            Err(e) => {
                self.set(Phase::Idle);
                self.publish(Event::Error(e));
            }
            Ok(None) => {
                self.set(Phase::Idle);
                self.publish(Event::NotAvailable);
            }
            Ok(Some(version)) => {
                self.set(Phase::Downloading(version.clone()));
                self.publish(Event::Available(version.clone()));
                let me = self.clone();
                let progress: Arc<dyn Fn(u8) + Send + Sync> = Arc::new(move |p| me.publish(Event::Progress(p)));
                match backend.download(progress).await {
                    Ok(()) => {
                        self.set(Phase::Ready(version.clone()));
                        self.publish(Event::Downloaded(version));
                    }
                    Err(e) => {
                        self.set(Phase::Idle);
                        self.publish(Event::Error(e));
                    }
                }
            }
        }
    }

    /// The "Check for updates" button: looks now and says what it found, instead of staying silent like the background checks. Never
    /// fails. Presses made while a check is already running share it, and it answers `available` as soon as an update is found (it
    /// keeps downloading), not when the download ends.
    pub async fn check_now(&self, timeout: Duration) -> CheckResult {
        if let Some(reason) = self.unsupported {
            return CheckResult { status: "unsupported", version: None, reason: Some(reason) };
        }
        let (mut rx, ours) = {
            let inner = self.inner.lock().unwrap();
            match &inner.phase {
                Phase::Ready(v) => return CheckResult::with_version("downloaded", v.clone()),
                Phase::Downloading(v) => return CheckResult::with_version("available", v.clone()),
                _ => {}
            }
            let rx = self.events.subscribe(); // before anything can be published, so no answer is missed
            drop(inner);
            (rx, self.begin())
        };
        if ours {
            let me = self.clone();
            tokio::spawn(async move { me.drive().await });
        }
        let wait = async {
            loop {
                match rx.recv().await {
                    Ok(Event::NotAvailable) => return CheckResult::plain("up-to-date"),
                    Ok(Event::Available(v)) => return CheckResult::with_version("available", v),
                    Ok(Event::Downloaded(v)) => return CheckResult::with_version("downloaded", v),
                    Ok(Event::Error(_)) | Err(broadcast::error::RecvError::Closed) => return CheckResult::plain("error"),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                }
            }
        };
        tokio::time::timeout(timeout, wait).await.unwrap_or_else(|_| CheckResult::plain("error"))
    }

    /// Applies a downloaded update (which ends this app). `Ok(false)` when none is ready.
    pub fn install(&self) -> Result<bool, String> {
        let Some(backend) = &self.backend else { return Ok(false) };
        if !self.ready_to_install() {
            return Ok(false);
        }
        backend.install()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A scripted release server.
    struct Fake {
        checks: AtomicU32,
        downloads: AtomicU32,
        installs: AtomicU32,
        found: Mutex<Result<Option<String>, String>>,
        check_delay: Mutex<Duration>,
        download_delay: Mutex<Duration>,
        download_error: Mutex<Option<String>>,
    }

    impl Fake {
        fn new(found: Result<Option<String>, String>) -> Arc<Self> {
            Arc::new(Self { checks: AtomicU32::new(0), downloads: AtomicU32::new(0), installs: AtomicU32::new(0), found: Mutex::new(found), check_delay: Mutex::new(Duration::ZERO), download_delay: Mutex::new(Duration::ZERO), download_error: Mutex::new(None) })
        }
    }

    impl Backend for Fake {
        fn check(&self) -> BoxFut<Result<Option<String>, String>> {
            self.checks.fetch_add(1, Ordering::SeqCst);
            let (found, delay) = (self.found.lock().unwrap().clone(), *self.check_delay.lock().unwrap());
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                found
            })
        }
        fn download(&self, on_progress: Arc<dyn Fn(u8) + Send + Sync>) -> BoxFut<Result<(), String>> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            let (delay, error) = (*self.download_delay.lock().unwrap(), self.download_error.lock().unwrap().clone());
            Box::pin(async move {
                on_progress(40);
                tokio::time::sleep(delay).await;
                match error {
                    Some(e) => Err(e),
                    None => {
                        on_progress(100);
                        Ok(())
                    }
                }
            })
        }
        fn install(&self) -> Result<(), String> {
            self.installs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn updater(fake: &Arc<Fake>) -> (Updater, Arc<Mutex<Vec<Event>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        (Updater::new(Some(fake.clone()), None, move |e| s2.lock().unwrap().push(e)), seen)
    }

    async fn pass(secs: u64) {
        tokio::time::advance(Duration::from_secs(secs)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    const T: Duration = Duration::from_secs(30);

    #[tokio::test(start_paused = true)]
    async fn nothing_newer_is_reported_as_up_to_date() {
        let fake = Fake::new(Ok(None));
        let (u, seen) = updater(&fake);
        assert_eq!(u.check_now(T).await, CheckResult::plain("up-to-date"));
        assert_eq!(*seen.lock().unwrap(), [Event::Checking, Event::NotAvailable]);
        assert!(!u.ready_to_install());
        assert_eq!(u.install(), Ok(false), "nothing to install");
        assert_eq!(fake.installs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_found_update_downloads_in_the_background_and_waits_to_be_installed() {
        let fake = Fake::new(Ok(Some("1.5.0".into())));
        let (u, seen) = updater(&fake);
        u.check().await;
        assert_eq!(*seen.lock().unwrap(), [Event::Checking, Event::Available("1.5.0".into()), Event::Progress(40), Event::Progress(100), Event::Downloaded("1.5.0".into())]);
        assert!(u.ready_to_install());
        assert_eq!(u.check_now(T).await, CheckResult::with_version("downloaded", "1.5.0".into()));
        assert_eq!((fake.checks.load(Ordering::SeqCst), fake.downloads.load(Ordering::SeqCst)), (1, 1), "a ready update is not looked for again");
        assert_eq!(u.install(), Ok(true));
        assert_eq!(fake.installs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn the_button_answers_available_as_soon_as_one_is_found_while_it_keeps_downloading() {
        let fake = Fake::new(Ok(Some("2.0.0".into())));
        *fake.download_delay.lock().unwrap() = Duration::from_secs(60);
        let (u, _) = updater(&fake);
        let answer = u.check_now(T).await;
        assert_eq!(answer, CheckResult::with_version("available", "2.0.0".into()));
        assert!(!u.ready_to_install(), "still downloading");
        assert_eq!(u.check_now(T).await, CheckResult::with_version("available", "2.0.0".into()), "a second press while it downloads says the same");
        pass(61).await;
        assert!(u.ready_to_install());
        assert_eq!(fake.checks.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn presses_made_during_one_check_share_it() {
        let fake = Fake::new(Ok(None));
        *fake.check_delay.lock().unwrap() = Duration::from_secs(5);
        let (u, seen) = updater(&fake);
        let (a, b, c) = tokio::join!(u.check_now(T), u.check_now(T), u.check_now(T));
        assert_eq!((a, b, c), (CheckResult::plain("up-to-date"), CheckResult::plain("up-to-date"), CheckResult::plain("up-to-date")));
        assert_eq!(fake.checks.load(Ordering::SeqCst), 1, "one look for all three");
        assert_eq!(seen.lock().unwrap().iter().filter(|e| **e == Event::Checking).count(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_background_check_in_flight_is_joined_by_the_button() {
        let fake = Fake::new(Ok(None));
        *fake.check_delay.lock().unwrap() = Duration::from_secs(5);
        let (u, _) = updater(&fake);
        let background = u.clone();
        let task = tokio::spawn(async move { background.check().await });
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
        assert_eq!(u.check_now(T).await, CheckResult::plain("up-to-date"));
        task.await.unwrap();
        assert_eq!(fake.checks.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_is_reported_and_the_next_check_tries_again() {
        let fake = Fake::new(Err("the update server did not answer".into()));
        let (u, seen) = updater(&fake);
        assert_eq!(u.check_now(T).await, CheckResult::plain("error"));
        assert!(seen.lock().unwrap().contains(&Event::Error("the update server did not answer".into())));
        *fake.found.lock().unwrap() = Ok(Some("1.6.0".into()));
        assert_eq!(u.check_now(T).await.status, "available");
        assert_eq!(fake.checks.load(Ordering::SeqCst), 2);

        let broken = Fake::new(Ok(Some("1.7.0".into())));
        *broken.download_error.lock().unwrap() = Some("signature did not match".into());
        let (u2, seen2) = updater(&broken);
        u2.check().await;
        assert!(!u2.ready_to_install(), "an update that failed to verify is never offered");
        assert_eq!(seen2.lock().unwrap().last(), Some(&Event::Error("signature did not match".into())));
        *broken.download_error.lock().unwrap() = None;
        u2.check().await;
        assert!(u2.ready_to_install(), "and the next check can still succeed");
    }

    #[tokio::test(start_paused = true)]
    async fn a_check_that_never_answers_gives_up_after_the_time_limit() {
        let fake = Fake::new(Ok(None));
        *fake.check_delay.lock().unwrap() = Duration::from_secs(3600);
        let (u, _) = updater(&fake);
        let started = tokio::time::Instant::now();
        assert_eq!(u.check_now(T).await, CheckResult::plain("error"));
        assert!(started.elapsed() >= T && started.elapsed() < Duration::from_secs(40));
    }

    #[tokio::test(start_paused = true)]
    async fn a_build_that_cannot_update_itself_says_why_and_does_nothing() {
        for reason in ["store", "dev", "platform", "not-configured"] {
            let u = Updater::new(None, Some(reason), |_| {});
            assert_eq!(u.check_now(T).await.to_json(), json!({ "status": "unsupported", "reason": reason }));
            u.start(Duration::from_secs(1), Duration::from_secs(1));
            pass(10).await;
            assert!(!u.ready_to_install());
            assert_eq!(u.install(), Ok(false));
            assert_eq!(u.unsupported(), Some(reason));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn it_checks_shortly_after_start_and_then_every_few_hours() {
        let fake = Fake::new(Ok(None));
        let (u, _) = updater(&fake);
        u.start(Duration::from_secs(10), Duration::from_secs(4 * 3600));
        pass(5).await;
        assert_eq!(fake.checks.load(Ordering::SeqCst), 0, "not at once: the window is still loading");
        pass(6).await;
        assert_eq!(fake.checks.load(Ordering::SeqCst), 1);
        pass(4 * 3600).await;
        assert_eq!(fake.checks.load(Ordering::SeqCst), 2);
        u.stop();
        pass(10 * 3600).await;
        assert_eq!(fake.checks.load(Ordering::SeqCst), 2, "stopped");
    }

    #[test]
    fn the_button_gets_the_answer_in_the_words_the_screen_knows() {
        assert_eq!(CheckResult::plain("up-to-date").to_json(), json!({ "status": "up-to-date" }));
        assert_eq!(CheckResult::with_version("downloaded", "1.2.3".into()).to_json(), json!({ "status": "downloaded", "version": "1.2.3" }));
    }
}

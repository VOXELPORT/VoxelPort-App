//! Updating the app: the shell's side of the `update:*` channels. The behaviour (check shortly after start and every four hours, share one
//! check between the button and the background, download but never install by itself) is `voxelport_core::updater`; how an update is
//! found, verified and run is Tauri's updater, which checks a minisign signature against a public key built into the app.
//!
//! What this build can do is decided once:
//! - the Microsoft Store delivers updates there (and an in-app updater is not allowed), so a packaged build says `store`;
//! - a development build says `dev` unless it is pointed at a test server (`VOXELPORT_UPDATE_URL` and `VOXELPORT_UPDATE_PUBKEY`);
//! - anything but Windows says `platform` (only the Windows installer is built);
//! - a build with no signing key says `not-configured`, because an update that cannot be verified is never installed.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;
use tauri_plugin_updater::{Update, UpdaterExt};
use voxelport_core::updater::{Backend, BoxFut, Event, Updater};

use crate::discord::say;
use crate::{dialogs, insights, AppState};

/// The public half of the key that release builds are signed with (`tauri signer generate`). While it is empty, release builds report
/// `not-configured` and never install anything. The private half lives only with whoever signs releases (see BUILD_INSTRUCTIONS.md).
pub const UPDATE_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc3ODMwQzAwNzE0MDhENzUKUldSMWpVQnhBQXlEZDN4bmpCVW1nKzJmMHU3bzgzNmdYZFRabk9vQzRsL0pQWVFtMzdvZitpdjEK";
/// Where the update manifest (`latest.json`) is published: the latest release of the app's GitHub repository.
const UPDATE_ENDPOINT: &str = "https://github.com/VOXELPORT/VoxelPort-App/releases/latest/download/latest.json";
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
const CHECK_NOW_LIMIT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_WAIT: Duration = Duration::from_secs(30);

struct Shared {
    app: tauri::AppHandle,
    endpoint: String,
    pubkey: String,
    found: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

struct TauriBackend(Arc<Shared>);

impl Backend for TauriBackend {
    fn check(&self) -> BoxFut<Result<Option<String>, String>> {
        let s = self.0.clone();
        Box::pin(async move {
            let url = url::Url::parse(&s.endpoint).map_err(|e| e.to_string())?;
            let updater = s.app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?.pubkey(s.pubkey.clone()).timeout(REQUEST_TIMEOUT).build().map_err(|e| e.to_string())?;
            match updater.check().await.map_err(|e| e.to_string())? {
                Some(update) => {
                    let version = update.version.clone();
                    *s.found.lock().unwrap() = Some(update);
                    *s.bytes.lock().unwrap() = None;
                    Ok(Some(version))
                }
                None => {
                    *s.found.lock().unwrap() = None;
                    Ok(None)
                }
            }
        })
    }

    fn download(&self, on_progress: Arc<dyn Fn(u8) + Send + Sync>) -> BoxFut<Result<(), String>> {
        let s = self.0.clone();
        Box::pin(async move {
            let update = s.found.lock().unwrap().clone().ok_or("There is no update to download.")?;
            let (mut received, mut last) = (0u64, 255u8);
            // The signature is checked inside `download`: bytes that do not match are an error, never an update.
            let bytes = update
                .download(
                    |chunk, total| {
                        received += chunk as u64;
                        if let Some(total) = total.filter(|t| *t > 0) {
                            let pct = (received * 100 / total).min(100) as u8;
                            if pct != last {
                                last = pct;
                                on_progress(pct);
                            }
                        }
                    },
                    || {},
                )
                .await
                .map_err(|e| e.to_string())?;
            *s.bytes.lock().unwrap() = Some(bytes);
            Ok(())
        })
    }

    fn install(&self) -> Result<(), String> {
        let update = self.0.found.lock().unwrap().clone().ok_or("There is no update to install.")?;
        let bytes = self.0.bytes.lock().unwrap().clone().ok_or("The update has not been downloaded.")?;
        update.install(bytes).map_err(|e| e.to_string())
    }
}

/// True when the app runs as a packaged Microsoft Store (MSIX) app, where the Store delivers updates.
fn is_store_build() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
        const APPMODEL_ERROR_NO_PACKAGE: u32 = 15700;
        let mut len = 0u32;
        // SAFETY: asks only for the length of the package name (a null buffer of length 0); nothing is written.
        let rc = unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) };
        rc != APPMODEL_ERROR_NO_PACKAGE
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// The update source. A development build can point at a local test server.
fn source() -> (String, String, bool) {
    #[cfg(debug_assertions)]
    if let (Ok(url), Ok(key)) = (std::env::var("VOXELPORT_UPDATE_URL"), std::env::var("VOXELPORT_UPDATE_PUBKEY")) {
        return (url, key, true);
    }
    (UPDATE_ENDPOINT.to_string(), UPDATE_PUBLIC_KEY.to_string(), false)
}

/// Decides what this build can do and makes the updater for it.
pub fn build(app: &tauri::AppHandle) -> Updater {
    let (endpoint, pubkey, overridden) = source();
    let unsupported = if is_store_build() {
        Some("store")
    } else if cfg!(debug_assertions) && !overridden {
        Some("dev")
    } else if !cfg!(windows) {
        Some("platform")
    } else if pubkey.trim().is_empty() {
        Some("not-configured")
    } else {
        None
    };
    let backend: Option<Arc<dyn Backend>> = unsupported.is_none().then(|| Arc::new(TauriBackend(Arc::new(Shared { app: app.clone(), endpoint, pubkey, found: Mutex::new(None), bytes: Mutex::new(None) }))) as Arc<dyn Backend>);
    let handle = app.clone();
    Updater::new(backend, unsupported, move |event| match event {
        Event::Available(v) => {
            let _ = handle.emit("update:available", v);
        }
        Event::Downloaded(v) => {
            let _ = handle.emit("update:downloaded", v);
        }
        Event::Error(m) => {
            let _ = handle.emit("update:error", m);
        }
        Event::Checking | Event::NotAvailable | Event::Progress(_) => {}
    })
}

/// Starts the background checks (inside the async runtime).
pub fn start(state: &AppState) {
    state.updater.start(FIRST_CHECK_AFTER, CHECK_EVERY);
}

pub fn update_state(state: &AppState) -> Value {
    json!({ "readyToInstall": state.updater.ready_to_install() })
}

/// The Settings "Check for updates" button. A finished download also shows the "ready to install" banner again.
pub async fn update_check(state: &AppState) -> Value {
    let result = state.updater.check_now(CHECK_NOW_LIMIT).await;
    if result.status == "downloaded" {
        if let Some(version) = &result.version {
            let _ = state.app.emit("update:downloaded", version);
        }
    }
    result.to_json()
}

/// Applying a downloaded update quits and relaunches the app. Never done silently while a server runs or the address is public:
/// the person is asked first, and the server is saved and stopped before the installer starts.
pub async fn update_install(state: &AppState) -> Value {
    if !state.updater.ready_to_install() {
        return json!({ "ok": false });
    }
    let server_running = state.server.is_running();
    if server_running || state.tunnels.any_live() {
        let title = if server_running { say(state, "A managed server is currently running.", "Ek managed server abhi chal raha hai.") } else { say(state, "The VoxelPort tunnel is currently public.", "VoxelPort tunnel abhi public hai.") };
        let detail = say(state, "Restarting to install the update will stop it. Continue?", "Update install karne ke liye restart karne se yeh band ho jayega. Aage badhein?");
        let labels = [say(state, "Cancel", "Cancel"), say(state, "Restart & Update", "Restart karo aur Update karo")];
        if !dialogs::confirm_switch(&state.app, title, detail, labels).await {
            return json!({ "ok": false, "cancelled": true });
        }
    }
    // The installer ends this app straight away, so a running server must already be saved and stopped. No "stop" backup is made.
    state.closing.store(true, std::sync::atomic::Ordering::SeqCst);
    state.updater.stop();
    state.tunnels.stop_all();
    if state.server.is_running() {
        insights::request_stop(state);
        state.server.stop().await;
        let _ = tokio::time::timeout(STOP_WAIT, async {
            while state.server.is_running() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await;
    }
    state.presence.shutdown().await;
    match state.updater.install() {
        Ok(true) => json!({ "ok": true }),
        Ok(false) => json!({ "ok": false }),
        Err(e) => {
            state.closing.store(false, std::sync::atomic::Ordering::SeqCst);
            json!({ "ok": false, "error": e })
        }
    }
}

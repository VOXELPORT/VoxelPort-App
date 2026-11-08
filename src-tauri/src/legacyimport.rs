//! Bringing the previous (Electron) app's data over: the banner's three calls. The rules and the reader of the old format are in
//! `voxelport_core::legacy_import` and are tested there; this file finds the old folder, asks nothing it should not, and updates the running app
//! when the device token changes.
//!
//! Safety rules, all of them deliberate:
//! * The banner counts what is there. To show the old app's 12-character VoxelPort ID, and to tell whether it differs from this PC's, it opens the
//!   old token **in memory only**: the token is never shown, never written anywhere else and never sent anywhere. Nothing is changed until the
//!   person presses the button.
//! * The old folder is only ever read.
//! * A **development build never looks at a real person's data**: it finds nothing unless `VOXELPORT_LEGACY_DIR` names a folder to use.
//! * The token is never shown: the screen gets counts, names and the 12-character VoxelPort ID.
//! * The device token of this PC is swapped only when no public address is running, and the file it replaces is kept beside it
//!   (`device-token.unreadable-<time>.json`), so the old state can be recovered by hand.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::Manager;
use voxelport_core::identity::{replace_token, short_id};
use voxelport_core::legacy_import::{self, TokenRead};

use crate::secrets::ChromiumKeyUnprotect;
use crate::{discord, AppState};

const MARKER: &str = "legacy-import.json";
/// The answer the previous app waits for after it started this one (see `start_handoff`).
const HANDOFF_FILE: &str = "legacy-handoff.json";
/// The command-line switch the previous app's "update to the new VoxelPort" button starts this app with.
pub const FLAG: &str = "--migrate-from-electron";
static BUSY: AtomicBool = AtomicBool::new(false);
/// True from the moment the switch was seen until the answer is written: the screen shows "bringing it over" instead of the opt-in banner.
static HANDOFF: AtomicBool = AtomicBool::new(false);

#[cfg_attr(debug_assertions, allow(dead_code))] // only the release lookup uses it
fn has_data(dir: &std::path::Path) -> bool {
    dir.join("device-token.json").is_file() || dir.join("server-profiles.json").is_file()
}

/// Where the previous app keeps its files, if it was ever used on this PC: `%APPDATA%\voxelport-app`, or the Microsoft Store copy's own view of it
/// (`%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\voxelport-app`).
pub fn legacy_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        // A development build uses only a folder it is told to (the tests' stand-in), never the real one.
        std::env::var_os("VOXELPORT_LEGACY_DIR").map(PathBuf::from).filter(|d| d.is_dir())
    }
    #[cfg(not(debug_assertions))]
    {
        let standard = std::env::var_os("APPDATA").map(|r| PathBuf::from(r).join("voxelport-app")).filter(|d| has_data(d));
        standard.or_else(|| {
            let packages = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Packages");
            std::fs::read_dir(packages).ok()?.flatten().map(|e| e.path().join("LocalCache").join("Roaming").join("voxelport-app")).find(|d| has_data(d))
        })
    }
}

fn marker_path(state: &AppState) -> PathBuf {
    state.data_dir.join(MARKER)
}

fn write_marker(state: &AppState, body: Value) {
    let _ = voxelport_core::atomic_write(&marker_path(state), body.to_string().as_bytes());
}

fn read_marker(state: &AppState) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(marker_path(state)).ok()?).ok()
}

/// What the banner shows: whether there is something worth bringing over, and what it is. Never any secret.
/// While the previous app's button is bringing the data over (`working`), and once, right after it finished (`announce`: what came), it says so instead.
pub async fn detect(state: &AppState) -> Value {
    let unavailable = json!({ "available": false });
    if HANDOFF.load(Ordering::SeqCst) {
        return json!({ "available": false, "working": true });
    }
    if let Some(mut marker) = read_marker(state) {
        if let Some(announce) = marker.as_object_mut().and_then(|m| m.remove("announce")) {
            write_marker(state, marker); // said once, then it stays quiet
            return json!({ "available": false, "announce": announce });
        }
    }
    let Some(legacy) = legacy_dir() else { return unavailable };
    if marker_path(state).exists() {
        return unavailable; // done before, or the person said not to ask again
    }
    let (data_dir, token) = (state.data_dir.clone(), state.device.lock().unwrap().token.clone());
    let summary = tokio::task::spawn_blocking(move || legacy_import::summarize(&legacy, &data_dir, &token, &ChromiumKeyUnprotect)).await.unwrap_or(Value::Null);
    let worth = summary["identity"] == "new" || summary["newServers"].as_u64().unwrap_or(0) > 0;
    if !worth {
        return unavailable;
    }
    let mut out = summary;
    out["available"] = json!(true);
    out
}

/// "Don't ask again".
pub fn dismiss(state: &AppState) -> Value {
    write_marker(state, json!({ "dismissed": true, "at": voxelport_core::profiles::iso_now() }));
    json!({ "ok": true })
}

/// The button: the device token first (only when no public address is running), then the servers, their backups and the settings.
pub async fn run(state: &AppState) -> Value {
    let fail = |e: &str| json!({ "ok": false, "error": e });
    let Some(legacy) = legacy_dir() else { return fail("The previous VoxelPort's files were not found.") };
    if BUSY.swap(true, Ordering::SeqCst) {
        return fail("Already bringing it over: one moment.");
    }
    let result = run_inner(state, legacy).await;
    BUSY.store(false, Ordering::SeqCst);
    discord::emit_state(state);
    result
}

async fn run_inner(state: &AppState, legacy: PathBuf) -> Value {
    let fail = |e: &str| json!({ "ok": false, "error": e });
    if state.tunnels.any_live() {
        return fail("Stop the public address first, then bring your data over (it changes this PC's VoxelPort ID).");
    }
    let legacy2 = legacy.clone();
    let token = tokio::task::spawn_blocking(move || legacy_import::read_token(&legacy2, &ChromiumKeyUnprotect)).await.unwrap_or(TokenRead::Unreadable);

    // The identity: this PC takes the old app's device token, so the address, custom name and supporter perks are the same ones.
    let current = state.device.lock().unwrap().token.clone();
    let (identity, carried) = match &token {
        TokenRead::Found(t) if *t == current => ("already", true),
        TokenRead::Found(t) => {
            if state.tunnels.any_live() {
                return fail("A public address started meanwhile: stop it, then try again.");
            }
            if replace_token(&state.data_dir, t, state.secrets.as_ref()).is_err() {
                return fail("Could not save the VoxelPort ID. Nothing was changed.");
            }
            {
                let mut d = state.device.lock().unwrap();
                d.token = t.clone();
                d.unreadable = false;
                d.encrypted_at_rest = state.secrets.available();
            }
            state.account.set_device_token(t);
            let app = state.app.clone();
            tauri::async_runtime::spawn(async move { discord::refresh(&app.state::<AppState>()).await });
            ("imported", true)
        }
        TokenRead::Missing => ("missing", false),
        TokenRead::Unreadable => ("unreadable", false),
    };

    let (data_dir, legacy3) = (state.data_dir.clone(), legacy.clone());
    let files = tokio::task::spawn_blocking(move || legacy_import::import_files(&legacy3, &data_dir, carried)).await.map_err(|e| e.to_string()).and_then(|r| r);
    match files {
        Ok(report) => {
            write_marker(state, json!({ "done": true, "identity": identity, "at": voxelport_core::profiles::iso_now() }));
            let vp_id = if carried { Some(short_id(&state.device.lock().unwrap().token)) } else { None };
            json!({ "ok": true, "identity": identity, "vpId": vp_id, "files": report.to_json() })
        }
        // The identity may already have come across; say so rather than hide it.
        Err(e) => json!({ "ok": false, "identity": identity, "error": format!("Some of your data could not be brought over: {e}") }),
    }
}

/// Does the command line carry the previous app's switch?
pub fn requested(args: &[String]) -> bool {
    args.iter().any(|a| a == FLAG)
}

/// The previous app's "update" button starts this app (just installed, or already open) with `--migrate-from-electron`. That is the person's yes: it brings the
/// data over at once, exactly as the banner's button does (same rules, including "not while a public address runs"), and then writes the answer to
/// `legacy-handoff.json` (`ok`, `identity`, and `error` when it failed) so the previous app knows whether it may remove itself. On success the screen
/// is also told, once, what came (`announce`, see `detect`).
pub fn start_handoff(app: &tauri::AppHandle) {
    if HANDOFF.swap(true, Ordering::SeqCst) {
        return; // already doing it (the switch can arrive twice: from the installer's own start and from the button)
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            HANDOFF.store(false, Ordering::SeqCst);
            return;
        };
        let _ = std::fs::remove_file(state.data_dir.join(HANDOFF_FILE));
        let result = run(&state).await;
        let ok = result["ok"] == true;
        let mut body = json!({ "ok": ok, "at": voxelport_core::profiles::iso_now() });
        if let Some(identity) = result.get("identity") {
            body["identity"] = identity.clone();
        }
        if let Some(error) = result.get("error") {
            body["error"] = error.clone();
        }
        if ok {
            if let Some(mut marker) = read_marker(&state) {
                marker["announce"] = result.clone();
                write_marker(&state, marker);
            }
        }
        let _ = voxelport_core::atomic_write(&state.data_dir.join(HANDOFF_FILE), body.to_string().as_bytes());
        HANDOFF.store(false, Ordering::SeqCst);
    });
}

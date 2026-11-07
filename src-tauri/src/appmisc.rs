//! The small app-level channels: the Support screen, the copy buttons, the Discord community link, and exporting an error report.
//! The rules (what support.json may say, what a report redacts) are in `voxelport-core` (`support`, `diagnostics`) and are tested
//! there; this file connects them to the screens, the clipboard, the browser and the save dialog.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::{json, Value};
use tauri::Listener;
use voxelport_core::diagnostics::{create_report, redact, ReportInput, ServerFacts};
use voxelport_core::identity::short_id;
use voxelport_core::support;

use crate::{dialogs, secrets, sys, AppState};

/// The Discord application that shows "Hosting a Paper 1.21.4 server". It is only an id; nothing secret.
pub const DISCORD_APPLICATION_ID: &str = "1506829006794657902";

/// The community invite the Electron app (v1.17.1) opens. Kept as one named constant so it is one line to change.
const COMMUNITY_INVITE: &str = "https://discord.gg/JAUfmey2fP";
/// How many recent lines the report keeps, and how much of one line.
const REPORT_LINES: usize = 160;
const REPORT_LINE_CHARS: usize = 4000;

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

// ─── Support ────────────────────────────────────────────────────────────────

/// Where support.json comes from. A development build can point at a local test server (`VOXELPORT_SUPPORT_URL=http://127.0.0.1:<port>/…`);
/// a release build always uses voxelport.in.
fn support_source() -> (voxelport_core::net::Fetcher, String) {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("VOXELPORT_SUPPORT_URL") {
        let mut policy = voxelport_core::net::HostPolicy::exact(&["127.0.0.1"]);
        policy.https_only = false;
        return (voxelport_core::net::Fetcher::new(policy, "Support", voxelport_core::mc_versions::USER_AGENT).with_timeout(std::time::Duration::from_secs(6)), url);
    }
    (support::support_fetcher(), support::SUPPORT_URL.to_string())
}

/// What the Support screen shows. Hosting links are remembered by id, so `support:open` can open only one of those.
pub async fn support_get(state: &AppState, args: &Value) -> Result<Value, String> {
    let force = args["force"] == true;
    let dir = state.data_dir.clone();
    let screen = tokio::task::spawn_blocking(move || {
        let (fetcher, url) = support_source();
        support::get_support(&dir, "desktop", &fetcher, &url, SystemTime::now(), force)
    })
    .await
    .map_err(|e| e.to_string())?;
    let hosts: HashMap<String, String> = screen["hosts"]["items"]
        .as_array()
        .map(|items| items.iter().filter_map(|h| Some((h["id"].as_str()?.to_string(), h["url"].as_str()?.to_string()))).collect())
        .unwrap_or_default();
    *state.support_hosts.lock().unwrap() = hosts;
    Ok(screen)
}

/// Opens one of a fixed set of pages, or a hosting link by id from the list validated in [`support_get`]. The page never supplies a URL.
pub fn support_open(state: &AppState, args: &Value) -> Value {
    let url = match str_arg(args, "what") {
        Some("sponsors") => Some(support::SPONSORS_URL.to_string()),
        Some("page") => Some(support::PAGE_URL.to_string()),
        Some("perks") => Some(support::PERKS_URL.to_string()),
        Some("host") => args.get("id").map(|id| id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string())).and_then(|id| state.support_hosts.lock().unwrap().get(&id).cloned()),
        _ => None,
    };
    match url.filter(|u| u.starts_with("https://")) {
        Some(u) => json!({ "ok": secrets::open_url(&u) || cfg!(debug_assertions) && std::env::var("VOXELPORT_NO_BROWSER").is_ok() }),
        None => json!({ "ok": false }),
    }
}

// ─── Copy buttons and the community link ────────────────────────────────────

/// The raw token never crosses into the page at all: copying goes straight from here to the clipboard.
pub fn token_copy(state: &AppState) -> Value {
    json!({ "ok": sys::set_clipboard(&state.device.lock().unwrap().token) })
}

pub fn supporter_id_copy(state: &AppState) -> Value {
    json!({ "ok": sys::set_clipboard(&short_id(&state.device.lock().unwrap().token)) })
}

pub fn copy_upi() -> Value {
    json!({ "ok": sys::set_clipboard(support::UPI_ID) })
}

pub fn community_discord() -> Value {
    let opened = secrets::open_url(COMMUNITY_INVITE) || cfg!(debug_assertions) && std::env::var("VOXELPORT_NO_BROWSER").is_ok();
    json!({ "ok": opened })
}

// ─── Discord presence ───────────────────────────────────────────────────────

/// Discord's own pipe. A development build never touches the real Discord (it would put a "Hosting a server" line under the developer's
/// name every time a test server runs) unless asked with `VOXELPORT_DISCORD_PIPE=system`; any other value is a pipe name to use instead
/// (`<name>-0`…), so a stand-in Discord can be tested against.
pub fn discord_connector() -> voxelport_core::presence::Connector {
    #[cfg(debug_assertions)]
    {
        match std::env::var("VOXELPORT_DISCORD_PIPE").as_deref() {
            Ok("system") => {}
            #[cfg(windows)]
            Ok(prefix) => return voxelport_core::presence::pipe_connector(prefix.to_string()),
            _ => return std::sync::Arc::new(|_| Box::pin(async { Err(std::io::Error::other("development builds do not connect to the real Discord")) })),
        }
    }
    voxelport_core::presence::system_connector()
}

fn prefs_path(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("preferences.json")
}

/// Whether to show what is being hosted on Discord: on unless the person turned it off.
pub fn presence_pref(state: &AppState) -> bool {
    std::fs::read_to_string(prefs_path(state)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map_or(true, |v| v["presence"] != false)
}

pub fn presence_get(state: &AppState) -> Value {
    json!({ "available": state.presence.available(), "enabled": presence_pref(state) })
}

pub fn presence_set(state: &AppState, args: &Value) -> Value {
    if !state.presence.available() {
        return json!({ "ok": false, "enabled": false });
    }
    let enabled = args["enabled"] == true;
    // The file also holds other preferences: change only this one.
    let mut doc = std::fs::read_to_string(prefs_path(state)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    doc["presence"] = json!(enabled);
    let _ = voxelport_core::atomic_write(&prefs_path(state), doc.to_string().as_bytes());
    state.presence.set_enabled(enabled);
    refresh_presence(state);
    json!({ "ok": true, "enabled": enabled })
}

/// Tells Discord what is running now: the active server and how many are on it, or nothing when no server runs.
pub fn refresh_presence(state: &AppState) {
    let running = state.server.status() == voxelport_core::Status::Online;
    let profile = running.then(|| state.active_profile.lock().unwrap().clone()).flatten().and_then(|id| voxelport_core::profiles::get(&state.data_dir, &id));
    state.presence.update(profile.map(|p| voxelport_core::presence::PresenceInfo {
        server_type: p["type"].as_str().unwrap_or_default().to_string(),
        version: p["version"].as_str().unwrap_or_default().to_string(),
        players: state.players.load(std::sync::atomic::Ordering::SeqCst) as usize,
    }));
}

// ─── Error report ───────────────────────────────────────────────────────────

/// What the report knows about the last server that ran.
#[derive(Clone)]
pub struct ServerNote {
    pub server_type: String,
    pub version: String,
    pub build: Option<String>,
    pub port: Option<u64>,
}

#[derive(Default)]
pub struct Diagnostics {
    lines: Mutex<VecDeque<String>>,
    server: Mutex<Option<ServerNote>>,
}

/// Starts keeping the recent output the report is made from: the server's console, the tunnel's messages, and update errors, each
/// redacted as it comes in. The event system already carries all of it, so nothing else has to call in.
pub fn watch_output(app: &tauri::AppHandle) {
    for channel in ["server:log", "tunnel:log", "tunnel:error", "update:error"] {
        let handle = app.clone();
        app.listen(channel, move |event| {
            use tauri::Manager;
            let payload: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            let text = payload.as_str().map(str::to_string).unwrap_or_else(|| payload.to_string());
            let text: String = text.chars().take(REPORT_LINE_CHARS).collect();
            let line = format!("{} [{channel}] {}", voxelport_core::profiles::iso_now(), redact(&text));
            let state = handle.state::<AppState>();
            let mut lines = state.diagnostics.lines.lock().unwrap();
            lines.push_back(line);
            while lines.len() > REPORT_LINES {
                lines.pop_front();
            }
        });
    }
}

/// A server is starting: remember what it is (the report names it), and start the output afresh unless this is the one automatic
/// restart after a Java fix (the first attempt's output is part of the story then).
pub fn note_server_start(state: &AppState, note: ServerNote, retried: bool) {
    *state.diagnostics.server.lock().unwrap() = Some(note);
    if !retried {
        state.diagnostics.lines.lock().unwrap().clear();
    }
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// The report, as text (shared by the export button and the tests).
pub fn report_text(state: &AppState) -> String {
    let lines: Vec<String> = state.diagnostics.lines.lock().unwrap().iter().cloned().collect();
    let note = state.diagnostics.server.lock().unwrap().clone();
    let created = voxelport_core::profiles::iso_now();
    let status = state.server.status().as_str();
    create_report(&ReportInput {
        version: env!("CARGO_PKG_VERSION"),
        platform: platform_name(),
        arch: arch_name(),
        server: note.as_ref().map(|n| ServerFacts { server_type: &n.server_type, version: &n.version, build: n.build.as_deref(), port: n.port }),
        status,
        lines: &lines,
        created: &created,
    })
}

/// Asks where to save the report and writes it. The screens get `{ canceled: true }` for a cancel, `{ ok: true }` when saved.
pub async fn diagnostics_export(state: &AppState) -> Value {
    let report = report_text(state);
    let name = format!("VoxelPort-errors-{}.txt", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let Some(path) = dialogs::pick_save(&state.app, "Export error report".to_string(), name, "Text report", &["txt"]).await else { return json!({ "canceled": true }) };
    match tokio::fs::write(path, report).await {
        Ok(()) => json!({ "ok": true }),
        Err(_) => json!({ "ok": false, "error": "Could not save the error report. Try another folder." }),
    }
}

//! Web control in the shell: friends press Start or Stop on the accounts site and this PC does it. The rules (the four
//! allowed actions, the console cleaner, the long poll) are in `voxelport_core::webcontrol` and tested there; this file
//! connects them to the app: the signed-in account, the server and the screens.
//!
//! It is for testers only for now: nothing here runs, and the screens show nothing, unless the app was started with
//! `VOXELPORT_WEB_CONTROL=1` in its environment or with the `--web-control` argument. A normal install never sees it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use voxelport_core::identity::short_id;
use voxelport_core::profiles;
use voxelport_core::webcontrol::{Actions, BoxFut, Link, Outcome, RemoteControl, Report};

use crate::{discord, ipc, secrets, serverconfig, AppState};

/// The page friends use (and the owner too, from a phone).
const PANEL_URL: &str = "https://web.voxelport.in";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const NOT_ON: &str = "Web control is not switched on in this build.";
const STATUSES: [&str; 5] = ["online", "starting", "stopping", "stopped", "crashed"];

/// Whether this run of the app has web control at all (testers only).
pub fn available() -> bool {
    std::env::var("VOXELPORT_WEB_CONTROL").as_deref() == Ok("1") || std::env::args().any(|a| a == "--web-control")
}

#[derive(Default)]
pub struct Control {
    running: Mutex<Option<Arc<RemoteControl>>>,
}

impl Control {
    pub fn stop(&self) {
        if let Some(rc) = self.running.lock().unwrap().take() {
            rc.stop();
        }
    }
}

fn prefs_path(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("preferences.json")
}

/// `{ enabled, profileId }` as saved. Anything unexpected reads as off.
fn saved(state: &AppState) -> (bool, Option<String>) {
    let doc = std::fs::read_to_string(prefs_path(state)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    let w = &doc["webControl"];
    let id = w["profileId"].as_str().filter(|s| !s.is_empty() && s.len() <= 80).map(String::from);
    (w["enabled"] == true && id.is_some(), id)
}

fn save(state: &AppState, enabled: bool, profile_id: Option<&str>) {
    // The file also holds other preferences: change only this one.
    let mut doc = std::fs::read_to_string(prefs_path(state)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    doc["webControl"] = json!({ "enabled": enabled, "profileId": profile_id });
    let _ = voxelport_core::atomic_write(&prefs_path(state), doc.to_string().as_bytes());
}

fn allowed(state: &AppState) -> bool {
    if !state.account.snapshot().session {
        return false;
    }
    let gate = discord::current_gate(state);
    gate.allowed && gate.banner == voxelport_core::gate::Banner::None && !gate.must_sign_in
}

fn vp_id(state: &AppState) -> String {
    let token = state.device.lock().unwrap().token.clone();
    if token.is_empty() {
        String::new()
    } else {
        short_id(&token)
    }
}

struct ShellLink(tauri::AppHandle);

impl Link for ShellLink {
    fn request(&self, method: &'static str, path: String, body: Option<Value>, timeout: Duration) -> BoxFut<'_, voxelport_core::account::ApiReply> {
        Box::pin(async move { self.0.state::<AppState>().account.request(method, &path, body, timeout).await })
    }
}

struct ShellActions(tauri::AppHandle);

impl Actions for ShellActions {
    fn run<'a>(&'a self, action: &'a str, arg: Option<&'a str>) -> BoxFut<'a, Outcome> {
        Box::pin(async move {
            let state = self.0.state::<AppState>();
            let state: &AppState = &state;
            match action {
                "start" => {
                    if state.server.is_running() {
                        return Outcome::err("The server is already running.");
                    }
                    let (_, id) = saved(state);
                    let Some(id) = id.filter(|id| profiles::get(&state.data_dir, id).is_some()) else { return Outcome::err("No server is chosen for web control in the app.") };
                    match ipc::start_profile(state, &id, false).await {
                        Ok(r) if r["ok"] == true => Outcome::ok("Starting"),
                        Ok(r) => Outcome::err(r["error"].as_str().unwrap_or("Could not start.")),
                        Err(e) => Outcome::err(&e),
                    }
                }
                "stop" => {
                    if !state.server.is_running() {
                        return Outcome::err("The server is not running.");
                    }
                    crate::insights::request_stop(state);
                    state.server.stop().await;
                    Outcome::ok("Stopping")
                }
                "restart" => match serverconfig::restart(state).await {
                    Ok(r) if r["ok"] == true => Outcome::ok("Restarting"),
                    Ok(r) => Outcome::err(r["error"].as_str().unwrap_or("Could not restart.")),
                    Err(e) => Outcome::err(&e),
                },
                "kick" => {
                    let Some(name) = arg else { return Outcome::err("Could not kick.") };
                    if !state.server.is_running() || !state.server.online_names().iter().any(|n| n == name) {
                        return Outcome::err("That player is not online.");
                    }
                    if state.server.player_action("kick", name).await {
                        Outcome::ok("Kicked")
                    } else {
                        Outcome::err("Could not kick.")
                    }
                }
                _ => Outcome::err("Not allowed"),
            }
        })
    }

    fn report(&self) -> Report {
        let state = self.0.state::<AppState>();
        let status = state.server.status().as_str();
        let logs = state.server.recent_logs();
        let skip = logs.len().saturating_sub(100);
        Report {
            status: if STATUSES.contains(&status) { status.to_string() } else { "stopped".into() },
            players: state.server.online_names(),
            lines: logs[skip..].to_vec(),
        }
    }

    fn is_allowed(&self) -> bool {
        allowed(&self.0.state::<AppState>())
    }

    fn vp_id(&self) -> String {
        vp_id(&self.0.state::<AppState>())
    }

    fn on_event(&self, action: &str, arg: Option<&str>, ok: bool) {
        let _ = self.0.emit("webcontrol:event", json!({ "action": action, "arg": arg, "ok": ok }));
    }
}

/// Starts or stops the loop to match the saved choice and the account. Called when the app starts, after every check of
/// the account, and when the person changes the switch.
pub fn sync(state: &AppState) {
    if !available() {
        return;
    }
    let (enabled, _) = saved(state);
    let mut slot = state.webcontrol.running.lock().unwrap();
    if let Some(rc) = slot.as_ref() {
        if !enabled || !rc.snapshot().running {
            rc.stop();
            *slot = None;
        }
    }
    if enabled && slot.is_none() && allowed(state) {
        let rc = RemoteControl::new(Arc::new(ShellLink(state.app.clone())), Arc::new(ShellActions(state.app.clone())));
        *slot = Some(rc.clone());
        tauri::async_runtime::spawn(rc.run());
    }
}

pub fn get(state: &AppState) -> Value {
    if !available() {
        return json!({ "available": false, "enabled": false, "profileId": null, "profiles": [], "running": false, "perk": null, "allowed": false });
    }
    let (enabled, profile_id) = saved(state);
    let list: Vec<Value> = profiles::list(&state.data_dir).iter().map(|p| json!({ "id": p["id"], "name": p["name"] })).collect();
    let snap = state.webcontrol.running.lock().unwrap().as_ref().map(|rc| rc.snapshot());
    json!({
        "available": true,
        "enabled": enabled,
        "profileId": profile_id,
        "profiles": list,
        "running": snap.map_or(false, |s| s.running),
        "perk": snap.and_then(|s| s.perk),
        "allowed": allowed(state),
    })
}

pub fn set(state: &AppState, args: &Value) -> Value {
    if !available() {
        return json!({ "ok": false, "error": NOT_ON });
    }
    let id = args["profileId"].as_str().filter(|id| profiles::get(&state.data_dir, id).is_some());
    save(state, args["enabled"] == true && id.is_some(), id);
    sync(state);
    get(state)
}

/// Invite links: made, listed and removed through the accounts service with this app's own session.
async fn invite_call(state: &AppState, method: &'static str, path: String, body: Option<Value>) -> Value {
    if !available() {
        return json!({ "ok": false, "error": NOT_ON });
    }
    if !state.account.snapshot().session || vp_id(state).is_empty() {
        return json!({ "ok": false, "error": "Sign in with Discord to use web control." });
    }
    let r = state.account.request(method, &path, body, CALL_TIMEOUT).await;
    if r.ok {
        let mut out = if r.json.is_object() { r.json } else { json!({}) };
        out["ok"] = json!(true);
        out
    } else {
        json!({ "ok": false, "error": r.json["error"].as_str().unwrap_or("Could not do that.") })
    }
}

pub async fn invite_list(state: &AppState) -> Value {
    invite_call(state, "GET", format!("/api/app/control/invites?vp={}", vp_id(state)), None).await
}

pub async fn invite_create(state: &AppState, args: &Value) -> Value {
    let label: String = args["label"].as_str().unwrap_or("").chars().take(40).collect();
    let days = args["days"].as_i64().filter(|d| [0, 1, 7, 30].contains(d)).unwrap_or(7);
    invite_call(state, "POST", "/api/app/control/invites".into(), Some(json!({ "vp": vp_id(state), "label": label, "days": days }))).await
}

pub async fn invite_remove(state: &AppState, args: &Value) -> Value {
    match args["id"].as_i64().filter(|i| *i > 0) {
        Some(id) => invite_call(state, "DELETE", format!("/api/app/control/invites/{id}?vp={}", vp_id(state)), None).await,
        None => json!({ "ok": false, "error": "Could not do that." }),
    }
}

pub fn open_dashboard() -> Value {
    if !available() {
        return json!({ "ok": false, "error": NOT_ON });
    }
    #[cfg(debug_assertions)]
    if let Ok(u) = std::env::var("VOXELPORT_WEB_URL") {
        secrets::open_url(&u);
        return json!({ "ok": true });
    }
    secrets::open_url(PANEL_URL);
    json!({ "ok": true })
}

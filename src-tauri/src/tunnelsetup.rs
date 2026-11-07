//! The shell's side of "make my server public": starting, switching and stopping the one tunnel, choosing a region, the custom address,
//! the public server-list entry, and the Bedrock address. The protocol itself is `voxelport-core::tunnel`; the rules for regions, relay
//! URLs and the Bedrock address cache are in their own core modules. Ported from the tunnel section of `main.js`.
//!
//! Also here: the relay operator's announcements said in the game chat (`notice.rs`), and Supporter Plus voice chat set up automatically
//! (`voice.rs`) from the rank and voice port the relay hands out.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;
use voxelport_core::bedrock::BedrockOptions;
use voxelport_core::bedrock_endpoint::{endpoint_ready, read_bedrock_endpoint, remember_bedrock_endpoint, Endpoint, FullEndpoint};
use voxelport_core::regions::{self, http_get_ok, measure_region, normalize_preference, pick_region, Region, DEFAULT_RELAY_URL, REGIONS};
use voxelport_core::relay_url::is_safe_relay_url;
use voxelport_core::tunnel::{StartParams, Tunnel, TunnelEvent};
use voxelport_core::{atomic_write, profiles, settings};

use crate::{dialogs, discord, ipc, AppState};

const AUTO_PICK_TTL: Duration = Duration::from_secs(10 * 60);
const STOP_WAIT: Duration = Duration::from_secs(10);
const SERVER_STOP_WAIT: Duration = Duration::from_secs(25);
const NAME_REPLY_WAIT: Duration = Duration::from_secs(30);
const LISTING_DEBOUNCE: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub struct CustomAddress {
    pub name: String,
    pub address: String,
    pub region: String,
}

/// Everything the shell remembers about the tunnel between calls.
#[derive(Default)]
pub struct TunnelState {
    tunnel: Mutex<Option<Tunnel>>,
    /// A tunnel that was let go but has not finished closing yet: a new one waits for it.
    retiring: Mutex<Option<Tunnel>>,
    region: Mutex<Option<&'static Region>>,
    public_profile: Mutex<Option<String>>,
    manual: AtomicBool,
    custom: Mutex<CustomAddress>,
    pref_region: Mutex<String>,
    auto_pick: Mutex<Option<(&'static str, Instant)>>,
    start_seq: AtomicU64,
    /// What the running server was launched advertising for Bedrock.
    bedrock_launch: Mutex<Option<(String, FullEndpoint)>>,
    pub bedrock_restarted_for: Mutex<Option<String>>,
    /// The server is being restarted on purpose to activate the Bedrock address: its tunnel stays up meanwhile.
    bedrock_restarting: AtomicBool,
    name_waiters: Mutex<Vec<oneshot::Sender<Value>>>,
    listing_pending: AtomicBool,
    /// What the voice-chat status line says (merged from what has been published so far).
    voice_state: Mutex<Value>,
    /// Servers whose voice chat was changed while they ran: they need one restart.
    voice_restart: Mutex<std::collections::HashSet<String>>,
    /// One voice set-up at a time.
    voice_lock: tokio::sync::Mutex<()>,
}

impl TunnelState {
    pub fn public_profile(&self) -> Option<String> {
        self.public_profile.lock().unwrap().clone()
    }
    pub fn manual_active(&self) -> bool {
        self.manual.load(Ordering::SeqCst)
    }
    pub fn set_bedrock_launch(&self, v: Option<(String, FullEndpoint)>) {
        *self.bedrock_launch.lock().unwrap() = v;
    }
    /// A tunnel that is connecting, online, reconnecting or still closing.
    pub fn any_live(&self) -> bool {
        self.tunnel.lock().unwrap().as_ref().is_some_and(Tunnel::is_live) || self.retiring.lock().unwrap().as_ref().is_some_and(Tunnel::is_live)
    }
    /// The window is closing: let the tunnel go too.
    pub fn stop_all(&self) {
        if let Some(t) = self.tunnel.lock().unwrap().as_ref() {
            t.stop();
        }
    }
}

fn emit(state: &AppState, channel: &str, payload: impl serde::Serialize + Clone) {
    let _ = state.app.emit(channel, payload);
}

fn broadcast_state(state: &AppState) {
    emit(state, "app:state", ipc::app_state(state));
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

// ─── Remembered settings: the custom address and the region preference ──────

fn custom_path(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("custom-address.json")
}

fn prefs_path(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("preferences.json")
}

/// Reads the saved custom address and region preference (called once at start-up).
pub fn load(state: &AppState) {
    if let Some(v) = std::fs::read_to_string(custom_path(state)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        if let (Some(name), Some(address)) = (v["name"].as_str(), v["address"].as_str()) {
            let region = if name.is_empty() { String::new() } else { v["region"].as_str().filter(|r| regions::is_region(r)).unwrap_or("in").to_string() };
            *state.tunnels.custom.lock().unwrap() = CustomAddress { name: name.into(), address: address.into(), region };
        }
    }
    let pref = std::fs::read_to_string(prefs_path(state)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["region"].as_str().map(|r| normalize_preference(r).to_string())).unwrap_or_else(|| "auto".into());
    *state.tunnels.pref_region.lock().unwrap() = pref;
}

fn save_custom(state: &AppState) {
    let c = state.tunnels.custom.lock().unwrap().clone();
    let _ = atomic_write(&custom_path(state), json!({ "name": c.name, "address": c.address, "region": c.region }).to_string().as_bytes());
}

/// The custom address as the screen should show it: hidden while the tunnel runs in a region it does not belong to (players could not
/// reach it there).
pub fn visible_custom_address(state: &AppState) -> Value {
    let c = state.tunnels.custom.lock().unwrap().clone();
    let active = *state.tunnels.region.lock().unwrap();
    if let (false, Some(active)) = (c.name.is_empty(), active) {
        if c.region != active.id {
            let label = regions::region(&c.region).map(|r| r.label).unwrap_or("another");
            return json!({ "name": "", "address": "", "elsewhere": { "address": c.address, "region": label } });
        }
    }
    json!({ "name": c.name, "address": c.address, "region": c.region })
}

pub fn region_get(state: &AppState) -> Value {
    let c = state.tunnels.custom.lock().unwrap().clone();
    json!({
        "preference": *state.tunnels.pref_region.lock().unwrap(),
        "regions": REGIONS.iter().map(|r| json!({ "id": r.id, "label": r.label })).collect::<Vec<_>>(),
        "active": state.tunnels.region.lock().unwrap().map(|r| r.id),
        "addressRegion": if c.name.is_empty() { Value::Null } else { json!(c.region) },
    })
}

pub fn region_set(state: &AppState, args: &Value) -> Value {
    let pref = normalize_preference(str_arg(args, "preference").unwrap_or("")).to_string();
    *state.tunnels.pref_region.lock().unwrap() = pref.clone();
    // The file also holds other preferences: change only this one.
    let mut doc = std::fs::read_to_string(prefs_path(state)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    doc["region"] = json!(pref);
    let _ = atomic_write(&prefs_path(state), doc.to_string().as_bytes());
    json!({ "ok": true, "preference": pref })
}

// ─── Choosing a region ──────────────────────────────────────────────────────

async fn choose_region(state: &AppState) -> &'static Region {
    let pref = state.tunnels.pref_region.lock().unwrap().clone();
    let custom = state.tunnels.custom.lock().unwrap().clone();
    if pref == "auto" && custom.name.is_empty() {
        if let Some((id, at)) = *state.tunnels.auto_pick.lock().unwrap() {
            if at.elapsed() < AUTO_PICK_TTL {
                return regions::region(id).unwrap_or(&REGIONS[0]);
            }
        }
    }
    let measuring = pref == "auto" && custom.name.is_empty() && REGIONS.len() > 1;
    if measuring {
        emit(state, "tunnel:log", "Finding the fastest VoxelPort region…");
    }
    let (p2, r2) = (pref.clone(), custom.region.clone());
    let pick = tokio::task::spawn_blocking(move || pick_region(&p2, &r2, REGIONS, &|r| measure_region(r, 3, &|u| http_get_ok(u, Duration::from_secs(4)))))
        .await
        .unwrap_or_else(|_| regions::Pick { region: &REGIONS[0], reason: "fallback", latency: vec![] });
    if pick.reason == "fastest" || pick.reason == "fallback" {
        *state.tunnels.auto_pick.lock().unwrap() = Some((pick.region.id, Instant::now()));
    }
    let ms = pick.latency.iter().map(|(id, v)| format!("{} {v} ms", regions::region(id).map(|r| r.label).unwrap_or(id))).collect::<Vec<_>>().join(", ");
    let why = match pick.reason {
        "chosen" => Some("chosen in settings".to_string()),
        "address" => Some(format!("your address {} lives there", custom.address)),
        "fastest" => Some(if ms.is_empty() { "fastest".to_string() } else { format!("fastest: {ms}") }),
        "fallback" => Some("couldn't measure, using the default".to_string()),
        _ => None, // with a single region the choice is implicit: do not log it
    };
    if let Some(why) = why {
        emit(state, "tunnel:log", format!("Region: {} ({why})", pick.region.label));
    }
    pick.region
}

/// A development build can send every tunnel to a local test relay (`VOXELPORT_RELAY_URL=ws://127.0.0.1:<port>`) while still behaving
/// as the chosen region. Compiled out of release builds.
fn relay_override() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        std::env::var("VOXELPORT_RELAY_URL").ok().filter(|u| !u.is_empty())
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

// ─── Starting, switching and stopping ───────────────────────────────────────

pub struct StartArgs {
    pub local_port: Value,
    pub relay_url: Option<String>,
    pub profile_id: Option<String>,
    pub udp_port: Option<u16>,
}

async fn wait_for_stopped(t: &Tunnel, within: Duration) {
    let _ = tokio::time::timeout(within, async {
        while t.is_live() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
}

fn is_current(state: &AppState, t: &Tunnel) -> bool {
    state.tunnels.tunnel.lock().unwrap().as_ref().is_some_and(|c| c.same(t))
}

/// Lets go of the current tunnel: stops it now, and remembers it until it has really finished closing.
fn retire(state: &AppState) {
    let old = state.tunnels.tunnel.lock().unwrap().take();
    if let Some(old) = old {
        old.stop();
        if old.is_live() {
            *state.tunnels.retiring.lock().unwrap() = Some(old);
        }
    }
}

pub async fn start_internal(state: &AppState, a: StartArgs) -> Value {
    // Joining the VoxelPort Discord is required to host publicly. Private and LAN play never reach this function.
    if !discord::current_gate(state).allowed {
        discord::emit_state(state);
        return discord::gate_refusal(state);
    }
    let port = match &a.local_port {
        Value::Number(n) => n.as_f64().filter(|f| f.fract() == 0.0 && (1.0..=65535.0).contains(f)).map(|f| f as u16),
        Value::String(s) => s.trim().parse::<u16>().ok().filter(|p| *p >= 1),
        _ => None,
    };
    let Some(port) = port else {
        emit(state, "tunnel:error", "Enter a valid local port (1–65535).");
        return json!({ "ok": false });
    };
    let resolved = a.relay_url.as_deref().map(str::trim).filter(|u| !u.is_empty()).unwrap_or(DEFAULT_RELAY_URL).to_string();
    if !is_safe_relay_url(&resolved) {
        emit(state, "tunnel:error", "Relay URL must be wss:// (plain ws:// is only allowed for localhost/private addresses).");
        return json!({ "ok": false });
    }

    let live = state.tunnels.tunnel.lock().unwrap().clone().filter(Tunnel::is_live);
    if let Some(current) = live {
        let manual = state.tunnels.manual_active();
        let public = state.tunnels.public_profile();
        let same = (a.profile_id.is_some() && public == a.profile_id) || (a.profile_id.is_none() && manual && a.profile_id.is_none());
        if !same {
            let current_label = public.as_deref().and_then(|id| profiles::get(&state.data_dir, id)).and_then(|p| p["name"].as_str().map(str::to_string)).unwrap_or_else(|| if manual { discord::say(state, "The manual tunnel", "Manual tunnel") } else { discord::say(state, "The current tunnel", "Abhi wala tunnel") });
            let target_label = a.profile_id.as_deref().and_then(|id| profiles::get(&state.data_dir, id)).and_then(|p| p["name"].as_str().map(str::to_string)).unwrap_or_else(|| discord::say(state, "the server you already run manually", "jo server tum manually chalate ho"));
            let title = discord::say(state, &format!("{current_label} is currently public."), &format!("{current_label} abhi public hai."));
            let detail = discord::say(state, &format!("Switch the VoxelPort tunnel to {target_label}?"), &format!("VoxelPort tunnel ko {target_label} par badlein?"));
            let labels = [discord::say(state, "Cancel", "Cancel"), discord::say(state, "Switch", "Badlo")];
            if !dialogs::confirm_switch(&state.app, title, detail, labels).await {
                return json!({ "ok": false, "cancelled": true });
            }
            current.stop();
            wait_for_stopped(&current, STOP_WAIT).await;
        } else {
            return json!({ "ok": true, "alreadyRunning": true });
        }
    }

    let using_default = resolved.trim_end_matches('/') == DEFAULT_RELAY_URL;
    let mut region: Option<&'static Region> = None;
    if using_default {
        let seq = state.tunnels.start_seq.fetch_add(1, Ordering::SeqCst) + 1;
        region = Some(choose_region(state).await);
        if seq != state.tunnels.start_seq.load(Ordering::SeqCst) {
            return json!({ "ok": false, "cancelled": true }); // stopped (or restarted) meanwhile
        }
        if state.tunnels.tunnel.lock().unwrap().as_ref().is_some_and(Tunnel::is_live) {
            return json!({ "ok": true, "alreadyRunning": true });
        }
    }
    let mut relay_urls: Vec<String> = match region {
        Some(r) => r.relay_urls.iter().map(|u| u.to_string()).collect(),
        None => vec![resolved.clone()],
    };
    if let Some(over) = relay_override() {
        relay_urls = vec![over];
    }
    let public_host = region.map(|r| r.public_host.to_string()).unwrap_or_else(|| url::Url::parse(&resolved).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default());
    let profile = a.profile_id.as_deref().and_then(|id| profiles::get(&state.data_dir, id));
    let mut voice_port = if region.is_some() { profile.as_ref().filter(|p| p["voice"]["enabled"] == true).and_then(|p| p["voice"]["port"].as_u64()).map(|p| p as u16) } else { None };
    // On VoxelPort's own relays a Paper or Fabric server asks the relay for a voice port, and the plugin is set up when one is assigned.
    // This is an extra: it must never keep a server from going public.
    let mut voice_auto = false;
    if let (Some(p), Some(_)) = (&profile, region) {
        match voxelport_core::voice::voice_plan(p, a.udp_port) {
            Ok(Some(plan)) => {
                voice_port = Some(plan.port);
                voice_auto = true;
            }
            Ok(None) => voice_port = None,
            Err(e) => {
                voice_port = None;
                publish_voice_state(state, json!({ "message": e }));
            }
        }
    }

    // Never leave an older tunnel behind: two of them would share this device's token and fight for it.
    let retiring = state.tunnels.retiring.lock().unwrap().clone().filter(Tunnel::is_live);
    if let Some(r) = retiring {
        wait_for_stopped(&r, STOP_WAIT).await;
    }
    let old = state.tunnels.tunnel.lock().unwrap().clone().filter(Tunnel::is_live);
    if let Some(old) = old {
        old.stop();
        wait_for_stopped(&old, STOP_WAIT).await;
    }

    let (tunnel, rx) = Tunnel::new();
    *state.tunnels.tunnel.lock().unwrap() = Some(tunnel.clone());
    *state.tunnels.region.lock().unwrap() = region;
    wire(state.app.clone(), tunnel.clone(), rx, public_host);
    emit(state, "tunnel:region", region.map(|r| json!({ "id": r.id, "label": r.label })));
    emit(state, "tunnel:name", visible_custom_address(state));
    if let Some(p) = &profile {
        tunnel.set_listing(build_listing(state, p));
    }
    *state.tunnels.public_profile.lock().unwrap() = a.profile_id.clone();
    state.tunnels.manual.store(a.profile_id.is_none(), Ordering::SeqCst);
    tunnel.start(StartParams {
        relay_urls,
        token: state.device.lock().unwrap().token.clone(),
        local_port: port,
        udp_port: a.udp_port,
        bedrock_port: a.udp_port,
        voice_port,
        voice_auto,
        client: Some(format!("desktop/{}", env!("CARGO_PKG_VERSION"))),
    });
    broadcast_state(state);
    json!({ "ok": true })
}

/// `tunnel:start`: the manual flow (a server the person runs themselves).
pub async fn tunnel_start(state: &AppState, args: &Value) -> Value {
    start_internal(state, StartArgs { local_port: args["localPort"].clone(), relay_url: str_arg(args, "relayUrl").map(str::to_string), profile_id: None, udp_port: None }).await
}

/// `server:makePublic`.
pub async fn make_public(state: &AppState, args: &Value) -> Value {
    let id = str_arg(args, "id").unwrap_or_default();
    let Some(profile) = profiles::get(&state.data_dir, id) else { return json!({ "ok": false, "error": "Server profile not found." }) };
    if state.active_profile.lock().unwrap().as_deref() != Some(id) {
        return json!({ "ok": false, "error": "Start this server before making it public." });
    }
    // The server is "active" from the moment Start is pressed, but while Java is still being installed there is no process yet.
    if !state.server.is_running() {
        return json!({ "ok": false, "error": "Wait for the server to finish starting, then make it public." });
    }
    // A deliberate make-public clears the once-per-endpoint auto-restart guard, so a fresh attempt can relaunch for Bedrock again.
    *state.tunnels.bedrock_restarted_for.lock().unwrap() = None;
    let udp = (profile["bedrock"] == true).then(|| crate::serverconfig::local_bedrock_port(&profile));
    start_internal(state, StartArgs { local_port: profile["port"].clone(), relay_url: None, profile_id: Some(id.to_string()), udp_port: udp }).await
}

pub async fn tunnel_stop(state: &AppState) -> Value {
    state.tunnels.start_seq.fetch_add(1, Ordering::SeqCst); // cancels a start that is still picking its region
    retire(state);
    *state.tunnels.public_profile.lock().unwrap() = None;
    state.tunnels.manual.store(false, Ordering::SeqCst);
    broadcast_state(state);
    json!({ "ok": true })
}

/// The server behind the public address died: the tunnel would only bridge to nothing, so it stops too.
pub fn on_server_exit(state: &AppState, exited: Option<&str>) {
    // (Electron stopped the tunnel here even for the deliberate Bedrock restart, which then left Bedrock unreachable until the person made
    // the server public again; its own message says players reconnect automatically, so the restart now keeps the tunnel.)
    let restarting = state.tunnels.bedrock_restarting.load(Ordering::SeqCst);
    if let (Some(id), Some(public), false) = (exited, state.tunnels.public_profile(), restarting) {
        if id == public {
            if let Some(t) = state.tunnels.tunnel.lock().unwrap().as_ref() {
                t.stop();
            }
        }
    }
    state.tunnels.set_bedrock_launch(None);
}

// ─── The public server list ─────────────────────────────────────────────────

/// The public server-list entry for a profile, or None if it is not opted in.
pub fn build_listing(state: &AppState, profile: &Value) -> Option<Value> {
    if profile["listing"]["enabled"] != true {
        return None;
    }
    let dir = std::path::PathBuf::from(profile["serverDir"].as_str().unwrap_or_default());
    let values = settings::read_settings(&dir);
    let desc = profile["listing"]["description"].as_str().filter(|d| !d.is_empty()).or_else(|| values["motd"].as_str().filter(|m| !m.is_empty())).unwrap_or("");
    let id = profile["id"].as_str().unwrap_or("");
    let players = if state.active_profile.lock().unwrap().as_deref() == Some(id) { state.players.load(Ordering::SeqCst) } else { 0 };
    Some(json!({
        "title": profile["name"], "description": desc, "version": profile["version"],
        "mode": settings::listing_mode(&values, profile["type"].as_str().unwrap_or("")),
        "players": players, "max_players": values["max-players"], "bedrock": profile["bedrock"] == true,
    }))
}

/// Pushes a changed listing to the running tunnel, when this profile is the public one.
pub fn refresh_listing(state: &AppState, profile: &Value) {
    if state.tunnels.public_profile().as_deref() == profile["id"].as_str() {
        if let Some(t) = state.tunnels.tunnel.lock().unwrap().as_ref() {
            t.set_listing(build_listing(state, profile));
        }
    }
}

/// A change in players is worth showing on the list, but not more often than every few seconds.
pub fn schedule_listing_update(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.tunnels.public_profile().is_none() || state.tunnels.listing_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LISTING_DEBOUNCE).await;
        let state = app.state::<AppState>();
        state.tunnels.listing_pending.store(false, Ordering::SeqCst);
        if let Some(id) = state.tunnels.public_profile() {
            if let Some(p) = profiles::get(&state.data_dir, &id) {
                refresh_listing(&state, &p);
            }
        }
    });
}

// ─── Custom address ─────────────────────────────────────────────────────────

pub fn name_get(state: &AppState) -> Value {
    visible_custom_address(state)
}

async fn await_name_reply(state: &AppState) -> oneshot::Receiver<Value> {
    let (tx, rx) = oneshot::channel();
    state.tunnels.name_waiters.lock().unwrap().push(tx);
    rx
}

async fn reply(rx: oneshot::Receiver<Value>) -> Value {
    match tokio::time::timeout(NAME_REPLY_WAIT, rx).await {
        Ok(Ok(v)) => v,
        _ => json!({ "ok": false, "error": "The relay didn't answer — try again." }),
    }
}

pub async fn name_claim(state: &AppState, args: &Value) -> Value {
    let Some(name) = str_arg(args, "name").filter(|n| n.len() <= 40) else { return json!({ "ok": false, "error": "Invalid name." }) };
    let tunnel = state.tunnels.tunnel.lock().unwrap().clone().filter(Tunnel::is_running);
    let Some(tunnel) = tunnel else { return json!({ "ok": false, "error": "Make a server public first, then pick your address." }) };
    let Some(active) = *state.tunnels.region.lock().unwrap() else { return json!({ "ok": false, "error": "Custom addresses only work on VoxelPort's own relays." }) };
    let c = state.tunnels.custom.lock().unwrap().clone();
    if !c.name.is_empty() && c.region != active.id {
        let owner = regions::region(&c.region).map(|r| r.label).unwrap_or("another");
        return json!({ "ok": false, "error": format!("You already have {} on the {owner} relay. Set the region to {owner} or Auto to use or change it.", c.address) });
    }
    let rx = await_name_reply(state).await;
    tunnel.claim_name(name);
    reply(rx).await
}

pub async fn name_release(state: &AppState) -> Value {
    let tunnel = state.tunnels.tunnel.lock().unwrap().clone().filter(Tunnel::is_running);
    let Some(tunnel) = tunnel else { return json!({ "ok": false, "error": "Make a server public first, then remove your address." }) };
    let active = *state.tunnels.region.lock().unwrap();
    if active.map_or(true, |a| state.tunnels.custom.lock().unwrap().region != a.id) {
        return json!({ "ok": false, "error": "Your address lives on another region — switch to it to remove it." });
    }
    let rx = await_name_reply(state).await;
    tunnel.release_name();
    reply(rx).await
}

fn resolve_name_waiters(state: &AppState, answer: &Value) {
    for tx in state.tunnels.name_waiters.lock().unwrap().drain(..) {
        let _ = tx.send(answer.clone());
    }
}

// ─── Voice chat ─────────────────────────────────────────────────────────────

/// Merges into the voice status line and tells the screens.
pub fn publish_voice_state(state: &AppState, patch: Value) {
    let mut current = state.tunnels.voice_state.lock().unwrap();
    if !current.is_object() {
        *current = voice_state_default();
    }
    if let (Some(base), Some(patch)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in patch {
            base.insert(k.clone(), v.clone());
        }
    }
    let snapshot = current.clone();
    drop(current);
    emit(state, "tunnel:voice", snapshot);
}

fn voice_state_default() -> Value {
    json!({ "rank": null, "message": "Make your server public to sync your supporter rank." })
}

/// `voice:state`.
pub fn voice_state(state: &AppState) -> Value {
    let current = state.tunnels.voice_state.lock().unwrap().clone();
    if current.is_object() { current } else { voice_state_default() }
}

/// The server just started: if its voice chat was changed while it ran, this start is the restart that was asked for.
pub fn voice_started(state: &AppState, id: &str) {
    if state.tunnels.voice_restart.lock().unwrap().remove(id) {
        publish_voice_state(state, json!({ "message": "Voice chat is configured automatically. Players join using your server address and the matching voice mod." }));
    }
}

/// The relay assigned (or took away) this server's public voice port. For a Supporter Plus server the voice plugin is installed if
/// needed and pointed at that address; one set-up at a time, and each step checks the tunnel is still the current one.
fn voice_assigned(app: &tauri::AppHandle, tunnel: Tunnel, host: String, port: Option<u16>) {
    let state = app.state::<AppState>();
    let Some(id) = state.tunnels.public_profile() else { return };
    let Some(port) = port else {
        if tunnel.rank().as_deref() == Some("supporter_plus") {
            publish_voice_state(&state, json!({ "message": "Automatic voice chat needs a Paper or Fabric server and an updated relay." }));
        }
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let _one_at_a_time = state.tunnels.voice_lock.lock().await;
        let current = |state: &AppState| is_current(state, &tunnel) && state.tunnels.public_profile().as_deref() == Some(id.as_str()) && tunnel.rank().as_deref() == Some("supporter_plus") && tunnel.voice_public_port() == Some(port);
        if !current(&state) {
            return;
        }
        let Some(profile) = profiles::get(&state.data_dir, &id) else { return };
        let bedrock = (profile["bedrock"] == true).then(|| crate::serverconfig::local_bedrock_port(&profile));
        let plan = match voxelport_core::voice::voice_plan(&profile, bedrock) {
            Ok(Some(plan)) => plan,
            Ok(None) => return,
            Err(e) => {
                publish_voice_state(&state, json!({ "message": format!("Voice setup could not finish: {e}. Make the server public again to retry.") }));
                return;
            }
        };
        let running = crate::serverconfig::is_running(&state, &id);
        let (worker_app, worker_profile, worker_id) = (app.clone(), profile.clone(), id.clone());
        let worker_tunnel = tunnel.clone();
        let result = tokio::task::spawn_blocking(move || {
            let (fetcher, api) = crate::serverconfig::modrinth();
            let state = worker_app.state::<AppState>();
            let still = || {
                is_current(&state, &worker_tunnel)
                    && state.tunnels.public_profile().as_deref() == Some(worker_id.as_str())
                    && worker_tunnel.rank().as_deref() == Some("supporter_plus")
                    && worker_tunnel.voice_public_port() == Some(port)
            };
            voxelport_core::voice::configure_voice(&voxelport_core::cracked::Modrinth { fetcher: &fetcher, api: &api }, &worker_profile, &plan, &host, port, running, &still)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        match result {
            Ok(Some(done)) => {
                if !current(&state) {
                    return;
                }
                let mut change = serde_json::Map::new();
                change.insert("voice".into(), json!({ "enabled": true, "plugin": done.plugin.name(), "port": done.port }));
                let _ = profiles::update(&state.data_dir, &id, &change);
                if done.changed && state.active_profile.lock().unwrap().as_deref() == Some(id.as_str()) && state.server.is_running() {
                    state.tunnels.voice_restart.lock().unwrap().insert(id.clone());
                }
                let restart = state.tunnels.voice_restart.lock().unwrap().contains(&id);
                publish_voice_state(
                    &state,
                    json!({ "message": if restart { "Voice chat is configured. Restart your server once to activate it. Players need the matching voice mod." } else { "Voice chat is configured automatically. Players join using your server address and the matching voice mod." } }),
                );
            }
            Ok(None) => {}
            Err(e) => {
                if is_current(&state, &tunnel) && state.tunnels.public_profile().as_deref() == Some(id.as_str()) {
                    publish_voice_state(&state, json!({ "message": format!("Voice setup could not finish: {e}. Make the server public again to retry.") }));
                }
            }
        }
    });
}

// ─── Events from the tunnel ─────────────────────────────────────────────────

/// Forwards one tunnel's events to the screens under the channel names they already listen to. An event from a tunnel that has been
/// replaced is dropped, so an old tunnel finishing late cannot clear a newer one's state.
fn wire(app: tauri::AppHandle, tunnel: Tunnel, mut rx: tokio::sync::mpsc::UnboundedReceiver<TunnelEvent>, public_host: String) {
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let state = app.state::<AppState>();
            let current = is_current(&state, &tunnel);
            match ev {
                TunnelEvent::Status(s) => emit(&state, "tunnel:status", s),
                TunnelEvent::Assigned { port, bedrock_port } => {
                    if !current {
                        continue;
                    }
                    let id = state.tunnels.public_profile();
                    let ready = on_assigned(&app, &state, &tunnel, id.as_deref(), &public_host, bedrock_port);
                    emit(&state, "tunnel:assigned", json!({ "port": port, "host": public_host, "bedrockPort": bedrock_port, "bedrockReady": ready }));
                }
                TunnelEvent::Rank(rank) => {
                    if !current {
                        continue;
                    }
                    let message = match rank.as_deref() {
                        Some("supporter_plus") => "Supporter Plus synced. Setting up voice chat…",
                        Some(_) => "Your supporter rank is synced. Automatic voice chat requires Supporter Plus.",
                        None => "This relay needs an update to sync your supporter rank.",
                    };
                    publish_voice_state(&state, json!({ "rank": rank, "profileId": state.tunnels.public_profile(), "message": message }));
                }
                TunnelEvent::VoiceAssigned(port) => {
                    if current {
                        voice_assigned(&app, tunnel.clone(), public_host.clone(), port);
                    }
                }
                TunnelEvent::Players(n) => emit(&state, "tunnel:players", n),
                TunnelEvent::Ping(ms) => emit(&state, "tunnel:ping", ms),
                TunnelEvent::Log(l) => emit(&state, "tunnel:log", l),
                TunnelEvent::Error(m) => emit(&state, "tunnel:error", m),
                TunnelEvent::Name { name, address } => {
                    // Only VoxelPort's own relays share the address list; ignore the rest.
                    let Some(active) = *state.tunnels.region.lock().unwrap() else { continue };
                    *state.tunnels.custom.lock().unwrap() = if name.is_empty() { CustomAddress::default() } else { CustomAddress { name: name.clone(), address: address.clone(), region: active.id.to_string() } };
                    save_custom(&state);
                    emit(&state, "tunnel:name", visible_custom_address(&state));
                    resolve_name_waiters(&state, &json!({ "ok": true, "name": name, "address": address }));
                }
                TunnelEvent::NameError(m) => {
                    emit(&state, "tunnel:nameError", m.clone());
                    resolve_name_waiters(&state, &json!({ "ok": false, "error": m }));
                }
                TunnelEvent::ListingError(m) => emit(&state, "server:log", format!("[VoxelPort] Server list: {m}")),
                TunnelEvent::Notice { message, seconds } => {
                    // Only VoxelPort's own relays may announce things; a self-hosted relay is not trusted to talk to your players.
                    if state.tunnels.region.lock().unwrap().is_some() {
                        emit(&state, "tunnel:notice", json!({ "message": message, "seconds": seconds }));
                        // The players never see the app, so it is also said in the game's chat (only for the server that is public).
                        let public = state.tunnels.public_profile();
                        if public.is_some() && public == *state.active_profile.lock().unwrap() {
                            state.notices.handle(&message, seconds);
                        }
                    }
                }
                TunnelEvent::UdpError(m) | TunnelEvent::VoiceError(m) => emit(&state, "server:log", format!("[VoxelPort] {m}")),
                TunnelEvent::Stopped => {
                    // An old tunnel finishing after a newer one took over must not clear its state.
                    let other_current = state.tunnels.tunnel.lock().unwrap().as_ref().is_some_and(|c| !c.same(&tunnel));
                    if other_current {
                        break;
                    }
                    emit(&state, "tunnel:notice", json!({ "message": "", "seconds": 0 }));
                    state.notices.cancel();
                    *state.tunnels.public_profile.lock().unwrap() = None;
                    state.tunnels.manual.store(false, Ordering::SeqCst);
                    if current || state.tunnels.tunnel.lock().unwrap().is_none() {
                        *state.tunnels.region.lock().unwrap() = None;
                        emit(&state, "tunnel:name", visible_custom_address(&state));
                    }
                    if state.tunnels.retiring.lock().unwrap().as_ref().is_some_and(|r| r.same(&tunnel)) {
                        *state.tunnels.retiring.lock().unwrap() = None;
                    }
                    broadcast_state(&state);
                    break;
                }
            }
        }
    });
}

/// The relay assigned the public ports. For Bedrock: remember the address and, the first time, restart the server once so Geyser comes
/// up advertising it (the relay only assigns the Bedrock port at make-public, after Geyser already started). Returns whether the
/// running server already advertises exactly this address.
fn on_assigned(app: &tauri::AppHandle, state: &AppState, tunnel: &Tunnel, id: Option<&str>, public_host: &str, bedrock_public: Option<u16>) -> bool {
    let (Some(id), Some(public_port), Some(local_port)) = (id, bedrock_public, tunnel.udp_port()) else { return false };
    let assigned = FullEndpoint { local_port, public_host: public_host.to_string(), public_port };
    let launch = state.tunnels.bedrock_launch.lock().unwrap().clone();
    let running_here = state.active_profile.lock().unwrap().as_deref() == Some(id) && state.server.is_running();
    let ready = running_here && launch.as_ref().is_some_and(|(pid, l)| pid == id && endpoint_ready(Some(l), Some(&assigned)));
    let token = state.device.lock().unwrap().token.clone();
    if let Err(e) = remember_bedrock_endpoint(&state.data_dir, id, &token, &Endpoint { public_host: public_host.to_string(), public_port }) {
        emit(state, "server:log", format!("[VoxelPort] Could not remember the Bedrock address: {e}"));
    }
    if !ready {
        let (app, id) = (app.clone(), id.to_string());
        tauri::async_runtime::spawn(async move { auto_restart_for_bedrock(&app, &id, &assigned).await });
    }
    ready
}

/// Relaunches a running, public Bedrock server once so Geyser comes up advertising the address the relay just assigned. Runs at most once
/// per assigned address, so a server that still does not match is not restarted in a loop. Best effort: any problem leaves the server
/// running and tells the person to restart by hand.
async fn auto_restart_for_bedrock(app: &tauri::AppHandle, id: &str, endpoint: &FullEndpoint) {
    let state = app.state::<AppState>();
    let log = |m: &str| emit(&state, "server:log", m.to_string());
    let key = format!("{id}|{}:{}", endpoint.public_host, endpoint.public_port);
    if state.tunnels.bedrock_restarted_for.lock().unwrap().as_deref() == Some(key.as_str()) {
        log("[VoxelPort] Bedrock still needs a manual restart: Stop, then Start the server once to activate its Bedrock address. Java is unaffected.");
        return;
    }
    // Only act on the server that is actually running and public right now.
    if state.active_profile.lock().unwrap().as_deref() != Some(id) || state.tunnels.public_profile().as_deref() != Some(id) || !state.server.is_running() {
        return;
    }
    *state.tunnels.bedrock_restarted_for.lock().unwrap() = Some(key);
    log("[VoxelPort] Activating the Bedrock address — restarting the server once. Java players reconnect automatically.");
    state.tunnels.bedrock_restarting.store(true, Ordering::SeqCst);
    restart_for_bedrock(&state, id).await;
    state.tunnels.bedrock_restarting.store(false, Ordering::SeqCst);
}

async fn restart_for_bedrock(state: &AppState, id: &str) {
    let log = |m: &str| emit(state, "server:log", m.to_string());
    crate::insights::request_stop(state);
    state.server.stop().await;
    let _ = tokio::time::timeout(SERVER_STOP_WAIT, async {
        while state.server.is_running() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    if state.server.is_running() {
        log("[VoxelPort] The server was slow to stop; Start it once to finish activating Bedrock.");
        return;
    }
    match ipc::start_profile(state, id, false).await {
        Ok(r) if r["ok"] == true => {}
        _ => log("[VoxelPort] Could not restart automatically; Start the server once to activate Bedrock."),
    }
}

/// What a start passes to Geyser for this profile, and what it advertises (remembered for [`on_assigned`]).
pub fn bedrock_for_start(state: &AppState, profile: &Value) -> Option<BedrockOptions> {
    if profile["bedrock"] != true {
        state.tunnels.set_bedrock_launch(None);
        return None;
    }
    let id = profile["id"].as_str().unwrap_or_default();
    let local_port = crate::serverconfig::local_bedrock_port(profile);
    let token = state.device.lock().unwrap().token.clone();
    let endpoint = read_bedrock_endpoint(&state.data_dir, id, &token);
    state.tunnels.set_bedrock_launch(endpoint.as_ref().map(|e| (id.to_string(), FullEndpoint { local_port, public_host: e.public_host.clone(), public_port: e.public_port })));
    Some(BedrockOptions { local_port, public: endpoint.map(|e| (e.public_host, e.public_port)) })
}

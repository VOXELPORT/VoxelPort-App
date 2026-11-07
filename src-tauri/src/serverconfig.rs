//! Managing an installed server: the Settings screen, friends-only (whitelist), the file browser, player accounts (cracked
//! mode), and the small fixes the app offers. The rules are in `voxelport-core` (`settings`, `whitelist`, `server_files`,
//! `cracked`) and are tested there; this file connects them to the screens and to the running server.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde_json::{json, Map, Value};
use tauri::Emitter;
use voxelport_core::bedrock::bedrock_port;
use voxelport_core::cracked::{self, Modrinth};
use voxelport_core::{profiles, server_files, server_install, settings, whitelist};

use crate::{sys, AppState};

const NOT_FOUND: &str = "Server profile not found.";
const STOP_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn profile_of(state: &AppState, args: &Value) -> Option<Value> {
    str_arg(args, "id").and_then(|id| profiles::get(&state.data_dir, id))
}

fn dir_of(profile: &Value) -> PathBuf {
    PathBuf::from(profile["serverDir"].as_str().unwrap_or_default())
}

/// Whether this profile is the one running now.
pub fn is_running(state: &AppState, id: &str) -> bool {
    state.active_profile.lock().unwrap().as_deref() == Some(id) && state.server.is_running()
}

fn bedrock_supported(server_type: &str) -> bool {
    matches!(server_type, "paper" | "fabric")
}

pub(crate) fn local_bedrock_port(profile: &Value) -> u16 {
    let java = profile["port"].as_u64().map(|p| p as u16);
    let voice = profile["voice"]["port"].as_u64().map(|p| p as u16);
    bedrock_port(&dir_of(profile), java, None, voice)
}

// ─── Settings ───────────────────────────────────────────────────────────────

pub fn settings_get(state: &AppState, args: &Value) -> Result<Value, String> {
    let profile = profile_of(state, args).ok_or(NOT_FOUND)?;
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    let listing = if profile["listing"].is_object() { profile["listing"].clone() } else { json!({ "enabled": false, "description": "" }) };
    Ok(json!({
        "profile": profile,
        "fields": settings::fields_json(),
        "values": settings::read_settings(&dir_of(&profile)),
        "bedrock": { "supported": bedrock_supported(profile["type"].as_str().unwrap_or("")), "enabled": profile["bedrock"] == true, "port": local_bedrock_port(&profile) },
        "listing": listing,
        "totalMemMb": sys::total_memory_mb().unwrap_or(8192),
        "running": is_running(state, &id),
    }))
}

fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|f| f.fract() == 0.0 && f.is_finite())
    .map(|f| f as i64)
}

pub fn settings_save(state: &AppState, args: &Value) -> Result<Value, String> {
    let profile = profile_of(state, args).ok_or(NOT_FOUND)?;
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    let mut props = settings::validate_settings(args.get("properties").filter(|p| !p.is_null()).unwrap_or(&json!({})))?;
    let mut changes = Map::new();

    if let Some(voice) = args.get("voice").filter(|v| !v.is_null()) {
        let port = int_of(&voice["port"]).filter(|p| (1..=65535).contains(p));
        let plugin = voice["plugin"].as_str().filter(|p| matches!(*p, "simple" | "plasmo"));
        let (Some(enabled), Some(plugin), Some(port)) = (voice["enabled"].as_bool(), plugin, port.filter(|_| voice["port"].is_number())) else {
            return Err("Enter a valid voice plugin and UDP port (1–65535).".into());
        };
        if enabled && profile["bedrock"] == true && port == i64::from(local_bedrock_port(&profile)) {
            return Err("Voice chat and Bedrock need different local UDP ports.".into());
        }
        changes.insert("voice".into(), json!({ "enabled": enabled, "plugin": plugin, "port": port }));
    }
    if let Some(name) = args["name"].as_str().map(str::trim).filter(|n| !n.is_empty()) {
        changes.insert("name".into(), json!(name.chars().take(60).collect::<String>()));
    }
    if let Some(p) = args.get("port").filter(|p| !p.is_null()) {
        let port = int_of(p).filter(|p| (1..=65535).contains(p)).ok_or("Enter a valid port (1–65535).")?;
        changes.insert("port".into(), json!(port));
        props.retain(|(k, _)| k != "server-port");
        props.push(("server-port".into(), port.to_string()));
    }
    if let Some(r) = args.get("ramMb").filter(|r| !r.is_null()) {
        let ram = int_of(r).filter(|r| (512..=131_072).contains(r)).ok_or("Invalid RAM amount.")?;
        changes.insert("minRamMb".into(), json!(ram));
        changes.insert("maxRamMb".into(), json!(ram));
    }
    if let Some(l) = args.get("listing").filter(|l| !l.is_null()) {
        let enabled = l["enabled"].as_bool().ok_or("Invalid server-list setting.")?;
        let description: String = l["description"].as_str().map(|d| d.chars().filter(|c| !(*c <= '\u{1f}' || *c == '\u{7f}')).collect::<String>().trim().chars().take(160).collect()).unwrap_or_default();
        changes.insert("listing".into(), json!({ "enabled": enabled, "description": description }));
    }

    let updated = profiles::update(&state.data_dir, &id, &changes)?;
    server_install::update_server_properties_safely(&dir_of(&updated), &props).map_err(|e| e.to_string())?;
    crate::tunnelsetup::refresh_listing(state, &updated); // a changed list entry reaches the public list at once
    Ok(json!({ "ok": true, "profile": updated, "restartNeeded": is_running(state, &id) }))
}

// ─── Files ──────────────────────────────────────────────────────────────────

/// Runs a file-browser call for one profile's folder; a refused path comes back as a plain message, never a stack.
pub fn with_files(state: &AppState, args: &Value, f: impl Fn(&Path) -> Result<Value, String>) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    match f(&dir_of(&profile)) {
        Ok(Value::Object(mut o)) => {
            let mut out = Map::new();
            out.insert("ok".into(), json!(true));
            out.append(&mut o);
            Value::Object(out)
        }
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

pub fn files_list(state: &AppState, args: &Value) -> Value {
    with_files(state, args, |d| server_files::list_dir(d, str_arg(args, "path").unwrap_or("")))
}
pub fn files_read(state: &AppState, args: &Value) -> Value {
    with_files(state, args, |d| server_files::read_text_file(d, str_arg(args, "path").unwrap_or("")))
}
pub fn files_write(state: &AppState, args: &Value) -> Value {
    with_files(state, args, |d| server_files::write_text_file(d, str_arg(args, "path").unwrap_or(""), &args["text"]))
}

// ─── Friends-only (whitelist) ───────────────────────────────────────────────

/// Runs a whitelist call. Commands for a live server are collected during the call and sent afterwards.
async fn whitelist_call(state: &AppState, args: &Value, f: impl Fn(&Path, bool, whitelist::Send) -> Result<Value, String>) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    let running = is_running(state, &id);
    // The collecting closure lives only inside this block, so nothing non-thread-safe is held across the awaits below.
    let (result, commands) = {
        let sent = RefCell::new(Vec::<String>::new());
        let push = |c: &str| sent.borrow_mut().push(c.to_string());
        let result = f(&dir_of(&profile), running, if running { Some(&push) } else { None });
        (result, sent.into_inner())
    };
    match result {
        Ok(mut v) => {
            for c in commands {
                state.server.send_command(&c).await;
            }
            if let Some(o) = v.as_object_mut() {
                o.insert("ok".into(), json!(true));
            }
            v
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

pub async fn whitelist_status(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    match whitelist::status(&dir_of(&profile)) {
        Ok(mut v) => {
            v["ok"] = json!(true);
            v["running"] = json!(is_running(state, &id));
            v
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}
pub async fn whitelist_add(state: &AppState, args: &Value) -> Value {
    let text = str_arg(args, "text").unwrap_or("").to_string();
    whitelist_call(state, args, |d, r, s| whitelist::add_friends(d, &text, r, s)).await
}
pub async fn whitelist_remove(state: &AppState, args: &Value) -> Value {
    let name = str_arg(args, "name").unwrap_or("").to_string();
    whitelist_call(state, args, |d, r, s| whitelist::remove_friend(d, &name, r, s)).await
}
pub async fn whitelist_set_enabled(state: &AppState, args: &Value) -> Value {
    let on = args["on"].as_bool().unwrap_or(false) || args["on"] == 1;
    whitelist_call(state, args, |d, r, s| whitelist::set_enabled(d, on, r, s)).await
}

// ─── Player accounts (cracked mode) ─────────────────────────────────────────

pub fn accounts_get(state: &AppState, args: &Value) -> Result<Value, String> {
    let profile = profile_of(state, args).ok_or(NOT_FOUND)?;
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    let dir = dir_of(&profile);
    Ok(json!({ "cracked": cracked::is_cracked(&dir), "loginPlugin": cracked::has_login_plugin(&dir), "canInstallLogin": profile["type"] == "paper", "running": is_running(state, &id) }))
}

/// The one dedicated, confirmed way to change `online-mode` (see `cracked.rs`).
pub fn accounts_set(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    let change = json!({ "cracked": args["cracked"], "confirmed": args["confirmed"] });
    match cracked::validate_accounts_change(&change).and_then(|on| cracked::set_cracked(&dir_of(&profile), on).map(|()| on)) {
        Ok(on) => json!({ "ok": true, "cracked": on, "restartNeeded": is_running(state, &id) }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// Where plugins come from. A development build can point at a local test server
/// (`VOXELPORT_MODRINTH_API=http://127.0.0.1:<port>/v2`); a release build always uses Modrinth.
pub fn modrinth() -> (voxelport_core::net::Fetcher, String) {
    #[cfg(debug_assertions)]
    if let Ok(api) = std::env::var("VOXELPORT_MODRINTH_API") {
        let mut policy = voxelport_core::net::HostPolicy::exact(&["127.0.0.1"]);
        policy.https_only = false;
        return (voxelport_core::net::Fetcher::new(policy, "Server", voxelport_core::mc_versions::USER_AGENT), api);
    }
    (voxelport_core::mc_versions::server_fetcher(), cracked::MODRINTH_API.to_string())
}

pub async fn accounts_install_login(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    if state.accounts_busy.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "error": "Already installing — one moment." });
    }
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    let (dir, ty, version) = (dir_of(&profile), profile["type"].as_str().unwrap_or("").to_string(), profile["version"].as_str().unwrap_or("").to_string());
    let app = state.app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let (f, api) = modrinth();
        cracked::install_login_plugin(&Modrinth { fetcher: &f, api: &api }, &dir, &ty, &version, &|stage, file| {
            let _ = app.emit("accounts:progress", match file { Some(file) => json!({ "stage": stage, "file": file }), None => json!({ "stage": stage }) });
        })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    state.accounts_busy.store(false, Ordering::SeqCst);
    match result {
        Ok(_) => json!({ "ok": true, "restartNeeded": is_running(state, &id) }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// ─── Small fixes ────────────────────────────────────────────────────────────

pub fn fix(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    if str_arg(args, "action") == Some("eula") {
        return match server_install::write_eula(&dir_of(&profile)) {
            Ok(()) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
    }
    json!({ "ok": false, "error": "Unknown fix." })
}

/// Stops the running server, waits for it to exit, then starts the same profile again.
pub async fn restart(state: &AppState) -> Result<Value, String> {
    let id = state.active_profile.lock().unwrap().clone();
    let Some(id) = id.filter(|_| state.server.is_running()) else { return Ok(json!({ "ok": false, "error": "The server is not running." })) };
    crate::insights::request_stop(state);
    state.server.stop().await;
    let _ = tokio::time::timeout(STOP_WAIT, async {
        while state.server.is_running() {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await;
    if state.server.is_running() {
        return Ok(json!({ "ok": false, "error": "The server is still shutting down — try again in a few seconds." }));
    }
    crate::ipc::start_profile(state, &id, false).await
}

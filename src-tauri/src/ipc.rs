//! The one command the page can call. It receives a channel name and a JSON argument, and answers with JSON.
//! The channel names are the Electron app's (see ui/tauri-bridge.js), so the screens do not change. A channel that
//! is not ported yet answers with a plain message instead of failing silently.

use serde_json::{json, Value};
use tauri::State;
use voxelport_core::{StartConfig, Status};

use crate::{catalog, profiles, sys, AppState};

/// Every channel the screens can call (generated from preload.js). Anything else is refused.
const KNOWN: &[&str] = include!("channels.in");

#[tauri::command(rename_all = "camelCase")]
pub async fn ipc(state: State<'_, AppState>, channel: String, args: Value) -> Result<Value, String> {
    if !KNOWN.contains(&channel.as_str()) {
        return Err(format!("Unknown channel: {channel}"));
    }
    dispatch(&state, &channel, args).await
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

async fn dispatch(state: &AppState, channel: &str, args: Value) -> Result<Value, String> {
    match channel {
        "app:info" => Ok(json!({
            "publicHost": "play.voxelport.in",
            "defaultRelayUrl": "wss://relay.voxelport.in",
            "maskedToken": "(not migrated yet)",
            "supporterID": "",
            "tokenEncryptedAtRest": false,
            "tokenUnreadable": false,
            "version": env!("CARGO_PKG_VERSION"),
        })),
        "app:versions" => Ok(json!({
            "app": env!("CARGO_PKG_VERSION"),
            // The About text prints "(Electron <this>)", so say what this build runs on.
            "electron": "none, this is the Tauri build",
            "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            "systemJava": Value::Null,
            "managedJava": [],
            "dataDir": state.data_dir.to_string_lossy(),
        })),
        "app:setTheme" => {
            let theme = match str_arg(&args, "theme") {
                Some(t @ ("light" | "dark" | "system")) => t,
                _ => "system",
            };
            *state.theme.lock().unwrap() = theme.to_string();
            Ok(json!({ "ok": true, "theme": theme }))
        }
        "app:setLanguage" => Ok(json!({ "ok": true })),
        "system:specs" => {
            let total = sys::total_memory_mb().unwrap_or(8192);
            Ok(json!({ "totalMemMb": total, "recommendedRamMb": sys::recommended_ram_mb(total) }))
        }
        "update:state" => Ok(json!({ "readyToInstall": false })),

        // Static lists and start-up defaults the screens read when they open.
        "server:types" => Ok(catalog::types()),
        "server:templates" => Ok(catalog::templates()),
        "region:get" => Ok(json!({ "preference": "auto", "regions": catalog::regions(), "active": Value::Null, "addressRegion": Value::Null })),
        "name:get" => Ok(json!({ "name": "", "address": "" })),
        "voice:state" => Ok(json!({ "rank": Value::Null, "message": "Make your server public to sync your supporter rank." })),
        "presence:get" => Ok(json!({ "available": false, "enabled": false })),

        "server:profiles:list" => Ok(Value::Array(profiles::list(&state.data_dir))),
        "server:profiles:get" => Ok(str_arg(&args, "id").and_then(|id| profiles::get(&state.data_dir, id)).unwrap_or(Value::Null)),
        "server:state" => Ok(app_state(state)),

        "server:start" => start_server(state, &args).await,
        "server:stop" => {
            state.server.stop().await;
            Ok(json!({ "ok": true }))
        }
        "server:command" => {
            if let Some(c) = str_arg(&args, "command") {
                state.server.send_command(c).await;
            }
            Ok(json!({ "ok": true }))
        }
        "server:playerAction" => {
            let ok = match (str_arg(&args, "action"), str_arg(&args, "name")) {
                (Some(a), Some(n)) => state.server.player_action(a, n).await,
                _ => false,
            };
            Ok(json!({ "ok": ok }))
        }
        _ => Err(format!("Not migrated to the Tauri build yet: {channel}")),
    }
}

/// Start a profile's server with the Java on the PATH. Not yet ported: the Discord join gate, managed Java
/// install, Bedrock/Geyser startup, backups-busy check. Until the gate is ported a start is refused unless this is
/// a development run that says so, so a build can never ship with the gate silently skipped.
async fn start_server(state: &AppState, args: &Value) -> Result<Value, String> {
    if std::env::var("VOXELPORT_DEV_ALLOW_START").as_deref() != Ok("1") {
        return Ok(json!({ "ok": false, "error": "Starting servers is switched off in this development build until the Discord gate is ported (set VOXELPORT_DEV_ALLOW_START=1 to test)." }));
    }
    let not_found = json!({ "ok": false, "error": "Server profile not found." });
    let Some(id) = str_arg(args, "id") else { return Ok(not_found) };
    let Some(profile) = profiles::get(&state.data_dir, id) else { return Ok(not_found) };
    if matches!(state.server.status(), Status::Starting | Status::Online | Status::Stopping) {
        return Ok(json!({ "ok": false, "error": "A server is already running." }));
    }
    let cfg = StartConfig::new(
        profile["serverDir"].as_str().unwrap_or_default(),
        profile["minRamMb"].as_u64().unwrap_or(1024) as u32,
        profile["maxRamMb"].as_u64().unwrap_or(2048) as u32,
    );
    // The screens learn which server is active from the same state event that reports its status, so the active
    // profile is set before the first status event goes out.
    *state.active_profile.lock().unwrap() = Some(id.to_string());
    match state.server.start(&cfg).await {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(e) => {
            *state.active_profile.lock().unwrap() = None;
            Ok(json!({ "ok": false, "error": e.to_string() }))
        }
    }
}

/// What `server:state` answers and what the `app:state` event carries (the screens redraw from it).
pub fn app_state(state: &AppState) -> Value {
    json!({
        "activeServerProfileId": state.active_profile.lock().unwrap().clone(),
        "publicServerProfileId": Value::Null,
        "manualTunnelActive": false,
        "serverStatus": state.server.status().as_str(),
    })
}

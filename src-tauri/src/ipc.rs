//! The one command the page can call. It receives a channel name and a JSON argument, and answers with JSON.
//! The channel names are the Electron app's (see ui/tauri-bridge.js), so the screens do not change. A channel that
//! is not ported yet answers with a plain message instead of failing silently.

use serde_json::{json, Value};
use std::sync::atomic::Ordering;

use tauri::{Emitter, State};
use voxelport_core::{bds, StartConfig, Status};

use voxelport_core::profiles;

use crate::{addonsetup, appmisc, legacyimport, updatesetup, backupservice, catalog, discord, insights, javasetup, secrets, serverconfig, serversetup, sys, tunnelsetup, webcontrol, AppState};

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
        "app:info" => Ok(discord::app_info(state)),
        "app:versions" => {
            let (system_java, managed_java) = javasetup::versions(state).await;
            Ok(json!({
                "app": env!("CARGO_PKG_VERSION"),
                // The About text prints "(Electron <this>)", so say what this build runs on.
                "electron": "none, this is the Tauri build",
                "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
                "systemJava": system_java,
                "managedJava": managed_java,
                "dataDir": state.data_dir.to_string_lossy(),
            }))
        }
        "java:check" => Ok(javasetup::resolve(state, str_arg(&args, "version"), 0).await.to_json()),
        "java:install" => Ok(javasetup::install_for_screens(state, str_arg(&args, "version")).await),
        "java:openDownloadPage" => {
            secrets::open_url("https://adoptium.net/temurin/releases/");
            Ok(json!({ "ok": true }))
        }
        "app:setTheme" => {
            let theme = match str_arg(&args, "theme") {
                Some(t @ ("light" | "dark" | "system")) => t,
                _ => "system",
            };
            *state.theme.lock().unwrap() = theme.to_string();
            Ok(json!({ "ok": true, "theme": theme }))
        }
        "app:setLanguage" => {
            let lang = if str_arg(&args, "lang") == Some("hinglish") { "hinglish" } else { "en" };
            *state.lang.lock().unwrap() = lang.to_string();
            Ok(json!({ "ok": true }))
        }

        // The Discord gate and the address backup.
        "discord:state" => Ok(discord::discord_state(state)),
        "discord:signIn" => Ok(discord::sign_in(state).await),
        "discord:cancel" => {
            state.account.cancel_sign_in();
            Ok(json!({ "ok": true }))
        }
        "discord:recheck" => {
            discord::refresh(state).await;
            Ok(discord::discord_state(state))
        }
        "discord:signOut" => Ok(discord::sign_out(state).await),
        "discord:openInvite" => Ok(discord::open_invite(state)),
        "identity:save" | "identity:restore" | "identity:delete" => {
            let passphrase = args.get("passphrase").and_then(Value::as_str).or_else(|| args.as_str()).unwrap_or("");
            Ok(discord::identity(state, channel.trim_start_matches("identity:"), passphrase).await)
        }
        "system:specs" => {
            let total = sys::total_memory_mb().unwrap_or(8192);
            Ok(json!({ "totalMemMb": total, "recommendedRamMb": sys::recommended_ram_mb(total) }))
        }
        // The Support screen, copy buttons, the community link, and the error report.
        "support:get" => appmisc::support_get(state, &args).await,
        "support:open" => Ok(appmisc::support_open(state, &args)),
        "support:copyUpi" => Ok(appmisc::copy_upi()),
        "token:copy" => Ok(appmisc::token_copy(state)),
        "supporterID:copy" => Ok(appmisc::supporter_id_copy(state)),
        "community:discord" => Ok(appmisc::community_discord()),
        "diagnostics:export" => Ok(appmisc::diagnostics_export(state).await),
        // Bringing the previous app's data over (see legacyimport.rs).
        "legacy:detect" => Ok(legacyimport::detect(state).await),
        "legacy:run" => Ok(legacyimport::run(state).await),
        "legacy:dismiss" => Ok(legacyimport::dismiss(state)),
        "update:state" => Ok(updatesetup::update_state(state)),
        "update:check" => Ok(updatesetup::update_check(state).await),
        "update:install" => Ok(updatesetup::update_install(state).await),

        // Static lists and start-up defaults the screens read when they open.
        "server:types" => Ok(catalog::types()),
        "server:templates" => Ok(catalog::templates()),
        // The public address: the tunnel, its region, the custom address.
        "tunnel:start" => Ok(tunnelsetup::tunnel_start(state, &args).await),
        "tunnel:stop" => Ok(tunnelsetup::tunnel_stop(state).await),
        "server:makePublic" => Ok(tunnelsetup::make_public(state, &args).await),
        "region:get" => Ok(tunnelsetup::region_get(state)),
        "region:set" => Ok(tunnelsetup::region_set(state, &args)),
        "name:get" => Ok(tunnelsetup::name_get(state)),
        "name:claim" => Ok(tunnelsetup::name_claim(state, &args).await),
        "name:release" => Ok(tunnelsetup::name_release(state).await),
        "voice:state" => Ok(tunnelsetup::voice_state(state)),
        "presence:get" => Ok(appmisc::presence_get(state)),
        "presence:set" => Ok(appmisc::presence_set(state, &args)),

        // Creating, importing, editing and removing servers.
        "server:versions" => serversetup::versions(str_arg(&args, "type").unwrap_or("")).await,
        "server:defaultDir" => Ok(serversetup::default_dir(state)),
        "server:chooseFolder" => Ok(serversetup::choose_folder(state).await),
        "server:detectExisting" => serversetup::detect_existing(&args),
        "server:import" => serversetup::import(state, &args),
        "server:install" => serversetup::install(state, &args).await,
        "server:profiles:update" => serversetup::update_profile(state, &args),
        "server:profiles:delete" => Ok(serversetup::delete_profile(state, &args).await),
        "server:openFolder" => Ok(serversetup::open_folder(state, &args)),

        // Settings, friends-only, files, accounts and small fixes for an installed server.
        "server:settings:get" => serverconfig::settings_get(state, &args),
        "server:settings:save" => serverconfig::settings_save(state, &args),
        "files:list" => Ok(serverconfig::files_list(state, &args)),
        "files:read" => Ok(serverconfig::files_read(state, &args)),
        "files:write" => Ok(serverconfig::files_write(state, &args)),
        "whitelist:status" => Ok(serverconfig::whitelist_status(state, &args).await),
        "whitelist:add" => Ok(serverconfig::whitelist_add(state, &args).await),
        "whitelist:remove" => Ok(serverconfig::whitelist_remove(state, &args).await),
        "whitelist:setEnabled" => Ok(serverconfig::whitelist_set_enabled(state, &args).await),
        "server:accounts:get" => serverconfig::accounts_get(state, &args),
        "server:accounts:set" => Ok(serverconfig::accounts_set(state, &args)),
        "server:accounts:installLogin" => Ok(serverconfig::accounts_install_login(state, &args).await),
        "server:fix" => Ok(serverconfig::fix(state, &args)),
        "server:restart" => serverconfig::restart(state).await,

        // Backups, and changing the Minecraft version (which takes a backup first).
        "backup:info" => backupservice::describe(state, &args),
        "backup:create" => Ok(backupservice::create(state, str_arg(&args, "id").unwrap_or_default(), "manual").await),
        "backup:settings:set" => backupservice::set_settings(state, &args),
        "backup:delete" => backupservice::delete(state, &args),
        "backup:openFolder" => Ok(backupservice::open_folder(state, &args)),
        "backup:restore" => Ok(backupservice::restore(state, &args).await),
        "server:changeVersion" => Ok(serversetup::change_version(state, &args).await),

        // Plugins and mods, modpacks, Bedrock players, and what is really installed.
        "addons:get" => addonsetup::addons_get(state, &args).await,
        "addons:search" => Ok(addonsetup::addons_search(state, &args).await),
        "addons:install" => Ok(addonsetup::addons_install(state, &args).await),
        "addons:icon" => Ok(addonsetup::addons_icon(&args).await),
        "addons:remove" => Ok(addonsetup::addons_remove(state, &args)),
        "addons:openFolder" => Ok(addonsetup::addons_open_folder(state, &args)),
        "modpack:choose" => Ok(addonsetup::modpack_choose(state).await),
        "modpack:install" => Ok(addonsetup::modpack_install(state, &args).await),
        "server:bedrock:set" => Ok(addonsetup::bedrock_set(state, &args).await),
        "server:runtimeInfo" => Ok(addonsetup::runtime_info(state, &args).await),

        "server:profiles:list" => Ok(Value::Array(profiles::list(&state.data_dir))),
        "server:profiles:get" => Ok(str_arg(&args, "id").and_then(|id| profiles::get(&state.data_dir, id)).unwrap_or(Value::Null)),
        "server:state" => Ok(app_state(state)),

        "webcontrol:get" => Ok(webcontrol::get(state)),
        "webcontrol:set" => Ok(webcontrol::set(state, &args)),
        "webcontrol:inviteList" => Ok(webcontrol::invite_list(state).await),
        "webcontrol:inviteCreate" => Ok(webcontrol::invite_create(state, &args).await),
        "webcontrol:inviteRemove" => Ok(webcontrol::invite_remove(state, &args).await),
        "webcontrol:openDashboard" => Ok(webcontrol::open_dashboard()),

        "server:start" => start_server(state, &args).await,
        "server:stop" => {
            insights::request_stop(state);
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

/// Start a profile's server on a suitable Java (installing one when needed). Not yet ported: the backups-busy check and switching from another running server. The Discord gate is the real one: joining the VoxelPort Discord is required to use the app.
async fn start_server(state: &AppState, args: &Value) -> Result<Value, String> {
    match str_arg(args, "id") {
        Some(id) => start_profile(state, id, false).await,
        None => start_profile(state, "", false).await,
    }
}

/// `retried` marks the one automatic restart after a server reported needing a newer Java.
pub async fn start_profile(state: &AppState, id: &str, retried: bool) -> Result<Value, String> {
    if !discord::current_gate(state).allowed {
        discord::emit_state(state);
        return Ok(discord::gate_refusal(state));
    }
    let not_found = json!({ "ok": false, "error": "Server profile not found." });
    let Some(profile) = profiles::get(&state.data_dir, id) else { return Ok(not_found) };
    if matches!(state.server.status(), Status::Starting | Status::Online | Status::Stopping) {
        return Ok(json!({ "ok": false, "error": "A server is already running." }));
    }
    if state.preparing_java.load(Ordering::SeqCst) {
        return Ok(json!({ "ok": false, "error": "Already getting Java ready for a server — one moment." }));
    }
    profiles::touch(&state.data_dir, id);
    // A Bedrock Dedicated Server needs no Java: it has its own program and its own start.
    if bds::is_bedrock_server(profile["type"].as_str().unwrap_or_default()) {
        return start_bedrock_server(state, id, &profile).await;
    }
    let name = profile["name"].as_str().unwrap_or("This server").to_string();
    let mut cfg = StartConfig::new(
        profile["serverDir"].as_str().unwrap_or_default(),
        profile["minRamMb"].as_u64().unwrap_or(1024) as u32,
        profile["maxRamMb"].as_u64().unwrap_or(2048) as u32,
    );

    // Prefer the Java VoxelPort installed itself; otherwise java on the PATH. If neither is new enough for this
    // server, fetch the right one first (the screens see "starting" meanwhile).
    let min_major = profile["javaMajor"].as_u64().unwrap_or(0) as u32;
    let version = profile["version"].as_str();
    let mut java = javasetup::resolve(state, version, min_major).await;
    if !java.satisfied {
        state.preparing_java.store(true, Ordering::SeqCst);
        emit_app_state(state);
        let have = match (java.check.found, java.check.major) {
            (true, Some(m)) => format!(" (this PC has Java {m})"),
            _ => String::new(),
        };
        let _ = state.app.emit("server:log", format!("[VoxelPort] {name} needs Java {}{have} — installing it automatically…", java.required));
        let installed = javasetup::install_into_console(state, java.required).await;
        let required = java.required;
        let mut failure = installed.err();
        if failure.is_none() {
            java = javasetup::resolve(state, version, min_major).await;
            if !java.satisfied {
                failure = Some("it did not start".to_string());
            }
        }
        state.preparing_java.store(false, Ordering::SeqCst);
        if let Some(why) = failure {
            let error = format!("Couldn't set up Java {required}: {}. Check your internet connection and try again.", why.trim_end_matches('.'));
            let _ = state.app.emit("server:log", format!("[VoxelPort] {error}"));
            emit_app_state(state);
            return Ok(json!({ "ok": false, "error": error }));
        }
    }
    // A Bedrock server on a Minecraft version no Geyser build supports gets a plain warning in the log (the start still goes ahead).
    addonsetup::geyser_preflight(state, &profile).await;
    // The error report names this server; its output starts afresh (unless this is the one automatic restart after a Java fix).
    appmisc::note_server_start(
        state,
        appmisc::ServerNote {
            server_type: profile["type"].as_str().unwrap_or_default().to_string(),
            version: addonsetup::running_version(&profile).await,
            build: profile["build"].as_str().map(str::to_string).or_else(|| profile["build"].as_u64().map(|b| b.to_string())),
            port: profile["port"].as_u64(),
        },
        retried,
    );
    cfg.java_path = java.java_path;
    cfg.bedrock = tunnelsetup::bedrock_for_start(state, &profile);
    // If this start is the restart that the voice status asked for, say that voice chat is now active.
    tunnelsetup::voice_started(state, id);
    // From here the server's own output is watched for "needs Java N" (see javasetup::note_log_line / on_exit).
    *state.java_watch.lock().unwrap() = Some(crate::JavaWatch { profile_id: id.to_string(), used_major: java.check.major.unwrap_or(0), needed_major: None, retried });

    // The screens learn which server is active from the same state event that reports its status, so the active
    // profile is set before the first status event goes out.
    *state.active_profile.lock().unwrap() = Some(id.to_string());
    match state.server.start(&cfg).await {
        Ok(()) => {
            insights::on_start(state);
            Ok(json!({ "ok": true }))
        }
        Err(e) => {
            *state.active_profile.lock().unwrap() = None;
            Ok(json!({ "ok": false, "error": e.to_string() }))
        }
    }
}

/// Starts a Bedrock Dedicated Server from its folder. Nothing Java is involved: no Java check or install, no Geyser, no voice plugin.
async fn start_bedrock_server(state: &AppState, id: &str, profile: &Value) -> Result<Value, String> {
    let dir = std::path::PathBuf::from(profile["serverDir"].as_str().unwrap_or_default());
    appmisc::note_server_start(
        state,
        appmisc::ServerNote { server_type: bds::TYPE_ID.to_string(), version: profile["version"].as_str().unwrap_or_default().to_string(), build: None, port: profile["port"].as_u64() },
        false,
    );
    tunnelsetup::prepare_bedrock_server_start(state, profile).await;
    *state.java_watch.lock().unwrap() = None;
    *state.active_profile.lock().unwrap() = Some(id.to_string());
    match state.server.start_bedrock(&dir).await {
        Ok(()) => {
            insights::on_start(state);
            Ok(json!({ "ok": true }))
        }
        Err(e) => {
            *state.active_profile.lock().unwrap() = None;
            Ok(json!({ "ok": false, "error": e.to_string() }))
        }
    }
}

fn emit_app_state(state: &AppState) {
    let _ = state.app.emit("app:state", app_state(state));
}

/// What `server:state` answers and what the `app:state` event carries (the screens redraw from it).
pub fn app_state(state: &AppState) -> Value {
    json!({
        "activeServerProfileId": state.active_profile.lock().unwrap().clone(),
        "publicServerProfileId": state.tunnels.public_profile(),
        "manualTunnelActive": state.tunnels.manual_active(),
        // While Java is being fetched for a start the screens see "starting" (as in Electron).
        "serverStatus": if state.preparing_java.load(std::sync::atomic::Ordering::SeqCst) { "starting" } else { state.server.status().as_str() },
    })
}

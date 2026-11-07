//! Plugins and mods (Modrinth), modpack import, Bedrock players (Geyser + Floodgate) and the "what is really installed" panel:
//! the shell's side of the `addons:*`, `modpack:*`, `server:bedrock:set` and `server:runtimeInfo` channels. The rules (downloads,
//! checksums, jar names, folder safety) are in `voxelport-core` and are tested there; this file connects them to the screens.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Map, Value};
use tauri::Emitter;
use voxelport_core::cracked::{self, Modrinth};
use voxelport_core::{addon_registry, addons, bedrock_install, modpack, profiles, runtime_info, server_install};

use crate::discord::say;
use crate::serverconfig::{is_running, local_bedrock_port, modrinth};
use crate::{dialogs, secrets, tunnelsetup, AppState};

const NOT_FOUND: &str = "Server profile not found.";
const ICON_CACHE_MAX: usize = 300;

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn profile_of(state: &AppState, args: &Value) -> Option<Value> {
    str_arg(args, "id").and_then(|id| profiles::get(&state.data_dir, id))
}

fn dir_of(profile: &Value) -> PathBuf {
    PathBuf::from(profile["serverDir"].as_str().unwrap_or_default())
}

fn blocking_failed(e: tokio::task::JoinError) -> String {
    format!("Something went wrong inside the app ({e}).")
}

// ─── Plugins and mods ───────────────────────────────────────────────────────

pub async fn addons_get(state: &AppState, args: &Value) -> Result<Value, String> {
    let profile = profile_of(state, args).ok_or(NOT_FOUND)?;
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    let ty = profile["type"].as_str().unwrap_or_default().to_string();
    let supported = addons::supported(&ty);
    let dir = dir_of(&profile);
    let (ty2, dir2) = (ty.clone(), dir.clone());
    let (installed, others) = tokio::task::spawn_blocking(move || {
        if !addons::supported(&ty2) {
            return (Vec::new(), Vec::new());
        }
        let installed = addon_registry::installed_addons(&dir2).unwrap_or_default();
        // Everything else in the folder (Geyser and Floodgate from Bedrock support, files added by hand): listed so nothing is
        // hidden, with its real version, but never offered for removal here.
        let mine: Vec<String> = installed.iter().filter_map(|a| a["file"].as_str().map(str::to_string)).collect();
        let folder = addons::folder_for(&ty2);
        let others: Vec<Value> = runtime_info::read_all_plugins(&dir2)
            .into_iter()
            .filter(|p| p["dir"] == folder && !mine.iter().any(|m| p["file"] == m.as_str()))
            .map(|p| json!({ "title": p["label"], "version": p["version"].as_str().unwrap_or(""), "file": p["file"], "bedrock": p["key"] == "geyser" || p["key"] == "floodgate" }))
            .collect();
        (installed, others)
    })
    .await
    .map_err(blocking_failed)?;
    Ok(json!({
        "supported": supported,
        "type": ty,
        "version": profile["version"],
        "folder": if supported { addons::folder_for(&ty) } else { "" },
        "installed": installed,
        "others": others,
        "running": is_running(state, &id),
    }))
}

pub async fn addons_search(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    let (ty, version) = (profile["type"].as_str().unwrap_or_default().to_string(), profile["version"].as_str().unwrap_or_default().to_string());
    let query = str_arg(args, "query").unwrap_or_default().to_string();
    let any_version = args["anyVersion"] == true;
    let offset = args["offset"].as_i64().unwrap_or(0);
    let result = tokio::task::spawn_blocking(move || {
        let (f, api) = modrinth();
        addons::search(&Modrinth { fetcher: &f, api: &api }, &ty, &version, &query, any_version, offset)
    })
    .await
    .map_err(blocking_failed)
    .and_then(|r| r);
    match result {
        Ok(mut res) => {
            res["ok"] = json!(true);
            res
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

pub async fn addons_install(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    if state.addons_busy.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "error": "Already installing — one moment." });
    }
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    let running = is_running(state, &id);
    let (dir, ty, version) = (dir_of(&profile), profile["type"].as_str().unwrap_or_default().to_string(), profile["version"].as_str().unwrap_or_default().to_string());
    let (project, title, icon) = (str_arg(args, "projectId").unwrap_or_default().to_string(), str_arg(args, "title").unwrap_or_default().to_string(), str_arg(args, "icon").unwrap_or_default().to_string());
    let app = state.app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let (f, api) = modrinth();
        let req = addons::InstallRequest { server_dir: &dir, server_type: &ty, version: &version, project_id: &project, title: &title, icon: &icon, running };
        addons::install(&Modrinth { fetcher: &f, api: &api }, &req, &|p| {
            let _ = app.emit("addons:progress", p);
        })
    })
    .await;
    state.addons_busy.store(false, Ordering::SeqCst);
    match result {
        Ok(Ok(installed)) => json!({ "ok": true, "installed": installed, "restartNeeded": is_running(state, &id) }),
        // `code` lets the screen word "that file is already there" in the person's language, with the name filled in.
        Ok(Err(e)) if e.code == Some("exists") => json!({ "ok": false, "error": e.message, "code": "exists", "file": e.file }),
        Ok(Err(e)) => json!({ "ok": false, "error": e.message }),
        Err(e) => json!({ "ok": false, "error": blocking_failed(e) }),
    }
}

fn icon_cache() -> &'static Mutex<Vec<(String, String)>> {
    static CACHE: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// A plugin icon, fetched here because the page may not load anything from the internet. "" means no icon (the page keeps its letter).
pub async fn addons_icon(args: &Value) -> Value {
    let url = str_arg(args, "url").unwrap_or_default().to_string();
    if let Some((_, hit)) = icon_cache().lock().unwrap().iter().find(|(u, _)| *u == url) {
        return json!(hit);
    }
    let fetch_url = url.clone();
    let icon = tokio::task::spawn_blocking(move || addons::fetch_icon(&addons::icon_fetcher(), &fetch_url)).await.unwrap_or_default();
    let mut cache = icon_cache().lock().unwrap();
    cache.push((url, icon.clone()));
    if cache.len() > ICON_CACHE_MAX {
        cache.remove(0); // bounded, so it cannot grow without end
    }
    json!(icon)
}

pub fn addons_remove(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    if state.addons_busy.load(Ordering::SeqCst) {
        return json!({ "ok": false, "error": "Already installing — one moment." });
    }
    let id = profile["id"].as_str().unwrap_or_default();
    let (dir, project) = (dir_of(&profile), str_arg(args, "projectId").unwrap_or_default());
    // The login plugin is what keeps a cracked server from letting anyone join as the owner: not while that is on.
    if project == cracked::LOGIN_PROJECT && cracked::is_cracked(&dir) {
        return json!({ "ok": false, "error": "This server lets in cracked players, so it needs its login plugin (AuthMe). Turn off cracked players in Settings first." });
    }
    match addons::remove(&dir, project, is_running(state, id)) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

pub fn addons_open_folder(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args).filter(|p| addons::supported(p["type"].as_str().unwrap_or_default())) else { return json!({ "ok": false }) };
    let dir = dir_of(&profile).join(addons::folder_for(profile["type"].as_str().unwrap_or_default()));
    if std::fs::create_dir_all(&dir).is_err() {
        return json!({ "ok": false });
    }
    secrets::open_url(&dir.to_string_lossy());
    json!({ "ok": true })
}

// ─── Modpack import ─────────────────────────────────────────────────────────

fn modpack_failed(e: modpack::ModpackError) -> Value {
    json!({ "ok": false, "error": e.message, "code": e.code })
}

/// Asks for a `.mrpack` file and reads its plan (what would be installed, what would be skipped), without installing anything.
pub async fn modpack_choose(state: &AppState) -> Value {
    let title = say(state, "Choose a Modrinth modpack (.mrpack)", "Modrinth modpack (.mrpack) chuno");
    let Some(file) = dialogs::pick_file(&state.app, title, "Modrinth modpack", &["mrpack"]).await else { return Value::Null };
    let path = file.clone();
    match tokio::task::spawn_blocking(move || modpack::read_plan(&path)).await {
        Ok(Ok(plan)) => json!({
            "ok": true, "file": file.to_string_lossy(), "name": plan.name, "minecraft": plan.minecraft, "quilt": plan.quilt,
            "install": plan.downloads.len(), "skipped": plan.skipped_json(),
        }),
        Ok(Err(e)) => modpack_failed(e),
        Err(e) => json!({ "ok": false, "error": blocking_failed(e), "code": "" }),
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|f| f.fract() == 0.0 && f.is_finite())
    .map(|f| f as i64)
}

/// Creates a Fabric server from the chosen `.mrpack`: the Fabric server jar, then the pack's server mods and config.
pub async fn modpack_install(state: &AppState, args: &Value) -> Value {
    let fail = |e: String| json!({ "ok": false, "error": e });
    if state.addons_busy.load(Ordering::SeqCst) {
        return fail(say(state, "Already installing — one moment.", "Pehle se install ho raha hai — ek pal."));
    }
    let Some(port) = int(&args["port"]).filter(|p| (1..=65535).contains(p)) else { return fail(say(state, "Enter a valid server port (1–65535).", "Sahi server port daalo (1–65535).")) };
    let (min_ram, max_ram) = (int(&args["minRamMb"]), int(&args["maxRamMb"]));
    let (Some(min_ram), Some(max_ram)) = (min_ram, max_ram) else { return fail(say(state, "Invalid RAM allocation.", "RAM galat hai.")) };
    if min_ram < 256 || max_ram < min_ram || max_ram > 131_072 {
        return fail(say(state, "Invalid RAM allocation.", "RAM galat hai."));
    }
    let given_dir: Option<PathBuf> = match args.get("serverDir") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if Path::new(s).is_absolute() => Some(PathBuf::from(s)),
        Some(_) => return fail(say(state, "Invalid server folder.", "Server folder galat hai.")),
    };
    let file = PathBuf::from(str_arg(args, "file").unwrap_or_default());
    let name_arg = str_arg(args, "name").map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);

    if state.addons_busy.swap(true, Ordering::SeqCst) {
        return fail("Already installing — one moment.".into());
    }
    let (dir, created_here) = match given_dir {
        Some(d) => {
            let new = !d.exists();
            (d, new)
        }
        None => (crate::serversetup::fresh_server_dir(state), true),
    };
    let app = state.app.clone();
    let progress = move |p: Value| {
        let _ = app.emit("install:progress", p);
    };
    let (file2, dir2) = (file.clone(), dir.clone());
    let result = tokio::task::spawn_blocking(move || -> Result<(modpack::Plan, usize, Option<String>), modpack::ModpackError> {
        let plan = modpack::read_plan(&file2)?; // read again: the file could have changed since it was chosen
        server_install::assert_folder_empty_for_install(&dir2).map_err(|m| modpack::ModpackError { code: "folder", message: m })?;
        let (fetcher, endpoints) = crate::serversetup::services();
        let req = server_install::InstallFiles { dir: &dir2, server_type: "fabric", version: &plan.minecraft, port, properties: &[] };
        let resolved = server_install::install_server_files(&req, &fetcher, &endpoints, &|ph| {
            progress(match ph {
                server_install::Phase::Resolving => json!({ "phase": "resolving" }),
                server_install::Phase::Downloading { received, total } => json!({ "phase": "downloading", "received": received, "total": total }),
                server_install::Phase::Verifying => json!({ "phase": "verifying" }),
            })
        })
        .map_err(|m| modpack::ModpackError { code: "install", message: m })?;
        progress(json!({ "phase": "mods", "index": 0, "total": plan.downloads.len() }));
        let count = modpack::install_mods(&fetcher, &file2, &dir2, &plan, &|p| {
            let mut p = p;
            p["phase"] = json!("mods");
            progress(p)
        })?;
        Ok((plan, count, resolved.build))
    })
    .await;
    state.addons_busy.store(false, Ordering::SeqCst);

    let (plan, count, build) = match result {
        Ok(Ok(done)) => done,
        Ok(Err(e)) => {
            // A folder this import created is removed again, so a retry is not blocked by a half-finished server.
            if created_here && e.code != "folder" {
                let _ = std::fs::remove_dir_all(&dir);
            }
            return modpack_failed(e);
        }
        Err(e) => return fail(blocking_failed(e)),
    };
    let name = name_arg.or_else(|| Some(plan.name.clone()).filter(|n| !n.is_empty())).unwrap_or_else(|| "Modpack server".into());
    let profile = match profiles::create(&state.data_dir, &json!({ "name": name, "type": "fabric", "version": plan.minecraft, "serverDir": dir.to_string_lossy(), "port": port, "minRamMb": min_ram, "maxRamMb": max_ram, "build": build })) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let _ = state.app.emit("install:progress", json!({ "phase": "done" }));
    json!({ "ok": true, "profile": profile, "modsInstalled": count, "skipped": plan.skipped_json() })
}

// ─── Bedrock players ────────────────────────────────────────────────────────

/// The Geyser and Floodgate sources. A development build can point them at local test servers
/// (`VOXELPORT_MODRINTH_API`, `VOXELPORT_GEYSER_API`); a release build always uses the real ones.
fn bedrock_services() -> (voxelport_core::net::Fetcher, String, String) {
    let (fetcher, modrinth_api) = modrinth();
    #[cfg(debug_assertions)]
    if let Ok(geyser) = std::env::var("VOXELPORT_GEYSER_API") {
        return (fetcher, modrinth_api, geyser);
    }
    (fetcher, modrinth_api, bedrock_install::GEYSER_API.to_string())
}

pub fn bedrock_supported(server_type: &str) -> bool {
    bedrock_install::supported(server_type)
}

/// Installs Geyser and Floodgate into a new server folder (the Bedrock template). Blocking.
pub fn install_bedrock_files(dir: &Path, server_type: &str, version: &str) -> Result<(), String> {
    let (f, m, g) = bedrock_services();
    bedrock_install::install(&bedrock_install::Sources { fetcher: &f, modrinth_api: &m, geyser_api: &g }, dir, server_type, version, &|_| {})
}

pub async fn bedrock_set(state: &AppState, args: &Value) -> Value {
    let fail = |e: &str| json!({ "ok": false, "error": e });
    let Some(profile) = profile_of(state, args) else { return fail(NOT_FOUND) };
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    if state.bedrock_busy.swap(true, Ordering::SeqCst) {
        return fail("Already setting up Bedrock — one moment.");
    }
    let result = bedrock_set_inner(state, &profile, &id, args["enabled"] == true).await;
    state.bedrock_busy.store(false, Ordering::SeqCst);
    result
}

async fn bedrock_set_inner(state: &AppState, profile: &Value, id: &str, enabled: bool) -> Value {
    let fail = |e: &str| json!({ "ok": false, "error": e });
    let (dir, ty, version) = (dir_of(profile), profile["type"].as_str().unwrap_or_default().to_string(), profile["version"].as_str().unwrap_or_default().to_string());
    if enabled {
        if !bedrock_install::supported(&ty) {
            return fail("Bedrock players need a Paper or Fabric server.");
        }
        let app = state.app.clone();
        let (dir2, ty2) = (dir.clone(), ty.clone());
        let done = tokio::task::spawn_blocking(move || {
            let (f, m, g) = bedrock_services();
            bedrock_install::install(&bedrock_install::Sources { fetcher: &f, modrinth_api: &m, geyser_api: &g }, &dir2, &ty2, &version, &|p| {
                let _ = app.emit("bedrock:progress", p);
            })
        })
        .await;
        match done {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return json!({ "ok": false, "error": e }),
            Err(e) => return json!({ "ok": false, "error": blocking_failed(e) }),
        }
    } else {
        let dir2 = dir.clone();
        let _ = tokio::task::spawn_blocking(move || bedrock_install::remove(&dir2)).await;
    }
    let mut change = Map::new();
    change.insert("bedrock".into(), json!(enabled));
    let updated = match profiles::update(&state.data_dir, id, &change) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };

    // A public tunnel only forwards UDP if it asked for it when connecting, so it reconnects with the new setting.
    if state.tunnels.public_profile().as_deref() == Some(id) {
        tunnelsetup::tunnel_stop(state).await;
        *state.tunnels.bedrock_restarted_for.lock().unwrap() = None;
        let udp = (updated["bedrock"] == true).then(|| local_bedrock_port(&updated));
        tunnelsetup::start_internal(state, tunnelsetup::StartArgs { local_port: updated["port"].clone(), relay_url: None, profile_id: Some(id.to_string()), udp_port: udp }).await;
    }
    json!({ "ok": true, "profile": updated, "restartNeeded": is_running(state, id) })
}

/// The Minecraft version a server really is: read from its jar. A Fabric launcher jar has none, so the stored version stands in.
pub async fn running_version(profile: &Value) -> String {
    let jar = dir_of(profile).join("server.jar");
    let from_jar = tokio::task::spawn_blocking(move || server_install::read_jar_minecraft_version(&jar).ok().flatten()).await.ok().flatten();
    from_jar.or_else(|| profile["version"].as_str().map(str::to_string)).unwrap_or_default()
}

/// Warns in the server log when a Bedrock-enabled server runs a Minecraft version no Geyser build supports (the start still
/// goes ahead: Java players are unaffected, and a failed check never blocks a start).
pub async fn geyser_preflight(state: &AppState, profile: &Value) {
    if profile["bedrock"] != true {
        return;
    }
    let running_version = running_version(profile).await;
    let ty = profile["type"].as_str().unwrap_or_default().to_string();
    let ask = running_version.clone();
    let compatible = tokio::task::spawn_blocking(move || {
        let (f, m, g) = bedrock_services();
        bedrock_install::geyser_compatible(&bedrock_install::Sources { fetcher: &f, modrinth_api: &m, geyser_api: &g }, &ty, &ask)
    })
    .await
    .ok()
    .flatten();
    if compatible == Some(false) {
        let _ = state.app.emit(
            "server:log",
            format!("[VoxelPort] Bedrock warning: No Geyser build supports Minecraft {running_version}, so Bedrock players would be disconnected. Fix: change this server to a version Geyser supports (Settings → change version), or turn Bedrock off. Java players are unaffected."),
        );
    }
}

// ─── What is really installed ───────────────────────────────────────────────

pub async fn runtime_info(state: &AppState, args: &Value) -> Value {
    let Some(profile) = profile_of(state, args) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    let dir = dir_of(&profile);
    let info = tokio::task::spawn_blocking(move || runtime_info::read_runtime_info(&dir)).await.unwrap_or(Value::Null);
    let running_version = info["minecraftVersion"].as_str().or_else(|| profile["version"].as_str()).unwrap_or_default().to_string();
    let mut compatible = Value::Null;
    if profile["bedrock"] == true {
        let (ty, ask) = (profile["type"].as_str().unwrap_or_default().to_string(), running_version.clone());
        let c = tokio::task::spawn_blocking(move || {
            let (f, m, g) = bedrock_services();
            bedrock_install::geyser_compatible(&bedrock_install::Sources { fetcher: &f, modrinth_api: &m, geyser_api: &g }, &ty, &ask)
        })
        .await
        .ok()
        .flatten();
        compatible = c.map_or(Value::Null, Value::Bool);
    }
    json!({
        "ok": true,
        "type": profile["type"],
        "storedVersion": profile["version"],
        "runningVersion": running_version,
        "jarVersionReadable": info["minecraftVersion"].is_string(),
        "build": if profile["build"].is_null() || profile["build"] == "" { Value::Null } else { profile["build"].clone() },
        "plugins": info["plugins"],
        "stagedUpdates": info["stagedUpdates"],
        "bedrock": profile["bedrock"] == true,
        "bedrockCompatible": compatible,
    })
}

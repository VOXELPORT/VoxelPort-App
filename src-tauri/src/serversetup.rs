//! Creating, importing, listing, editing and removing servers: the shell's side of the `server:*` channels that are not
//! about a running process. The rules (downloads, checksums, folder checks, the profile store) are in `voxelport-core`
//! and are tested there; this file only connects them to the screens and the native dialogs.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};
use voxelport_core::mc_versions::{self, Endpoints};
use voxelport_core::net::{Fetcher, HostPolicy};
use voxelport_core::removal::{check_deletable, Refusal};
use voxelport_core::server_install::{self, InstallFiles, Phase};
use voxelport_core::profiles;

use crate::dialogs::{self, RemoveChoice};
use crate::discord::say;
use crate::{catalog, secrets, AppState};

const KNOWN_TYPES: &[&str] = &["vanilla", "paper", "fabric"];

/// The version services and the download client. A development build can point at a local test server
/// (`VOXELPORT_MC_API=http://127.0.0.1:<port>`); a release build always uses the real ones.
fn services() -> (Fetcher, Endpoints) {
    #[cfg(debug_assertions)]
    if let Ok(base) = std::env::var("VOXELPORT_MC_API") {
        let mut policy = HostPolicy::exact(&["127.0.0.1"]);
        policy.https_only = false;
        let ep = Endpoints { vanilla_manifest: format!("{base}/mojang/version_manifest_v2.json"), paper_api: format!("{base}/paper"), fabric_meta: format!("{base}/fabric") };
        return (Fetcher::new(policy, "Server", mc_versions::USER_AGENT), ep);
    }
    (mc_versions::server_fetcher(), Endpoints::production())
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn int(v: &Value) -> Option<i64> {
    number(v).filter(|f| f.fract() == 0.0 && f.is_finite()).map(|f| f as i64)
}

pub async fn versions(ty: &str) -> Result<Value, String> {
    let ty = ty.to_string();
    let list = tokio::task::spawn_blocking(move || {
        let (f, ep) = services();
        mc_versions::list_versions(&f, &ep, &ty)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(json!(list))
}

fn servers_root(state: &AppState) -> PathBuf {
    state.data_dir.join("servers")
}

/// A fresh suggested folder per install, so two servers never collide unless the person chooses the same folder.
pub fn default_dir(state: &AppState) -> Value {
    let mut nonce = [0u8; 4];
    let _ = getrandom::getrandom(&mut nonce);
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    json!(servers_root(state).join(format!("server-{ms}-{}", nonce.iter().map(|b| format!("{b:02x}")).collect::<String>())).to_string_lossy())
}

pub async fn choose_folder(state: &AppState) -> Value {
    let title = say(state, "Choose a folder for the server files", "Server files ke liye ek folder chuno");
    match dialogs::pick_folder(&state.app, title).await {
        Some(p) => json!(p.to_string_lossy()),
        None => Value::Null,
    }
}

pub fn detect_existing(args: &Value) -> Result<Value, String> {
    match str_arg(args, "dir") {
        Some(d) if Path::new(d).is_absolute() => Ok(server_install::detect_existing_server(Path::new(d))),
        _ => Err("Invalid folder.".into()),
    }
}

/// Adopts a folder that already holds a server. Nothing is installed, downloaded or overwritten: only a profile is
/// recorded that points at the folder as it is.
pub fn import(state: &AppState, args: &Value) -> Result<Value, String> {
    let dir = str_arg(args, "serverDir").filter(|d| Path::new(d).is_absolute() && Path::new(d).exists()).ok_or("Choose a valid existing server folder.")?;
    let port = int(&args["port"]).filter(|p| (1..=65535).contains(p)).ok_or("Enter a valid server port (1–65535).")?;
    let min_ram = int(&args["minRamMb"]).filter(|n| *n != 0).unwrap_or(1024);
    let max_ram = int(&args["maxRamMb"]).filter(|n| *n != 0).unwrap_or(min_ram);
    let ty = str_arg(args, "type").filter(|t| KNOWN_TYPES.contains(t)).ok_or("Unknown server type.")?;
    let version = str_arg(args, "version").filter(|v| !v.is_empty()).unwrap_or("unknown");
    let profile = profiles::create(&state.data_dir, &json!({ "name": args["name"], "type": ty, "version": version, "serverDir": dir, "port": port, "minRamMb": min_ram, "maxRamMb": max_ram }))?;
    Ok(json!({ "ok": true, "profile": profile }))
}

fn progress(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit("install:progress", payload);
}

/// Installs a new server: the jar is downloaded and checked, the files are written, and the profile is recorded.
pub async fn install(state: &AppState, args: &Value) -> Result<Value, String> {
    let template_id = str_arg(args, "templateId").filter(|t| !t.is_empty());
    let template = match template_id {
        Some(id) => Some((id, catalog::template_properties(id).ok_or("Unknown template.")?)),
        None => None,
    };
    let template_meta = template_id.and_then(|id| catalog::templates().as_array().and_then(|a| a.iter().find(|t| t["id"] == id).cloned()));
    let cracked = template_meta.as_ref().is_some_and(|t| t["cracked"] == true);
    let bedrock = template_meta.as_ref().is_some_and(|t| t["bedrock"] == true);
    // A cracked server turns off Minecraft's account check, so it only happens after the person has seen the risks and said
    // yes (the backend insists, not just the dialog).
    if cracked && args["crackedConfirmed"] != true {
        return Err("Confirm that you want to allow cracked players first.".into());
    }
    let port = int(&args["port"]).filter(|p| (1..=65535).contains(p)).ok_or("Enter a valid server port (1–65535).")?;
    let (min_ram, max_ram) = (int(&args["minRamMb"]), int(&args["maxRamMb"]));
    let (Some(min_ram), Some(max_ram)) = (min_ram, max_ram) else { return Err("Invalid RAM allocation.".into()) };
    if min_ram < 256 || max_ram < min_ram || max_ram > 131_072 {
        return Err("Invalid RAM allocation.".into());
    }
    let dir: PathBuf = match args.get("serverDir") {
        None | Some(Value::Null) => state.data_dir.join("servers").join(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0).to_string()),
        Some(Value::String(s)) if Path::new(s).is_absolute() => PathBuf::from(s),
        Some(_) => return Err("Invalid server folder.".into()),
    };
    let ty = str_arg(args, "type").filter(|t| KNOWN_TYPES.contains(t)).ok_or("Unknown server type.")?.to_string();
    let version = str_arg(args, "version").unwrap_or_default().to_string();

    let app = state.app.clone();
    let (dir2, ty2, version2) = (dir.clone(), ty.clone(), version.clone());
    let props = template.as_ref().map(|(_, p)| p.clone()).unwrap_or_default();
    let resolved = tokio::task::spawn_blocking(move || {
        let (f, ep) = services();
        let req = InstallFiles { dir: &dir2, server_type: &ty2, version: &version2, port, properties: &props };
        server_install::install_server_files(&req, &f, &ep, &|p| {
            progress(&app, match p {
                Phase::Resolving => json!({ "phase": "resolving" }),
                Phase::Downloading { received, total } => json!({ "phase": "downloading", "received": received, "total": total }),
                Phase::Verifying => json!({ "phase": "verifying" }),
            })
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    let label = template_meta.as_ref().and_then(|t| t["label"].as_str().map(str::to_string));
    let default_name = label.unwrap_or_else(|| format!("{}{} server", ty[..1].to_uppercase(), &ty[1..]));
    let name = str_arg(args, "name").filter(|n| !n.is_empty()).map(str::to_string).unwrap_or(default_name);
    let profile = profiles::create(
        &state.data_dir,
        &json!({ "name": name, "type": ty, "version": version, "serverDir": dir.to_string_lossy(), "port": port, "minRamMb": min_ram, "maxRamMb": max_ram, "build": resolved.build, "template": template_id }),
    )?;

    // Parts of a template that need modules not in this build yet. The server itself is complete and works; these are said
    // plainly rather than half done.
    let mut warnings: Vec<&str> = Vec::new();
    if bedrock {
        warnings.push("Bedrock support isn't in the Tauri build yet, so this server is Java-only for now.");
    }
    if cracked {
        warnings.push("Cracked-server setup (the login plugin and skins) isn't in the Tauri build yet, so this server still uses normal Minecraft accounts.");
    }
    progress(&state.app, json!({ "phase": "done" }));
    Ok(json!({ "ok": true, "profile": profile, "warning": if warnings.is_empty() { Value::Null } else { json!(warnings.join(" ")) } }))
}

/// Name, port and RAM are the only things the screens may change here. A new port is also written into the server's
/// own `server.properties` (only that line), best effort: an imported folder may not have one yet.
pub fn update_profile(state: &AppState, args: &Value) -> Result<Value, String> {
    let id = str_arg(args, "id").unwrap_or_default();
    let changes = args.get("changes").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut safe = Map::new();
    if let Some(n) = changes.get("name").filter(|n| n.is_string()) {
        safe.insert("name".into(), n.clone());
    }
    for k in ["port", "minRamMb", "maxRamMb"] {
        if let Some(v) = changes.get(k).filter(|v| !v.is_null()) {
            safe.insert(k.into(), v.clone());
        }
    }
    let updated = profiles::update(&state.data_dir, id, &safe)?;
    if safe.contains_key("port") {
        if let (Some(dir), Some(port)) = (updated["serverDir"].as_str(), updated["port"].as_i64()) {
            let _ = server_install::update_server_properties_safely(Path::new(dir), &[("server-port".to_string(), port.to_string())]);
        }
    }
    Ok(updated)
}

/// "Delete server": asks first, then (if the person says so and the folder is clearly the server's own) moves the whole
/// folder to the Recycle Bin, and forgets the server. A folder that is not clearly a server's own (home, Desktop, a folder
/// shared with another saved server...) is never deleted: the server is then only taken off the list.
pub async fn delete_profile(state: &AppState, args: &Value) -> Value {
    let id = str_arg(args, "id").unwrap_or_default();
    if state.active_profile.lock().unwrap().as_deref() == Some(id) {
        return json!({ "ok": false, "error": "Stop and un-publish this server before removing it." });
    }
    let Some(profile) = profiles::get(&state.data_dir, id) else { return json!({ "ok": false, "error": "Server profile not found." }) };
    let dir = PathBuf::from(profile["serverDir"].as_str().unwrap_or_default());

    let p = state.app.path();
    let keep: Vec<PathBuf> = [p.home_dir(), p.desktop_dir(), p.document_dir(), p.download_dir(), p.data_dir(), p.app_data_dir(), p.temp_dir()].into_iter().flatten().collect();
    let others: Vec<PathBuf> = profiles::list(&state.data_dir).iter().filter(|o| o["id"] != id).filter_map(|o| o["serverDir"].as_str().map(PathBuf::from)).collect();
    let check = check_deletable(&dir, &keep, &others);
    let folder_gone = check == Err(Refusal::Missing);
    let can_delete = check.is_ok();

    let name = profile["name"].as_str().unwrap_or("").to_string();
    let dir_text = dir.to_string_lossy().into_owned();
    let why = match check {
        Ok(()) => String::new(),
        Err(Refusal::TooBroad) => say(state, "This folder is too broad to delete safely.", "Ye folder itna bada hai ki safely delete nahi ho sakta."),
        Err(Refusal::Protected) => say(state, "This folder holds your personal or VoxelPort folders, so it will not be deleted.", "Is folder mein tumhare personal ya VoxelPort ke folders hain, isliye ye delete nahi hoga."),
        Err(Refusal::Shared) => say(state, "Another saved server uses this folder, so it will not be deleted.", "Koi aur saved server ye folder use karta hai, isliye ye delete nahi hoga."),
        Err(Refusal::NotAServer) => say(state, "This does not look like a Minecraft server folder, so it will not be deleted.", "Ye Minecraft server ka folder nahi lagta, isliye delete nahi hoga."),
        Err(Refusal::Missing) => say(state, "The folder is already gone.", "Folder pehle se nahi hai."),
        Err(Refusal::NotAFolder) => say(state, "The saved location is not a folder.", "Saved location folder nahi hai."),
    };
    let detail = if can_delete {
        say(
            state,
            &format!("Delete server and files moves this whole folder to the Recycle Bin: the world, plugins, mods and settings.\n\n{dir_text}\n\nYou can restore it from the Recycle Bin until you empty it. Backups made by VoxelPort are kept."),
            &format!("Server aur files delete karo se ye poora folder Recycle Bin mein chala jayega: world, plugins, mods aur settings.\n\n{dir_text}\n\nRecycle Bin khaali karne tak tum ise wapas la sakte ho. VoxelPort ke banaye backups bache rahenge."),
        )
    } else {
        say(state, &format!("{why}\n\nOnly the entry in VoxelPort is removed; no files are touched."), &format!("{why}\n\nSirf VoxelPort ki entry hatayi jayegi; koi file nahi chhuyi jayegi."))
    };
    let labels = if can_delete {
        [say(state, "Cancel", "Cancel"), say(state, "Only remove from the list", "Sirf list se hatao"), say(state, "Delete server and files", "Server aur files delete karo")]
    } else {
        [say(state, "Cancel", "Cancel"), say(state, "Remove from the list", "List se hatao"), String::new()]
    };
    let title = say(state, &format!("Delete \"{name}\"?"), &format!("\"{name}\" delete karna hai?"));

    let choice = dialogs::confirm_removal(&state.app, title, detail, can_delete, labels).await;
    if choice == RemoveChoice::Cancel {
        return json!({ "ok": false, "cancelled": true });
    }
    let delete_files = can_delete && choice == RemoveChoice::DeleteFiles;
    if delete_files && !dialogs::move_to_recycle_bin(&dir) {
        return json!({ "ok": false, "error": "Could not move the server folder to the Recycle Bin. Nothing was removed." });
    }
    let removed = profiles::delete(&state.data_dir, id);
    json!({ "ok": removed, "deletedFiles": delete_files, "folderGone": folder_gone })
}

/// Opens a saved server's folder in the file manager. The folder comes from the saved profile, never from the page.
pub fn open_folder(state: &AppState, args: &Value) -> Value {
    if let Some(profile) = str_arg(args, "id").and_then(|id| profiles::get(&state.data_dir, id)) {
        if let Some(dir) = profile["serverDir"].as_str().filter(|d| Path::new(d).is_dir()) {
            secrets::open_url(dir);
        }
    }
    json!({ "ok": true })
}

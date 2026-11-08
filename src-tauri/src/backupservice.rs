//! Runs backups for the app: makes a running server save first, keeps the schedule, never lets two jobs touch the same server
//! at once, and keeps old backups tidy. The file work itself is in `voxelport-core::backups`; this is ported from
//! `backupService.js` and the backup handlers in `main.js`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};
use voxelport_core::backups::{self, BackupInfo, BedrockCreateOptions, CreateOptions, RestoreOptions};
use voxelport_core::server_process::Flavor;
use voxelport_core::{bds, profiles, server_install, server_process::strip_log_prefix, Status};

use crate::discord::say;
use crate::{dialogs, secrets, serverconfig, AppState};

const SAVE_WAIT: Duration = Duration::from_secs(60);
const CHECK_EVERY: Duration = Duration::from_secs(60);
/// How long a Bedrock server gets to answer one `save query`, and how long the list of files is waited for after it says "ready".
const QUERY_WAIT: Duration = Duration::from_secs(2);
const LIST_SETTLE: Duration = Duration::from_millis(600);
/// A "server stopped" backup is skipped when the last one is this recent.
const RECENT_MS: i64 = 2 * 60 * 1000;
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const NOT_FOUND: &str = "Server profile not found.";

/// Everything the service remembers between calls.
#[derive(Default)]
pub struct Backups {
    /// Servers with a backup or restore running right now.
    busy: Mutex<HashSet<String>>,
    /// Server id -> when its last backup finished (ms).
    last_at: Mutex<HashMap<String, i64>>,
    /// Server id -> a player was on since the last backup.
    dirty: Mutex<HashMap<String, bool>>,
    /// The server the schedule is running for, and its timer.
    watching: Mutex<Option<String>>,
    timer: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// Waiters for a line the server prints ("Saved the game").
    waiters: Mutex<Vec<(fn(&str) -> bool, tokio::sync::oneshot::Sender<()>)>>,
    /// While a Bedrock server holds its saves: the files and lengths its `save query` answers listed (Some = collecting).
    lengths: Mutex<Option<Vec<(String, u64)>>>,
}

fn now_ms() -> i64 {
    (voxelport_core::account::system_clock())()
}

fn is_profile_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Backups of one server live in `<data>/backups/<server id>`. Profile ids are random UUIDs; anything else (a path, `..`) must
/// never become part of a folder name.
pub fn dir_for(state: &AppState, id: &str) -> Result<PathBuf, String> {
    if !is_profile_id(id) {
        return Err("Invalid server id.".into());
    }
    Ok(state.data_dir.join("backups").join(id))
}

pub fn is_busy(state: &AppState, id: &str) -> bool {
    state.backups.busy.lock().unwrap().contains(id)
}

fn info_of(profile: &Value) -> BackupInfo {
    BackupInfo { server_type: profile["type"].as_str().map(str::to_string), version: profile["version"].as_str().map(str::to_string), app_version: Some(env!("CARGO_PKG_VERSION").to_string()) }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn emit(state: &AppState, payload: Value) {
    let _ = state.app.emit("backup:progress", payload);
}

fn log(state: &AppState, line: &str) {
    let _ = state.app.emit("server:log", line);
}

fn dir_json(p: &backups::Progress) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("phase".into(), json!(p.phase));
    if p.total > 0 || p.phase == "zipping" || p.phase == "unpacking" {
        m.insert("done".into(), json!(p.done));
        m.insert("total".into(), json!(p.total));
    }
    m
}

// ─── What the Backups screen shows ──────────────────────────────────────────

pub fn describe(state: &AppState, args: &Value) -> Result<Value, String> {
    let id = str_arg(args, "id").unwrap_or_default();
    let profile = profiles::get(&state.data_dir, id).ok_or(NOT_FOUND)?;
    let dir = dir_for(state, id)?;
    let server_dir = PathBuf::from(profile["serverDir"].as_str().unwrap_or_default());
    let has_world = if bds::is_bedrock_server(profile["type"].as_str().unwrap_or_default()) {
        backups::bedrock_world_exists(&server_dir, &backups::bedrock_level_name_of(&server_dir))
    } else {
        !backups::existing_worlds(&server_dir, &backups::level_name_of(&server_dir)).is_empty()
    };
    Ok(json!({
        "backups": backups::list_backups(&dir).iter().map(backups::BackupEntry::to_json).collect::<Vec<_>>(),
        "settings": backups::backup_settings(&profile).to_json(),
        "dir": dir.to_string_lossy(),
        "busy": is_busy(state, id),
        "running": serverconfig::is_running(state, id),
        "hasWorld": has_world,
    }))
}

pub fn set_settings(state: &AppState, args: &Value) -> Result<Value, String> {
    let id = str_arg(args, "id").unwrap_or_default();
    let profile = profiles::get(&state.data_dir, id).ok_or(NOT_FOUND)?;
    let changes = backups::validate_backup_settings(&args["settings"])?;
    let mut merged = backups::backup_settings(&profile);
    if let Some(a) = changes.get("auto").and_then(Value::as_bool) {
        merged.auto = a;
    }
    if let Some(n) = changes.get("intervalMin").and_then(Value::as_i64) {
        merged.interval_min = n;
    }
    if let Some(n) = changes.get("keep").and_then(Value::as_i64) {
        merged.keep = n;
    }
    let mut c = Map::new();
    c.insert("backups".into(), merged.to_json());
    profiles::update(&state.data_dir, id, &c)?;
    if changes.contains_key("keep") {
        backups::apply_retention(&dir_for(state, id)?, merged.keep as usize, backups::AUTO_BUDGET_BYTES);
    }
    Ok(merged.to_json())
}

pub fn delete(state: &AppState, args: &Value) -> Result<Value, String> {
    let id = str_arg(args, "id").unwrap_or_default();
    profiles::get(&state.data_dir, id).ok_or(NOT_FOUND)?;
    if is_busy(state, id) {
        return Err("A backup or restore is running; try again in a moment.".into());
    }
    backups::delete_backup(&dir_for(state, id)?, str_arg(args, "name").unwrap_or_default()).map_err(|e| e.message)?;
    Ok(json!({ "ok": true }))
}

pub fn open_folder(state: &AppState, args: &Value) -> Value {
    let id = str_arg(args, "id").unwrap_or_default();
    if profiles::get(&state.data_dir, id).is_none() {
        return json!({ "ok": false, "error": NOT_FOUND });
    }
    if let Ok(dir) = dir_for(state, id) {
        let _ = std::fs::create_dir_all(&dir);
        secrets::open_url(&dir.to_string_lossy());
    }
    json!({ "ok": true })
}

// ─── Making a backup ────────────────────────────────────────────────────────

/// Waits until the server prints a line for which `matcher` is true (the whole message after the log prefix), or the time runs out.
async fn wait_for_log(state: &AppState, matcher: fn(&str) -> bool, within: Duration) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.backups.waiters.lock().unwrap().push((matcher, tx));
    tokio::time::timeout(within, rx).await.is_ok()
}

/// What a Minecraft server says when `save-all` is done ("Saved the game"; older versions: "Saved the world").
fn is_saved(message: &str) -> bool {
    message.eq_ignore_ascii_case("Saved the game") || message.eq_ignore_ascii_case("Saved the world")
}

/// Called for every line the server prints.
pub fn note_log_line(state: &AppState, line: &str) {
    if state.backups.lengths.lock().unwrap().is_some() && state.server.flavor() == Flavor::Bedrock {
        let found = bds::parse_save_files(&bds::strip_log_prefix(line));
        if !found.is_empty() {
            if let Some(list) = state.backups.lengths.lock().unwrap().as_mut() {
                for (name, len) in found {
                    match list.iter_mut().find(|(n, _)| *n == name) {
                        Some(entry) => entry.1 = len,
                        None => list.push((name, len)),
                    }
                }
            }
        }
    }
    let mut waiters = state.backups.waiters.lock().unwrap();
    if waiters.is_empty() {
        return;
    }
    let message = if state.server.flavor() == Flavor::Bedrock { bds::strip_log_prefix(line) } else { strip_log_prefix(line) };
    let mut keep = Vec::new();
    for (matcher, tx) in waiters.drain(..) {
        if matcher(&message) {
            let _ = tx.send(());
        } else {
            keep.push((matcher, tx));
        }
    }
    *waiters = keep;
}

/// Asks a running Bedrock server to hold its saves and waits until it says the files may be copied (`save hold`, then `save query` until it
/// answers "Data saved. Files are now ready to be copied."). Returns the files and lengths it reported, or nothing when it never said ready
/// (the files are then copied whole, from disk).
async fn hold_bedrock_world(state: &AppState) -> Vec<(String, u64)> {
    *state.backups.lengths.lock().unwrap() = Some(Vec::new());
    state.server.send_command("save hold").await;
    let deadline = Instant::now() + SAVE_WAIT;
    let mut ready = false;
    while Instant::now() < deadline {
        // The waiter is registered before the command goes out (join polls it first).
        let (got, _) = tokio::join!(wait_for_log(state, bds::is_save_ready, QUERY_WAIT), state.server.send_command("save query"));
        if got {
            ready = true;
            break;
        }
    }
    if ready {
        tokio::time::sleep(LIST_SETTLE).await; // the list of files follows the line that says ready
    } else {
        log(state, "[VoxelPort] The server was slow to save; backing up what is on disk.");
    }
    let lengths = state.backups.lengths.lock().unwrap().take().unwrap_or_default();
    if ready { lengths } else { Vec::new() }
}

/// Makes a backup now. `reason`: manual, auto or stop. If the server is running it is told to save and to hold its saves while
/// the files are copied; saving is always switched back on afterwards.
pub async fn create(state: &AppState, id: &str, reason: &str) -> Value {
    let Some(profile) = profiles::get(&state.data_dir, id) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    let Ok(dir) = dir_for(state, id) else { return json!({ "ok": false, "error": "Invalid server id." }) };
    if !state.backups.busy.lock().unwrap().insert(id.to_string()) {
        return json!({ "ok": false, "error": "A backup or restore is already running for this server.", "code": "busy" });
    }
    let is_bds = bds::is_bedrock_server(profile["type"].as_str().unwrap_or_default());
    let active = serverconfig::is_running(state, id);
    if active && state.server.status() != Status::Online {
        state.backups.busy.lock().unwrap().remove(id);
        return json!({ "ok": false, "error": "The server is starting or stopping. Try again in a moment.", "code": "not-ready" });
    }
    let live = active;
    let mut saving_held = false;
    let result: Result<backups::Created, backups::BackupError> = async {
        emit(state, json!({ "profileId": id, "reason": reason, "phase": "starting" }));
        let mut lengths: Vec<(String, u64)> = Vec::new();
        if live && is_bds {
            log(state, "[VoxelPort] Saving the world for a backup…");
            saving_held = true;
            lengths = hold_bedrock_world(state).await;
        } else if live {
            log(state, "[VoxelPort] Saving the world for a backup…");
            saving_held = true;
            state.server.send_command("save-off").await;
            let saved = wait_for_log(state, is_saved, SAVE_WAIT);
            // The waiter is registered (the future is created above) before the command goes out; polling it starts the clock.
            let (saved, _) = tokio::join!(saved, state.server.send_command("save-all flush"));
            if !saved {
                log(state, "[VoxelPort] The server was slow to save; backing up what is on disk.");
            }
        }
        let server_dir = PathBuf::from(profile["serverDir"].as_str().unwrap_or_default());
        let (reason_s, info, dir2, id2) = (reason.to_string(), info_of(&profile), dir.clone(), id.to_string());
        let app = state.app.clone();
        let last = std::sync::Mutex::new(Instant::now() - PROGRESS_EVERY);
        let created = tokio::task::spawn_blocking(move || {
            let report = |p: backups::Progress| {
                let mut l = last.lock().unwrap();
                if p.done != p.total && l.elapsed() < PROGRESS_EVERY {
                    return;
                }
                *l = Instant::now();
                let mut m = dir_json(&p);
                m.insert("profileId".into(), json!(id2));
                m.insert("reason".into(), json!(reason_s));
                let _ = app.emit("backup:progress", Value::Object(m));
            };
            if is_bds {
                backups::create_backup_bedrock(&BedrockCreateOptions { backup_dir: &dir2, server_dir: &server_dir, reason: &reason_s, info, now_ms: now_ms(), levels: None, lengths }, &report)
            } else {
                backups::create_backup(&CreateOptions { backup_dir: &dir2, server_dir: &server_dir, reason: &reason_s, info, now_ms: now_ms(), worlds: None, level_names: None }, &report)
            }
        })
        .await
        .map_err(|e| backups::BackupError { code: "failed", message: e.to_string() })??;
        backups::apply_retention(&dir, backups::backup_settings(&profile).keep as usize, backups::AUTO_BUDGET_BYTES);
        Ok(created)
    }
    .await;

    let out = match result {
        Ok(created) => {
            state.backups.last_at.lock().unwrap().insert(id.to_string(), now_ms());
            state.backups.dirty.lock().unwrap().insert(id.to_string(), serverconfig::is_running(state, id) && state.players.load(std::sync::atomic::Ordering::SeqCst) > 0);
            emit(state, json!({ "profileId": id, "reason": reason, "phase": "done", "backup": created.to_json() }));
            if live {
                log(state, &format!("[VoxelPort] Backup saved ({}).", created.name));
            }
            json!({ "ok": true, "backup": created.to_json() })
        }
        Err(e) => {
            emit(state, json!({ "profileId": id, "reason": reason, "phase": "failed", "code": e.code, "error": e.message }));
            if live {
                log(state, &format!("[VoxelPort] Backup failed: {}", e.message));
            }
            json!({ "ok": false, "error": e.message, "code": e.code })
        }
    };
    if saving_held && serverconfig::is_running(state, id) {
        state.server.send_command(if is_bds { "save resume" } else { "save-on" }).await;
    }
    *state.backups.lengths.lock().unwrap() = None;
    state.backups.busy.lock().unwrap().remove(id);
    out
}

// ─── Restoring ──────────────────────────────────────────────────────────────

/// Putting a backup back replaces the world, so it always asks first (and saves the current world before it does).
pub async fn restore(state: &AppState, args: &Value) -> Value {
    let id = str_arg(args, "id").unwrap_or_default();
    let name = str_arg(args, "name").unwrap_or_default();
    let Some(profile) = profiles::get(&state.data_dir, id) else { return json!({ "ok": false, "error": NOT_FOUND }) };
    let Some((created_at, _)) = backups::parse_backup_name(name) else { return json!({ "ok": false, "error": "That is not one of VoxelPort's backups." }) };
    let p = backups::local_parts_of(created_at);
    let when = format!("{:04}-{:02}-{:02} {:02}:{:02}", p.y, p.mo, p.d, p.h, p.mi);
    let pname = profile["name"].as_str().unwrap_or("").to_string();
    let title = say(state, &format!("Restore the backup from {when}?"), &format!("{when} wala backup restore karein?"));
    let detail = if bds::is_bedrock_server(profile["type"].as_str().unwrap_or_default()) {
        say(
            state,
            &format!("{pname} goes back to how it was then. Anything built since is replaced. Your current world is saved first so you can undo this."),
            &format!("{pname} waisi ho jayegi jaisi tab thi. Uske baad ka sab kuch badal jayega. Abhi wali world pehle save hoti hai, to undo kar sakte ho."),
        )
    } else {
        say(
            state,
            &format!("{pname} goes back to how it was then. Anything built since is replaced. If the backup includes server.jar, that file is restored too. Your current world and jar are saved first so you can undo this."),
            &format!("{pname} waisi ho jayegi jaisi tab thi. Uske baad ka sab kuch badal jayega. Backup mein server.jar hai to woh bhi restore hogi. Abhi wali world aur jar pehle save hoti hain, to undo kar sakte ho."),
        )
    };
    if !dialogs::confirm_restore(&state.app, title, detail, [say(state, "Cancel", "Cancel"), say(state, "Restore", "Restore karo")]).await {
        return json!({ "ok": false, "cancelled": true });
    }
    restore_confirmed(state, &profile, name).await
}

async fn restore_confirmed(state: &AppState, profile: &Value, name: &str) -> Value {
    let id = profile["id"].as_str().unwrap_or_default().to_string();
    if serverconfig::is_running(state, &id) {
        return json!({ "ok": false, "error": "Stop the server first. A running server would write over the restored world.", "code": "running" });
    }
    if !state.backups.busy.lock().unwrap().insert(id.clone()) {
        return json!({ "ok": false, "error": "A backup or restore is already running for this server.", "code": "busy" });
    }
    let Ok(dir) = dir_for(state, &id) else { return json!({ "ok": false, "error": "Invalid server id." }) };
    let server_dir = PathBuf::from(profile["serverDir"].as_str().unwrap_or_default());
    let (name2, info, app, id2, dir2, sd2) = (name.to_string(), info_of(profile), state.app.clone(), id.clone(), dir.clone(), server_dir.clone());
    let bedrock = bds::is_bedrock_server(profile["type"].as_str().unwrap_or_default());
    let result = tokio::task::spawn_blocking(move || {
        let options = RestoreOptions { backup_dir: &dir2, server_dir: &sd2, name: &name2, info, now_ms: now_ms(), max_entries: backups::MAX_ENTRIES };
        let report = |p: backups::Progress| {
            let mut m = dir_json(&p);
            m.insert("profileId".into(), json!(id2));
            m.insert("reason".into(), json!("restore"));
            let _ = app.emit("backup:progress", Value::Object(m));
        };
        if bedrock { backups::restore_backup_bedrock(&options, &report) } else { backups::restore_backup(&options, &report) }
    })
    .await
    .map_err(|e| backups::BackupError { code: "failed", message: e.to_string() })
    .and_then(|r| r);

    let out = match result {
        Ok(r) => {
            if r.level_name != r.previous_level_name {
                let _ = server_install::update_server_properties_safely(&server_dir, &[("level-name".to_string(), r.level_name.clone())]);
            }
            if let Some((ty, version)) = &r.restored_server {
                // The jar came back with the backup: the profile follows it, and a Java minimum learned for the old jar is forgotten.
                let mut c = Map::new();
                c.insert("type".into(), json!(ty));
                c.insert("version".into(), json!(version));
                c.insert("javaMajor".into(), Value::Null);
                let _ = profiles::update(&state.data_dir, &id, &c);
            }
            state.backups.last_at.lock().unwrap().insert(id.clone(), now_ms());
            state.backups.dirty.lock().unwrap().insert(id.clone(), false);
            emit(state, json!({ "profileId": id, "reason": "restore", "phase": "done" }));
            json!({ "ok": true, "levelName": r.level_name, "previousLevelName": r.previous_level_name, "safetyBackup": r.safety_backup, "restoredServer": r.restored_server.map(|(t, v)| json!({ "type": t, "version": v })) })
        }
        Err(e) => {
            emit(state, json!({ "profileId": id, "reason": "restore", "phase": "failed", "code": e.code, "error": e.message }));
            json!({ "ok": false, "error": e.message, "code": e.code })
        }
    };
    state.backups.busy.lock().unwrap().remove(&id);
    out
}

// ─── The schedule ───────────────────────────────────────────────────────────

/// The server just came online: start checking whether it is time for a backup.
pub fn on_server_online(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let Some(id) = state.active_profile.lock().unwrap().clone() else { return };
    stop_schedule(&state);
    if let Ok(dir) = dir_for(&state, &id) {
        if let Some(newest) = backups::list_backups(&dir).first() {
            let mut last = state.backups.last_at.lock().unwrap();
            let cur = last.get(&id).copied().unwrap_or(0);
            last.insert(id.clone(), cur.max(newest.created_at));
        }
    }
    state.backups.dirty.lock().unwrap().insert(id.clone(), true);
    *state.backups.watching.lock().unwrap() = Some(id);
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CHECK_EVERY).await;
            tick(&handle).await;
        }
    });
    *state.backups.timer.lock().unwrap() = Some(task);
}

/// A player joined or left. Only a world someone was in is worth another backup.
pub fn on_players(state: &AppState, count: u32) {
    if count > 0 {
        if let Some(id) = state.active_profile.lock().unwrap().clone() {
            state.backups.dirty.lock().unwrap().insert(id, true);
        }
    }
}

pub fn stop_schedule(state: &AppState) {
    if let Some(t) = state.backups.timer.lock().unwrap().take() {
        t.abort();
    }
    *state.backups.watching.lock().unwrap() = None;
}

/// The server stopped. A clean stop gets one last backup, so the finished state is always saved (never when the app is closing).
pub async fn on_server_exit(app: &tauri::AppHandle, id: Option<String>, clean: bool) {
    let state = app.state::<AppState>();
    stop_schedule(&state);
    let Some(id) = id else { return };
    if state.closing.load(std::sync::atomic::Ordering::SeqCst) || !clean {
        return;
    }
    let Some(profile) = profiles::get(&state.data_dir, &id) else { return };
    if !backups::backup_settings(&profile).auto {
        return;
    }
    let Ok(dir) = dir_for(&state, &id) else { return };
    let has_any = !backups::list_backups(&dir).is_empty();
    let recent = now_ms() - state.backups.last_at.lock().unwrap().get(&id).copied().unwrap_or(0) < RECENT_MS;
    let dirty = state.backups.dirty.lock().unwrap().get(&id).copied().unwrap_or(false);
    if recent || (has_any && !dirty) {
        return;
    }
    create(&state, &id, "stop").await;
}

async fn tick(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let Some(id) = state.backups.watching.lock().unwrap().clone() else { return };
    if !serverconfig::is_running(&state, &id) || state.server.status() != Status::Online {
        return;
    }
    let Some(profile) = profiles::get(&state.data_dir, &id) else { return };
    let s = backups::backup_settings(&profile);
    if !s.auto || is_busy(&state, &id) {
        return;
    }
    let last = state.backups.last_at.lock().unwrap().get(&id).copied().unwrap_or(0);
    let due = now_ms() - last >= s.interval_min * 60 * 1000;
    let Ok(dir) = dir_for(&state, &id) else { return };
    let has_any = !backups::list_backups(&dir).is_empty();
    let dirty = state.backups.dirty.lock().unwrap().get(&id).copied().unwrap_or(false);
    if !due || (has_any && !dirty) {
        return;
    }
    create(&state, &id, "auto").await;
}

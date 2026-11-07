//! The shell's side of Java: pick the Java a server will run on, install one when none is new enough, and report
//! progress to the screens and the server console. The rules and the download live in `voxelport-core::java`.

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};
use tauri::Emitter;
use voxelport_core::java::{check_java, find_managed_java, install_java, list_managed_java, required_java_major, JavaCheck, Progress, Source};

use crate::AppState;

/// The Java to use for a Minecraft version: Java that VoxelPort installed itself (if one is new enough), else `java`
/// on the PATH.
pub struct Resolved {
    pub check: JavaCheck,
    pub required: u32,
    pub satisfied: bool,
    /// None means `java` from the PATH.
    pub java_path: Option<PathBuf>,
    pub managed: bool,
}

impl Resolved {
    /// What `java:check` tells the screens. The path stays in Rust.
    pub fn to_json(&self) -> Value {
        json!({ "found": self.check.found, "major": self.check.major, "raw": self.check.raw, "required": self.required, "satisfied": self.satisfied, "managed": self.managed })
    }
}

pub async fn resolve(state: &AppState, mc_version: Option<&str>, min_major: u32) -> Resolved {
    let required = required_java_major(mc_version.filter(|v| !v.is_empty()).unwrap_or("1.20.5")).max(min_major);
    if let Some(managed) = find_managed_java(&state.data_dir, required) {
        let check = check_java(&managed.java_path.to_string_lossy()).await;
        if check.found && check.major.map(|m| m >= required).unwrap_or(false) {
            return Resolved { check, required, satisfied: true, java_path: Some(managed.java_path), managed: true };
        }
    }
    let check = check_java("java").await;
    let satisfied = check.found && check.major.map(|m| m >= required).unwrap_or(false);
    Resolved { check, required, satisfied, java_path: None, managed: false }
}

/// What the About/Settings screens show: the Java servers will run on.
pub async fn versions(state: &AppState) -> (Option<u32>, Vec<u32>) {
    let system = check_java("java").await;
    (system.found.then_some(system.major).flatten(), list_managed_java(&state.data_dir))
}

fn progress_json(p: Progress) -> Value {
    match p {
        Progress::Resolve => json!({ "stage": "resolve" }),
        Progress::Download { received, total } => json!({ "stage": "download", "received": received, "total": total }),
        Progress::Extract => json!({ "stage": "extract" }),
        Progress::Done => json!({ "stage": "done" }),
    }
}

/// Where Java comes from. A development build may point at a local test server; a release build always uses Adoptium.
fn source() -> Source {
    #[cfg(debug_assertions)]
    if let Ok(api) = std::env::var("VOXELPORT_JAVA_API") {
        return Source { api_base: api, allowed_hosts: vec!["127.0.0.1".into()], https_only: false, ..Source::adoptium() };
    }
    Source::adoptium()
}

/// Installs Java `major`. One install at a time: a second request waits, then finds the first one's result in place and
/// returns at once without downloading again.
pub async fn install_once(state: &AppState, major: u32, on_progress: impl Fn(Progress) + Send + Sync + 'static) -> Result<(), String> {
    let _one_at_a_time = state.java_lock.lock().await;
    let dir = state.data_dir.clone();
    tokio::task::spawn_blocking(move || install_java(&dir, major, &source(), &on_progress).map(|_| ())).await.map_err(|e| e.to_string())?
}

/// `java:install`: progress goes to the screens as `java:progress`.
pub async fn install_for_screens(state: &AppState, version: Option<&str>) -> Value {
    let major = required_java_major(version.filter(|v| !v.is_empty()).unwrap_or("1.20.5"));
    let app = state.app.clone();
    match install_once(state, major, move |p| { let _ = app.emit("java:progress", progress_json(p)); }).await {
        Ok(()) => json!({ "ok": true, "major": major }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// Narrates an install into the server console, the way the Electron app does.
pub async fn install_into_console(state: &AppState, major: u32) -> Result<(), String> {
    let app = state.app.clone();
    let last_pct = std::sync::atomic::AtomicI64::new(-1);
    install_once(state, major, move |p| {
        let say = |line: String| { let _ = app.emit("server:log", line); };
        match p {
            Progress::Resolve => say(format!("[VoxelPort] Downloading Java {major} (Eclipse Temurin)…")),
            Progress::Download { received, total } if total > 0 => {
                let pct = (received * 100 / total) as i64;
                if pct >= last_pct.load(Ordering::Relaxed) + 20 || pct == 100 {
                    last_pct.store(pct, Ordering::Relaxed);
                    say(format!("[VoxelPort] Java download {pct}%"));
                }
            }
            Progress::Download { .. } => {}
            Progress::Extract => say("[VoxelPort] Unpacking Java…".into()),
            Progress::Done => say(format!("[VoxelPort] Java {major} ready.")),
        }
    })
    .await
}

/// Called for every line the server prints: if it says it needs a newer Java than the one it runs on, remember that.
pub fn note_log_line(state: &AppState, line: &str) {
    let Some(need) = voxelport_core::java::required_java_from_log(line) else { return };
    if let Some(w) = state.java_watch.lock().unwrap().as_mut() {
        if need > w.used_major {
            w.needed_major = Some(w.needed_major.map_or(need, |n| n.max(need)));
        }
    }
}

/// Called when the server has exited. A server that died because it needs a newer Java is fixed once: the profile
/// remembers the new minimum and the server starts again (which installs that Java if needed). If it still fails after
/// that, say so rather than loop.
pub fn on_exit(app: &tauri::AppHandle, code: Option<i32>) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let Some(watch) = state.java_watch.lock().unwrap().take() else { return };
    let Some(needed) = watch.needed_major else { return };
    if code == Some(0) {
        return;
    }
    let say = |app: &tauri::AppHandle, line: String| { let _ = app.emit("server:log", line); };
    if watch.retried {
        say(app, format!("[VoxelPort] The server still reports it needs Java {needed}. Please check the server files."));
        return;
    }
    say(app, format!("[VoxelPort] This server needs Java {needed} — fixing that and restarting…"));
    voxelport_core::profiles::set_java_major(&state.data_dir, &watch.profile_id, needed);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if let Ok(res) = crate::ipc::start_profile(&state, &watch.profile_id, true).await {
            if res["ok"] == false {
                if let Some(e) = res["error"].as_str() {
                    say(&app, format!("[VoxelPort] {e}"));
                }
            }
        }
    });
}

//! What the screens learn about a running server beyond its console: the performance panel (CPU, memory and TPS) and, when a
//! server stops, a plain-language explanation of why. The rules are in `voxelport-core` (`perf`, `crash_explain`) and are tested
//! there; this file feeds them the server's console and sends the results to the page (`perf:sample`, `server:diagnosis`).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{Emitter, Manager};
use tokio::task::JoinHandle;
use voxelport_core::crash_explain::{explain_crash, Lang};
use voxelport_core::perf::{self, Monitor, PerfState};
use voxelport_core::{profiles, Status};

use crate::AppState;

/// Recent console lines kept for explaining a stop.
const RECENT_LINES: usize = 400;
/// How many of them are read when explaining.
const EXPLAIN_LINES: usize = 200;
const TICK_QUERY_EVERY: Duration = Duration::from_secs(10);
/// Lines printed this soon after our own `tick query` are its answer, and are kept out of the console.
const TICK_QUERY_WINDOW: Duration = Duration::from_secs(3);
/// A server that has not answered `tick query` this many times in a row has no such command; stop asking.
const TICK_MISSES_BEFORE_GIVING_UP: u32 = 3;

#[derive(Default)]
struct Tick {
    asked_at: Option<Instant>,
    misses: u32,
}

#[derive(Default)]
pub struct Insights {
    monitor: Monitor,
    perf: Mutex<PerfState>,
    recent: Mutex<VecDeque<String>>,
    tick: Mutex<Tick>,
    tick_task: Mutex<Option<JoinHandle<()>>>,
    /// The person (or a restart, or a switch) asked the server to stop: that is not a crash, so nothing is explained.
    stop_requested: AtomicBool,
}

fn send_perf(state: &AppState) {
    let max_ram = state.active_profile.lock().unwrap().clone().and_then(|id| profiles::get(&state.data_dir, &id)).and_then(|p| p["maxRamMb"].as_u64());
    let payload = state.insights.perf.lock().unwrap().to_json(max_ram);
    let _ = state.app.emit("perf:sample", payload);
}

/// A stop is about to be asked for, by the person or by the app itself: its exit is not a crash.
pub fn request_stop(state: &AppState) {
    state.insights.stop_requested.store(true, Ordering::SeqCst);
}

/// A server was just started: everything about the previous run is forgotten and the process starts being watched.
pub fn on_start(state: &AppState) {
    let i = &state.insights;
    i.stop_requested.store(false, Ordering::SeqCst);
    i.recent.lock().unwrap().clear();
    *i.perf.lock().unwrap() = PerfState::default();
    *i.tick.lock().unwrap() = Tick::default();
    if let Some(pid) = state.server.pid() {
        let app = state.app.clone();
        i.monitor.start(pid, move |s| {
            let state = app.state::<AppState>();
            {
                let mut p = state.insights.perf.lock().unwrap();
                p.cpu_percent = Some(s.cpu_percent);
                p.mem_mb = Some(s.mem_mb);
            }
            send_perf(&state);
        });
    }
}

/// The server is online: start asking it for its tick time now and then (Minecraft 1.20.3 and newer has `/tick`).
pub fn on_online(state: &AppState) {
    stop_tick_polling(state);
    let version = state.active_profile.lock().unwrap().clone().and_then(|id| profiles::get(&state.data_dir, &id)).and_then(|p| p["version"].as_str().map(str::to_string));
    if !version.is_some_and(|v| perf::supports_tick_query(&v)) {
        return;
    }
    *state.insights.tick.lock().unwrap() = Tick::default();
    let app = state.app.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::time::sleep(TICK_QUERY_EVERY).await;
            let state = app.state::<AppState>();
            if state.server.status() != Status::Online {
                continue;
            }
            {
                let mut tick = state.insights.tick.lock().unwrap();
                if tick.asked_at.is_some() && state.insights.perf.lock().unwrap().mspt.is_none() {
                    tick.misses += 1;
                }
                if tick.misses >= TICK_MISSES_BEFORE_GIVING_UP {
                    return; // this server has no /tick
                }
                tick.asked_at = Some(Instant::now());
            }
            state.server.send_command("tick query").await;
        }
    });
    *state.insights.tick_task.lock().unwrap() = Some(task);
}

fn stop_tick_polling(state: &AppState) {
    if let Some(t) = state.insights.tick_task.lock().unwrap().take() {
        t.abort();
    }
    state.insights.tick.lock().unwrap().asked_at = None;
}

/// Looks at every console line. Returns true when the line is our own `tick query` answer and should stay out of the console.
pub fn on_log(state: &AppState, line: &str) -> bool {
    let i = &state.insights;
    {
        let mut recent = i.recent.lock().unwrap();
        recent.push_back(line.to_string());
        while recent.len() > RECENT_LINES {
            recent.pop_front();
        }
    }
    let asked_recently = i.tick.lock().unwrap().asked_at.is_some_and(|at| at.elapsed() < TICK_QUERY_WINDOW);
    if asked_recently && perf::is_tick_query_line(line) {
        if let Some(mspt) = perf::parse_mspt(line) {
            {
                let mut p = i.perf.lock().unwrap();
                p.mspt = Some(mspt);
                p.tps = Some(perf::tps_from_mspt(mspt));
            }
            i.tick.lock().unwrap().misses = 0;
            send_perf(state);
        }
        return true;
    }
    if perf::is_lag_line(line) {
        i.perf.lock().unwrap().lag_warnings += 1;
        send_perf(state);
    }
    false
}

/// The server has exited. `java_fix` is true when it is about to be restarted on a newer Java (the explanation would only
/// confuse). A stop the person asked for is not a crash and gets none.
pub fn on_exit(state: &AppState, exited_profile: Option<&str>, code: Option<i32>, java_fix: bool) {
    let i = &state.insights;
    i.monitor.stop();
    stop_tick_polling(state);
    let (Some(id), false, false) = (exited_profile, i.stop_requested.load(Ordering::SeqCst), java_fix) else { return };
    let lines: Vec<String> = {
        let recent = i.recent.lock().unwrap();
        recent.iter().skip(recent.len().saturating_sub(EXPLAIN_LINES)).cloned().collect()
    };
    let port = profiles::get(&state.data_dir, id).and_then(|p| p["port"].as_u64());
    let lang = if state.lang.lock().unwrap().as_str() == "hinglish" { Lang::Hinglish } else { Lang::English };
    let items = explain_crash(&lines, port, code != Some(0), lang);
    if !items.is_empty() {
        let _ = state.app.emit("server:diagnosis", json!({ "profileId": id, "items": items }));
    }
}

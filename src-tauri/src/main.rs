#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod addonsetup;
mod appmisc;
mod catalog;
mod backupservice;
mod dialogs;
mod discord;
mod insights;
mod ipc;
mod javasetup;
mod legacyimport;

mod secrets;
mod serverconfig;
mod serversetup;
mod sleepservice;
mod sys;
mod tunnelsetup;
mod updatesetup;
mod webcontrol;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, WindowEvent};
use voxelport_core::account::AppAccount;
use voxelport_core::gate::{record_install, InstallRecord};
use voxelport_core::identity::{load_or_create_token, SecretBox};
use voxelport_core::sleep::SleepSchedule;
use voxelport_core::{Event, EventReceiver, ServerProcess, Status, StopPolicy};

/// How long a window close waits for the server to save and stop before giving up (Electron's quit gate waits too).
const QUIT_WAIT: Duration = Duration::from_secs(30);
type AppSleepSchedule = SleepSchedule<Box<dyn Fn() -> voxelport_core::sleep::SleepSettings + Send + Sync>, Box<dyn Fn() + Send + Sync>>;
/// How often the idle timer checks whether the server should sleep.
const SLEEP_CHECK_EVERY: Duration = Duration::from_secs(20);
/// How long the idle check waits for the server to say how many are playing.
const SLEEP_PING_TIMEOUT: Duration = Duration::from_secs(3);
/// A wake-triggered start is retried at most this often, so a client hammering a crash-looping server can't
/// cause a restart loop.
const WAKE_RETRY_EVERY: Duration = Duration::from_secs(60);

/// What a running server needs from Java, learned from its own output (see `javasetup`).
pub struct JavaWatch {
    pub profile_id: String,
    pub used_major: u32,
    pub needed_major: Option<u32>,
    pub retried: bool,
}

/// This install's identity. The raw token never goes to the page: only a masked hint and a short id do.
pub struct Device {
    pub token: String,
    pub encrypted_at_rest: bool,
    pub unreadable: bool,
}

pub struct AppState {
    pub app: tauri::AppHandle,
    pub data_dir: PathBuf,
    pub server: ServerProcess,
    pub active_profile: Mutex<Option<String>>,
    pub theme: Mutex<String>,
    pub lang: Mutex<String>,
    pub secrets: Arc<dyn SecretBox>,
    pub install: InstallRecord,
    pub device: Mutex<Device>,
    pub account: AppAccount,
    pub link_error: Mutex<Option<String>>,
    pub backup_busy: AtomicBool,
    pub accounts_busy: AtomicBool,
    /// One add-on install, removal or modpack import at a time.
    pub addons_busy: AtomicBool,
    /// One Bedrock (Geyser) set-up at a time.
    pub bedrock_busy: AtomicBool,
    /// Performance panel and crash explanations.
    pub insights: insights::Insights,
    /// Hosting links from the last Support screen, by id: the only ones `support:open` will open.
    pub support_hosts: Mutex<std::collections::HashMap<String, String>>,
    /// Recent output for the error report.
    pub diagnostics: appmisc::Diagnostics,
    /// Says the relay operator's announcements in the game chat.
    pub notices: voxelport_core::notice::NoticeAnnouncer,
    /// What is being hosted, shown under the person's name in Discord (if they allow it).
    pub presence: voxelport_core::presence::Presence,
    /// Finding, downloading and (when asked) installing a newer version of the app.
    pub updater: voxelport_core::updater::Updater,
    pub backups: backupservice::Backups,
    /// Web control (testers only): friends press Start or Stop on the accounts site.
    pub webcontrol: webcontrol::Control,
    pub tunnels: tunnelsetup::TunnelState,
    /// How many players are on the running server.
    pub players: AtomicU32,
    /// The window is closing: no "server stopped" backup is made then.
    pub closing: AtomicBool,
    /// Set while a Java install runs before a start: the screens see the server as "starting".
    pub preparing_java: AtomicBool,
    pub java_watch: Mutex<Option<JavaWatch>>,
    pub java_lock: tokio::sync::Mutex<()>,
    pub last_refresh: Mutex<Option<Instant>>,
    /// Stops the current server once it has sat empty for a while, per the active profile's own setting.
    pub sleep_schedule: Mutex<AppSleepSchedule>,
    /// When a wake-triggered start was last attempted, so a hammering or crash-looping client can't retry forever.
    pub last_wake_attempt: Mutex<Option<Instant>>,
}

/// A development build can run the idle clock faster (`VOXELPORT_SLEEP_SPEED=60`: a minute counts as a second),
/// so testing auto-sleep does not mean waiting for it. Compiled out of release builds.
fn sleep_clock_speed() -> i64 {
    #[cfg(debug_assertions)]
    {
        std::env::var("VOXELPORT_SLEEP_SPEED").ok().and_then(|s| s.parse().ok()).filter(|n| (1..=600).contains(n)).unwrap_or(1)
    }
    #[cfg(not(debug_assertions))]
    {
        1
    }
}

/// Forward the server's events to the page under the channel names the screens already listen to.
async fn pump(app: tauri::AppHandle, mut rx: EventReceiver) {
    while let Some(ev) = rx.recv().await {
        let _ = match ev {
            Event::Status(s) => {
                let _ = app.emit("server:status", s.as_str());
                // Electron sends the whole app state with every status change; the screens redraw from it.
                let r = app.emit("app:state", ipc::app_state(&app.state::<AppState>()));
                if s == Status::Online {
                    backupservice::on_server_online(&app);
                    insights::on_online(&app.state::<AppState>());
                    let state = app.state::<AppState>();
                    // The server is confirmed up again, whether from a manual Start or a wake: the next sleep
                    // cycle starts its idle clock fresh, and a wake-triggered start may be attempted again
                    // next time, rather than inheriting a stale rate-limit window from hours earlier.
                    state.sleep_schedule.lock().unwrap().reset();
                    *state.last_wake_attempt.lock().unwrap() = None;
                    state.tunnels.mark_awake();
                }
                appmisc::refresh_presence(&app.state::<AppState>());
                r
            }
            Event::Log(line) => {
                let state = app.state::<AppState>();
                javasetup::note_log_line(&state, &line);
                backupservice::note_log_line(&state, &line);
                // Our own `tick query` answers are kept out of the console.
                if insights::on_log(&state, &line) { Ok(()) } else { app.emit("server:log", line) }
            }
            Event::Players(n) => {
                let state = app.state::<AppState>();
                state.players.store(n as u32, std::sync::atomic::Ordering::SeqCst);
                backupservice::on_players(&state, n as u32);
                tunnelsetup::schedule_listing_update(&app);
                appmisc::refresh_presence(&state);
                app.emit("server:players", n)
            }
            Event::Names(names) => app.emit("server:playerNames", names),
            Event::Exit(code) => {
                let _ = app.emit("server:exit", code);
                let state = app.state::<AppState>();
                // Nothing is active once the server has exited; the screens redraw from the state event.
                let exited = state.active_profile.lock().unwrap().take();
                tunnelsetup::on_server_exit(&state, exited.as_deref());
                state.players.store(0, std::sync::atomic::Ordering::SeqCst);
                let handle = app.clone();
                let exited_for_backup = exited.clone();
                let clean = code == Some(0);
                tauri::async_runtime::spawn(async move { backupservice::on_server_exit(&handle, exited_for_backup, clean).await });
                let result = app.emit("app:state", ipc::app_state(&state));
                // A server that died for want of a newer Java is restarted on it, and then needs no explanation.
                let java_fix = code != Some(0) && state.java_watch.lock().unwrap().as_ref().is_some_and(|w| w.needed_major.is_some() && !w.retried);
                insights::on_exit(&state, exited.as_deref(), code, java_fix);
                appmisc::refresh_presence(&state);
                javasetup::on_exit(&app, code);
                result
            }
        };
    }
}

fn main() {
    tauri::Builder::default()
        // One copy of the app at a time (two would share this device's token and fight over the same ports). Starting it again brings the
        // running window to the front instead. This plugin must be registered first.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // The previous app's "update" button starts this app again while it is already open (the installer starts a copy of its own first).
            if legacyimport::requested(&args) {
                legacyimport::start_handoff(app);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // The page is granted none of this plugin's commands (see capabilities/default.json): it is driven from Rust only.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // The identifier is in.voxelport.app.dev, so this folder is separate from the Electron app's data.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            voxelport_core::backups::set_local_time(Box::new(sys::WindowsLocalTime));
            let (server, rx) = ServerProcess::new(StopPolicy::default());
            let secrets = secrets::platform_secrets();
            // Order matters: the install record looks for an existing device token, so it runs before one is created.
            let install = record_install(&data_dir, (voxelport_core::account::system_clock())());
            let loaded = load_or_create_token(&data_dir, secrets.as_ref());
            let account = AppAccount::new(discord::account_options(&data_dir, loaded.token.clone(), secrets.clone()));
            app.manage(AppState {
                app: app.handle().clone(),
                data_dir,
                server,
                active_profile: Mutex::new(None),
                theme: Mutex::new("system".into()),
                lang: Mutex::new("en".into()),
                secrets,
                install,
                device: Mutex::new(Device { token: loaded.token, encrypted_at_rest: loaded.encrypted_at_rest, unreadable: loaded.unreadable }),
                account,
                link_error: Mutex::new(None),
                backup_busy: AtomicBool::new(false),
                accounts_busy: AtomicBool::new(false),
                addons_busy: AtomicBool::new(false),
                bedrock_busy: AtomicBool::new(false),
                insights: insights::Insights::default(),
                support_hosts: Mutex::new(std::collections::HashMap::new()),
                diagnostics: appmisc::Diagnostics::default(),
                updater: updatesetup::build(app.handle()),
                presence: voxelport_core::presence::Presence::new(appmisc::DISCORD_APPLICATION_ID, appmisc::discord_connector(), std::process::id()),
                notices: {
                    let (say_app, lang_app) = (app.handle().clone(), app.handle().clone());
                    voxelport_core::notice::NoticeAnnouncer::new(
                        move |line| {
                            let app = say_app.clone();
                            tauri::async_runtime::spawn(async move {
                                let state = app.state::<AppState>();
                                if state.server.status() == Status::Online {
                                    state.server.send_command(&format!("say {line}")).await;
                                }
                            });
                        },
                        move || if lang_app.state::<AppState>().lang.lock().unwrap().as_str() == "hinglish" { voxelport_core::notice::Lang::Hinglish } else { voxelport_core::notice::Lang::English },
                    )
                },
                backups: backupservice::Backups::default(),
                webcontrol: webcontrol::Control::default(),
                tunnels: tunnelsetup::TunnelState::default(),
                players: AtomicU32::new(0),
                closing: AtomicBool::new(false),
                preparing_java: AtomicBool::new(false),
                java_watch: Mutex::new(None),
                java_lock: tokio::sync::Mutex::new(()),
                last_refresh: Mutex::new(Some(Instant::now())),
                sleep_schedule: {
                    let (settings_app, stop_app) = (app.handle().clone(), app.handle().clone());
                    let settings: Box<dyn Fn() -> voxelport_core::sleep::SleepSettings + Send + Sync> = Box::new(move || {
                        let state = settings_app.state::<AppState>();
                        let Some(id) = state.active_profile.lock().unwrap().clone() else { return voxelport_core::sleep::SleepSettings { auto: false, idle_min: 20 } };
                        let Some(profile) = voxelport_core::profiles::get(&state.data_dir, &id) else { return voxelport_core::sleep::SleepSettings { auto: false, idle_min: 20 } };
                        voxelport_core::sleep::sleep_settings(&profile)
                    });
                    let stop: Box<dyn Fn() + Send + Sync> = Box::new(move || {
                        let app = stop_app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<AppState>();
                            state.tunnels.mark_asleep();
                            let _ = app.emit("server:log", "[VoxelPort] Nobody is playing, so the server is going to sleep. It starts again when someone tries to join.");
                            insights::request_stop(&state);
                            state.server.stop().await;
                        });
                    });
                    Mutex::new(SleepSchedule::new(settings, stop))
                },
                last_wake_attempt: Mutex::new(None),
            });
            tunnelsetup::load(&app.state::<AppState>());
            // Started by the previous app's "update" button: bring its data over at once (see legacyimport.rs).
            if legacyimport::requested(&std::env::args().collect::<Vec<_>>()) {
                legacyimport::start_handoff(app.handle());
            }
            appmisc::watch_output(app.handle());
            // Updates: a check shortly after start, then every few hours.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { updatesetup::start(&handle.state::<AppState>()) });
            // Presence follows the saved choice (on unless the person turned it off).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                state.presence.set_enabled(appmisc::presence_pref(&state));
            });
            tauri::async_runtime::spawn(pump(app.handle().clone(), rx));
            // Stops the current server once it has sat empty long enough, per the active profile's own setting.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(SLEEP_CHECK_EVERY).await;
                    let state = handle.state::<AppState>();
                    let Some(id) = state.active_profile.lock().unwrap().clone() else { continue };
                    // The relay hears join attempts over TCP only, so a Bedrock Dedicated Server could never be woken.
                    let profile = voxelport_core::profiles::get(&state.data_dir, &id);
                    let is_bds = profile.as_ref().is_some_and(|p| voxelport_core::bds::is_bedrock_server(p["type"].as_str().unwrap_or_default()));
                    let could = state.server.status() == Status::Online && !is_bds && state.tunnels.can_wake(&id);
                    // The server itself is asked who is there too: a plugin can change the join messages the log is read for.
                    let port = profile.as_ref().and_then(|p| p["port"].as_u64()).and_then(|p| u16::try_from(p).ok());
                    let counted = match port {
                        Some(port) if could => voxelport_core::slp::players_online(port, SLEEP_PING_TIMEOUT).await,
                        _ => None,
                    };
                    let there = voxelport_core::sleep::who_is_there(&state.server.online_names(), counted);
                    let ready = could && there.is_some();
                    let online = there.unwrap_or_default();
                    let now = (voxelport_core::account::system_clock())() * sleep_clock_speed();
                    state.sleep_schedule.lock().unwrap().tick(&online, ready, now);
                }
            });
            // Ask the accounts service now and then every 15 minutes while the app is open.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    discord::refresh(&handle.state::<AppState>()).await;
                    tokio::time::sleep(discord::RECHECK).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Quit gate: closing the window while a server runs asks it to stop and waits (bounded), so a world is
            // never cut off mid-save.
            if let WindowEvent::Focused(true) = event {
                discord::refresh_soon(window.app_handle());
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let server = window.state::<AppState>().server.clone();
                window.state::<AppState>().closing.store(true, std::sync::atomic::Ordering::SeqCst);
                window.state::<AppState>().tunnels.stop_all();
                window.state::<AppState>().webcontrol.stop();
                if server.is_running() {
                    api.prevent_close();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        server.stop().await;
                        app.state::<AppState>().presence.shutdown().await;
                        let _ = tokio::time::timeout(QUIT_WAIT, async {
                            while server.is_running() {
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                        })
                        .await;
                        app.exit(0);
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        .run(tauri::generate_context!())
        .expect("error while running VoxelPort");
}

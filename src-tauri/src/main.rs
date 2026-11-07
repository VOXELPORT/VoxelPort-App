#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod discord;
mod ipc;
mod profiles;
mod secrets;
mod sys;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, WindowEvent};
use voxelport_core::account::AppAccount;
use voxelport_core::gate::{record_install, InstallRecord};
use voxelport_core::identity::{load_or_create_token, SecretBox};
use voxelport_core::{Event, EventReceiver, ServerProcess, StopPolicy};

/// How long a window close waits for the server to save and stop before giving up (Electron's quit gate waits too).
const QUIT_WAIT: Duration = Duration::from_secs(30);

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
    pub last_refresh: Mutex<Option<Instant>>,
}

/// Forward the server's events to the page under the channel names the screens already listen to.
async fn pump(app: tauri::AppHandle, mut rx: EventReceiver) {
    while let Some(ev) = rx.recv().await {
        let _ = match ev {
            Event::Status(s) => {
                let _ = app.emit("server:status", s.as_str());
                // Electron sends the whole app state with every status change; the screens redraw from it.
                app.emit("app:state", ipc::app_state(&app.state::<AppState>()))
            }
            Event::Log(line) => app.emit("server:log", line),
            Event::Players(n) => app.emit("server:players", n),
            Event::Names(names) => app.emit("server:playerNames", names),
            Event::Exit(code) => app.emit("server:exit", code),
        };
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // The identifier is in.voxelport.app.dev, so this folder is separate from the Electron app's data.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
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
                last_refresh: Mutex::new(Some(Instant::now())),
            });
            tauri::async_runtime::spawn(pump(app.handle().clone(), rx));
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
                if server.is_running() {
                    api.prevent_close();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        server.stop().await;
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

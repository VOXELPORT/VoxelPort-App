#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod ipc;
mod profiles;
mod sys;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager, WindowEvent};
use voxelport_core::{Event, EventReceiver, ServerProcess, StopPolicy};

/// How long a window close waits for the server to save and stop before giving up (Electron's quit gate waits too).
const QUIT_WAIT: Duration = Duration::from_secs(30);

pub struct AppState {
    pub data_dir: PathBuf,
    pub server: ServerProcess,
    pub active_profile: Mutex<Option<String>>,
    pub theme: Mutex<String>,
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
            app.manage(AppState { data_dir, server, active_profile: Mutex::new(None), theme: Mutex::new("system".into()) });
            tauri::async_runtime::spawn(pump(app.handle().clone(), rx));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Quit gate: closing the window while a server runs asks it to stop and waits (bounded), so a world is
            // never cut off mid-save.
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

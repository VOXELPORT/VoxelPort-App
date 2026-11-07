fn main() {
    // The only command the page can call is `ipc`; a capability grants it to the main window alone.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["ipc"])),
    )
    .expect("failed to run the Tauri build step");
}

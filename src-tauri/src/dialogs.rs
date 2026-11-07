//! Native dialogs (folder and file pickers, delete confirmation) and the Recycle Bin. The page can never skip a confirmation: the
//! question is asked here, in the backend.
//!
//! Development builds can answer the dialogs from the environment so the whole flow can be tested without a person
//! clicking (`VOXELPORT_TEST_FOLDER=<path>`, `VOXELPORT_TEST_FILE=<path>`, `VOXELPORT_TEST_REMOVE=cancel|list|delete`). Compiled out of release builds.

use std::path::{Path, PathBuf};

use tauri::Manager;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RemoveChoice {
    Cancel,
    ListOnly,
    DeleteFiles,
}

/// Asks for a folder. None when the person cancels.
pub async fn pick_folder(app: &tauri::AppHandle, title: String) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("VOXELPORT_TEST_FOLDER") {
        return (!p.is_empty()).then(|| PathBuf::from(p));
    }
    let window = app.get_webview_window("main");
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(title);
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        dialog.pick_folder()
    })
    .await
    .ok()
    .flatten()
}

/// Asks for one file of a kind (for example a modpack). None when the person cancels.
pub async fn pick_file(app: &tauri::AppHandle, title: String, filter_name: &str, extensions: &[&str]) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("VOXELPORT_TEST_FILE") {
        return (!p.is_empty()).then(|| PathBuf::from(p));
    }
    let window = app.get_webview_window("main");
    let (name, exts): (String, Vec<String>) = (filter_name.to_string(), extensions.iter().map(|e| e.to_string()).collect());
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(title).add_filter(name, &exts);
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        dialog.pick_file()
    })
    .await
    .ok()
    .flatten()
}

/// Asks where to save a file. None when the person cancels. A development build can answer from the environment
/// (`VOXELPORT_TEST_SAVE_FILE=<path>`).
pub async fn pick_save(app: &tauri::AppHandle, title: String, default_name: String, filter_name: &str, extensions: &[&str]) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("VOXELPORT_TEST_SAVE_FILE") {
        return (!p.is_empty()).then(|| PathBuf::from(p));
    }
    let window = app.get_webview_window("main");
    let (name, exts): (String, Vec<String>) = (filter_name.to_string(), extensions.iter().map(|e| e.to_string()).collect());
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(title).set_file_name(default_name).add_filter(name, &exts);
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        dialog.save_file()
    })
    .await
    .ok()
    .flatten()
}

/// The delete question. With `can_delete` there are three answers (cancel, only remove from the list, delete the files
/// to the Recycle Bin); without it only "remove from the list" or cancel.
pub async fn confirm_removal(app: &tauri::AppHandle, title: String, detail: String, can_delete: bool, labels: [String; 3]) -> RemoveChoice {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("VOXELPORT_TEST_REMOVE") {
        return match v.as_str() {
            "list" => RemoveChoice::ListOnly,
            "delete" if can_delete => RemoveChoice::DeleteFiles,
            "delete" => RemoveChoice::ListOnly, // what a person would be offered when the files cannot be deleted
            _ => RemoveChoice::Cancel,
        };
    }
    let window = app.get_webview_window("main");
    let [cancel, list_only, delete_files] = labels;
    tokio::task::spawn_blocking(move || {
        let buttons = if can_delete {
            rfd::MessageButtons::YesNoCancelCustom(delete_files.clone(), list_only.clone(), cancel.clone())
        } else {
            rfd::MessageButtons::OkCancelCustom(list_only.clone(), cancel.clone())
        };
        let mut dialog = rfd::MessageDialog::new().set_level(if can_delete { rfd::MessageLevel::Warning } else { rfd::MessageLevel::Info }).set_title(title).set_description(detail).set_buttons(buttons);
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        match dialog.show() {
            rfd::MessageDialogResult::Custom(c) if c == delete_files && can_delete => RemoveChoice::DeleteFiles,
            rfd::MessageDialogResult::Custom(c) if c == list_only => RemoveChoice::ListOnly,
            rfd::MessageDialogResult::Yes if can_delete => RemoveChoice::DeleteFiles,
            rfd::MessageDialogResult::No | rfd::MessageDialogResult::Ok => RemoveChoice::ListOnly,
            _ => RemoveChoice::Cancel,
        }
    })
    .await
    .unwrap_or(RemoveChoice::Cancel)
}

/// "Restore this backup?" Always asked in the backend, so the page cannot skip it.
pub async fn confirm_restore(app: &tauri::AppHandle, title: String, detail: String, labels: [String; 2]) -> bool {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("VOXELPORT_TEST_RESTORE") {
        return v == "yes";
    }
    let window = app.get_webview_window("main");
    let [cancel, restore] = labels;
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::MessageDialog::new().set_level(rfd::MessageLevel::Warning).set_title(title).set_description(detail).set_buttons(rfd::MessageButtons::OkCancelCustom(restore.clone(), cancel));
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        matches!(dialog.show(), rfd::MessageDialogResult::Custom(c) if c == restore)
    })
    .await
    .unwrap_or(false)
}

/// "Switch the tunnel to another server?" Asked in the backend, so the page cannot skip it.
pub async fn confirm_switch(app: &tauri::AppHandle, title: String, detail: String, labels: [String; 2]) -> bool {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("VOXELPORT_TEST_SWITCH") {
        return v == "yes";
    }
    let window = app.get_webview_window("main");
    let [cancel, switch] = labels;
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::MessageDialog::new().set_level(rfd::MessageLevel::Info).set_title(title).set_description(detail).set_buttons(rfd::MessageButtons::OkCancelCustom(switch.clone(), cancel));
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        matches!(dialog.show(), rfd::MessageDialogResult::Custom(c) if c == switch)
    })
    .await
    .unwrap_or(false)
}

/// Moves a folder to the Recycle Bin (so it can be restored until the bin is emptied). True only if it is really gone
/// from where it was.
#[cfg(windows)]
pub fn move_to_recycle_bin(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    if !path.is_absolute() {
        return false;
    }
    // The list of paths ends with two NULs; no trailing slash.
    let trimmed = PathBuf::from(path.as_os_str().to_string_lossy().trim_end_matches(['\\', '/']));
    let mut from: Vec<u16> = trimmed.as_os_str().encode_wide().collect();
    from.extend([0, 0]);
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16;
    // SAFETY: `op` is a zeroed, filled-in SHFILEOPSTRUCTW and `from` is a double-NUL-terminated wide string that outlives the call.
    let code = unsafe { SHFileOperationW(&mut op) };
    code == 0 && op.fAnyOperationsAborted == 0 && !path.exists()
}

#[cfg(not(windows))]
pub fn move_to_recycle_bin(_path: &Path) -> bool {
    false
}

//! A small file browser for one server folder: list, read and edit plain-text settings files (`ops.json`, plugin configs,
//! `bukkit.yml`...). Ported from `serverFiles.js`. The page only ever sends a path RELATIVE to the server folder; it is
//! checked here and never trusted.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::atomic_write;

const MAX_ENTRIES: usize = 1000;
pub const MAX_TEXT_BYTES: u64 = 512 * 1024;
const TEXT_EXTENSIONS: &[&str] = &["properties", "json", "json5", "yml", "yaml", "toml", "cfg", "conf", "ini", "txt", "xml", "mcmeta", "md", "log"];
/// Read-only: the server writes these itself and an edit would be thrown away or fight the running server.
const READ_ONLY_EXTENSIONS: &[&str] = &["log"];

const NOT_ALLOWED: &str = "That path is not allowed.";
const NO_FOLDER: &str = "Server folder not found.";

fn ext_of(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// The absolute path for `rel` inside `root`, or why not. Rejects absolute paths, `..`, NUL bytes, drive letters, stream
/// names (`file.txt:stream`) and anything that leaves the folder through a symbolic link or junction (checked on the real
/// path of the deepest part that exists).
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err(NO_FOLDER.into());
    }
    if rel.contains('\0') || rel.contains(':') {
        return Err(NOT_ALLOWED.into());
    }
    let clean = rel.replace('\\', "/");
    let clean = clean.trim_start_matches('/');
    if clean.split('/').any(|p| p == "..") {
        return Err(NOT_ALLOWED.into());
    }
    let real_root = fs::canonicalize(root).map_err(|_| NO_FOLDER.to_string())?;
    let mut target = real_root.clone();
    for part in clean.split('/').filter(|p| !p.is_empty() && *p != ".") {
        target.push(part);
    }
    // Walk up to the part that exists and check where it really points.
    let mut probe = target.clone();
    while !probe.exists() {
        match probe.parent() {
            Some(p) if p != probe => probe = p.to_path_buf(),
            _ => break,
        }
    }
    let real_probe = fs::canonicalize(&probe).map_err(|_| NOT_ALLOWED.to_string())?;
    if !real_probe.starts_with(&real_root) || !target.starts_with(&real_root) {
        return Err(NOT_ALLOWED.into());
    }
    Ok(target)
}

fn is_editable(name: &str, size: u64) -> bool {
    let ext = ext_of(name);
    TEXT_EXTENSIONS.contains(&ext.as_str()) && !READ_ONLY_EXTENSIONS.contains(&ext.as_str()) && size <= MAX_TEXT_BYTES
}

/// Folders first, then files, each A to Z. Hidden dot-files are listed too (a server has few and they matter).
pub fn list_dir(root: &Path, rel: &str) -> Result<Value, String> {
    let dir = resolve_inside(root, rel)?;
    let read = fs::read_dir(&dir).map_err(|_| "Could not read that folder.".to_string())?;
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    for d in read.flatten() {
        if entries.len() >= MAX_ENTRIES {
            break;
        }
        let Ok(meta) = fs::metadata(d.path()) else { continue }; // a dead link: skip it
        let is_dir = meta.is_dir();
        entries.push((is_dir, d.file_name().to_string_lossy().into_owned(), if is_dir { 0 } else { meta.len() }));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let real_root = fs::canonicalize(root).map_err(|_| NO_FOLDER.to_string())?;
    let shown = dir.strip_prefix(&real_root).map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")).unwrap_or_default();
    Ok(json!({
        "path": shown,
        "entries": entries.into_iter().map(|(dir, name, size)| json!({ "editable": !dir && is_editable(&name, size), "name": name, "dir": dir, "size": size })).collect::<Vec<_>>(),
    }))
}

pub fn read_text_file(root: &Path, rel: &str) -> Result<Value, String> {
    let file = resolve_inside(root, rel)?;
    let ext = ext_of(&file.to_string_lossy());
    if !TEXT_EXTENSIONS.contains(&ext.as_str()) {
        return Err("That kind of file cannot be opened here.".into());
    }
    let meta = fs::metadata(&file).map_err(|_| "That file does not exist.".to_string())?;
    if !meta.is_file() {
        return Err("That is not a file.".into());
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err("That file is too large to edit here (limit 512 KB).".into());
    }
    let bytes = fs::read(&file).map_err(|_| "Could not do that.".to_string())?;
    if bytes.contains(&0) {
        return Err("That file is not plain text.".into());
    }
    Ok(json!({ "text": String::from_utf8_lossy(&bytes), "readOnly": READ_ONLY_EXTENSIONS.contains(&ext.as_str()) }))
}

/// Replaces an EXISTING text file. New files and other kinds of file are never created or changed from here.
pub fn write_text_file(root: &Path, rel: &str, text: &Value) -> Result<Value, String> {
    let file = resolve_inside(root, rel)?;
    let ext = ext_of(&file.to_string_lossy());
    if !TEXT_EXTENSIONS.contains(&ext.as_str()) || READ_ONLY_EXTENSIONS.contains(&ext.as_str()) {
        return Err("That file cannot be edited here.".into());
    }
    let Some(text) = text.as_str() else { return Err("Nothing to save.".into()) };
    if text.len() as u64 > MAX_TEXT_BYTES {
        return Err("That file is too large to save here (limit 512 KB).".into());
    }
    let meta = fs::metadata(&file).map_err(|_| "That file does not exist.".to_string())?;
    if !meta.is_file() {
        return Err("That is not a file.".into());
    }
    if ext == "json" {
        if let Err(e) = serde_json::from_str::<Value>(text) {
            return Err(format!("That is not valid JSON, so it was not saved ({e})."));
        }
    }
    atomic_write(&file, text.as_bytes()).map_err(|_| "Could not do that.".to_string())?;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("server.properties"), "motd=hi\n").unwrap();
        fs::write(d.path().join("ops.json"), "[]").unwrap();
        fs::write(d.path().join("server.jar"), [0x50, 0x4b, 0, 1]).unwrap();
        fs::write(d.path().join("latest.log"), "log").unwrap();
        fs::create_dir(d.path().join("plugins")).unwrap();
        fs::write(d.path().join("plugins").join("config.yml"), "a: 1\n").unwrap();
        d
    }
    fn real(d: &tempfile::TempDir) -> PathBuf {
        fs::canonicalize(d.path()).unwrap()
    }

    #[test]
    fn paths_inside_the_folder_are_accepted() {
        let d = server();
        assert_eq!(resolve_inside(d.path(), "").unwrap(), real(&d));
        assert_eq!(resolve_inside(d.path(), "plugins/config.yml").unwrap(), real(&d).join("plugins").join("config.yml"));
        assert_eq!(resolve_inside(d.path(), "/plugins").unwrap(), real(&d).join("plugins"));
        assert_eq!(resolve_inside(d.path(), "plugins\\config.yml").unwrap(), real(&d).join("plugins").join("config.yml"));
    }

    #[test]
    fn traversal_absolute_paths_drives_streams_and_nul_are_refused() {
        let d = server();
        for bad in ["..", "../x", "plugins/../../x", "..\\x", "C:\\Windows", "C:/Windows", "a\0b", "ops.json:evil", "ops.json::$DATA"] {
            assert_eq!(resolve_inside(d.path(), bad).unwrap_err(), "That path is not allowed.", "{bad:?}");
        }
        assert_eq!(resolve_inside(Path::new("relative/dir"), "").unwrap_err(), "Server folder not found.");
        assert_eq!(resolve_inside(&d.path().join("nope"), "").unwrap_err(), "Server folder not found.");
    }

    #[test]
    fn a_link_that_leaves_the_folder_is_refused() {
        let d = server();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        // A junction needs no special rights on Windows; elsewhere a symlink does the same job.
        let link = d.path().join("escape");
        #[cfg(windows)]
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(outside.path()).output().map(|o| o.status.success()).unwrap_or(false);
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(outside.path(), &link).is_ok();
        if !made {
            eprintln!("cannot create links here; skipping");
            return;
        }
        assert_eq!(resolve_inside(d.path(), "escape").unwrap_err(), NOT_ALLOWED);
        assert_eq!(read_text_file(d.path(), "escape/secret.txt").unwrap_err(), NOT_ALLOWED);
        assert_eq!(write_text_file(d.path(), "escape/secret.txt", &json!("x")).unwrap_err(), NOT_ALLOWED);
        assert_eq!(fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "secret", "nothing outside was touched");
        #[cfg(windows)]
        let _ = std::process::Command::new("cmd").args(["/C", "rmdir"]).arg(&link).output(); // removes the junction, not its target
    }

    #[test]
    fn listing_puts_folders_first_and_marks_what_can_be_edited() {
        let d = server();
        let l = list_dir(d.path(), "").unwrap();
        assert_eq!(l["path"], "");
        let names: Vec<&str> = l["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["plugins", "latest.log", "ops.json", "server.jar", "server.properties"]);
        let by = |n: &str| l["entries"].as_array().unwrap().iter().find(|e| e["name"] == n).unwrap().clone();
        assert_eq!((by("plugins")["dir"].clone(), by("ops.json")["editable"].clone(), by("server.jar")["editable"].clone(), by("latest.log")["editable"].clone()), (json!(true), json!(true), json!(false), json!(false)));
        assert_eq!(list_dir(d.path(), "plugins").unwrap()["path"], "plugins");
    }

    #[test]
    fn text_files_open_binaries_and_unknown_types_do_not() {
        let d = server();
        assert_eq!(read_text_file(d.path(), "server.properties").unwrap()["text"], "motd=hi\n");
        assert_eq!(read_text_file(d.path(), "latest.log").unwrap()["readOnly"], true);
        assert!(read_text_file(d.path(), "server.jar").unwrap_err().contains("cannot be opened"));
        fs::write(d.path().join("bin.txt"), [65, 0, 66]).unwrap();
        assert!(read_text_file(d.path(), "bin.txt").unwrap_err().contains("not plain text"));
        assert!(read_text_file(d.path(), "missing.txt").unwrap_err().contains("does not exist"));
        assert!(read_text_file(d.path(), "plugins").unwrap_err().contains("cannot be opened"));
    }

    #[test]
    fn a_file_over_the_limit_is_refused() {
        let d = server();
        fs::write(d.path().join("big.txt"), "x".repeat(512 * 1024 + 1)).unwrap();
        assert!(read_text_file(d.path(), "big.txt").unwrap_err().contains("too large"));
        assert!(!is_editable("big.txt", 512 * 1024 + 1));
        assert!(is_editable("big.txt", 512 * 1024));
    }

    #[test]
    fn saving_replaces_an_existing_text_file_and_leaves_no_temp_files() {
        let d = server();
        write_text_file(d.path(), "server.properties", &json!("motd=changed\n")).unwrap();
        assert_eq!(fs::read_to_string(d.path().join("server.properties")).unwrap(), "motd=changed\n");
        assert!(!fs::read_dir(d.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(".tmp-")));
    }

    #[test]
    fn saving_never_creates_files_edits_logs_or_touches_binaries() {
        let d = server();
        let w = |p: &str| write_text_file(d.path(), p, &json!("x")).unwrap_err();
        assert!(w("new.txt").contains("does not exist"));
        assert!(w("latest.log").contains("cannot be edited"));
        assert!(w("server.jar").contains("cannot be edited"));
        assert!(w("../evil.txt").contains("not allowed"));
        assert!(w("plugins").contains("cannot be edited"));
        assert!(!d.path().join("new.txt").exists());
    }

    #[test]
    fn invalid_json_is_refused_and_the_old_file_kept() {
        let d = server();
        assert!(write_text_file(d.path(), "ops.json", &json!("[{")).unwrap_err().contains("not valid JSON"));
        assert_eq!(fs::read_to_string(d.path().join("ops.json")).unwrap(), "[]");
        write_text_file(d.path(), "ops.json", &json!("[{\"name\":\"a\"}]")).unwrap();
        assert_eq!(fs::read_to_string(d.path().join("ops.json")).unwrap(), "[{\"name\":\"a\"}]");
    }

    #[test]
    fn non_text_and_oversize_input_are_refused() {
        let d = server();
        assert!(write_text_file(d.path(), "server.properties", &json!(5)).unwrap_err().contains("Nothing to save"));
        assert!(write_text_file(d.path(), "server.properties", &json!("x".repeat(512 * 1024 + 1))).unwrap_err().contains("too large"));
    }
}

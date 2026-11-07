//! Friends-only hosting: a small whitelist a host can edit from one screen. Ported from `whitelist.js`.
//!
//! When the whitelist is on, only the names on it can join. The list lives in the server's own `whitelist.json` (and
//! `white-list=true` in `server.properties`). If the server is running the matching `whitelist ...` commands are also sent,
//! so the change applies at once; if it is stopped, editing the file is enough and it applies on the next start.
//!
//! Names are checked as Minecraft usernames (3 to 16 of letters, digits, underscore). On a normal server the server resolves
//! each name to a real account when it is added; on a cracked/offline server the match is by the exact typed name, which is
//! why `add_friends` reports `cracked` (so the screen can warn).

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::atomic_write;
use crate::cracked::is_cracked;
use crate::settings::read_properties_file;

const MAX_NAMES: usize = 200;

/// A command sender for a live server; `None` when the server is stopped.
pub type Send<'a> = Option<&'a dyn Fn(&str)>;

pub fn is_valid_username(name: &str) -> bool {
    (3..=16).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Splits what the host typed (comma, space or line separated) into valid and invalid names, without duplicates (names
/// are case-insensitive to join).
pub fn parse_names(text: &str) -> (Vec<String>, Vec<String>) {
    let (mut valid, mut invalid, mut seen) = (Vec::new(), Vec::new(), HashSet::new());
    for p in text.split(|c: char| c.is_whitespace() || c == ',' || c == ';').map(str::trim).filter(|s| !s.is_empty()) {
        if !seen.insert(p.to_lowercase()) {
            continue;
        }
        if is_valid_username(p) {
            if valid.len() < MAX_NAMES {
                valid.push(p.to_string());
            }
        } else {
            invalid.push(p.chars().take(20).collect());
        }
    }
    (valid, invalid)
}

fn check_dir(dir: &Path) -> Result<(), String> {
    if dir.is_absolute() { Ok(()) } else { Err("Invalid server folder.".into()) }
}

/// The valid, de-duplicated entries of `whitelist.json` as (name, uuid).
pub fn read_whitelist(dir: &Path) -> Result<Vec<(String, String)>, String> {
    check_dir(dir)?;
    let Some(Value::Array(list)) = fs::read_to_string(dir.join("whitelist.json")).ok().and_then(|t| serde_json::from_str(&t).ok()) else { return Ok(Vec::new()) };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for e in list {
        let Some(name) = e["name"].as_str().filter(|n| is_valid_username(n)) else { continue };
        if seen.insert(name.to_lowercase()) {
            out.push((name.to_string(), e["uuid"].as_str().unwrap_or("").to_string()));
        }
    }
    Ok(out)
}

fn write_whitelist(dir: &Path, entries: &[(String, String)]) -> Result<(), String> {
    let list: Vec<Value> = entries.iter().map(|(n, u)| json!({ "uuid": u, "name": n })).collect();
    atomic_write(&dir.join("whitelist.json"), serde_json::to_string_pretty(&list).unwrap().as_bytes()).map_err(|e| e.to_string())
}

/// Sets `white-list` and `enforce-whitelist` in `server.properties`, adding the keys if missing and keeping every other line
/// and the file's line endings.
fn set_whitelist_property(dir: &Path, on: bool) -> Result<(), String> {
    let file = dir.join("server.properties");
    let text = fs::read_to_string(&file).unwrap_or_default();
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let value = if on { "true" } else { "false" };
    let mut lines: Vec<String> = if text.is_empty() { Vec::new() } else { text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect() };
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    for key in ["white-list", "enforce-whitelist"] {
        let at = lines.iter().position(|l| l.trim().strip_prefix(key).is_some_and(|r| r.trim_start().starts_with('=')));
        match at {
            Some(i) => lines[i] = format!("{key}={value}"),
            None => lines.push(format!("{key}={value}")),
        }
    }
    atomic_write(&file, (lines.join(eol) + eol).as_bytes()).map_err(|e| e.to_string())
}

pub fn is_whitelist_on(dir: &Path) -> bool {
    read_properties_file(dir).get("white-list").is_some_and(|v| v.trim() == "true")
}

fn send_all(send: Send, running: bool, commands: &[String]) {
    if let (true, Some(f)) = (running, send) {
        for c in commands {
            f(c);
        }
    }
}

/// Adds friends and turns the whitelist on. Reports which names were added, which were already there, which were invalid,
/// whether the server is cracked, and whether a restart is needed (only when the file was edited while stopped).
pub fn add_friends(dir: &Path, text: &str, running: bool, send: Send) -> Result<Value, String> {
    check_dir(dir)?;
    let (valid, invalid) = parse_names(text);
    let mut current = read_whitelist(dir)?;
    let mut have: HashSet<String> = current.iter().map(|(n, _)| n.to_lowercase()).collect();
    let (mut added, mut already) = (Vec::new(), Vec::new());
    for name in valid {
        if !have.insert(name.to_lowercase()) {
            already.push(name);
            continue;
        }
        current.push((name.clone(), String::new()));
        added.push(name);
    }
    if !added.is_empty() {
        write_whitelist(dir, &current)?;
    }
    set_whitelist_property(dir, true)?;
    let mut cmds: Vec<String> = added.iter().map(|n| format!("whitelist add {n}")).collect();
    cmds.extend(["whitelist on".to_string(), "whitelist reload".to_string()]);
    send_all(send, running, &cmds);
    Ok(json!({ "added": added, "already": already, "invalid": invalid, "cracked": is_cracked(dir), "total": current.len(), "restartNeeded": !running && !added.is_empty() }))
}

pub fn remove_friend(dir: &Path, name: &str, running: bool, send: Send) -> Result<Value, String> {
    check_dir(dir)?;
    if !is_valid_username(name) {
        return Err("That is not a valid username.".into());
    }
    let current = read_whitelist(dir)?;
    let next: Vec<_> = current.iter().filter(|(n, _)| !n.eq_ignore_ascii_case(name)).cloned().collect();
    let changed = next.len() != current.len();
    if changed {
        write_whitelist(dir, &next)?;
    }
    send_all(send, running, &[format!("whitelist remove {name}"), "whitelist reload".to_string()]);
    Ok(json!({ "total": next.len(), "restartNeeded": !running && changed }))
}

/// Turns the whitelist on or off. The names are kept so it can be turned back on.
pub fn set_enabled(dir: &Path, on: bool, running: bool, send: Send) -> Result<Value, String> {
    check_dir(dir)?;
    set_whitelist_property(dir, on)?;
    send_all(send, running, &[(if on { "whitelist on" } else { "whitelist off" }).to_string(), "whitelist reload".to_string()]);
    Ok(json!({ "on": on, "restartNeeded": false }))
}

pub fn status(dir: &Path) -> Result<Value, String> {
    check_dir(dir)?;
    Ok(json!({ "enabled": is_whitelist_on(dir), "friends": read_whitelist(dir)?.into_iter().map(|(n, _)| n).collect::<Vec<_>>(), "cracked": is_cracked(dir) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn server(cracked: bool, props: &str) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("server.properties"), format!("online-mode={}\n{props}", if cracked { "false" } else { "true" })).unwrap();
        d
    }
    fn names(d: &Path) -> Vec<String> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(d.join("whitelist.json")).unwrap()).unwrap();
        v.as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect()
    }
    fn prop(d: &Path, k: &str) -> Option<String> {
        read_properties_file(d).get(k).cloned()
    }

    #[test]
    fn usernames_are_three_to_sixteen_of_letters_digits_underscore() {
        for ok in ["Steve", "a_b_123", "abc", &"x".repeat(16)] {
            assert!(is_valid_username(ok), "{ok}");
        }
        for bad in ["ab", &"x".repeat(17), "has space", "bad-dash", "emoji😀name", ""] {
            assert!(!is_valid_username(bad), "{bad}");
        }
    }

    #[test]
    fn names_split_on_spaces_commas_and_lines_drop_duplicates_and_sort_out_invalid() {
        let (valid, invalid) = parse_names("Steve, Alex\nSteve  bad-name  Notch");
        assert_eq!((valid, invalid), (vec!["Steve".to_string(), "Alex".into(), "Notch".into()], vec!["bad-name".to_string()]));
        assert_eq!(parse_names("Steve steve STEVE").0, ["Steve"]);
        assert!(parse_names("").0.is_empty());
    }

    #[test]
    fn adding_friends_writes_the_list_and_turns_the_whitelist_on() {
        let d = server(false, "");
        let r = add_friends(d.path(), "Steve Alex", false, None).unwrap();
        assert_eq!(r["added"], json!(["Steve", "Alex"]));
        assert_eq!(names(d.path()), ["Steve", "Alex"]);
        assert_eq!((prop(d.path(), "white-list").as_deref(), prop(d.path(), "enforce-whitelist").as_deref()), (Some("true"), Some("true")));
        assert_eq!(r["restartNeeded"], true, "added while stopped");
        assert_eq!(prop(d.path(), "online-mode").as_deref(), Some("true"), "other lines are kept");
    }

    #[test]
    fn already_present_and_invalid_names_are_reported_without_duplicating() {
        let d = server(false, "");
        add_friends(d.path(), "Steve", false, None).unwrap();
        let r = add_friends(d.path(), "Steve Alex ab name!", false, None).unwrap();
        assert_eq!((r["added"].clone(), r["already"].clone()), (json!(["Alex"]), json!(["Steve"])));
        let mut inv: Vec<String> = r["invalid"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        inv.sort();
        assert_eq!(inv, ["ab", "name!"]);
        assert_eq!(names(d.path()), ["Steve", "Alex"]);
    }

    #[test]
    fn a_running_server_gets_commands_and_needs_no_restart() {
        let d = server(false, "");
        let sent = RefCell::new(Vec::new());
        let f = |c: &str| sent.borrow_mut().push(c.to_string());
        let r = add_friends(d.path(), "Steve", true, Some(&f)).unwrap();
        assert!(sent.borrow().contains(&"whitelist add Steve".to_string()) && sent.borrow().contains(&"whitelist on".to_string()));
        assert_eq!(r["restartNeeded"], false);
        // Nothing is sent to a server that is stopped, even if a sender is supplied.
        sent.borrow_mut().clear();
        add_friends(d.path(), "Alex", false, Some(&f)).unwrap();
        assert!(sent.borrow().is_empty());
    }

    #[test]
    fn a_cracked_server_is_flagged_so_the_screen_can_warn() {
        let (plain, cracked) = (server(false, ""), server(true, ""));
        assert_eq!(add_friends(plain.path(), "Steve", false, None).unwrap()["cracked"], false);
        assert_eq!(add_friends(cracked.path(), "Steve", false, None).unwrap()["cracked"], true);
    }

    #[test]
    fn removing_a_friend_updates_the_file_and_commands_a_running_server() {
        let d = server(false, "");
        add_friends(d.path(), "Steve Alex", false, None).unwrap();
        let sent = RefCell::new(Vec::new());
        let f = |c: &str| sent.borrow_mut().push(c.to_string());
        let r = remove_friend(d.path(), "steve", true, Some(&f)).unwrap();
        assert_eq!(names(d.path()), ["Alex"]);
        assert!(sent.borrow().contains(&"whitelist remove steve".to_string()));
        assert_eq!((r["total"].clone(), r["restartNeeded"].clone()), (json!(1), json!(false)));
        assert!(remove_friend(d.path(), "bad name", false, None).is_err());
        assert_eq!(remove_friend(d.path(), "Nobody", false, None).unwrap()["restartNeeded"], false);
    }

    #[test]
    fn turning_it_off_keeps_the_names() {
        let d = server(false, "");
        add_friends(d.path(), "Steve", false, None).unwrap();
        set_enabled(d.path(), false, false, None).unwrap();
        assert_eq!(prop(d.path(), "white-list").as_deref(), Some("false"));
        assert_eq!(names(d.path()), ["Steve"]);
        assert_eq!(status(d.path()).unwrap()["enabled"], false);
    }

    #[test]
    fn status_reports_enabled_friends_and_cracked() {
        let d = server(true, "");
        add_friends(d.path(), "Steve", false, None).unwrap();
        let s = status(d.path()).unwrap();
        assert_eq!((s["enabled"].clone(), s["friends"].clone(), s["cracked"].clone()), (json!(true), json!(["Steve"]), json!(true)));
    }

    #[test]
    fn malformed_entries_and_duplicates_in_the_file_are_ignored() {
        let d = server(false, "");
        std::fs::write(d.path().join("whitelist.json"), json!([{ "name": "Steve", "uuid": "u1" }, { "name": "steve" }, { "name": "bad name" }, { "nope": true }, "x"]).to_string()).unwrap();
        assert_eq!(read_whitelist(d.path()).unwrap(), [("Steve".to_string(), "u1".to_string())]);
        std::fs::write(d.path().join("whitelist.json"), "{ not json").unwrap();
        assert!(read_whitelist(d.path()).unwrap().is_empty());
    }

    #[test]
    fn the_property_edit_keeps_windows_line_endings_and_other_lines() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("server.properties"), "motd=Hi\r\nwhite-list = false\r\nview-distance=8\r\n").unwrap();
        set_enabled(d.path(), true, false, None).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("server.properties")).unwrap(), "motd=Hi\r\nwhite-list=true\r\nview-distance=8\r\nenforce-whitelist=true\r\n");
        let fresh = tempfile::tempdir().unwrap();
        set_enabled(fresh.path(), true, false, None).unwrap();
        assert!(is_whitelist_on(fresh.path()));
    }

    #[test]
    fn relative_folders_are_refused() {
        assert!(add_friends(Path::new("rel"), "Steve", false, None).is_err());
        assert!(status(Path::new("rel")).is_err());
    }
}

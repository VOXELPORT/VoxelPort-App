//! Friends-only hosting for a Bedrock Dedicated Server: the same small screen as for a Java server, over the Bedrock server's own
//! `allowlist.json` and its `allow-list` setting. When it is on, only the gamertags on it can join.
//!
//! The answers have the same shape as [`crate::whitelist`]'s, so the screen is shared. What differs: gamertags may hold spaces (so a typed
//! list is split on commas, semicolons and line breaks, never on spaces), the commands are `allowlist add "name"` and friends, and there is no
//! cracked mode to warn about.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::atomic_write;
use crate::server_install::update_server_properties_safely;
use crate::settings::read_properties_file;
use crate::whitelist::Send;

const MAX_NAMES: usize = 200;
const FILE: &str = "allowlist.json";

pub fn is_valid_gamertag(name: &str) -> bool {
    crate::bds::is_player_name(name) && name == name.trim()
}

/// Splits what the host typed (commas, semicolons or line breaks) into valid and invalid gamertags, without duplicates (names are
/// case-insensitive to join).
pub fn parse_names(text: &str) -> (Vec<String>, Vec<String>) {
    let (mut valid, mut invalid, mut seen) = (Vec::new(), Vec::new(), HashSet::new());
    for p in text.split([',', ';', '\n', '\r']).map(str::trim).filter(|s| !s.is_empty()) {
        if !seen.insert(p.to_lowercase()) {
            continue;
        }
        if is_valid_gamertag(p) {
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

/// The entries of `allowlist.json` exactly as stored (so a xuid the server added is kept), without duplicates or unusable names.
fn read_entries(dir: &Path) -> Vec<Value> {
    let Some(Value::Array(list)) = fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()) else { return Vec::new() };
    let mut seen = HashSet::new();
    list.into_iter().filter(|e| e["name"].as_str().is_some_and(|n| is_valid_gamertag(n) && seen.insert(n.to_lowercase()))).collect()
}

fn names_of(entries: &[Value]) -> Vec<String> {
    entries.iter().filter_map(|e| e["name"].as_str().map(str::to_string)).collect()
}

fn write_entries(dir: &Path, entries: &[Value]) -> Result<(), String> {
    atomic_write(&dir.join(FILE), serde_json::to_string_pretty(entries).unwrap().as_bytes()).map_err(|e| e.to_string())
}

fn set_property(dir: &Path, on: bool) -> Result<(), String> {
    update_server_properties_safely(dir, &[("allow-list".to_string(), (if on { "true" } else { "false" }).to_string())]).map_err(|e| e.to_string())
}

pub fn is_allowlist_on(dir: &Path) -> bool {
    read_properties_file(dir).get("allow-list").is_some_and(|v| v.trim() == "true")
}

fn send_all(send: Send, running: bool, commands: &[String]) {
    if let (true, Some(f)) = (running, send) {
        for c in commands {
            f(c);
        }
    }
}

/// Adds friends and turns the allow-list on. Reports which were added, which were already there and which were not valid gamertags.
pub fn add_friends(dir: &Path, text: &str, running: bool, send: Send) -> Result<Value, String> {
    check_dir(dir)?;
    let (valid, invalid) = parse_names(text);
    let mut current = read_entries(dir);
    let mut have: HashSet<String> = names_of(&current).iter().map(|n| n.to_lowercase()).collect();
    let (mut added, mut already) = (Vec::new(), Vec::new());
    for name in valid {
        if !have.insert(name.to_lowercase()) {
            already.push(name);
            continue;
        }
        current.push(json!({ "ignoresPlayerLimit": false, "name": name }));
        added.push(name);
    }
    if !added.is_empty() {
        write_entries(dir, &current)?;
    }
    set_property(dir, true)?;
    let mut cmds: Vec<String> = added.iter().map(|n| format!("allowlist add \"{n}\"")).collect();
    cmds.extend(["allowlist on".to_string(), "allowlist reload".to_string()]);
    send_all(send, running, &cmds);
    Ok(json!({ "added": added, "already": already, "invalid": invalid, "cracked": false, "total": current.len(), "restartNeeded": !running && !added.is_empty() }))
}

pub fn remove_friend(dir: &Path, name: &str, running: bool, send: Send) -> Result<Value, String> {
    check_dir(dir)?;
    if !is_valid_gamertag(name) {
        return Err("That is not a valid gamertag.".into());
    }
    let current = read_entries(dir);
    let next: Vec<Value> = current.iter().filter(|e| !e["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))).cloned().collect();
    let changed = next.len() != current.len();
    if changed {
        write_entries(dir, &next)?;
    }
    send_all(send, running, &[format!("allowlist remove \"{name}\""), "allowlist reload".to_string()]);
    Ok(json!({ "total": next.len(), "restartNeeded": !running && changed }))
}

/// Turns the allow-list on or off. The names are kept so it can be turned back on.
pub fn set_enabled(dir: &Path, on: bool, running: bool, send: Send) -> Result<Value, String> {
    check_dir(dir)?;
    set_property(dir, on)?;
    send_all(send, running, &[(if on { "allowlist on" } else { "allowlist off" }).to_string(), "allowlist reload".to_string()]);
    Ok(json!({ "on": on, "restartNeeded": false }))
}

pub fn status(dir: &Path) -> Result<Value, String> {
    check_dir(dir)?;
    Ok(json!({ "enabled": is_allowlist_on(dir), "friends": names_of(&read_entries(dir)), "cracked": false }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn server(props: &str) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("server.properties"), format!("# Mojang defaults\nonline-mode=true\n{props}")).unwrap();
        d
    }
    fn stored(d: &Path) -> Vec<Value> {
        serde_json::from_str::<Vec<Value>>(&fs::read_to_string(d.join(FILE)).unwrap()).unwrap()
    }

    #[test]
    fn names_split_on_commas_and_lines_so_gamertags_may_hold_spaces() {
        let (valid, invalid) = parse_names("Steve Smith, alex;Steve smith\nBob_1\n\n  ,\"quote\", x\u{1}y, 12345678901234567890123456789012345");
        assert_eq!(valid, vec!["Steve Smith".to_string(), "alex".to_string(), "Bob_1".to_string()]);
        assert_eq!(invalid.len(), 3, "{invalid:?}");
    }

    #[test]
    fn adding_friends_writes_the_file_turns_the_list_on_and_tells_a_running_server() {
        let d = server("allow-list=false\n");
        fs::write(d.path().join(FILE), r#"[{"name":"Old Friend","xuid":"253500001","ignoresPlayerLimit":false}]"#).unwrap();
        let sent = RefCell::new(Vec::<String>::new());
        let push = |c: &str| sent.borrow_mut().push(c.to_string());
        let r = add_friends(d.path(), "Steve Smith, old friend, Alex", true, Some(&push)).unwrap();
        assert_eq!((r["added"].clone(), r["already"].clone(), r["total"].clone(), r["restartNeeded"].clone()), (json!(["Steve Smith", "Alex"]), json!(["old friend"]), json!(3), json!(false)));
        assert_eq!(*sent.borrow(), vec!["allowlist add \"Steve Smith\"", "allowlist add \"Alex\"", "allowlist on", "allowlist reload"]);
        let entries = stored(d.path());
        assert_eq!(entries[0]["xuid"], "253500001", "what the server stored is kept");
        assert_eq!(entries[1], json!({ "ignoresPlayerLimit": false, "name": "Steve Smith" }));
        let props = read_properties_file(d.path());
        assert_eq!((props["allow-list"].as_str(), props["online-mode"].as_str()), ("true", "true"));
        assert!(fs::read_to_string(d.path().join("server.properties")).unwrap().starts_with("# Mojang defaults\n"));
    }

    #[test]
    fn a_stopped_server_only_has_its_file_edited_and_asks_for_a_restart() {
        let d = server("");
        let sent = RefCell::new(Vec::<String>::new());
        let push = |c: &str| sent.borrow_mut().push(c.to_string());
        let r = add_friends(d.path(), "Alex", false, Some(&push)).unwrap();
        assert_eq!(r["restartNeeded"], true);
        assert!(sent.borrow().is_empty(), "nothing is sent to a server that is not running");
        let r = remove_friend(d.path(), "alex", false, Some(&push)).unwrap();
        assert_eq!((r["total"].clone(), r["restartNeeded"].clone()), (json!(0), json!(true)));
        assert!(stored(d.path()).is_empty());
    }

    #[test]
    fn removing_turning_off_and_status_follow_the_file() {
        let d = server("");
        add_friends(d.path(), "Alex, Sam", false, None).unwrap();
        assert_eq!(status(d.path()).unwrap(), json!({ "enabled": true, "friends": ["Alex", "Sam"], "cracked": false }));
        let sent = RefCell::new(Vec::<String>::new());
        let push = |c: &str| sent.borrow_mut().push(c.to_string());
        set_enabled(d.path(), false, true, Some(&push)).unwrap();
        assert_eq!(*sent.borrow(), vec!["allowlist off", "allowlist reload"]);
        assert_eq!(status(d.path()).unwrap()["enabled"], false);
        assert_eq!(status(d.path()).unwrap()["friends"], json!(["Alex", "Sam"]), "the names are kept");
        assert_eq!(remove_friend(d.path(), "a\"b", false, None).unwrap_err(), "That is not a valid gamertag.");
        assert_eq!(add_friends(Path::new("relative"), "x", false, None).unwrap_err(), "Invalid server folder.");
    }

    #[test]
    fn a_broken_file_reads_as_empty_and_bad_entries_are_dropped() {
        let d = server("");
        fs::write(d.path().join(FILE), "{ not json").unwrap();
        assert!(status(d.path()).unwrap()["friends"].as_array().unwrap().is_empty());
        fs::write(d.path().join(FILE), r#"[{"name":"Fine"},{"name":"fine"},{"name":"bad\"name"},{"nameless":1},7]"#).unwrap();
        assert_eq!(status(d.path()).unwrap()["friends"], json!(["Fine"]));
    }
}

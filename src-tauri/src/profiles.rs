//! Server profiles, read from `server-profiles.json` in the app's data folder (same file and rules as
//! serverProfiles.js). Read-only for now: writing profiles comes with the install and settings screens.
//! An entry that fails the checks is dropped rather than trusted, so a corrupt or hand-edited file can
//! never be used to start a process.

use std::path::Path;

use serde_json::Value;

const FILE: &str = "server-profiles.json";

pub fn list(data_dir: &Path) -> Vec<Value> {
    load(data_dir).into_iter().filter(is_valid).collect()
}

pub fn get(data_dir: &Path, id: &str) -> Option<Value> {
    list(data_dir).into_iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id))
}

fn load(data_dir: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(data_dir.join(FILE)) else { return Vec::new() };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => v.get("servers").and_then(Value::as_array).cloned().unwrap_or_default(),
        Err(_) => Vec::new(), // a corrupt store is treated as "no servers yet", as in Electron
    }
}

/// A JSON integer within [lo, hi].
fn int_in(v: &Value, lo: i64, hi: i64) -> bool {
    match v {
        Value::Number(n) => n.as_i64().is_some_and(|x| x >= lo && x <= hi),
        _ => false,
    }
}

pub fn is_valid(p: &Value) -> bool {
    let Some(o) = p.as_object() else { return false };
    let field = |k: &str| o.get(k);
    let opt = |k: &str| o.get(k).filter(|v| !v.is_null());

    let ok_core = field("id").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        && field("name").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
        && field("type").and_then(Value::as_str).is_some_and(|t| matches!(t, "vanilla" | "paper" | "fabric"))
        && field("version").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        && field("serverDir").and_then(Value::as_str).is_some_and(|s| Path::new(s).is_absolute())
        && field("port").is_some_and(|v| int_in(v, 1, 65535));
    if !ok_core {
        return false;
    }
    let (Some(min), Some(max)) = (field("minRamMb"), field("maxRamMb")) else { return false };
    if !int_in(min, 256, 131_072) || !int_in(max, 256, 131_072) || max.as_i64() < min.as_i64() {
        return false;
    }
    if let Some(b) = opt("build") {
        if !b.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 120) {
            return false;
        }
    }
    if let Some(j) = opt("javaMajor") {
        if !int_in(j, 8, 99) {
            return false;
        }
    }
    if let Some(b) = opt("bedrock") {
        if !b.is_boolean() {
            return false;
        }
    }
    if let Some(v) = opt("voice") {
        let ok = v.get("enabled").is_some_and(Value::is_boolean)
            && v.get("plugin").and_then(Value::as_str).is_some_and(|s| s == "simple" || s == "plasmo")
            && v.get("port").is_some_and(|p| int_in(p, 1, 65535));
        if !ok {
            return false;
        }
    }
    if let Some(l) = opt("listing") {
        let ok = l.get("enabled").is_some_and(Value::is_boolean)
            && l.get("description").map_or(true, |d| d.is_null() || d.as_str().is_some_and(|s| s.chars().count() <= 160));
        if !ok {
            return false;
        }
    }
    if let Some(b) = opt("backups") {
        let range = |k: &str, lo, hi| b.get(k).map_or(true, |v| v.is_null() || int_in(v, lo, hi));
        let ok = b.is_object() && b.get("auto").map_or(true, |v| v.is_null() || v.is_boolean()) && range("intervalMin", 5, 720) && range("keep", 1, 30);
        if !ok {
            return false;
        }
    }
    if let Some(t) = opt("template") {
        let ok = t.as_str().is_some_and(|s| (1..=32).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'));
        if !ok {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn good() -> Value {
        let dir = std::env::temp_dir().join("vp-server");
        json!({"id":"a1","name":"My Server","type":"paper","version":"1.21.4","serverDir":dir.to_string_lossy(),"port":25565,"minRamMb":1024,"maxRamMb":2048})
    }

    #[test]
    fn a_complete_profile_is_valid() {
        assert!(is_valid(&good()));
    }

    #[test]
    fn broken_profiles_are_dropped() {
        let cases: Vec<(&str, Value)> = vec![
            ("type", json!("forge")),
            ("port", json!(0)),
            ("port", json!(70000)),
            ("minRamMb", json!(100)),
            ("maxRamMb", json!(512)),
            ("serverDir", json!("relative/path")),
            ("name", json!("   ")),
            ("id", json!("")),
        ];
        for (key, bad) in cases {
            let mut p = good();
            p[key] = bad.clone();
            assert!(!is_valid(&p), "{key}={bad} should be rejected");
        }
        assert!(!is_valid(&json!("nope")));
        assert!(!is_valid(&json!(null)));
    }

    #[test]
    fn optional_fields_are_checked_when_present() {
        let mut p = good();
        p["bedrock"] = json!(true);
        p["javaMajor"] = json!(21);
        p["template"] = json!("survival-smp");
        p["backups"] = json!({"auto": true, "intervalMin": 30, "keep": 5});
        p["listing"] = json!({"enabled": true, "description": "hi"});
        p["voice"] = json!({"enabled": true, "plugin": "simple", "port": 24454});
        assert!(is_valid(&p));
        p["javaMajor"] = json!(3);
        assert!(!is_valid(&p));
        p["javaMajor"] = json!(21);
        p["backups"] = json!({"intervalMin": 1});
        assert!(!is_valid(&p));
        p["backups"] = json!({"keep": 5});
        p["template"] = json!("Bad Template!");
        assert!(!is_valid(&p));
    }

    #[test]
    fn a_missing_or_corrupt_store_means_no_servers() {
        let dir = std::env::temp_dir().join(format!("vp-profiles-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(list(&dir).is_empty());
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        assert!(list(&dir).is_empty());
        std::fs::write(dir.join(FILE), serde_json::to_string(&json!({"version":2,"servers":[good(), {"id":"bad"}]})).unwrap()).unwrap();
        assert_eq!(list(&dir).len(), 1);
        assert!(get(&dir, "a1").is_some());
        assert!(get(&dir, "zzz").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}


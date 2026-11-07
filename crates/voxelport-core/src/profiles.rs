//! Server profiles: the list of servers the person has set up, in `server-profiles.json` in the app's data folder. Same
//! file, shape and validation rules as `serverProfiles.js`. A profile only ever points at a folder; removing one never
//! touches the folder.
//!
//! Two deliberate differences from the Electron module, both about not destroying what this build does not understand:
//! entries that fail validation are left in the file (they are just not listed), and a store that cannot be parsed is
//! copied aside before a new one is started.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::atomic_write;

pub const FILE: &str = "server-profiles.json";
const LEGACY_FILE: &str = "server-config.json";
const STORE_VERSION: i64 = 2;

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


// ─── The store ──────────────────────────────────────────────────────────────

fn iso_now() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let (secs, milli) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milli:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("random source");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// JavaScript's `Number(x)` for the values the screens send: numbers stay, numeric strings are read, anything else is
/// not a number (stored as null, which then fails validation).
fn to_number(v: &Value) -> Value {
    match v {
        Value::Number(_) => v.clone(),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite())
            .map(|f| if f.fract() == 0.0 { json!(f as i64) } else { json!(f) })
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn read_doc(dir: &Path) -> Option<Value> {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).ok()?).ok()?;
    doc.get("servers").is_some_and(Value::is_array).then_some(doc)
}

fn write_doc(dir: &Path, doc: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(FILE), serde_json::to_string_pretty(doc).unwrap().as_bytes()).map_err(|e| e.to_string())
}

/// The store as it is on disk. If there is none, a one-time migration from the old single-server `server-config.json`
/// runs (once: after that the store exists, even if empty, so a deleted server is never resurrected); the old file is
/// renamed, not deleted. A store that exists but cannot be parsed is copied aside first.
fn load_doc(dir: &Path) -> Value {
    if let Some(doc) = read_doc(dir) {
        return doc;
    }
    let file = dir.join(FILE);
    if file.exists() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let _ = std::fs::copy(&file, dir.join(format!("server-profiles.unreadable-{stamp}.json")));
    }
    let legacy_path = dir.join(LEGACY_FILE);
    let fresh = json!({ "version": STORE_VERSION, "servers": [] });
    let Some(legacy) = std::fs::read_to_string(&legacy_path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        let _ = write_doc(dir, &fresh);
        return fresh;
    };
    let now = iso_now();
    let min_ram = legacy["minRamMb"].as_i64().unwrap_or(1024);
    let profile = json!({
        "id": new_id(),
        "name": "My Server",
        "type": legacy["type"],
        "version": legacy["version"],
        // Earlier builds never stored the folder: it was always the one default install location.
        "serverDir": legacy["serverDir"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| dir.join("server").to_string_lossy().into_owned()),
        "port": to_number(&legacy["port"]),
        "minRamMb": min_ram,
        "maxRamMb": legacy["maxRamMb"].as_i64().unwrap_or(min_ram),
        "createdAt": now,
        "lastUsedAt": now,
    });
    let doc = if is_valid(&profile) { json!({ "version": STORE_VERSION, "servers": [profile] }) } else { fresh };
    let _ = write_doc(dir, &doc);
    let _ = std::fs::rename(&legacy_path, dir.join(format!("{LEGACY_FILE}.migrated-backup")));
    doc
}

fn servers_mut(doc: &mut Value) -> &mut Vec<Value> {
    doc["servers"].as_array_mut().expect("store has a servers array")
}

fn id_of(p: &Value) -> Option<&str> {
    p.get("id").and_then(Value::as_str)
}

/// The valid servers, in stored order.
pub fn list(dir: &Path) -> Vec<Value> {
    load_doc(dir)["servers"].as_array().map(|a| a.iter().filter(|p| is_valid(p)).cloned().collect()).unwrap_or_default()
}

pub fn get(dir: &Path, id: &str) -> Option<Value> {
    list(dir).into_iter().find(|p| id_of(p) == Some(id))
}

/// Adds a server. `input` carries name, type, version, serverDir, port, minRamMb, maxRamMb and optionally build and
/// template; the id and the two timestamps are made here.
pub fn create(dir: &Path, input: &Value) -> Result<Value, String> {
    let now = iso_now();
    let name = input["name"].as_str().unwrap_or("").trim();
    let mut profile = json!({
        "id": new_id(),
        "name": if name.is_empty() { "My Server" } else { name },
        "type": input["type"],
        "version": input["version"],
        "serverDir": input["serverDir"],
        "port": to_number(&input["port"]),
        "minRamMb": to_number(&input["minRamMb"]),
        "maxRamMb": to_number(&input["maxRamMb"]),
        "createdAt": now,
        "lastUsedAt": now,
    });
    if let Some(b) = input["build"].as_str().filter(|b| !b.is_empty()) {
        profile["build"] = json!(b);
    }
    if let Some(t) = input["template"].as_str().filter(|t| !t.is_empty()) {
        profile["template"] = json!(t);
    }
    if !is_valid(&profile) {
        return Err("Invalid server profile.".into());
    }
    let mut doc = load_doc(dir);
    servers_mut(&mut doc).push(profile.clone());
    write_doc(dir, &doc)?;
    Ok(profile)
}

/// Changes fields of one server. The id never changes; port and RAM are read as numbers; a null removes a field; the result must be valid.
pub fn update(dir: &Path, id: &str, changes: &Map<String, Value>) -> Result<Value, String> {
    let mut doc = load_doc(dir);
    let list = servers_mut(&mut doc);
    let idx = list.iter().position(|p| id_of(p) == Some(id) && is_valid(p)).ok_or("Server profile not found.")?;
    let mut merged = list[idx].clone();
    for (k, v) in changes {
        if k == "id" {
            continue;
        }
        if v.is_null() {
            // A null removes the field (as setting a JavaScript property to undefined did): e.g. a Java minimum that no longer applies.
            if let Some(o) = merged.as_object_mut() {
                o.shift_remove(k.as_str());
            }
            continue;
        }
        merged[k.as_str()] = if matches!(k.as_str(), "port" | "minRamMb" | "maxRamMb") { to_number(v) } else { v.clone() };
    }
    if let Some(n) = merged["name"].as_str() {
        merged["name"] = json!(n.trim());
    }
    if !is_valid(&merged) {
        return Err("Invalid server profile.".into());
    }
    list[idx] = merged.clone();
    write_doc(dir, &doc)?;
    Ok(merged)
}

/// Notes that a server was just used. Best effort: never lets bookkeeping break the real action.
pub fn touch(dir: &Path, id: &str) {
    let mut c = Map::new();
    c.insert("lastUsedAt".into(), json!(iso_now()));
    let _ = update(dir, id, &c);
}

/// Forgets a server. Never touches its folder.
pub fn delete(dir: &Path, id: &str) -> bool {
    let mut doc = load_doc(dir);
    let list = servers_mut(&mut doc);
    let before = list.len();
    list.retain(|p| !(id_of(p) == Some(id) && is_valid(p)));
    let removed = list.len() != before;
    removed && write_doc(dir, &doc).is_ok()
}

/// Remembers that a server needs at least this Java (after the server itself said so).
pub fn set_java_major(dir: &Path, id: &str, major: u32) -> bool {
    let mut c = Map::new();
    c.insert("javaMajor".into(), json!(major));
    update(dir, id, &c).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn good() -> Value {
        let dir = std::env::temp_dir().join("vp-server");
        json!({"id":"a1","name":"My Server","type":"paper","version":"1.21.4","serverDir":dir.to_string_lossy(),"port":25565,"minRamMb":1024,"maxRamMb":2048})
    }
    fn input(name: &str) -> Value {
        json!({"name": name, "type": "paper", "version": "1.21.4", "serverDir": std::env::temp_dir().join("vp-input").to_string_lossy(), "port": "25570", "minRamMb": 1024, "maxRamMb": "2048"})
    }
    fn changes(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn a_complete_profile_is_valid_and_broken_ones_are_not() {
        assert!(is_valid(&good()));
        let cases: Vec<(&str, Value)> = vec![("type", json!("forge")), ("port", json!(0)), ("port", json!(70000)), ("minRamMb", json!(100)), ("maxRamMb", json!(512)), ("serverDir", json!("relative/path")), ("name", json!("   ")), ("id", json!(""))];
        for (key, bad) in cases {
            let mut p = good();
            p[key] = bad.clone();
            assert!(!is_valid(&p), "{key}={bad}");
        }
        assert!(!is_valid(&json!("nope")) && !is_valid(&Value::Null));
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
    fn a_first_run_makes_an_empty_store_and_create_get_list_work() {
        let d = tmp();
        assert!(list(d.path()).is_empty());
        assert!(d.path().join(FILE).exists());
        let p = create(d.path(), &input("  Survival  ")).unwrap();
        assert_eq!((p["name"].clone(), p["port"].clone(), p["maxRamMb"].clone()), (json!("Survival"), json!(25570), json!(2048)));
        assert!(p["id"].as_str().unwrap().len() == 36 && p["createdAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(p["createdAt"], p["lastUsedAt"]);
        assert_eq!(get(d.path(), p["id"].as_str().unwrap()), Some(p.clone()));
        assert_eq!(list(d.path()), vec![p]);
        assert_eq!(create(d.path(), &input("")).unwrap()["name"], "My Server");
    }

    #[test]
    fn keys_are_written_in_the_electron_order() {
        let d = tmp();
        let mut i = input("A");
        i["build"] = json!("123");
        i["template"] = json!("survival");
        let p = create(d.path(), &i).unwrap();
        let keys: Vec<&str> = p.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["id", "name", "type", "version", "serverDir", "port", "minRamMb", "maxRamMb", "createdAt", "lastUsedAt", "build", "template"]);
    }

    #[test]
    fn invalid_input_is_refused_and_nothing_is_stored() {
        let d = tmp();
        for (k, bad) in [("type", json!("forge")), ("port", json!("abc")), ("port", json!(0)), ("serverDir", json!("rel")), ("minRamMb", json!(10))] {
            let mut i = input("X");
            i[k] = bad.clone();
            assert_eq!(create(d.path(), &i).unwrap_err(), "Invalid server profile.", "{k}={bad}");
        }
        assert!(list(d.path()).is_empty());
    }

    #[test]
    fn update_merges_coerces_and_validates() {
        let d = tmp();
        let id = create(d.path(), &input("One")).unwrap()["id"].as_str().unwrap().to_string();
        let u = update(d.path(), &id, &changes(json!({"name": "  Two ", "port": "25580", "id": "hijack", "minRamMb": 512, "maxRamMb": 4096}))).unwrap();
        assert_eq!((u["id"].clone(), u["name"].clone(), u["port"].clone(), u["minRamMb"].clone()), (json!(id), json!("Two"), json!(25580), json!(512)));
        assert_eq!(update(d.path(), &id, &changes(json!({"port": "nope"}))).unwrap_err(), "Invalid server profile.");
        assert_eq!(update(d.path(), &id, &changes(json!({"maxRamMb": 100}))).unwrap_err(), "Invalid server profile.");
        assert_eq!(update(d.path(), "nope", &changes(json!({"name": "x"}))).unwrap_err(), "Server profile not found.");
        assert_eq!(get(d.path(), &id).unwrap()["name"], "Two", "a refused change stores nothing");
    }

    #[test]
    fn delete_forgets_the_server_and_nothing_else() {
        let d = tmp();
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join("server.properties"), "x").unwrap();
        let mut i = input("Keep files");
        i["serverDir"] = json!(folder.path().to_string_lossy());
        let a = create(d.path(), &i).unwrap()["id"].as_str().unwrap().to_string();
        let b = create(d.path(), &input("Other")).unwrap()["id"].as_str().unwrap().to_string();
        assert!(delete(d.path(), &a));
        assert!(!delete(d.path(), &a));
        assert_eq!(list(d.path()).len(), 1);
        assert!(get(d.path(), &b).is_some());
        assert!(folder.path().join("server.properties").exists(), "the folder is never touched");
    }

    #[test]
    fn touch_updates_only_the_last_used_time() {
        let d = tmp();
        let p = create(d.path(), &input("T")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        touch(d.path(), p["id"].as_str().unwrap());
        let q = get(d.path(), p["id"].as_str().unwrap()).unwrap();
        assert_ne!(q["lastUsedAt"], p["lastUsedAt"]);
        assert_eq!((q["createdAt"].clone(), q["name"].clone()), (p["createdAt"].clone(), p["name"].clone()));
        touch(d.path(), "nope"); // no panic, no effect
    }

    #[test]
    fn invalid_entries_and_unknown_fields_survive_every_write() {
        let d = tmp();
        let mut known = good();
        known["somethingNew"] = json!({"kept": true});
        std::fs::write(d.path().join(FILE), serde_json::to_string(&json!({"version": 2, "extra": 7, "servers": [known.clone(), {"id": "bad", "hand": "edited"}]})).unwrap()).unwrap();
        assert_eq!(list(d.path()).len(), 1);
        create(d.path(), &input("New")).unwrap();
        update(d.path(), "a1", &changes(json!({"name": "Renamed"}))).unwrap();
        assert!(set_java_major(d.path(), "a1", 25));
        let after: Value = serde_json::from_str(&std::fs::read_to_string(d.path().join(FILE)).unwrap()).unwrap();
        assert_eq!((after["version"].clone(), after["extra"].clone()), (json!(2), json!(7)));
        let servers = after["servers"].as_array().unwrap();
        assert_eq!(servers.len(), 3);
        assert_eq!(servers[0]["somethingNew"], json!({"kept": true}));
        assert_eq!((servers[0]["name"].clone(), servers[0]["javaMajor"].clone()), (json!("Renamed"), json!(25)));
        assert_eq!(servers[1], json!({"id": "bad", "hand": "edited"}), "the broken entry is still there");
    }

    #[test]
    fn a_corrupt_store_is_copied_aside_not_silently_replaced() {
        let d = tmp();
        std::fs::write(d.path().join(FILE), "{ not json").unwrap();
        assert!(list(d.path()).is_empty());
        let copies: Vec<_> = std::fs::read_dir(d.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("server-profiles.unreadable-")).collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(std::fs::read_to_string(copies[0].path()).unwrap(), "{ not json");
        create(d.path(), &input("After")).unwrap();
        assert_eq!(list(d.path()).len(), 1);
    }

    #[test]
    fn the_old_single_server_config_migrates_once() {
        let d = tmp();
        std::fs::write(d.path().join(LEGACY_FILE), json!({"type": "paper", "version": "1.20.4", "port": 25565, "minRamMb": 1024}).to_string()).unwrap();
        let l = list(d.path());
        assert_eq!(l.len(), 1);
        assert_eq!((l[0]["name"].clone(), l[0]["maxRamMb"].clone()), (json!("My Server"), json!(1024)));
        assert!(l[0]["serverDir"].as_str().unwrap().ends_with("server"), "falls back to the conventional folder");
        assert!(!d.path().join(LEGACY_FILE).exists() && d.path().join("server-config.json.migrated-backup").exists());
        let id = l[0]["id"].as_str().unwrap().to_string();
        assert!(delete(d.path(), &id));
        assert!(list(d.path()).is_empty(), "a deleted server is never resurrected");
        // An unusable legacy file gives an empty store.
        let e = tmp();
        std::fs::write(e.path().join(LEGACY_FILE), json!({"type": "forge"}).to_string()).unwrap();
        assert!(list(e.path()).is_empty());
    }

    #[test]
    fn remembering_a_java_major_changes_only_that_field() {
        let d = tmp();
        let mut a = good();
        let mut b = good();
        a["id"] = json!("a");
        b["id"] = json!("b");
        std::fs::write(d.path().join(FILE), serde_json::to_string(&json!({"version": 2, "servers": [a.clone(), b]})).unwrap()).unwrap();
        assert!(set_java_major(d.path(), "b", 25));
        assert_eq!(get(d.path(), "a"), Some(a));
        assert_eq!(get(d.path(), "b").unwrap()["javaMajor"], 25);
        assert!(!set_java_major(d.path(), "nope", 25) && !set_java_major(d.path(), "a", 7) && !set_java_major(d.path(), "a", 100));
    }

    #[test]
    fn timestamps_are_iso_like_javascripts() {
        let t = iso_now();
        assert_eq!(t.len(), 24);
        assert!(t.starts_with("20") && t.as_bytes()[4] == b'-' && t.as_bytes()[10] == b'T' && t.as_bytes()[19] == b'.' && t.ends_with('Z'), "{t}");
    }
}

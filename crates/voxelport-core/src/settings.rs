//! The `server.properties` settings the Settings screen can change, with their validation. Ported from `serverSettings.js`.
//!
//! Anything not in [`SETTINGS`] is never written from the screens, and the security-sensitive keys (`online-mode`,
//! `enable-rcon`, `rcon.password`, `enable-command-block`...) are deliberately absent so they cannot be weakened from the
//! page. The one exception, the confirmed "cracked players" switch, has its own narrow code path in `cracked.rs`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug)]
pub enum Kind {
    Text { max: usize, def: &'static str },
    Enum { options: &'static [&'static str], def: &'static str },
    Bool { def: bool },
    Int { min: i64, max: i64, def: i64 },
}

pub struct Setting {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: Kind,
}

pub const SETTINGS: &[Setting] = &[
    Setting { key: "motd", label: "Description (MOTD)", kind: Kind::Text { max: 59, def: "A VoxelPort server" } },
    Setting { key: "gamemode", label: "Game mode", kind: Kind::Enum { options: &["survival", "creative", "adventure", "spectator"], def: "survival" } },
    Setting { key: "difficulty", label: "Difficulty", kind: Kind::Enum { options: &["peaceful", "easy", "normal", "hard"], def: "easy" } },
    Setting { key: "hardcore", label: "Hardcore (one life)", kind: Kind::Bool { def: false } },
    Setting { key: "pvp", label: "PvP", kind: Kind::Bool { def: true } },
    Setting { key: "max-players", label: "Max players", kind: Kind::Int { min: 1, max: 1000, def: 20 } },
    Setting { key: "white-list", label: "Whitelist (only approved players)", kind: Kind::Bool { def: false } },
    Setting { key: "allow-flight", label: "Allow flight", kind: Kind::Bool { def: false } },
    Setting { key: "view-distance", label: "View distance (chunks)", kind: Kind::Int { min: 3, max: 32, def: 10 } },
    Setting { key: "simulation-distance", label: "Simulation distance (chunks)", kind: Kind::Int { min: 3, max: 32, def: 10 } },
    Setting { key: "spawn-protection", label: "Spawn protection (blocks)", kind: Kind::Int { min: 0, max: 64, def: 16 } },
    Setting { key: "level-seed", label: "World seed (new worlds only)", kind: Kind::Text { max: 64, def: "" } },
];

/// What the Settings screen changes on a Bedrock Dedicated Server. Its `server.properties` is a different file from Java's: other keys, other
/// values. `online-mode` (Xbox sign-in) and the other security keys are absent here for the same reason as above.
pub const BEDROCK_SETTINGS: &[Setting] = &[
    Setting { key: "server-name", label: "Name in the server list", kind: Kind::Text { max: 50, def: "A VoxelPort server" } },
    Setting { key: "gamemode", label: "Game mode", kind: Kind::Enum { options: &["survival", "creative", "adventure"], def: "survival" } },
    Setting { key: "difficulty", label: "Difficulty", kind: Kind::Enum { options: &["peaceful", "easy", "normal", "hard"], def: "easy" } },
    Setting { key: "max-players", label: "Max players", kind: Kind::Int { min: 1, max: 1000, def: 10 } },
    Setting { key: "allow-list", label: "Allow-list (only approved players)", kind: Kind::Bool { def: false } },
    Setting { key: "allow-cheats", label: "Allow cheats", kind: Kind::Bool { def: false } },
    Setting { key: "default-player-permission-level", label: "New players can", kind: Kind::Enum { options: &["visitor", "member", "operator"], def: "member" } },
    Setting { key: "view-distance", label: "View distance (chunks)", kind: Kind::Int { min: 5, max: 64, def: 32 } },
    Setting { key: "tick-distance", label: "Simulation distance (chunks)", kind: Kind::Int { min: 4, max: 12, def: 4 } },
    Setting { key: "level-seed", label: "World seed (new worlds only)", kind: Kind::Text { max: 64, def: "" } },
];

/// The settings of a server type.
pub fn settings_for(server_type: &str) -> &'static [Setting] {
    if crate::bds::is_bedrock_server(server_type) { BEDROCK_SETTINGS } else { SETTINGS }
}

/// The field list the Settings screen draws (same shape as the Electron app's `SETTINGS`).
pub fn fields_json() -> Value {
    fields_json_for("")
}

pub fn fields_json_for(server_type: &str) -> Value {
    Value::Array(
        settings_for(server_type)
            .iter()
            .map(|s| match s.kind {
                Kind::Text { max, def } => json!({ "key": s.key, "label": s.label, "type": "text", "max": max, "def": def }),
                Kind::Enum { options, def } => json!({ "key": s.key, "label": s.label, "type": "enum", "options": options, "def": def }),
                Kind::Bool { def } => json!({ "key": s.key, "label": s.label, "type": "bool", "def": def }),
                Kind::Int { min, max, def } => json!({ "key": s.key, "label": s.label, "type": "int", "min": min, "max": max, "def": def }),
            })
            .collect(),
    )
}

fn unescape_prop(s: &str) -> String {
    let mut out: Vec<u16> = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let n = chars[i + 1];
            if n == 'u' && i + 5 < chars.len() && chars[i + 2..i + 6].iter().all(char::is_ascii_hexdigit) {
                let hex: String = chars[i + 2..i + 6].iter().collect();
                out.push(u16::from_str_radix(&hex, 16).unwrap_or(0xfffd));
                i += 6;
                continue;
            }
            let mapped = match n {
                't' => '\t',
                'n' => '\n',
                'r' => '\r',
                'f' => '\u{c}',
                other => other,
            };
            let mut b = [0u16; 2];
            out.extend_from_slice(mapped.encode_utf16(&mut b));
            i += 2;
            continue;
        }
        let mut b = [0u16; 2];
        out.extend_from_slice(c.encode_utf16(&mut b));
        i += 1;
    }
    String::from_utf16_lossy(&out)
}

/// Escapes a value for `server.properties`: backslash and everything non-ASCII as `\uXXXX`, so it reads the same in every
/// Minecraft version. Control characters are dropped, so a value can never smuggle in a new line.
pub fn escape_value(s: &str) -> String {
    let mut out = String::new();
    for unit in s.encode_utf16() {
        match unit {
            0x5c => out.push_str("\\\\"),
            u if u < 0x20 || u == 0x7f => {}
            u if u > 0x7e => out.push_str(&format!("\\u{u:04x}")),
            u => out.push(u as u8 as char),
        }
    }
    out
}

/// Parses `server.properties` text (the Java `.properties` subset Minecraft writes). Later lines win.
pub fn parse_properties(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = raw.trim_start();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        // The key runs to the first unescaped '=', ':' or whitespace.
        let chars: Vec<(usize, char)> = line.char_indices().collect();
        let mut end = line.len();
        let mut i = 0;
        while i < chars.len() {
            let (pos, c) = chars[i];
            if c == '\\' {
                i += 2;
                continue;
            }
            if c == '=' || c == ':' || c.is_whitespace() {
                end = pos;
                break;
            }
            i += 1;
        }
        let key = &line[..end.min(line.len())];
        if key.is_empty() {
            continue;
        }
        let mut rest = line[end.min(line.len())..].trim_start();
        if let Some(r) = rest.strip_prefix(['=', ':']) {
            rest = r.trim_start();
        }
        out.insert(unescape_prop(key), unescape_prop(rest));
    }
    out
}

/// A Bedrock Dedicated Server's `server.properties`: plain `key=value` lines in UTF-8, with no escapes (a backslash is a backslash, and
/// "é" is "é", not "\u00e9"). Reading it as Java's format would mangle names and writing it that way would show the escapes in the game.
pub fn parse_properties_raw(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if !key.trim().is_empty() {
                out.insert(key.trim().to_string(), value.to_string());
            }
        }
    }
    out
}

pub fn read_properties_file_raw(server_dir: &Path) -> HashMap<String, String> {
    fs::read_to_string(server_dir.join("server.properties")).map(|t| parse_properties_raw(&t)).unwrap_or_default()
}

pub fn read_properties_file(server_dir: &Path) -> HashMap<String, String> {
    fs::read_to_string(server_dir.join("server.properties")).map(|t| parse_properties(&t)).unwrap_or_default()
}

/// `parseInt(raw, 10)`: the leading integer, ignoring what follows.
fn parse_int_prefix(raw: &str) -> Option<i64> {
    let t = raw.trim_start();
    let (sign, digits) = match t.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, t.strip_prefix('+').unwrap_or(t)),
    };
    let d: String = digits.chars().take_while(char::is_ascii_digit).collect();
    d.parse::<i64>().ok().map(|n| n * sign)
}

/// Current values of every editable setting (defaults where missing or unreadable).
pub fn read_settings(server_dir: &Path) -> Value {
    read_settings_for("", server_dir)
}

pub fn read_settings_for(server_type: &str, server_dir: &Path) -> Value {
    let props = if crate::bds::is_bedrock_server(server_type) { read_properties_file_raw(server_dir) } else { read_properties_file(server_dir) };
    let mut out = Map::new();
    for s in settings_for(server_type) {
        let raw = props.get(s.key);
        let v = match (s.kind, raw) {
            (Kind::Text { def, .. } | Kind::Enum { def, .. }, None) => json!(def),
            (Kind::Bool { def }, None) => json!(def),
            (Kind::Int { def, .. }, None) => json!(def),
            (Kind::Bool { .. }, Some(r)) => json!(r.trim().eq_ignore_ascii_case("true")),
            (Kind::Int { def, .. }, Some(r)) => json!(parse_int_prefix(r).unwrap_or(def)),
            (_, Some(r)) => json!(r),
        };
        out.insert(s.key.to_string(), v);
    }
    Value::Object(out)
}

fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { Some(0.0) } else { t.parse().ok() }
        }
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// Validates changes from the screens and returns them as escaped `server.properties` strings. Unknown keys and invalid
/// values are errors: the screen never sends them, so a bad value means something is wrong.
pub fn validate_settings(changes: &Value) -> Result<Vec<(String, String)>, String> {
    validate_settings_for("", changes)
}

pub fn validate_settings_for(server_type: &str, changes: &Value) -> Result<Vec<(String, String)>, String> {
    let Some(map) = changes.as_object() else { return Err("Invalid settings.".into()) };
    let mut out: Vec<(String, String)> = Vec::new();
    for (key, value) in map {
        let Some(s) = settings_for(server_type).iter().find(|s| s.key == key) else { return Err(format!("\"{key}\" can't be changed here.")) };
        let text = match s.kind {
            Kind::Bool { .. } => match value {
                Value::Bool(b) => (if *b { "true" } else { "false" }).to_string(),
                _ => return Err(format!("{} must be on or off.", s.label)),
            },
            Kind::Int { min, max, .. } => {
                let n = js_number(value).filter(|n| n.fract() == 0.0 && n.is_finite() && *n >= min as f64 && *n <= max as f64);
                match n {
                    Some(n) => (n as i64).to_string(),
                    None => return Err(format!("{} must be between {min} and {max}.", s.label)),
                }
            }
            Kind::Enum { options, .. } => match value.as_str() {
                Some(v) if options.contains(&v) => v.to_string(),
                _ => return Err(format!("Invalid {}.", s.label.to_lowercase())),
            },
            Kind::Text { max, .. } => {
                let Some(v) = value.as_str() else { return Err(format!("Invalid {}.", s.label.to_lowercase())) };
                let clean: String = v.chars().filter(|c| !(*c <= '\u{1f}' || *c == '\u{7f}')).collect();
                let clean = clean.trim();
                if clean.chars().count() > max {
                    return Err(format!("{} can be at most {max} characters.", s.label));
                }
                // Java's file escapes non-ASCII text; the Bedrock server's file holds it as it is.
                if crate::bds::is_bedrock_server(server_type) { clean.to_string() } else { escape_value(clean) }
            }
        };
        out.push((key.clone(), text));
    }
    // Whitelist on should actually keep non-whitelisted players out. (The Bedrock server has one key, `allow-list`, for both.)
    if let Some((_, v)) = out.iter().find(|(k, _)| k == "white-list").cloned() {
        out.push(("enforce-whitelist".into(), v));
    }
    Ok(out)
}

/// The game-mode label shown on the public server list.
pub fn listing_mode(values: &Value, server_type: &str) -> &'static str {
    if values["hardcore"].as_bool().unwrap_or(false) {
        return "hardcore";
    }
    if server_type == "fabric" {
        return "modded";
    }
    match values["gamemode"].as_str() {
        Some("survival") => "survival",
        Some("creative") => "creative",
        Some("adventure") => "adventure",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_install::{update_server_properties_safely, write_server_properties};

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn minecraft_style_properties_are_read() {
        let p = parse_properties("#Minecraft server properties\nmotd=Hi \\u00e9t\\u00e9\nlevel-type=minecraft\\:flat\nmax-players = 12\n\npvp=false\n! another comment\nkey: colon\r\n");
        assert_eq!(p["motd"], "Hi été");
        assert_eq!(p["level-type"], "minecraft:flat");
        assert_eq!(p["max-players"], "12");
        assert_eq!(p["pvp"], "false");
        assert_eq!(p["key"], "colon");
        assert!(!p.contains_key("!"));
    }

    #[test]
    fn escaping_keeps_one_line_and_round_trips_non_ascii() {
        assert_eq!(escape_value("a\\b"), "a\\\\b");
        assert_eq!(escape_value("x\nenable-rcon=true"), "xenable-rcon=true");
        assert_eq!(parse_properties(&format!("motd={}", escape_value("Café 🎮")))["motd"], "Café 🎮");
    }

    #[test]
    fn typed_values_come_back_with_defaults() {
        let d = tmp();
        std::fs::write(d.path().join("server.properties"), "gamemode=creative\nhardcore=true\nmax-players=7\nview-distance=oops\nspawn-protection=12abc\n").unwrap();
        let v = read_settings(d.path());
        assert_eq!(v["gamemode"], "creative");
        assert_eq!(v["hardcore"], true);
        assert_eq!(v["max-players"], 7);
        assert_eq!(v["view-distance"], 10, "unparsable gives the default");
        assert_eq!(v["spawn-protection"], 12, "like parseInt, the leading number counts");
        assert_eq!(v["difficulty"], "easy", "missing gives the default");
        assert_eq!(read_settings(&d.path().join("nope"))["max-players"], 20);
    }

    #[test]
    fn good_values_are_checked_and_escaped() {
        let out = validate_settings(&json!({ "gamemode": "survival", "hardcore": false, "max-players": 50, "motd": "  My Server ", "white-list": true })).unwrap();
        let get = |k: &str| out.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!((get("gamemode"), get("hardcore"), get("max-players"), get("motd"), get("white-list"), get("enforce-whitelist")), (Some("survival"), Some("false"), Some("50"), Some("My Server"), Some("true"), Some("true")));
        assert_eq!(validate_settings(&json!({ "max-players": "25" })).unwrap()[0].1, "25", "a numeric string counts, as Number() reads it");
    }

    #[test]
    fn unknown_dangerous_and_bad_values_are_refused() {
        let err = |v: Value| validate_settings(&v).unwrap_err();
        assert!(err(json!({ "online-mode": false })).contains("can't be changed"));
        assert!(err(json!({ "enable-rcon": true })).contains("can't be changed"));
        assert!(err(json!({ "rcon.password": "x" })).contains("can't be changed"));
        assert!(err(json!({ "gamemode": "god" })).contains("Invalid"));
        assert!(err(json!({ "max-players": 0 })).contains("between"));
        assert!(err(json!({ "max-players": 2.5 })).contains("between"));
        assert!(err(json!({ "max-players": "abc" })).contains("between"));
        assert!(err(json!({ "pvp": "yes" })).contains("on or off"));
        assert!(err(json!({ "motd": "x".repeat(60) })).contains("at most"));
        assert_eq!(err(json!("nope")), "Invalid settings.");
        assert_eq!(err(Value::Null), "Invalid settings.");
    }

    #[test]
    fn a_bedrock_server_has_its_own_settings_and_keeps_the_security_keys_out_of_reach() {
        let d = tmp();
        std::fs::write(d.path().join("server.properties"), "# Mojang defaults\nserver-name=Dedicated Server\ngamemode=creative\nmax-players=7\nview-distance=oops\nallow-list=true\nonline-mode=true\n").unwrap();
        let ty = crate::bds::TYPE_ID;
        let v = read_settings_for(ty, d.path());
        assert_eq!((v["server-name"].clone(), v["gamemode"].clone(), v["max-players"].clone(), v["view-distance"].clone(), v["allow-list"].clone()), ("Dedicated Server".into(), "creative".into(), 7.into(), 32.into(), true.into()));
        assert_eq!(v["default-player-permission-level"], "member", "missing gives the default");
        assert!(v.get("motd").is_none() && v.get("pvp").is_none(), "Java's settings are not shown");
        assert!(read_settings_for("paper", d.path()).get("server-name").is_none());
        // Its file has no escapes: a name keeps its accents and backslashes, in both directions.
        let raw = validate_settings_for(ty, &json!({ "server-name": "Café 🎮 a\\b" })).unwrap();
        assert_eq!(raw[0].1, "Café 🎮 a\\b");
        update_server_properties_safely(d.path(), &raw).unwrap();
        assert_eq!(read_settings_for(ty, d.path())["server-name"], "Café 🎮 a\\b");
        assert!(std::fs::read_to_string(d.path().join("server.properties")).unwrap().contains("server-name=Café 🎮 a\\b"));
        assert_eq!(validate_settings(&json!({ "motd": "Café" })).unwrap()[0].1, "Caf\\u00e9", "Java's file still escapes it");

        let out = validate_settings_for(ty, &json!({ "server-name": " Pocket Realm ", "gamemode": "adventure", "max-players": "12", "allow-list": true, "tick-distance": 8 })).unwrap();
        let get = |k: &str| out.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!((get("server-name"), get("gamemode"), get("max-players"), get("allow-list"), get("tick-distance")), (Some("Pocket Realm"), Some("adventure"), Some("12"), Some("true"), Some("8")));
        assert!(get("enforce-whitelist").is_none(), "that is a Java key");
        let err = |v: Value| validate_settings_for(ty, &v).unwrap_err();
        assert!(err(json!({ "gamemode": "spectator" })).contains("Invalid"), "the Bedrock server has no spectator mode");
        assert!(err(json!({ "online-mode": false })).contains("can't be changed"));
        assert!(err(json!({ "motd": "x" })).contains("can't be changed"), "Java keys are refused on a Bedrock server");
        assert!(err(json!({ "tick-distance": 20 })).contains("between"));
        assert!(validate_settings(&json!({ "server-name": "x" })).unwrap_err().contains("can't be changed"), "and Bedrock keys on a Java one");
        // Saved lines keep Mojang's comments and the keys the app does not own.
        update_server_properties_safely(d.path(), &validate_settings_for(ty, &json!({ "difficulty": "hard" })).unwrap()).unwrap();
        let text = std::fs::read_to_string(d.path().join("server.properties")).unwrap();
        assert!(text.starts_with("# Mojang defaults\n") && text.contains("online-mode=true") && text.contains("difficulty=hard"));
    }

    #[test]
    fn the_motd_limit_counts_characters_not_bytes() {
        assert!(validate_settings(&json!({ "motd": "é".repeat(59) })).is_ok());
        assert!(validate_settings(&json!({ "motd": "é".repeat(60) })).is_err());
        assert_eq!(validate_settings(&json!({ "motd": "a\u{1}b\nc" })).unwrap()[0].1, "abc", "control characters are stripped");
    }

    #[test]
    fn saved_settings_land_in_the_file_without_touching_other_lines() {
        let d = tmp();
        std::fs::write(d.path().join("server.properties"), "online-mode=true\nmotd=Old\ncustom-plugin-key=keep\n").unwrap();
        update_server_properties_safely(d.path(), &validate_settings(&json!({ "motd": "New ✨", "difficulty": "hard" })).unwrap()).unwrap();
        let p = read_properties_file(d.path());
        assert_eq!((p["motd"].as_str(), p["difficulty"].as_str(), p["custom-plugin-key"].as_str(), p["online-mode"].as_str()), ("New ✨", "hard", "keep", "true"));
    }

    #[test]
    fn every_template_applies_through_the_installer_and_cannot_break_the_rules() {
        // The template list itself lives in the shell's generated catalog; the rules it must obey live here.
        let d = tmp();
        write_server_properties(d.path(), 25570, &[("gamemode".into(), "creative".into()), ("level-type".into(), "minecraft\\:flat".into())]).unwrap();
        let p = read_properties_file(d.path());
        assert_eq!((p["gamemode"].as_str(), p["level-type"].as_str(), p["server-port"].as_str()), ("creative", "minecraft:flat", "25570"));
    }

    #[test]
    fn the_public_list_label() {
        assert_eq!(listing_mode(&json!({ "hardcore": true, "gamemode": "survival" }), "paper"), "hardcore");
        assert_eq!(listing_mode(&json!({ "gamemode": "creative" }), "fabric"), "modded");
        assert_eq!(listing_mode(&json!({ "gamemode": "creative" }), "paper"), "creative");
        assert_eq!(listing_mode(&json!({ "gamemode": "spectator" }), "paper"), "");
    }

    #[test]
    fn the_field_list_matches_the_table_and_includes_what_the_screen_needs() {
        let f = fields_json();
        let a = f.as_array().unwrap();
        assert_eq!(a.len(), SETTINGS.len());
        assert_eq!(a[0], json!({ "key": "motd", "label": "Description (MOTD)", "type": "text", "max": 59, "def": "A VoxelPort server" }));
        assert_eq!(a[1]["options"], json!(["survival", "creative", "adventure", "spectator"]));
        assert_eq!(a[5], json!({ "key": "max-players", "label": "Max players", "type": "int", "min": 1, "max": 1000, "def": 20 }));
        assert!(a.iter().all(|s| s["key"] != "online-mode"));
    }
}

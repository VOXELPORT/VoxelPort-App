//! Automatic voice chat for Supporter Plus: the relay hands out a public voice port, and this installs the voice plugin if it is not
//! there and points it at that address. Ported from `voiceSetup.js`.
//!
//! Two plugins are understood: Simple Voice Chat (`voicechat-server.properties`) and Plasmo Voice (`config.toml`). Only the lines that
//! matter are changed, the original file is kept once as `<file>.voxelport-backup`, and the write is atomic.
//!
//! (Electron asked Modrinth for these plugins by name where its install code only accepts a project id, so its automatic install of a
//! missing voice plugin always failed with "Invalid project."; here the real project ids are used.)

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{json, Value};

use crate::addons::{self, InstallRequest};
use crate::atomic_write;
use crate::cracked::Modrinth;

/// Simple Voice Chat on Modrinth.
pub const SIMPLE_PROJECT: &str = "9eGKb6K1";
/// Plasmo Voice on Modrinth.
pub const PLASMO_PROJECT: &str = "1bZhdhsH";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Plugin {
    Simple,
    Plasmo,
}

impl Plugin {
    pub fn name(self) -> &'static str {
        match self {
            Plugin::Simple => "simple",
            Plugin::Plasmo => "plasmo",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VoicePlan {
    pub plugin: Plugin,
    /// The local port the voice plugin listens on (distinct from Bedrock and the server query port).
    pub port: u16,
    /// The plugin's own config file.
    pub file: PathBuf,
    /// Whether the plugin's jar is already in the server folder.
    pub installed: bool,
}

pub fn supported(server_type: &str) -> bool {
    matches!(server_type, "paper" | "fabric")
}

fn read(file: &Path) -> Result<String, String> {
    match fs::read_to_string(file) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// What to do for this server, or `Ok(None)` when it cannot have voice chat (Vanilla). An error when two voice plugins are installed.
pub fn voice_plan(profile: &Value, bedrock_port: Option<u16>) -> Result<Option<VoicePlan>, String> {
    let ty = profile["type"].as_str().unwrap_or_default();
    if !supported(ty) {
        return Ok(None);
    }
    let dir = PathBuf::from(profile["serverDir"].as_str().unwrap_or_default());
    let paper = ty == "paper";
    let base = if paper { "plugins" } else { "config" };
    let simple_file = dir.join(base).join("voicechat").join("voicechat-server.properties");
    let plasmo_file = dir.join(base).join(if paper { "PlasmoVoice" } else { "plasmovoice" }).join("config.toml");
    let jar_dir = dir.join(if paper { "plugins" } else { "mods" });
    let jars: Vec<String> = fs::read_dir(&jar_dir).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    let simple_re = Regex::new(r"(?i)^(?:voicechat|simple-voice-chat)[A-Za-z0-9_.+-]*\.jar$").unwrap();
    let plasmo_re = Regex::new(r"(?i)^plasmovoice[A-Za-z0-9_.+-]*\.jar$").unwrap();
    let (has_simple, has_plasmo) = (jars.iter().any(|n| simple_re.is_match(n)), jars.iter().any(|n| plasmo_re.is_match(n)));
    if has_simple && has_plasmo {
        return Err("Two voice plugins are installed. Keep one voice plugin to use automatic setup.".into());
    }
    let plugin = if has_plasmo {
        Plugin::Plasmo
    } else if has_simple {
        Plugin::Simple
    } else if profile["voice"]["plugin"] == "plasmo" {
        Plugin::Plasmo
    } else {
        Plugin::Simple
    };
    // A predictable local port, distinct from Bedrock and the server query port.
    let properties = read(&dir.join("server.properties"))?;
    let query_port = Regex::new(r"(?m)^query\.port\s*=\s*([0-9]+)").unwrap().captures(&properties).and_then(|c| c[1].parse::<u32>().ok()).unwrap_or(25565);
    let mut port = profile["voice"]["port"].as_u64().filter(|p| *p != 0).unwrap_or(24454) as u32;
    while Some(port) == bedrock_port.map(u32::from) || port == query_port {
        port = if port == 65535 { 1024 } else { port + 1 };
    }
    let (file, installed) = if plugin == Plugin::Plasmo { (plasmo_file, has_plasmo) } else { (simple_file, has_simple) };
    Ok(Some(VoicePlan { plugin, port: port as u16, file, installed }))
}

/// Sets `key=value` lines in a properties file, keeping every other line, and adds the keys that are not there.
pub fn set_properties(text: &str, values: &[(&str, String)]) -> String {
    let key_re = Regex::new(r"^\s*([^#!\s=:]+)\s*[=:]").unwrap();
    let mut remaining: Vec<(&str, &String)> = values.iter().map(|(k, v)| (*k, v)).collect();
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .map(|line| {
            if let Some(c) = key_re.captures(line) {
                if let Some(pos) = values.iter().position(|(k, _)| *k == &c[1]) {
                    remaining.retain(|(k, _)| *k != &c[1]);
                    return format!("{}={}", values[pos].0, values[pos].1);
                }
            }
            line.to_string()
        })
        .collect();
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines.extend(remaining.iter().map(|(k, v)| format!("{k}={v}")));
    lines.push(String::new());
    lines.join("\n")
}

/// A value in a TOML file: text is quoted, a number is not.
pub enum Toml {
    Text(String),
    Number(u64),
}

impl Toml {
    fn render(&self) -> String {
        match self {
            Toml::Text(s) => json!(s).to_string(),
            Toml::Number(n) => n.to_string(),
        }
    }
}

/// Sets `key = value` lines inside one `[section]` of a TOML file (adding the section if it is missing), leaving the rest as it was.
pub fn set_toml_section(text: &str, section: &str, values: &[(&str, Toml)]) -> String {
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let settings: Vec<String> = values.iter().map(|(k, v)| format!("{k} = {}", v.render())).collect();
    let header = format!("[{section}]");
    let Some(start) = lines.iter().position(|l| l.trim() == header) else {
        return format!("{}\n\n{header}\n{}\n", text.trim_end(), settings.join("\n"));
    };
    let mut end = start + 1;
    while end < lines.len() && !lines[end].trim_start().starts_with('[') {
        end += 1;
    }
    let is_ours = |line: &str| values.iter().any(|(k, _)| Regex::new(&format!(r"^\s*{}\s*=", regex::escape(k))).unwrap().is_match(line));
    let kept: Vec<String> = lines[start + 1..end].iter().filter(|l| !is_ours(l)).map(|l| l.to_string()).collect();
    let mut out: Vec<String> = lines[..=start].iter().map(|l| l.to_string()).collect();
    out.extend(settings);
    out.extend(kept);
    out.extend(lines[end..].iter().map(|l| l.to_string()));
    out.join("\n")
}

#[derive(Debug, PartialEq)]
pub struct VoiceResult {
    pub changed: bool,
    pub plugin: Plugin,
    pub port: u16,
}

/// Installs the voice plugin if needed and points it at the relay's public voice address. `Ok(None)` when `is_current` turns false
/// meanwhile (the tunnel moved on). `running`: the server is running, so a jar can be added but not replaced.
pub fn configure_voice(m: &Modrinth, profile: &Value, plan: &VoicePlan, host: &str, public_port: u16, running: bool, is_current: &dyn Fn() -> bool) -> Result<Option<VoiceResult>, String> {
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') || public_port == 0 {
        return Err("Invalid voice address from relay.".into());
    }
    if !is_current() {
        return Ok(None);
    }
    let dir = PathBuf::from(profile["serverDir"].as_str().unwrap_or_default());
    let mut installed = false;
    if !plan.installed {
        let (project, title) = if plan.plugin == Plugin::Plasmo { (PLASMO_PROJECT, "Plasmo Voice") } else { (SIMPLE_PROJECT, "Simple Voice Chat") };
        let req = InstallRequest {
            server_dir: &dir,
            server_type: profile["type"].as_str().unwrap_or_default(),
            version: profile["version"].as_str().unwrap_or_default(),
            project_id: project,
            title,
            icon: "",
            running,
        };
        addons::install(m, &req, &|_| {}).map_err(|e| e.message)?;
        installed = true;
    }
    if !is_current() {
        return Ok(None);
    }
    let before = read(&plan.file)?;
    let after = match plan.plugin {
        Plugin::Simple => set_properties(&before, &[("bind_address", "127.0.0.1".into()), ("port", plan.port.to_string()), ("voice_host", format!("{host}:{public_port}"))]),
        Plugin::Plasmo => {
            let once = set_toml_section(&before, "host", &[("ip", Toml::Text("127.0.0.1".into())), ("port", Toml::Number(plan.port.into()))]);
            set_toml_section(&once, "host.public", &[("ip", Toml::Text(host.into())), ("port", Toml::Number(public_port.into()))])
        }
    };
    if before != after {
        if let Some(parent) = plan.file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let backup = PathBuf::from(format!("{}.voxelport-backup", plan.file.to_string_lossy()));
        if !before.is_empty() && !backup.exists() {
            let _ = fs::write(&backup, &before); // the first original is kept, never a later edit of ours
        }
        atomic_write(&plan.file, after.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(Some(VoiceResult { changed: installed || before != after, plugin: plan.plugin, port: plan.port }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(dir: &Path, ty: &str) -> Value {
        json!({ "type": ty, "version": "1.21.4", "serverDir": dir.to_string_lossy() })
    }

    fn jar(dir: &Path, folder: &str, name: &str) {
        fs::create_dir_all(dir.join(folder)).unwrap();
        fs::write(dir.join(folder).join(name), "x").unwrap();
    }

    #[test]
    fn only_paper_and_fabric_can_have_voice_chat() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(voice_plan(&profile(d.path(), "vanilla"), None).unwrap(), None);
        assert!(voice_plan(&profile(d.path(), "paper"), None).unwrap().is_some());
        assert!(voice_plan(&profile(d.path(), "fabric"), None).unwrap().is_some());
    }

    #[test]
    fn the_plan_follows_the_installed_voice_plugin_and_its_own_config_file() {
        let d = tempfile::tempdir().unwrap();
        let none = voice_plan(&profile(d.path(), "paper"), None).unwrap().unwrap();
        assert_eq!((none.plugin, none.installed, none.port), (Plugin::Simple, false, 24454));
        assert!(none.file.ends_with(Path::new("plugins").join("voicechat").join("voicechat-server.properties")));

        jar(d.path(), "plugins", "voicechat-bukkit-2.5.jar");
        let simple = voice_plan(&profile(d.path(), "paper"), None).unwrap().unwrap();
        assert_eq!((simple.plugin, simple.installed), (Plugin::Simple, true));

        let e = tempfile::tempdir().unwrap();
        jar(e.path(), "plugins", "PlasmoVoice-paper-2.1.jar");
        let plasmo = voice_plan(&profile(e.path(), "paper"), None).unwrap().unwrap();
        assert_eq!((plasmo.plugin, plasmo.installed), (Plugin::Plasmo, true));
        assert!(plasmo.file.ends_with(Path::new("plugins").join("PlasmoVoice").join("config.toml")));

        let f = tempfile::tempdir().unwrap();
        jar(f.path(), "mods", "voicechat-fabric-1.21.4-2.5.jar");
        let fabric = voice_plan(&profile(f.path(), "fabric"), None).unwrap().unwrap();
        assert!(fabric.file.ends_with(Path::new("config").join("voicechat").join("voicechat-server.properties")), "{:?}", fabric.file);
        assert!(fabric.installed);

        let g = tempfile::tempdir().unwrap();
        let mut remembered = profile(g.path(), "fabric");
        remembered["voice"] = json!({ "plugin": "plasmo", "port": 30000 });
        let p = voice_plan(&remembered, None).unwrap().unwrap();
        assert_eq!((p.plugin, p.installed, p.port), (Plugin::Plasmo, false, 30000), "a chosen plugin is remembered until one is installed");
        assert!(p.file.ends_with(Path::new("config").join("plasmovoice").join("config.toml")));
    }

    #[test]
    fn two_voice_plugins_at_once_are_refused_with_a_plain_message() {
        let d = tempfile::tempdir().unwrap();
        jar(d.path(), "plugins", "voicechat-bukkit-2.5.jar");
        jar(d.path(), "plugins", "PlasmoVoice-paper-2.1.jar");
        assert_eq!(voice_plan(&profile(d.path(), "paper"), None).unwrap_err(), "Two voice plugins are installed. Keep one voice plugin to use automatic setup.");
    }

    #[test]
    fn the_local_port_steps_aside_for_bedrock_and_the_query_port() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("server.properties"), "query.port=24455\nmotd=x\n").unwrap();
        let p = voice_plan(&profile(d.path(), "paper"), Some(24454)).unwrap().unwrap();
        assert_eq!(p.port, 24456, "24454 is Bedrock's, 24455 the query port");
        let mut near_end = profile(d.path(), "paper");
        near_end["voice"] = json!({ "port": 65535 });
        let q = voice_plan(&near_end, Some(65535)).unwrap().unwrap();
        assert_eq!(q.port, 1024, "wraps round instead of passing 65535");
    }

    #[test]
    fn properties_are_changed_in_place_and_missing_keys_added() {
        let before = "# Simple Voice Chat\r\nport=24454\r\nmax_voice_distance=48.0\r\nbind_address = *\r\n";
        let after = set_properties(before, &[("bind_address", "127.0.0.1".into()), ("port", "24460".into()), ("voice_host", "play.example.in:30001".into())]);
        assert_eq!(after, "# Simple Voice Chat\nport=24460\nmax_voice_distance=48.0\nbind_address=127.0.0.1\nvoice_host=play.example.in:30001\n");
        assert_eq!(set_properties("", &[("port", "1".into())]), "port=1\n");
        assert_eq!(set_properties(&after, &[("bind_address", "127.0.0.1".into()), ("port", "24460".into()), ("voice_host", "play.example.in:30001".into())]), after, "running it again changes nothing");
        assert_eq!(set_properties("a: 1\n", &[("a", "2".into())]), "a=2\n", "a colon is a separator too");
    }

    #[test]
    fn a_toml_section_is_changed_in_place_or_added_without_touching_the_rest() {
        let before = "[general]\nname = \"x\"\n\n[host]\nip = \"0.0.0.0\"\nport = 60606\nkeep = true\n\n[other]\nport = 1\n";
        let after = set_toml_section(before, "host", &[("ip", Toml::Text("127.0.0.1".into())), ("port", Toml::Number(24460))]);
        assert_eq!(after, "[general]\nname = \"x\"\n\n[host]\nip = \"127.0.0.1\"\nport = 24460\nkeep = true\n\n[other]\nport = 1\n");
        let added = set_toml_section("[general]\nname = \"x\"\n", "host.public", &[("ip", Toml::Text("play.example.in".into())), ("port", Toml::Number(30001))]);
        assert_eq!(added, "[general]\nname = \"x\"\n\n[host.public]\nip = \"play.example.in\"\nport = 30001\n");
        let twice = set_toml_section(&added, "host.public", &[("ip", Toml::Text("play.example.in".into())), ("port", Toml::Number(30001))]);
        assert_eq!(twice, added, "running it again changes nothing");
        assert_eq!(set_toml_section("", "host", &[("port", Toml::Number(1))]), "\n\n[host]\nport = 1\n");
    }
}

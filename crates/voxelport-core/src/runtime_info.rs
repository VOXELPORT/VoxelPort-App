//! What is actually installed for a server, read from the disk and never from the stored profile (for display and
//! diagnostics): the real Minecraft version from the server jar, and each plugin's or mod's own name and version from inside its
//! jar. Ported from `runtimeInfo.js` and the plugin-metadata half of `jarVersion.js`.

use std::fs;
use std::io::Read;
use std::path::Path;

use regex::Regex;
use serde_json::{json, Value};

use crate::server_install::read_jar_minecraft_version;

const META_FILES: &[&str] = &["plugin.yml", "paper-plugin.yml", "fabric.mod.json"];
const MAX_META_BYTES: u64 = 256 * 1024;

/// Plugins and mods named in the screens, matched by the start of the jar file name.
const KNOWN: &[(&str, &str)] = &[("geyser", "Geyser"), ("floodgate", "Floodgate"), ("viaversion", "ViaVersion"), ("viabackwards", "ViaBackwards")];

/// The known plugin a jar file name belongs to: `(key, label)`. `Geyser-Spigot.jar` and `geyser_fabric.jar` both match
/// `geyser`; `GeyserSkinManager.jar` does not (the name must continue with `-` or `_`).
pub fn known_plugin(file_name: &str) -> Option<(&'static str, &'static str)> {
    let lower = file_name.to_ascii_lowercase();
    KNOWN.iter().find(|(key, _)| lower.strip_prefix(key).is_some_and(|rest| rest.starts_with(['-', '_']))).copied()
}

/// Pulls a version out of a jar file name: `Geyser-Spigot-2.11.3.jar` gives `2.11.3`. `None` when nothing looks like one.
pub fn version_from_file_name(name: &str) -> Option<String> {
    let base = name.strip_suffix(".jar").or_else(|| name.strip_suffix(".JAR")).unwrap_or(name);
    let re = Regex::new(r"([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+][A-Za-z0-9_.]+)?)").unwrap();
    re.captures(base).map(|c| c[1].to_string())
}

/// A value out of a plugin.yml line like `version: '2.2.5-SNAPSHOT'`; `None` when absent or an unfilled `${placeholder}`.
fn yaml_value(text: &str, key: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?mi)^{key}\s*:\s*(.+?)\s*$")).unwrap();
    let raw = re.captures(text)?[1].to_string();
    let v = raw.trim_matches(|c| c == '\'' || c == '"').trim().to_string();
    (!v.is_empty() && !v.contains("${")).then(|| v.chars().take(60).collect())
}

/// The name and version a plugin or mod declares about itself (plugin.yml, paper-plugin.yml or fabric.mod.json inside the jar):
/// that is the real version, whatever the file is called. `None` for what it does not say or when the jar cannot be read.
pub fn read_jar_plugin_meta(jar: &Path) -> (Option<String>, Option<String>) {
    let Ok(file) = fs::File::open(jar) else { return (None, None) };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return (None, None) };
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        let name = entry.name().to_string();
        if !META_FILES.contains(&name.as_str()) || entry.size() > MAX_META_BYTES {
            continue;
        }
        let mut bytes = Vec::new();
        if entry.take(MAX_META_BYTES).read_to_end(&mut bytes).is_err() {
            return (None, None);
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if name == "fabric.mod.json" {
            let Ok(j) = serde_json::from_str::<Value>(&text) else { return (None, None) };
            let nm = j["name"].as_str().map(|n| n.chars().take(60).collect::<String>());
            let ver = j["version"].as_str().filter(|v| !v.contains("${")).map(|v| v.chars().take(60).collect::<String>());
            return (nm, ver);
        }
        return (yaml_value(&text, "name"), yaml_value(&text, "version"));
    }
    (None, None)
}

fn jar_names(dir: &Path) -> Vec<String> {
    let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = read.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.to_ascii_lowercase().ends_with(".jar")).collect();
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b)));
    names
}

/// Every plugin and mod jar in the server folder with its real name and version, read from the jar itself (the file name is
/// only a fallback: `Geyser-Spigot.jar` and `floodgate-spigot.jar` carry no version in their names). Each is
/// `{ key, label, version, file, dir }`: `key` is `geyser` etc. for the ones named in the screens and the lower-cased name
/// otherwise.
pub fn read_all_plugins(server_dir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    for dir in ["plugins", "mods"] {
        for name in jar_names(&server_dir.join(dir)) {
            let known = known_plugin(&name);
            let (meta_name, meta_version) = read_jar_plugin_meta(&server_dir.join(dir).join(&name));
            let label = known.map(|k| k.1.to_string()).or(meta_name).unwrap_or_else(|| name[..name.len() - 4].to_string());
            let key = known.map(|k| k.0.to_string()).unwrap_or_else(|| label.to_lowercase());
            let version = meta_version.or_else(|| version_from_file_name(&name));
            out.push(json!({ "key": key, "label": label, "version": version, "file": name, "dir": dir }));
        }
    }
    out
}

/// Plugin and mod updates that were downloaded but could not replace the running jar (it was locked), so the server staged them
/// in `plugins/update` or `mods/update` and applies them on the next restart: `[{ dir, name }]`.
pub fn read_staged_updates(server_dir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    for dir in ["plugins", "mods"] {
        let Ok(read) = fs::read_dir(server_dir.join(dir).join("update")) else { continue };
        for e in read.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.to_ascii_lowercase().ends_with(".jar") {
                out.push(json!({ "dir": dir, "name": name }));
            }
        }
    }
    out
}

/// `{ minecraftVersion, plugins, stagedUpdates }`. `minecraftVersion` is null for a Fabric launcher jar (no version.json) or a
/// missing or unreadable jar: callers show the stored version then.
pub fn read_runtime_info(server_dir: &Path) -> Value {
    let minecraft = read_jar_minecraft_version(&server_dir.join("server.jar")).ok().flatten();
    json!({ "minecraftVersion": minecraft, "plugins": read_all_plugins(server_dir), "stagedUpdates": read_staged_updates(server_dir) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn jar(dir: &Path, name: &str, entries: &[(&str, &str)]) {
        fs::create_dir_all(dir).unwrap();
        let mut w = zip::ZipWriter::new(fs::File::create(dir.join(name)).unwrap());
        for (n, body) in entries {
            w.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn versions_come_out_of_file_names() {
        assert_eq!(version_from_file_name("Geyser-Spigot-2.11.3.jar").as_deref(), Some("2.11.3"));
        assert_eq!(version_from_file_name("ViaVersion-5.1.1.jar").as_deref(), Some("5.1.1"));
        assert_eq!(version_from_file_name("pack-1.2-SNAPSHOT.jar").as_deref(), Some("1.2-SNAPSHOT"));
        assert_eq!(version_from_file_name("Geyser-Spigot.jar"), None);
    }

    #[test]
    fn only_the_exact_known_plugin_names_are_recognised() {
        assert_eq!(known_plugin("Geyser-Spigot.jar"), Some(("geyser", "Geyser")));
        assert_eq!(known_plugin("floodgate_fabric-1.jar"), Some(("floodgate", "Floodgate")));
        assert_eq!(known_plugin("ViaBackwards-5.jar"), Some(("viabackwards", "ViaBackwards")));
        assert_eq!(known_plugin("GeyserSkinManager-Spigot.jar"), None);
        assert_eq!(known_plugin("geyser.jar"), None);
    }

    #[test]
    fn a_plugin_names_itself_in_its_own_files() {
        let d = tempfile::tempdir().unwrap();
        jar(d.path(), "a.jar", &[("plugin.yml", "main: x.Y\nname: 'Cool Plugin'\r\nversion: \"2.2.5-SNAPSHOT\"\n")]);
        jar(d.path(), "b.jar", &[("plugin.yml", "name: Raw\nversion: ${project.version}\n")]);
        jar(d.path(), "c.jar", &[("fabric.mod.json", r#"{ "name": "Lithium", "version": "0.14.3+mc1.21" }"#)]);
        jar(d.path(), "d.jar", &[("fabric.mod.json", r#"{ "name": "Raw", "version": "${version}" }"#)]);
        jar(d.path(), "e.jar", &[("other.txt", "nothing")]);
        fs::write(d.path().join("f.jar"), "not a zip").unwrap();
        let meta = |n: &str| read_jar_plugin_meta(&d.path().join(n));
        assert_eq!(meta("a.jar"), (Some("Cool Plugin".into()), Some("2.2.5-SNAPSHOT".into())));
        assert_eq!(meta("b.jar"), (Some("Raw".into()), None), "an unfilled placeholder is not a version");
        assert_eq!(meta("c.jar"), (Some("Lithium".into()), Some("0.14.3+mc1.21".into())));
        assert_eq!(meta("d.jar"), (Some("Raw".into()), None));
        assert_eq!(meta("e.jar"), (None, None));
        assert_eq!(meta("f.jar"), (None, None), "an unreadable jar says nothing and does not fail");
        assert_eq!(meta("missing.jar"), (None, None));
    }

    #[test]
    fn every_jar_is_listed_with_its_real_version_and_known_ones_get_their_label() {
        let d = tempfile::tempdir().unwrap();
        let plugins = d.path().join("plugins");
        jar(&plugins, "Geyser-Spigot.jar", &[("plugin.yml", "name: Geyser-Spigot\nversion: 2.9.1-b1\n")]);
        jar(&plugins, "EssentialsX-2.20.1.jar", &[("other", "x")]);
        jar(&plugins, "Named.jar", &[("plugin.yml", "name: Fancy Name\nversion: 3.0\n")]);
        fs::write(plugins.join("readme.txt"), "x").unwrap();
        jar(&d.path().join("mods"), "fabric-api-0.100.jar", &[("fabric.mod.json", r#"{ "name": "Fabric API", "version": "0.100.0" }"#)]);
        let all = read_all_plugins(d.path());
        let row = |f: &str| all.iter().find(|p| p["file"] == f).cloned().unwrap();
        assert_eq!(all.len(), 4);
        assert_eq!((row("Geyser-Spigot.jar")["key"].as_str(), row("Geyser-Spigot.jar")["label"].as_str(), row("Geyser-Spigot.jar")["version"].as_str()), (Some("geyser"), Some("Geyser"), Some("2.9.1-b1")));
        assert_eq!((row("EssentialsX-2.20.1.jar")["label"].as_str(), row("EssentialsX-2.20.1.jar")["version"].as_str()), (Some("EssentialsX-2.20.1"), Some("2.20.1")), "no metadata: file name is the fallback for both");
        assert_eq!((row("Named.jar")["key"].as_str(), row("Named.jar")["label"].as_str()), (Some("fancy name"), Some("Fancy Name")));
        assert_eq!((row("fabric-api-0.100.jar")["dir"].as_str(), row("fabric-api-0.100.jar")["version"].as_str()), (Some("mods"), Some("0.100.0")));
    }

    #[test]
    fn staged_updates_and_a_missing_or_launcher_jar_are_reported_honestly() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_runtime_info(d.path())["minecraftVersion"], Value::Null, "no server.jar");
        jar(d.path(), "server.jar", &[("version.json", r#"{ "id": "1.21.4" }"#)]);
        fs::create_dir_all(d.path().join("plugins").join("update")).unwrap();
        fs::write(d.path().join("plugins").join("update").join("New.jar"), "x").unwrap();
        fs::write(d.path().join("plugins").join("update").join("notes.txt"), "x").unwrap();
        let info = read_runtime_info(d.path());
        assert_eq!(info["minecraftVersion"], "1.21.4");
        assert_eq!(info["stagedUpdates"], json!([{ "dir": "plugins", "name": "New.jar" }]));
        jar(d.path(), "server.jar", &[("something-else", "x")]);
        assert_eq!(read_runtime_info(d.path())["minecraftVersion"], Value::Null, "a Fabric launcher jar has none");
        fs::write(d.path().join("server.jar"), "garbage").unwrap();
        assert_eq!(read_runtime_info(d.path())["minecraftVersion"], Value::Null, "an unreadable jar is not an error here");
    }
}

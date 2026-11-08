//! Installing and importing a server folder: downloading and verifying the jar, writing `eula.txt` and
//! `server.properties`, and recognising a server that is already there. Ported from `serverInstall.js` and
//! `jarVersion.js` (the install orchestration is the body of the `server:install` handler in `main.js`).

use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};

use crate::atomic_write;
use crate::mc_versions::{self, Endpoints, Resolved};
use crate::net::Fetcher;

pub const MAX_SERVER_JAR_BYTES: u64 = 500 * 1024 * 1024; // real server jars are low tens of MB
const MAX_VERSION_JSON_BYTES: u64 = 1024 * 1024;

// ─── Reading a jar ──────────────────────────────────────────────────────────

/// The real Minecraft version inside a Vanilla or Paper server jar (`version.json` at the archive root), so what landed
/// on disk can be checked against what was asked for. Fabric's launcher jar carries no such file: `Ok(None)`. An
/// unreadable archive is an error; an unreadable `version.json` counts as "unknown".
pub fn read_jar_minecraft_version(jar: &Path) -> Result<Option<String>, String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(jar).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let Ok(entry) = zip.by_name("version.json") else { return Ok(None) };
    if entry.size() > MAX_VERSION_JSON_BYTES {
        return Ok(None);
    }
    let mut text = Vec::new();
    entry.take(MAX_VERSION_JSON_BYTES).read_to_end(&mut text).map_err(|e| e.to_string())?;
    Ok(serde_json::from_slice::<Value>(&text).ok().and_then(|v| v["id"].as_str().map(str::to_string)))
}

// ─── Files a server needs ───────────────────────────────────────────────────

pub fn write_eula(dir: &Path) -> std::io::Result<()> {
    fs::write(dir.join("eula.txt"), "# By setting eula=true you agree to the Minecraft EULA (https://www.minecraft.net/eula)\neula=true\n")
}

/// Keys a template may never set: they could weaken the server.
const PROTECTED_KEYS: &[&str] = &["server-port", "online-mode", "enable-command-block", "enable-rcon"];

fn safe_key(k: &str) -> bool {
    !k.is_empty() && k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// A fresh `server.properties`. The port is written as a plain integer (never the caller's text, so it cannot smuggle in
/// an extra line such as `enable-rcon=true`). Template settings override the defaults except the protected keys, and a
/// key or value that could start another line is skipped.
pub fn write_server_properties(dir: &Path, port: i64, extra: &[(String, String)]) -> std::io::Result<()> {
    let port = if (1..=65535).contains(&port) { port } else { 25565 };
    let mut lines: Vec<String> = vec![
        format!("server-port={port}"),
        "max-players=20".into(),
        "difficulty=easy".into(),
        "gamemode=survival".into(),
        "motd=A VoxelPort server".into(),
        "online-mode=true".into(),
        "enable-command-block=false".into(),
    ];
    for (key, value) in extra {
        if PROTECTED_KEYS.contains(&key.as_str()) || !safe_key(key) || value.contains('\r') || value.contains('\n') {
            continue;
        }
        let prefix = format!("{key}=");
        match lines.iter().position(|l| l.starts_with(&prefix)) {
            Some(i) => lines[i] = format!("{key}={value}"),
            None => lines.push(format!("{key}={value}")),
        }
    }
    atomic_write(&dir.join("server.properties"), (lines.join("\n") + "\n").as_bytes())
}

/// Changes only the given keys of an existing `server.properties`, leaving every other line as it was (an imported
/// server keeps its view-distance, whitelist, plugin keys...). The dangerous keys are never touched even if asked.
pub fn update_server_properties_safely(dir: &Path, changes: &[(String, String)]) -> std::io::Result<()> {
    const DANGEROUS: &[&str] = &["enable-rcon", "enable-command-block", "online-mode"];
    let file = dir.join("server.properties");
    let text = fs::read_to_string(&file).unwrap_or_default();
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let wanted: Vec<&(String, String)> = changes.iter().filter(|(k, _)| !DANGEROUS.contains(&k.as_str())).collect();
    let mut seen = vec![false; wanted.len()];
    let ends_with_newline = text.ends_with('\n');
    let mut lines: Vec<String> = if text.is_empty() { Vec::new() } else { text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect() };
    if ends_with_newline {
        lines.pop(); // the empty piece after the last newline: new keys go before it, and the newline is put back
    }
    for line in lines.iter_mut() {
        let first = line.chars().next();
        if matches!(first, None | Some('#') | Some('=')) || first.is_some_and(char::is_whitespace) {
            continue;
        }
        let Some((key, _)) = line.split_once('=') else { continue };
        if let Some(i) = wanted.iter().position(|(k, _)| k == key) {
            seen[i] = true;
            *line = format!("{key}={}", wanted[i].1);
        }
    }
    for (i, (k, v)) in wanted.iter().enumerate() {
        if !seen[i] {
            lines.push(format!("{k}={v}"));
        }
    }
    let mut out = lines.join(eol);
    if ends_with_newline {
        out.push_str(eol);
    }
    atomic_write(&file, out.as_bytes())
}

/// What a folder the person points VoxelPort at already holds. Only used to fill in the Import screen and to guess a
/// type; never to decide whether to overwrite anything.
pub fn detect_existing_server(dir: &Path) -> Value {
    let has = |n: &str| dir.join(n).exists();
    let (jar, props, eula, world, mods, plugins) = (has("server.jar"), has("server.properties"), has("eula.txt"), has("world"), has("mods"), has("plugins"));
    // A Bedrock Dedicated Server folder: its program, and its worlds live under `worlds`.
    let (bedrock, worlds) = (has(crate::bds::EXE), has("worlds"));
    let guessed_type = if bedrock { Some(crate::bds::TYPE_ID) } else if mods { Some("fabric") } else if plugins { Some("paper") } else if jar || props { Some("vanilla") } else { None };
    let guessed_port = props
        .then(|| fs::read_to_string(dir.join("server.properties")).ok())
        .flatten()
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("server-port=")?.trim_end().parse::<u32>().ok()));
    json!({
        "hasServerJar": jar, "hasProperties": props, "hasEula": eula, "hasWorld": world, "hasMods": mods, "hasPlugins": plugins, "hasBedrockServer": bedrock,
        "looksLikeServer": jar || props || world || bedrock || worlds, "guessedType": guessed_type, "guessedPort": guessed_port,
    })
}

/// Installing writes `server.jar` and a fresh `server.properties`, so it must never be pointed at a folder that already
/// holds a server.
pub fn assert_folder_empty_for_install(dir: &Path) -> Result<(), String> {
    if detect_existing_server(dir)["looksLikeServer"] == true {
        return Err("That folder already has a Minecraft server in it. Use Import Existing Server instead.".into());
    }
    Ok(())
}

// ─── The install itself ─────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    Resolving,
    Downloading { received: u64, total: u64 },
    Verifying,
}

pub struct InstallFiles<'a> {
    pub dir: &'a Path,
    pub server_type: &'a str,
    pub version: &'a str,
    pub port: i64,
    /// Template settings in `server.properties` form.
    pub properties: &'a [(String, String)],
}

/// Downloads the jar for `server_type`/`version` into `dir`, checks it really is that Minecraft version, and writes the
/// EULA and a fresh `server.properties`. Blocking. Nothing is written until the folder is known to hold no server; a
/// jar that is the wrong version is deleted; and a folder this call created is removed again if the install fails.
pub fn install_server_files(req: &InstallFiles, fetcher: &Fetcher, endpoints: &Endpoints, on_phase: &dyn Fn(Phase)) -> Result<Resolved, String> {
    assert_folder_empty_for_install(req.dir)?; // before anything is downloaded or written
    let created = !req.dir.exists();
    fs::create_dir_all(req.dir).map_err(|e| format!("Could not create the server folder: {e}"))?;
    let result = install_into(req, fetcher, endpoints, on_phase);
    if result.is_err() && created {
        let _ = fs::remove_dir(req.dir); // only succeeds if it is empty again
    }
    result
}

fn install_into(req: &InstallFiles, fetcher: &Fetcher, endpoints: &Endpoints, on_phase: &dyn Fn(Phase)) -> Result<Resolved, String> {
    on_phase(Phase::Resolving);
    let resolved = mc_versions::resolve_download(fetcher, endpoints, req.server_type, req.version)?;

    on_phase(Phase::Downloading { received: 0, total: 0 });
    let jar = req.dir.join(resolved.file_name);
    fetcher.download(&resolved.url, &jar, MAX_SERVER_JAR_BYTES, resolved.checksum.as_ref(), 0, &|received, total| on_phase(Phase::Downloading { received, total }))?;

    // The jar must really be the selected Minecraft version. A Fabric launcher jar carries none ("can't verify from
    // the jar"), which is accepted for Fabric only.
    on_phase(Phase::Verifying);
    let in_jar = read_jar_minecraft_version(&jar).ok().flatten();
    match &in_jar {
        Some(v) if v != req.version => {
            let _ = fs::remove_file(&jar);
            return Err(format!("Downloaded server is Minecraft {v}, not the {} you selected. Nothing was installed.", req.version));
        }
        None if req.server_type != "fabric" => {
            let _ = fs::remove_file(&jar);
            return Err(format!("Couldn't read the Minecraft version from the downloaded {} server to confirm it is {}. Nothing was installed.", req.server_type, req.version));
        }
        _ => {}
    }

    write_eula(req.dir).map_err(|e| e.to_string())?;
    write_server_properties(req.dir, req.port, req.properties).map_err(|e| e.to_string())?;
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn read(dir: &Path, f: &str) -> String {
        fs::read_to_string(dir.join(f)).unwrap()
    }
    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_fresh_properties_file_has_the_safe_defaults() {
        let d = tmp();
        write_server_properties(d.path(), 25570, &[]).unwrap();
        let t = read(d.path(), "server.properties");
        for line in ["server-port=25570", "max-players=20", "difficulty=easy", "gamemode=survival", "online-mode=true", "enable-command-block=false"] {
            assert!(t.lines().any(|l| l == line), "{line} in {t}");
        }
        assert!(!t.contains("enable-rcon"));
    }

    #[test]
    fn template_settings_override_defaults_but_never_the_protected_keys() {
        let d = tmp();
        let extra = kv(&[("gamemode", "creative"), ("level-type", "minecraft\\:flat"), ("online-mode", "false"), ("enable-rcon", "true"), ("server-port", "1"), ("enable-command-block", "true"), ("Bad Key", "x"), ("motd", "two\nenable-rcon=true"), ("pvp", "false")]);
        write_server_properties(d.path(), 25565, &extra).unwrap();
        let t = read(d.path(), "server.properties");
        assert!(t.contains("gamemode=creative") && t.contains("level-type=minecraft\\:flat") && t.contains("pvp=false"));
        assert!(t.contains("online-mode=true") && t.contains("enable-command-block=false") && t.contains("server-port=25565"));
        assert!(!t.contains("enable-rcon") && !t.contains("Bad Key") && t.contains("motd=A VoxelPort server"));
        assert_eq!(t.lines().filter(|l| l.starts_with("gamemode=")).count(), 1);
    }

    #[test]
    fn a_bad_port_falls_back_and_cannot_inject_lines() {
        for bad in [0, -5, 70000] {
            let d = tmp();
            write_server_properties(d.path(), bad, &[]).unwrap();
            assert!(read(d.path(), "server.properties").starts_with("server-port=25565\n"));
        }
    }

    #[test]
    fn editing_properties_changes_only_what_was_asked() {
        let d = tmp();
        fs::write(d.path().join("server.properties"), "#Minecraft server properties\nview-distance=12\nserver-port=25565\nwhite-list=true\nonline-mode=true\n").unwrap();
        update_server_properties_safely(d.path(), &kv(&[("server-port", "25570"), ("online-mode", "false"), ("enable-rcon", "true"), ("new-key", "1")])).unwrap();
        let t = read(d.path(), "server.properties");
        assert_eq!(t, "#Minecraft server properties\nview-distance=12\nserver-port=25570\nwhite-list=true\nonline-mode=true\nnew-key=1\n");
    }

    #[test]
    fn editing_keeps_windows_line_endings_and_works_on_a_missing_file() {
        let d = tmp();
        fs::write(d.path().join("server.properties"), "a=1\r\nserver-port=1\r\nb=2\r\n").unwrap();
        update_server_properties_safely(d.path(), &kv(&[("server-port", "7")])).unwrap();
        assert_eq!(read(d.path(), "server.properties"), "a=1\r\nserver-port=7\r\nb=2\r\n");
        let e = tmp();
        update_server_properties_safely(e.path(), &kv(&[("server-port", "9")])).unwrap();
        assert_eq!(read(e.path(), "server.properties"), "server-port=9");
    }

    #[test]
    fn existing_servers_are_recognised_and_typed_by_what_they_hold() {
        let d = tmp();
        assert_eq!(detect_existing_server(d.path())["looksLikeServer"], false);
        assert!(assert_folder_empty_for_install(d.path()).is_ok());
        fs::write(d.path().join("server.properties"), "motd=x\nserver-port=25599\n").unwrap();
        let v = detect_existing_server(d.path());
        assert_eq!((v["looksLikeServer"].clone(), v["guessedType"].clone(), v["guessedPort"].clone()), (json!(true), json!("vanilla"), json!(25599)));
        assert!(assert_folder_empty_for_install(d.path()).unwrap_err().contains("Import Existing Server"));
        fs::create_dir(d.path().join("plugins")).unwrap();
        assert_eq!(detect_existing_server(d.path())["guessedType"], "paper");
        fs::create_dir(d.path().join("mods")).unwrap();
        assert_eq!(detect_existing_server(d.path())["guessedType"], "fabric");
        let w = tmp();
        fs::create_dir(w.path().join("world")).unwrap();
        assert_eq!(detect_existing_server(w.path())["looksLikeServer"], true);
    }

    #[test]
    fn the_eula_is_written() {
        let d = tmp();
        write_eula(d.path()).unwrap();
        assert!(read(d.path(), "eula.txt").contains("eula=true"));
    }
}

//! One-click Bedrock support: Geyser (translates Bedrock and Java) plus Floodgate (lets Bedrock players in without a Java
//! account). Ported from the install half of `bedrock.js` (the start-up arguments and ports are in `bedrock.rs`).
//!
//! Paper  → Geyser-Spigot from Modrinth (matched to the server's Minecraft version, SHA-512) and floodgate-spigot from GeyserMC's
//!          download API (SHA-256).
//! Fabric → Geyser-Fabric, Floodgate-Fabric and Fabric API from Modrinth (SHA-512), matched to the server's Minecraft version.
//! Vanilla can't load plugins or mods, so it isn't supported.
//!
//! Only jars this module itself installed are ever replaced or removed: their exact names are written to
//! `voxelport-bedrock.json`. A server set up by an older VoxelPort has no such list; for those the jars are recognised by the
//! exact names Geyser and Floodgate use, which does not match look-alikes such as `GeyserSkinManager-Spigot.jar`.

use std::fs;
use std::path::Path;

use regex::Regex;
use serde_json::{json, Value};

use crate::addon_registry::is_safe_jar_name;
use crate::atomic_write;
use crate::net::{Algo, Checksum, Fetcher};
use crate::server_install::MAX_SERVER_JAR_BYTES;

pub const GEYSER_API: &str = "https://download.geysermc.org/v2/projects";
pub const MODRINTH_API: &str = "https://api.modrinth.com/v2";
const REGISTRY: &str = "voxelport-bedrock.json";
const FOLDERS: [&str; 2] = ["plugins", "mods"];
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;

/// What the install needs from the network: the client (HTTPS to the allow-listed hosts) and the two API roots.
pub struct Sources<'a> {
    pub fetcher: &'a Fetcher,
    pub modrinth_api: &'a str,
    pub geyser_api: &'a str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Jar {
    pub url: String,
    pub file_name: String,
    pub checksum: Checksum,
    pub dir: &'static str,
    /// `Some("fabric-api")` for the library, which is kept if one is already there and never counted as ours.
    pub project: Option<&'static str>,
}

pub fn supported(server_type: &str) -> bool {
    matches!(server_type, "paper" | "fabric")
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn get_json(s: &Sources, url: &str) -> Result<Value, String> {
    s.fetcher.fetch_json(url, MAX_JSON_BYTES).map_err(|e| {
        let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
        format!("{host} → {e}")
    })
}

/// The newest release (or newest of anything) of a Modrinth project for these loaders and this Minecraft version.
fn modrinth_versions(s: &Sources, project: &str, loaders: &[&str], mc: &str) -> Result<Vec<Value>, String> {
    let url = format!("{}/project/{project}/version?loaders={}&game_versions={}", s.modrinth_api, enc(&serde_json::to_string(loaders).unwrap()), enc(&serde_json::to_string(&[mc]).unwrap()));
    Ok(get_json(s, &url)?.as_array().cloned().unwrap_or_default())
}

fn pick_file(versions: &[Value]) -> Option<Value> {
    versions.iter().find(|v| v["version_type"] == "release").or_else(|| versions.first()).cloned()
}

fn modrinth_jar(pick: &Value, dir: &'static str, project: Option<&'static str>) -> Option<Jar> {
    let files = pick["files"].as_array().cloned().unwrap_or_default();
    let file = files.iter().find(|f| f["primary"] == true).or_else(|| files.first())?;
    let (sha512, name, url) = (file["hashes"]["sha512"].as_str().unwrap_or(""), file["filename"].as_str().unwrap_or(""), file["url"].as_str().unwrap_or(""));
    (!sha512.is_empty() && is_safe_jar_name(name) && !url.is_empty()).then(|| Jar { url: url.into(), file_name: name.into(), checksum: Checksum { algo: Algo::Sha512, expected: sha512.into() }, dir, project })
}

/// The Geyser build that actually supports a given Minecraft version, from Modrinth's per-release `game_versions` (GeyserMC's
/// own download API does not say which Minecraft versions a build supports, which is how "latest" could hand a 26.2 server a Geyser
/// that only speaks 26.3).
pub fn resolve_geyser_for_version(s: &Sources, loaders: &[&str], mc: &str, dir: &'static str) -> Result<Jar, String> {
    let versions = modrinth_versions(s, "geyser", loaders, mc)?;
    let pick = pick_file(&versions).ok_or_else(|| format!("No Geyser build supports Minecraft {mc} yet."))?;
    modrinth_jar(&pick, dir, None).ok_or_else(|| format!("No usable Geyser download for Minecraft {mc}."))
}

/// The jars to download for a server, all resolved before anything is written.
pub fn resolve_bedrock_jars(s: &Sources, server_type: &str, mc: &str) -> Result<Vec<Jar>, String> {
    match server_type {
        "paper" => {
            let geyser = resolve_geyser_for_version(s, &["paper", "spigot"], mc, "plugins")?;
            // Floodgate is Minecraft-version-agnostic (it only adds the auth path), so the latest build from GeyserMC's own API
            // is right for every server version.
            let fg = get_json(s, &format!("{}/floodgate/versions/latest/builds/latest", s.geyser_api))?;
            let dl = &fg["downloads"]["spigot"];
            let (name, sha256) = (dl["name"].as_str().unwrap_or(""), dl["sha256"].as_str().unwrap_or(""));
            let (version, build) = (fg["version"].as_str().unwrap_or(""), fg["build"].as_u64());
            let Some(build) = build.filter(|_| !sha256.is_empty() && is_safe_jar_name(name) && !version.is_empty()) else { return Err("No Paper download for floodgate.".into()) };
            let floodgate = Jar {
                url: format!("{}/floodgate/versions/{}/builds/{build}/downloads/spigot", s.geyser_api, enc(version)),
                file_name: name.into(),
                checksum: Checksum { algo: Algo::Sha256, expected: sha256.into() },
                dir: "plugins",
                project: None,
            };
            Ok(vec![geyser, floodgate])
        }
        "fabric" => {
            let mut out = Vec::new();
            for project in ["fabric-api", "geyser", "floodgate"] {
                let versions = modrinth_versions(s, project, &["fabric"], mc)?;
                let pick = pick_file(&versions).ok_or_else(|| format!("{project} isn't available for Minecraft {mc} yet."))?;
                out.push(modrinth_jar(&pick, "mods", (project == "fabric-api").then_some("fabric-api")).ok_or_else(|| format!("No usable download for {project}."))?);
            }
            Ok(out)
        }
        _ => Err("Bedrock players need a Paper or Fabric server — Vanilla can't run Geyser.".into()),
    }
}

/// The jars an earlier install put there, `(dir, name)`, or `None` when there is no (usable) list.
fn read_registry(server_dir: &Path) -> Option<Vec<(String, String)>> {
    let data: Value = serde_json::from_str(&fs::read_to_string(server_dir.join(REGISTRY)).ok()?).ok()?;
    let files = data["files"].as_array()?;
    Some(files.iter().filter_map(|f| Some((f["dir"].as_str().filter(|d| FOLDERS.contains(d))?.to_string(), f["name"].as_str().filter(|n| is_safe_jar_name(n))?.to_string()))).collect())
}

fn write_registry(server_dir: &Path, files: &[(String, String)]) -> Result<(), String> {
    let list: Vec<Value> = files.iter().map(|(dir, name)| json!({ "dir": dir, "name": name })).collect();
    atomic_write(&server_dir.join(REGISTRY), serde_json::to_string_pretty(&json!({ "files": list })).unwrap().as_bytes()).map_err(|e| e.to_string())
}

/// The jars to replace or remove: the ones on the list, or (no list) the ones with Geyser's and Floodgate's own names.
pub fn owned_jars(server_dir: &Path) -> Vec<(String, String)> {
    if let Some(listed) = read_registry(server_dir) {
        return listed.into_iter().filter(|(d, n)| server_dir.join(d).join(n).exists()).collect();
    }
    let legacy = Regex::new(r"(?i)^(?:geyser|floodgate)[-_](?:spigot|fabric)(?:[-_.][A-Za-z0-9_.+-]*)?\.jar$").unwrap();
    let mut out = Vec::new();
    for dir in FOLDERS {
        let Ok(read) = fs::read_dir(server_dir.join(dir)) else { continue };
        let mut names: Vec<String> = read.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| legacy.is_match(n)).collect();
        names.sort();
        out.extend(names.into_iter().map(|n| (dir.to_string(), n)));
    }
    out
}

/// Installs Geyser and Floodgate into `server_dir`. Existing Geyser and Floodgate jars are replaced; an existing Fabric API is kept.
/// `on_progress` gets `{ stage: "resolve" }`, `{ stage: "download", file }` for each jar, then `{ stage: "done" }`.
pub fn install(s: &Sources, server_dir: &Path, server_type: &str, version: &str, on_progress: &dyn Fn(Value)) -> Result<(), String> {
    if !server_dir.is_absolute() {
        return Err("Invalid server folder.".into());
    }
    on_progress(json!({ "stage": "resolve" }));
    let jars = resolve_bedrock_jars(s, server_type, version)?;
    let mut owned = owned_jars(server_dir); // what is VoxelPort's to replace, worked out before anything is written
    let mut installed: Vec<(String, String)> = Vec::new();
    let fabric_api = Regex::new(r"(?i)^fabric-api[A-Za-z0-9_.+-]*\.jar$").unwrap();

    for jar in &jars {
        let dir = server_dir.join(jar.dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if jar.project == Some("fabric-api") && fs::read_dir(&dir).is_ok_and(|d| d.flatten().any(|e| fabric_api.is_match(&e.file_name().to_string_lossy()))) {
            continue;
        }
        on_progress(json!({ "stage": "download", "file": jar.file_name }));
        s.fetcher.download(&jar.url, &dir.join(&jar.file_name), MAX_SERVER_JAR_BYTES, Some(&jar.checksum), 0, &|_, _| {})?;
        if jar.project != Some("fabric-api") {
            // Drop older copies of the same one, so the server does not load two Geysers.
            let family = if jar.file_name.to_ascii_lowercase().starts_with("geyser") { "geyser" } else { "floodgate" };
            for (old_dir, old_name) in &owned {
                if old_dir == jar.dir && *old_name != jar.file_name && old_name.to_ascii_lowercase().starts_with(family) {
                    let _ = fs::remove_file(server_dir.join(old_dir).join(old_name));
                }
            }
            owned.retain(|(d, n)| !(d == jar.dir && n.to_ascii_lowercase().starts_with(family)));
            installed.push((jar.dir.to_string(), jar.file_name.clone()));
        }
    }
    owned.extend(installed);
    write_registry(server_dir, &owned)?;
    on_progress(json!({ "stage": "done" }));
    Ok(())
}

/// Removes the Geyser and Floodgate jars VoxelPort installed (Fabric API stays: other mods may need it).
pub fn remove(server_dir: &Path) {
    for (dir, name) in owned_jars(server_dir) {
        let _ = fs::remove_file(server_dir.join(dir).join(name));
    }
    let _ = fs::remove_file(server_dir.join(REGISTRY));
}

/// Pre-flight: does a Geyser build exist that supports this server's Minecraft version? Reads Modrinth's per-release
/// `game_versions` (not a hardcoded table). `Ok(true)` when one exists, `Ok(false)` when none does (Bedrock players would be let
/// in only to be disconnected by Geyser), and `None` when the check itself failed (network): a start is never blocked on our own
/// inability to check.
pub fn geyser_compatible(s: &Sources, server_type: &str, mc: &str) -> Option<bool> {
    let loaders: &[&str] = if server_type == "fabric" { &["fabric"] } else { &["paper", "spigot"] };
    modrinth_versions(s, "geyser", loaders, mc).ok().map(|v| !v.is_empty())
}

//! Import a Modrinth modpack (`.mrpack`) and install the parts that run on a server. Ported from `modpackImport.js`.
//!
//! A `.mrpack` is a ZIP whose `modrinth.index.json` lists each file with a download URL, a SHA-512, and an `env` saying whether
//! it belongs on the client, the server, or both. Only the files marked for the server (or required on both) are downloaded,
//! each verified against its SHA-512 and only from Modrinth's own hosts, into the Fabric server's `mods/` folder. Client-only
//! mods (shaders, minimaps, key-binds) are skipped and reported so the person understands why their pack looks smaller.
//!
//! Everything inside the pack is untrusted: the manifest is size-limited and strictly validated, file paths are kept inside
//! `mods/` or `config/`, and nothing is downloaded from a host that is not on the allow-list.
//!
//! Forge and NeoForge packs are refused with a clear message, because the app has no Forge/NeoForge server installer. Quilt
//! packs install on Fabric (Quilt loads Fabric mods), which is how most of them are meant to run.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::net::{Algo, Checksum, Fetcher, HostPolicy};
use crate::server_install::MAX_SERVER_JAR_BYTES;

const MAX_INDEX_BYTES: u64 = 2 * 1024 * 1024; // modrinth.index.json: a few hundred KB even for a huge pack
const MAX_FILES: usize = 1000; // a pack with more than this is not something to install blindly
const MAX_OVERRIDE_BYTES: u64 = 64 * 1024 * 1024; // total bytes of config/ files copied out of the pack
const MAX_OVERRIDE_FILES: usize = 2000;
const MODRINTH_DOMAIN: &str = "modrinth.com";

/// A tidy error the screens show as-is, with a machine-readable `code`.
#[derive(Debug, PartialEq, Clone)]
pub struct ModpackError {
    pub code: &'static str,
    pub message: String,
}

fn err(code: &'static str, message: impl Into<String>) -> ModpackError {
    ModpackError { code, message: message.into() }
}

#[derive(Debug, PartialEq, Clone)]
pub struct Download {
    pub path: String,
    pub url: String,
    pub sha512: String,
    pub bytes: u64,
}

#[derive(Debug, PartialEq, Clone)]
pub struct Skipped {
    pub name: String,
    pub reason: &'static str,
}

#[derive(Debug, PartialEq, Clone)]
pub struct Plan {
    pub name: String,
    pub minecraft: String,
    pub quilt: bool,
    pub downloads: Vec<Download>,
    pub skipped: Vec<Skipped>,
}

impl Plan {
    pub fn skipped_json(&self) -> Value {
        Value::Array(self.skipped.iter().map(|s| json!({ "name": s.name, "reason": s.reason })).collect())
    }
}

/// `[\w.+-]{1,40}`.
fn is_tame_version(v: &str) -> bool {
    (1..=40).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
}

/// A relative path with no `..` and only tame characters, in plain `/`-separated pieces. Stricter than the Electron regex in
/// one way: a lone `.` piece is refused too.
pub fn is_safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains("..")
        && rel.split('/').all(|seg| !seg.is_empty() && seg != "." && seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b' ' | b'.' | b'+' | b'(' | b')' | b'[' | b']' | b'-')))
}

/// The Minecraft version and loader a parsed manifest asks for, or an error if it is not a Fabric pack we can run.
pub fn read_dependencies(deps: &Value) -> Result<(String, bool), ModpackError> {
    if !deps.is_object() {
        return Err(err("bad-pack", "This modpack has no version information."));
    }
    let mc = deps["minecraft"].as_str().filter(|m| is_tame_version(m)).ok_or_else(|| err("bad-pack", "This modpack does not say which Minecraft version it needs."))?;
    let present = |k: &str| !(deps[k].is_null() || deps[k] == "" || deps[k] == false);
    if present("forge") || present("neoforge") {
        return Err(err("forge", "This is a Forge or NeoForge modpack. VoxelPort can host Fabric modpacks; Forge isn’t supported yet."));
    }
    let loader = if present("fabric-loader") { &deps["fabric-loader"] } else { &deps["quilt-loader"] };
    if !loader.as_str().is_some_and(is_tame_version) {
        return Err(err("not-fabric", "VoxelPort can host Fabric (and Quilt) modpacks. This one needs a loader it doesn’t support."));
    }
    Ok((mc.to_string(), present("quilt-loader")))
}

/// True when a file's env marks it as wanted on the server. "required" and "optional" both go on the server; only
/// "unsupported" is left off (the person can remove an optional one later from the add-ons screen).
pub fn wanted_on_server(env: &Value) -> bool {
    !(env.is_object() && env["server"] == "unsupported")
}

pub fn skip_reason(env: &Value) -> &'static str {
    if env.is_object() && env["server"] == "unsupported" {
        if env["client"] == "required" { "client-only" } else { "not for servers" }
    } else {
        ""
    }
}

pub fn is_modrinth_url(u: &str) -> bool {
    let Ok(parsed) = url::Url::parse(u) else { return false };
    parsed.scheme() == "https" && parsed.host_str().is_some_and(|h| HostPolicy::domains(&[MODRINTH_DOMAIN]).host_allowed(h))
}

/// Turns the raw `files` array of `modrinth.index.json` into a plan: what to download to the server, and what was skipped and
/// why. Anything malformed is an error. Pure: the caller does the downloading.
pub fn plan_files(files: &Value) -> Result<(Vec<Download>, Vec<Skipped>), ModpackError> {
    let Some(files) = files.as_array() else { return Err(err("bad-pack", "This modpack’s file list is missing or damaged.")) };
    if files.len() > MAX_FILES {
        return Err(err("too-big", "This modpack lists an unusual number of files, so it was not imported."));
    }
    let (mut downloads, mut skipped) = (Vec::new(), Vec::new());
    for f in files {
        if !f.is_object() {
            return Err(err("bad-pack", "This modpack has a damaged entry in its file list."));
        }
        let rel = f["path"].as_str().unwrap_or("");
        let in_mods = rel.starts_with("mods/");
        let in_config = rel.starts_with("config/");
        let name = rel.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or(rel).to_string();
        // A backslash, a drive letter or anything but a plain forward-slash path is refused outright, not tidied up.
        if !is_safe_rel(rel) || rel.contains('\\') {
            return Err(err("unsafe", "This modpack names a file in an unexpected place, so it was not imported."));
        }
        // Only mods and config go on the server. Anything else in the manifest (resourcepacks/, shaderpacks/) is client art.
        if !in_mods && !in_config {
            skipped.push(Skipped { name, reason: "client-only" });
            continue;
        }
        if !wanted_on_server(&f["env"]) {
            skipped.push(Skipped { name, reason: Some(skip_reason(&f["env"])).filter(|r| !r.is_empty()).unwrap_or("not for servers") });
            continue;
        }
        let url = f["downloads"].as_array().and_then(|a| a.iter().filter_map(Value::as_str).find(|u| is_modrinth_url(u)));
        let sha512 = f["hashes"]["sha512"].as_str().filter(|h| h.len() == 128 && h.bytes().all(|b| b.is_ascii_hexdigit()));
        let (Some(url), Some(sha512)) = (url, sha512) else {
            // A server mod that can't be fetched safely: say so rather than installing something unverified.
            skipped.push(Skipped { name, reason: if url.is_some() { "no checksum" } else { "not on Modrinth" } });
            continue;
        };
        let bytes = f["fileSize"].as_f64().filter(|b| b.is_finite() && *b > 0.0).map(|b| b as u64).unwrap_or(0);
        downloads.push(Download { path: rel.to_string(), url: url.to_string(), sha512: sha512.to_string(), bytes });
    }
    Ok((downloads, skipped))
}

/// Validates the parsed `modrinth.index.json` and returns the name, versions and the install plan. Pure.
pub fn plan_from_manifest(index: &Value) -> Result<Plan, ModpackError> {
    if !index.is_object() {
        return Err(err("bad-pack", "This file is not a readable Modrinth modpack."));
    }
    if !index["game"].is_null() && index["game"] != "minecraft" {
        return Err(err("bad-pack", "This modpack is not for Minecraft."));
    }
    if !index["formatVersion"].is_null() && index["formatVersion"] != 1 {
        return Err(err("bad-pack", "This modpack is in a newer format VoxelPort can’t read yet."));
    }
    let name: String = index["name"].as_str().map(|n| n.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(80).collect()).unwrap_or_default();
    let (minecraft, quilt) = read_dependencies(&index["dependencies"])?;
    let (downloads, skipped) = plan_files(&index["files"])?;
    Ok(Plan { name, minecraft, quilt, downloads, skipped })
}

// ─── File side: read the .mrpack, run the plan, copy config overrides ───

pub fn check_mrpack_path(file: &Path) -> Result<(), ModpackError> {
    if !file.is_absolute() {
        return Err(err("bad-pack", "Invalid modpack file."));
    }
    if !file.extension().is_some_and(|e| e.eq_ignore_ascii_case("mrpack")) {
        return Err(err("bad-pack", "Choose a Modrinth modpack (.mrpack) file."));
    }
    Ok(())
}

fn open_zip(file: &Path) -> Result<zip::ZipArchive<fs::File>, ModpackError> {
    let f = fs::File::open(file).map_err(|e| err("bad-pack", format!("That modpack file can’t be read ({e}).")))?;
    zip::ZipArchive::new(f).map_err(|e| err("bad-pack", format!("That modpack file can’t be read ({e}).")))
}

/// Reads `modrinth.index.json` out of the pack (nothing is extracted) and returns the install plan.
pub fn read_plan(file: &Path) -> Result<Plan, ModpackError> {
    check_mrpack_path(file)?;
    let mut zip = open_zip(file)?;
    let idx = (0..zip.len()).find(|i| zip.by_index_raw(*i).is_ok_and(|e| e.name() == "modrinth.index.json")).ok_or_else(|| err("not-mrpack", "That file is not a Modrinth modpack (no modrinth.index.json inside)."))?;
    let entry = zip.by_index(idx).map_err(|e| err("bad-pack", format!("That modpack is damaged ({e}).")))?;
    if entry.size() > MAX_INDEX_BYTES {
        return Err(err("too-big", "This modpack’s index is unexpectedly large, so it was not imported."));
    }
    let mut bytes = Vec::new();
    entry.take(MAX_INDEX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| err("bad-pack", format!("That modpack is damaged ({e}).")))?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err(err("too-big", "This modpack’s index is unexpectedly large, so it was not imported."));
    }
    let index: Value = serde_json::from_slice(&bytes).map_err(|e| err("bad-pack", format!("This modpack’s index is damaged ({e}).")))?;
    plan_from_manifest(&index)
}

/// Copies the pack's own config files (the `overrides/` and `server-overrides/` folders) into the server, so a pack that ships
/// tuned config works out of the box. Only files under `config/` or `mods/` are taken; a world, a client option file or
/// anything with a strange path is ignored. `server-overrides` wins over `overrides` for the same file because it is applied
/// in the order the zip lists them and a later copy replaces an earlier one. Returns how many files were copied.
pub fn copy_overrides(file: &Path, server_dir: &Path) -> Result<usize, ModpackError> {
    let mut zip = open_zip(file)?;
    let root = server_dir.to_path_buf();
    let (mut copied, mut bytes) = (0usize, 0u64);
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| err("bad-pack", format!("The modpack’s config could not be read ({e}).")))?;
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix("server-overrides/").or_else(|| name.strip_prefix("overrides/")) else { continue };
        if rel.is_empty() || name.ends_with('/') {
            continue;
        }
        if !(rel.starts_with("config/") || rel.starts_with("mods/")) || !is_safe_rel(rel) || rel.contains('\\') {
            continue;
        }
        copied += 1;
        if copied > MAX_OVERRIDE_FILES {
            return Err(err("too-big", "This modpack ships too many config files, so it was not imported."));
        }
        let target: PathBuf = rel.split('/').fold(root.clone(), |p, seg| p.join(seg));
        if !target.starts_with(&root) || target.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(err("unsafe", "This modpack tried to write outside its folder, so it was not imported."));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| err("bad-pack", format!("The modpack’s config could not be written ({e}).")))?;
        }
        let mut out = fs::File::create(&target).map_err(|e| err("bad-pack", format!("The modpack’s config could not be written ({e}).")))?;
        let n = std::io::copy(&mut (&mut entry).take(MAX_OVERRIDE_BYTES - bytes + 1), &mut out).map_err(|e| err("bad-pack", format!("The modpack’s config could not be read ({e}).")))?;
        bytes += n;
        if bytes > MAX_OVERRIDE_BYTES {
            return Err(err("bad-pack", "The modpack’s config could not be read (overrides too large)."));
        }
    }
    Ok(copied)
}

/// Downloads every planned server mod into `server_dir`, verified by SHA-512, then copies the pack's config overrides. The
/// Fabric server jar itself is installed by the caller (it knows the version from the plan). `on_progress` gets
/// `{ stage: "download", name, index, total }`, then `{ stage: "config" }`, then `{ stage: "done" }`.
pub fn install_mods(fetcher: &Fetcher, file: &Path, server_dir: &Path, plan: &Plan, on_progress: &dyn Fn(Value)) -> Result<usize, ModpackError> {
    check_mrpack_path(file)?;
    if !server_dir.is_absolute() {
        return Err(err("bad-pack", "Invalid server folder."));
    }
    let total = plan.downloads.len();
    for (i, d) in plan.downloads.iter().enumerate() {
        let name = d.path.rsplit('/').next().unwrap_or(&d.path);
        on_progress(json!({ "stage": "download", "name": name, "index": i + 1, "total": total }));
        let target: PathBuf = d.path.split('/').fold(server_dir.to_path_buf(), |p, seg| p.join(seg));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| err("bad-pack", e.to_string()))?;
        }
        let checksum = Checksum { algo: Algo::Sha512, expected: d.sha512.clone() };
        fetcher.download(&d.url, &target, MAX_SERVER_JAR_BYTES, Some(&checksum), d.bytes, &|_, _| {}).map_err(|e| err("download", e))?;
    }
    on_progress(json!({ "stage": "config" }));
    copy_overrides(file, server_dir)?;
    on_progress(json!({ "stage": "done" }));
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash() -> String {
        "a".repeat(128)
    }

    fn file(path: &str, env: Value) -> Value {
        json!({ "path": path, "hashes": { "sha512": hash() }, "downloads": ["https://cdn.modrinth.com/data/x/versions/y/f.jar"], "fileSize": 1234, "env": env })
    }

    #[test]
    fn fabric_and_quilt_packs_are_accepted_and_forge_is_refused_with_its_own_code() {
        assert_eq!(read_dependencies(&json!({ "minecraft": "1.21.4", "fabric-loader": "0.16.9" })).unwrap(), ("1.21.4".into(), false));
        assert_eq!(read_dependencies(&json!({ "minecraft": "1.21.4", "quilt-loader": "0.26.0" })).unwrap(), ("1.21.4".into(), true));
        assert_eq!(read_dependencies(&json!({ "minecraft": "1.20.1", "forge": "47.2.0" })).unwrap_err().code, "forge");
        assert_eq!(read_dependencies(&json!({ "minecraft": "1.21.1", "neoforge": "21.1.1" })).unwrap_err().code, "forge");
        assert_eq!(read_dependencies(&json!({ "minecraft": "1.21.4" })).unwrap_err().code, "not-fabric");
        assert_eq!(read_dependencies(&json!({ "fabric-loader": "0.16.9" })).unwrap_err().code, "bad-pack");
        assert_eq!(read_dependencies(&json!({ "minecraft": "1.21 4", "fabric-loader": "1" })).unwrap_err().code, "bad-pack");
        assert_eq!(read_dependencies(&Value::Null).unwrap_err().code, "bad-pack");
    }

    #[test]
    fn server_side_rules_follow_the_manifest_env() {
        assert!(wanted_on_server(&Value::Null));
        assert!(wanted_on_server(&json!({ "client": "required", "server": "required" })));
        assert!(wanted_on_server(&json!({ "client": "required", "server": "optional" })));
        assert!(!wanted_on_server(&json!({ "client": "required", "server": "unsupported" })));
        assert_eq!(skip_reason(&json!({ "client": "required", "server": "unsupported" })), "client-only");
        assert_eq!(skip_reason(&json!({ "client": "optional", "server": "unsupported" })), "not for servers");
        assert_eq!(skip_reason(&Value::Null), "");
    }

    #[test]
    fn only_modrinth_https_addresses_are_downloaded_from() {
        for ok in ["https://cdn.modrinth.com/data/a/b.jar", "https://modrinth.com/x", "https://api.modrinth.com/y"] {
            assert!(is_modrinth_url(ok), "{ok}");
        }
        for bad in ["http://cdn.modrinth.com/a", "https://evilmodrinth.com/a", "https://modrinth.com.evil.example/a", "https://github.com/a.jar", "ftp://modrinth.com/a", "nope"] {
            assert!(!is_modrinth_url(bad), "{bad}");
        }
    }

    #[test]
    fn the_plan_keeps_server_mods_and_says_why_it_left_the_rest() {
        let mut offsite = file("mods/offsite.jar", Value::Null);
        offsite["downloads"] = json!(["https://example.com/o.jar"]);
        let mut nohash = file("mods/nohash.jar", Value::Null);
        nohash["hashes"] = json!({});
        let files = Value::Array(vec![
            file("mods/lithium.jar", json!({ "client": "optional", "server": "required" })),
            file("mods/sodium.jar", json!({ "client": "required", "server": "unsupported" })),
            file("mods/map.jar", json!({ "client": "optional", "server": "unsupported" })),
            file("config/lithium.toml", Value::Null),
            file("shaderpacks/pretty.zip", Value::Null),
            offsite,
            nohash,
        ]);
        let (downloads, skipped) = plan_files(&files).unwrap();
        assert_eq!(downloads.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["mods/lithium.jar", "config/lithium.toml"]);
        assert_eq!(downloads[0].bytes, 1234);
        let why: Vec<(&str, &str)> = skipped.iter().map(|s| (s.name.as_str(), s.reason)).collect();
        assert_eq!(why, [("sodium.jar", "client-only"), ("map.jar", "not for servers"), ("pretty.zip", "client-only"), ("offsite.jar", "not on Modrinth"), ("nohash.jar", "no checksum")]);
    }

    #[test]
    fn a_path_that_could_escape_the_server_folder_refuses_the_whole_pack() {
        for bad in ["mods/../../evil.jar", "..\\evil.jar", "mods\\evil.jar", "/etc/passwd", "C:/x.jar", "mods//x.jar", "mods/./x.jar", "", "mods/a;b.jar", "mods/a%2e.jar"] {
            let r = plan_files(&json!([file(bad, Value::Null)]));
            assert_eq!(r.unwrap_err().code, "unsafe", "{bad:?}");
        }
        assert_eq!(plan_files(&json!("nope")).unwrap_err().code, "bad-pack");
        assert_eq!(plan_files(&json!([1])).unwrap_err().code, "bad-pack");
        let many: Vec<Value> = (0..1001).map(|i| file(&format!("mods/m{i}.jar"), Value::Null)).collect();
        assert_eq!(plan_files(&Value::Array(many)).unwrap_err().code, "too-big");
    }

    #[test]
    fn the_manifest_header_is_validated_and_the_name_is_cleaned() {
        let ok = json!({ "formatVersion": 1, "game": "minecraft", "name": "  My\u{7} Pack \n", "dependencies": { "minecraft": "1.21.4", "fabric-loader": "0.16.9" }, "files": [] });
        let plan = plan_from_manifest(&ok).unwrap();
        assert_eq!((plan.name.as_str(), plan.minecraft.as_str(), plan.quilt), ("My Pack", "1.21.4", false));
        for (bad, code) in [
            (json!({ "game": "terraria", "dependencies": ok["dependencies"], "files": [] }), "bad-pack"),
            (json!({ "formatVersion": 2, "dependencies": ok["dependencies"], "files": [] }), "bad-pack"),
            (json!([]), "bad-pack"),
            (json!({ "dependencies": ok["dependencies"] }), "bad-pack"),
        ] {
            assert_eq!(plan_from_manifest(&bad).unwrap_err().code, code, "{bad}");
        }
    }
}

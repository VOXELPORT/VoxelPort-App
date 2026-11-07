//! Plugins (Paper) and mods (Fabric) from Modrinth: search, install with the libraries they need, and remove. Ported from
//! `addons.js`.
//!
//! Everything that comes from Modrinth is treated as untrusted text: it is only ever shown as text, file names must be plain
//! `.jar` names, and every download is checked against Modrinth's SHA-512 before it is put in the folder. What was installed is
//! written to `voxelport-addons.json` in the server folder (see `addon_registry.rs`), so Remove only ever deletes files
//! VoxelPort put there (never the ones the person added by hand, or Geyser and Floodgate, which Bedrock support manages).

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha512};

use crate::addon_registry::{installed_addons, is_icon_url, is_project_id, is_safe_jar_name, save};
use crate::cracked::Modrinth;
use crate::net::{Algo, Checksum, Fetcher, HostPolicy};
use crate::server_install::MAX_SERVER_JAR_BYTES;

const PAGE: usize = 20;
const MAX_DEPENDENCY_DEPTH: u32 = 2;
const MAX_JARS_TO_IDENTIFY: usize = 100;
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ICON_BYTES: u64 = 256 * 1024;
const ICON_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

/// An error the screens show as text. `code` and `file` let the screen word "that file is already there" in the person's
/// language with the name filled in.
#[derive(Debug, PartialEq)]
pub struct AddonError {
    pub message: String,
    pub code: Option<&'static str>,
    pub file: Option<String>,
}

impl AddonError {
    fn plain(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, file: None }
    }
}

impl From<String> for AddonError {
    fn from(message: String) -> Self {
        Self::plain(message)
    }
}

/// Vanilla can't load either; Paper takes plugins, Fabric takes mods.
pub fn supported(server_type: &str) -> bool {
    matches!(server_type, "paper" | "fabric")
}

pub fn loaders_for(server_type: &str) -> &'static [&'static str] {
    if server_type == "fabric" { &["fabric"] } else { &["paper", "spigot", "bukkit"] }
}

pub fn folder_for(server_type: &str) -> &'static str {
    if server_type == "fabric" { "mods" } else { "plugins" }
}

/// `[\w.+-]{1,40}`, ASCII.
pub fn is_mc_version(v: &str) -> bool {
    (1..=40).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
}

fn check_dir(dir: &Path) -> Result<(), String> {
    if dir.is_absolute() { Ok(()) } else { Err("Invalid server folder.".into()) }
}

fn check_type(server_type: &str) -> Result<(), String> {
    if supported(server_type) { Ok(()) } else { Err("Plugins and mods need a Paper or Fabric server.".into()) }
}

fn check_project(id: &str) -> Result<(), String> {
    if is_project_id(id) { Ok(()) } else { Err("Invalid project.".into()) }
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn get_json(m: &Modrinth, url: &str) -> Result<Value, String> {
    m.fetcher.fetch_json(url, MAX_JSON_BYTES).map_err(|e| {
        let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
        format!("{host} → {e}")
    })
}

/// One page of search results. `any_version` also lists the ones not marked for this Minecraft version.
/// Returns `{ hits: [{ id, slug, title, desc, downloads, author, icon }], more }`.
pub fn search(m: &Modrinth, server_type: &str, version: &str, query: &str, any_version: bool, offset: i64) -> Result<Value, String> {
    check_type(server_type)?;
    let q: String = query.trim().chars().take(100).collect();
    let off = if (0..=1000).contains(&offset) { offset } else { 0 };
    let mut facets: Vec<Vec<String>> = vec![
        if server_type == "fabric" { vec!["project_type:mod".into()] } else { vec!["project_type:mod".into(), "project_type:plugin".into()] },
        loaders_for(server_type).iter().map(|l| format!("categories:{l}")).collect(),
    ];
    if !any_version && is_mc_version(version) {
        facets.push(vec![format!("versions:{version}")]);
    }
    let url = format!(
        "{}/search?query={}&facets={}&limit={PAGE}&offset={off}&index={}",
        m.api,
        enc(&q),
        enc(&serde_json::to_string(&facets).unwrap()),
        if q.is_empty() { "downloads" } else { "relevance" }
    );
    let body = get_json(m, &url)?;
    let raw: Vec<Value> = body["hits"].as_array().cloned().unwrap_or_default();
    let hits: Vec<Value> = raw
        .iter()
        .filter(|h| h["project_id"].as_str().is_some_and(is_project_id))
        .map(|h| {
            let text = |k: &str| h[k].as_str().unwrap_or("").to_string();
            let slug = text("slug");
            let title = h["title"].as_str().filter(|t| !t.is_empty()).map(str::to_string).unwrap_or_else(|| slug.clone());
            json!({
                "id": text("project_id"), "slug": slug, "title": title, "desc": text("description"),
                "downloads": h["downloads"].as_f64().unwrap_or(0.0) as u64, "author": text("author"),
                "icon": h["icon_url"].as_str().filter(|i| is_icon_url(i)).unwrap_or(""),
            })
        })
        .collect();
    Ok(json!({ "hits": hits, "more": raw.len() >= PAGE }))
}

/// The newest version that fits: a release if there is one, otherwise the newest beta or alpha.
fn best_version(m: &Modrinth, project: &str, server_type: &str, version: &str) -> Result<Option<Value>, String> {
    let mut url = format!("{}/project/{project}/version?loaders={}", m.api, enc(&serde_json::to_string(loaders_for(server_type)).unwrap()));
    if is_mc_version(version) {
        url += &format!("&game_versions={}", enc(&serde_json::to_string(&[version]).unwrap()));
    }
    let list = get_json(m, &url)?;
    let versions: Vec<&Value> = list.as_array().map(|a| a.iter().filter(|v| v.is_object()).collect()).unwrap_or_default();
    Ok(versions.iter().copied().find(|v| v["version_type"] == "release").or_else(|| versions.first().copied()).cloned())
}

/// SHA-512 of a file, read in pieces: a mods folder holds jars of many megabytes.
fn hash_file(file: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(file)?;
    let (mut hasher, mut buf) = (Sha512::new(), vec![0u8; 64 * 1024]);
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Which projects are already in the folder, by file fingerprint (so a mod added by hand, or Fabric API that Bedrock support
/// installed, is recognised and not downloaded twice). A failed lookup just means "none recognised".
pub fn projects_in_folder(m: &Modrinth, dir: &Path) -> HashSet<String> {
    let Ok(read) = fs::read_dir(dir) else { return HashSet::new() };
    let mut names: Vec<String> = read.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.to_ascii_lowercase().ends_with(".jar")).collect();
    names.sort();
    names.truncate(MAX_JARS_TO_IDENTIFY);
    let hashes: Vec<String> = names.iter().filter_map(|n| hash_file(&dir.join(n)).ok()).collect();
    if hashes.is_empty() {
        return HashSet::new();
    }
    let Ok(found) = m.fetcher.post_json(&format!("{}/version_files", m.api), &json!({ "hashes": hashes, "algorithm": "sha512" }), MAX_JSON_BYTES) else { return HashSet::new() };
    found.as_object().map(|o| o.values().filter_map(|v| v["project_id"].as_str().map(str::to_string)).collect()).unwrap_or_default()
}

pub struct InstallRequest<'a> {
    pub server_dir: &'a Path,
    pub server_type: &'a str,
    pub version: &'a str,
    pub project_id: &'a str,
    pub title: &'a str,
    pub icon: &'a str,
    /// The server is running: new files can be added, but one that is already there can't be replaced.
    pub running: bool,
}

struct Install<'a, 'b> {
    m: &'a Modrinth<'a>,
    req: &'a InstallRequest<'a>,
    dir: std::path::PathBuf,
    done: Vec<String>,
    seen: HashSet<String>,
    in_folder: Option<HashSet<String>>,
    on_progress: &'b dyn Fn(Value),
}

impl Install<'_, '_> {
    fn one(&mut self, id: &str, name: &str, depth: u32) -> Result<(), AddonError> {
        if !self.seen.insert(id.to_string()) {
            return Ok(());
        }
        let req = self.req;
        (self.on_progress)(json!({ "stage": "resolve", "title": name }));
        let loader_name = if req.server_type == "fabric" { "Fabric" } else { "Paper" };
        let who = if name.is_empty() { "It".to_string() } else { name.to_string() };
        let v = best_version(self.m, id, req.server_type, req.version)?.ok_or_else(|| format!("{who} has no {loader_name} version for Minecraft {}.", req.version))?;

        for d in v["dependencies"].as_array().cloned().unwrap_or_default() {
            let dep = d["project_id"].as_str().unwrap_or("");
            if d["dependency_type"] != "required" || !is_project_id(dep) || depth >= MAX_DEPENDENCY_DEPTH {
                continue;
            }
            if installed_addons(req.server_dir)?.iter().any(|a| a["id"] == dep) {
                continue;
            }
            if self.in_folder.is_none() {
                self.in_folder = Some(projects_in_folder(self.m, &self.dir));
            }
            if self.in_folder.as_ref().is_some_and(|s| s.contains(dep)) {
                continue;
            }
            let dep_title = get_json(self.m, &format!("{}/project/{dep}", self.m.api)).ok().and_then(|p| p["title"].as_str().map(str::to_string)).unwrap_or_default();
            self.one(dep, &dep_title, depth + 1)?;
        }

        let files = v["files"].as_array().cloned().unwrap_or_default();
        let file = files.iter().find(|f| f["primary"] == true).or_else(|| files.first());
        // A plain name or nothing: never "tidied up" into one.
        let file_name = file.and_then(|f| f["filename"].as_str()).unwrap_or("");
        let Some(file) = file.filter(|_| is_safe_jar_name(file_name)) else { return Err(format!("{who} is not shipped as a .jar, so it can't be installed here.").into()) };
        let Some(sha512) = file["hashes"]["sha512"].as_str().filter(|h| !h.is_empty()) else { return Err(format!("{who} has no checksum to verify, so it was not installed.").into()) };

        let registry = installed_addons(req.server_dir)?;
        let older: Vec<&Value> = registry.iter().filter(|a| a["id"] == id).collect();
        let dest = self.dir.join(file_name);
        let folder = folder_for(req.server_type);
        // A file with this name that VoxelPort did not put there is the owner's own (added by hand, or by another tool): never overwrite it.
        if dest.exists() && !older.iter().any(|a| a["file"] == file_name) {
            return Err(AddonError { message: format!("A file named {file_name} is already in {folder}. Remove it first, or keep using it."), code: Some("exists"), file: Some(file_name.to_string()) });
        }
        if req.running && (!older.is_empty() || dest.exists()) {
            return Err("Stop the server first to update one that is already installed.".to_string().into());
        }
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        (self.on_progress)(json!({ "stage": "download", "title": if name.is_empty() { file_name } else { name }, "file": file_name }));
        let url = file["url"].as_str().unwrap_or("");
        self.m.fetcher.download(url, &dest, MAX_SERVER_JAR_BYTES, Some(&Checksum { algo: Algo::Sha512, expected: sha512.to_string() }), 0, &|_, _| {})?;
        for a in &older {
            if a["file"] != file_name {
                let _ = fs::remove_file(req.server_dir.join(a["dir"].as_str().unwrap_or("")).join(a["file"].as_str().unwrap_or("")));
            }
        }
        let mut entry = json!({ "id": id, "title": if name.is_empty() { file_name } else { name }, "file": file_name, "dir": folder });
        if id == req.project_id && is_icon_url(req.icon) {
            entry["icon"] = json!(req.icon);
        }
        let mut list: Vec<Value> = registry.iter().filter(|a| a["id"] != id).cloned().collect();
        list.push(entry);
        save(req.server_dir, &list)?;
        self.done.push(if name.is_empty() { file_name.to_string() } else { name.to_string() });
        Ok(())
    }
}

/// Installs a project and the libraries it requires. Returns the titles that were installed (libraries first).
pub fn install(m: &Modrinth, req: &InstallRequest, on_progress: &dyn Fn(Value)) -> Result<Vec<String>, AddonError> {
    check_dir(req.server_dir)?;
    check_type(req.server_type)?;
    check_project(req.project_id)?;
    let mut run = Install { m, req, dir: req.server_dir.join(folder_for(req.server_type)), done: Vec::new(), seen: HashSet::new(), in_folder: None, on_progress };
    let title: String = req.title.chars().take(100).collect();
    run.one(req.project_id, &title, 0)?;
    on_progress(json!({ "stage": "done" }));
    Ok(run.done)
}

/// Deletes the files VoxelPort installed for a project. A running server has them open, so it has to be stopped first.
pub fn remove(server_dir: &Path, project_id: &str, running: bool) -> Result<(), String> {
    check_dir(server_dir)?;
    check_project(project_id)?;
    let all = installed_addons(server_dir)?;
    let mine: Vec<&Value> = all.iter().filter(|a| a["id"] == project_id).collect();
    if mine.is_empty() {
        return Err("That one was not installed by VoxelPort.".into());
    }
    if running {
        return Err("Stop the server first. A running server has its plugins and mods open.".into());
    }
    for a in &mine {
        let _ = fs::remove_file(server_dir.join(a["dir"].as_str().unwrap_or("")).join(a["file"].as_str().unwrap_or("")));
    }
    let rest: Vec<Value> = all.iter().filter(|a| a["id"] != project_id).cloned().collect();
    save(server_dir, &rest)
}

/// The client for icons: Modrinth's own image host only.
pub fn icon_fetcher() -> Fetcher {
    Fetcher::new(HostPolicy::exact(&["cdn.modrinth.com"]), "Icon", crate::mc_versions::USER_AGENT)
}

/// Fetches one plugin icon and returns it as a `data:` address the page can show (the page itself may not load anything from
/// the internet). Only Modrinth's image host, only small real images. Returns "" for anything else (the page keeps its letter).
pub fn fetch_icon(fetcher: &Fetcher, url: &str) -> String {
    if !is_icon_url(url) {
        return String::new();
    }
    match fetcher.fetch_bytes(url, MAX_ICON_BYTES) {
        Ok((kind, bytes)) if !bytes.is_empty() && ICON_TYPES.contains(&kind.as_str()) => {
            use base64::Engine;
            format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_paper_and_fabric_take_add_ons_and_each_has_its_folder() {
        assert!(supported("paper") && supported("fabric") && !supported("vanilla") && !supported(""));
        assert_eq!((folder_for("paper"), folder_for("fabric")), ("plugins", "mods"));
        assert_eq!(loaders_for("fabric"), &["fabric"]);
        assert_eq!(loaders_for("paper"), &["paper", "spigot", "bukkit"]);
    }

    #[test]
    fn minecraft_versions_in_a_query_are_checked() {
        for ok in ["1.21.4", "26.1", "1.20.1-rc1", "24w14a"] {
            assert!(is_mc_version(ok), "{ok}");
        }
        for bad in ["", "1.21 4", "1.21\"]", "a/b", &"1".repeat(41)] {
            assert!(!is_mc_version(bad), "{bad}");
        }
    }
}

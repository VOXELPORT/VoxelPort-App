//! Which Minecraft versions each server type offers, and where its jar comes from. Ported from `mcVersions.js`.
//! Each type is "fetch a small JSON API, then hand back a direct jar URL"; none needs an installer program.

use serde_json::Value;

use crate::net::{Algo, Checksum, Fetcher, HostPolicy};

/// Official first-party hosts (and their subdomains) a server jar may come from. `geysermc.org` and `modrinth.com`
/// serve the Geyser, Floodgate and Fabric API jars for one-click Bedrock support, always checksum-verified.
pub const ALLOWED_DOWNLOAD_DOMAINS: &[&str] = &["mojang.com", "minecraft.net", "papermc.io", "fabricmc.net", "geysermc.org", "modrinth.com"];

const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
pub const USER_AGENT: &str = "VoxelPort-App (+https://voxelport.in)";

/// The three version services. Production values are the real ones; tests point them at a local server.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub vanilla_manifest: String,
    /// PaperMC retired api.papermc.io/v2 (now HTTP 410) for their "Fill" service, which needs a real User-Agent.
    pub paper_api: String,
    pub fabric_meta: String,
}

impl Endpoints {
    pub fn production() -> Self {
        Self {
            vanilla_manifest: "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json".into(),
            paper_api: "https://fill.papermc.io/v3/projects/paper".into(),
            fabric_meta: "https://meta.fabricmc.net/v2".into(),
        }
    }
}

/// The client for version lookups and jar downloads: HTTPS to the official domains only.
pub fn server_fetcher() -> Fetcher {
    Fetcher::new(HostPolicy::domains(ALLOWED_DOWNLOAD_DOMAINS), "Server", USER_AGENT)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub url: String,
    pub file_name: &'static str,
    pub minecraft_version: String,
    /// The exact build the version resolved to (Paper build id, Fabric loader/installer pair); Vanilla has none.
    pub build: Option<String>,
    pub checksum: Option<Checksum>,
}

pub const TYPES: &[(&str, &str)] = &[("vanilla", "Vanilla"), ("paper", "Paper"), ("fabric", "Fabric")];

fn get_json(f: &Fetcher, url: &str) -> Result<Value, String> {
    f.fetch_json(url, MAX_JSON_BYTES).map_err(|e| format!("{url} → {e}"))
}

fn vanilla_versions(f: &Fetcher, ep: &Endpoints) -> Result<Vec<String>, String> {
    let manifest = get_json(f, &ep.vanilla_manifest)?;
    let list = manifest["versions"].as_array().ok_or("The Mojang version list was not in the expected shape.")?;
    Ok(list.iter().filter(|v| v["type"] == "release").filter_map(|v| v["id"].as_str().map(str::to_string)).collect())
}

/// Versions grouped by minor release ("1.21": ["1.21.4", "1.21.3", ...]), newest group first and newest patch first
/// within each group; flattened in that order.
fn paper_versions(f: &Fetcher, ep: &Endpoints) -> Result<Vec<String>, String> {
    let project = get_json(f, &ep.paper_api)?;
    let groups = project["versions"].as_object().ok_or("The Paper version list was not in the expected shape.")?;
    Ok(groups.values().filter_map(Value::as_array).flatten().filter_map(|v| v.as_str().map(str::to_string)).collect())
}

fn fabric_versions(f: &Fetcher, ep: &Endpoints) -> Result<Vec<String>, String> {
    let games = get_json(f, &format!("{}/versions/game", ep.fabric_meta))?;
    Ok(games.as_array().map(|a| a.iter().filter(|g| g["stable"] == true).filter_map(|g| g["version"].as_str().map(str::to_string)).collect()).unwrap_or_default())
}

pub fn list_versions(f: &Fetcher, ep: &Endpoints, ty: &str) -> Result<Vec<String>, String> {
    match ty {
        "vanilla" => vanilla_versions(f, ep),
        "paper" => paper_versions(f, ep),
        "fabric" => fabric_versions(f, ep),
        _ => Err(format!("Unknown server type: {ty}")),
    }
}

fn resolve_vanilla(f: &Fetcher, ep: &Endpoints, version: &str) -> Result<Resolved, String> {
    let manifest = get_json(f, &ep.vanilla_manifest)?;
    let entry = manifest["versions"].as_array().and_then(|a| a.iter().find(|v| v["id"] == version)).ok_or_else(|| format!("Unknown vanilla version: {version}"))?;
    let detail = get_json(f, entry["url"].as_str().ok_or("The Mojang version entry has no address.")?)?;
    let server = &detail["downloads"]["server"];
    let url = server["url"].as_str().ok_or_else(|| format!("{version} has no server download (too old?)"))?;
    // Vanilla has no separate build number; the version id is the whole identity.
    Ok(Resolved { url: url.into(), file_name: "server.jar", minecraft_version: version.into(), build: None, checksum: server["sha1"].as_str().map(|s| Checksum { algo: Algo::Sha1, expected: s.into() }) })
}

fn resolve_paper(f: &Fetcher, ep: &Endpoints, version: &str) -> Result<Resolved, String> {
    if !paper_versions(f, ep)?.iter().any(|v| v == version) {
        return Err(format!("Unknown Paper version: {version}"));
    }
    let builds = get_json(f, &format!("{}/versions/{version}/builds", ep.paper_api))?;
    let all: Vec<&Value> = builds.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let stable: Vec<&Value> = all.iter().copied().filter(|b| b["channel"] == "STABLE").collect();
    let pool = if stable.is_empty() { &all } else { &stable };
    let build = pool.iter().copied().max_by_key(|b| b["id"].as_i64().unwrap_or(i64::MIN)).ok_or_else(|| format!("Paper {version} has no builds"))?;
    let id = build["id"].as_i64().ok_or("A Paper build has no id.")?;
    let download = &build["downloads"]["server:default"];
    let url = download["url"].as_str().ok_or_else(|| format!("Paper {version} build {id} has no server download"))?;
    let checksum = download["checksums"]["sha256"].as_str().map(|s| Checksum { algo: Algo::Sha256, expected: s.into() });
    Ok(Resolved { url: url.into(), file_name: "server.jar", minecraft_version: version.into(), build: Some(id.to_string()), checksum })
}

fn resolve_fabric(f: &Fetcher, ep: &Endpoints, version: &str) -> Result<Resolved, String> {
    if !fabric_versions(f, ep)?.iter().any(|v| v == version) {
        return Err(format!("Unknown Fabric version: {version}"));
    }
    let loaders = get_json(f, &format!("{}/versions/loader/{version}", ep.fabric_meta))?;
    let installers = get_json(f, &format!("{}/versions/installer", ep.fabric_meta))?;
    let loader = loaders.as_array().and_then(|a| a.iter().find(|l| l["loader"]["stable"] == true).or_else(|| a.first()));
    let installer = installers.as_array().and_then(|a| a.iter().find(|i| i["stable"] == true).or_else(|| a.first()));
    let (Some(loader), Some(installer)) = (loader, installer) else { return Err(format!("No Fabric loader/installer available for {version}")) };
    let (lv, iv) = (loader["loader"]["version"].as_str().ok_or("A Fabric loader has no version.")?, installer["version"].as_str().ok_or("A Fabric installer has no version.")?);
    Ok(Resolved {
        url: format!("{}/versions/loader/{version}/{lv}/{iv}/server/jar", ep.fabric_meta),
        file_name: "server.jar",
        minecraft_version: version.into(),
        build: Some(format!("loader {lv} / installer {iv}")),
        // Fabric's server/jar endpoint assembles the jar on request: no published hash to verify against.
        checksum: None,
    })
}

pub fn resolve_download(f: &Fetcher, ep: &Endpoints, ty: &str, version: &str) -> Result<Resolved, String> {
    match ty {
        "vanilla" => resolve_vanilla(f, ep, version),
        "paper" => resolve_paper(f, ep, version),
        "fabric" => resolve_fabric(f, ep, version),
        _ => Err(format!("Unknown server type: {ty}")),
    }
}


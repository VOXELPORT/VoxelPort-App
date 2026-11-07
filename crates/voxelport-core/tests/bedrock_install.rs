//! One-click Bedrock support (Geyser + Floodgate) against scripted local copies of Modrinth and GeyserMC's download API.
//! Ported from Electron's bedrock tests, run against a real socket instead of a fake `fetch`.

mod common;

use std::fs;
use std::sync::{Arc, Mutex};

use common::{fetcher, j, names, query, server_dir, sha512, Server};
use sha2::{Digest, Sha256};
use serde_json::{json, Value};
use voxelport_core::bedrock_install::{self, Sources};

const GEYSER_PAPER: &[u8] = b"geyser spigot bytes";
const GEYSER_FABRIC: &[u8] = b"geyser fabric bytes";
const FLOODGATE_PAPER: &[u8] = b"floodgate spigot bytes";
const FLOODGATE_FABRIC: &[u8] = b"floodgate fabric bytes";
const FABRIC_API: &[u8] = b"fabric api bytes";

/// One server standing in for both Modrinth (`/v2/...`) and GeyserMC (`/geyser/...`). Everything exists for Minecraft 1.21.4
/// only; `good_checksum: false` makes GeyserMC publish a checksum the floodgate download does not match.
fn services(good_checksum: bool) -> Server {
    let cell = Arc::new(Mutex::new(0u16));
    let c2 = cell.clone();
    let srv = Server::start(move |_, target, _| {
        let port = *c2.lock().unwrap();
        let path = target.split('?').next().unwrap_or("");
        let q = query(target);
        let has = |k: &str, v: &str| q.iter().any(|(a, b)| a == k && b.contains(v));
        let version = |name: &str, bytes: &[u8], file: &str| {
            if !has("game_versions", "1.21.4") {
                return j(json!([]));
            }
            j(json!([
                { "version_type": "beta", "files": [{ "primary": true, "url": format!("http://127.0.0.1:{port}/data/beta.jar"), "filename": "Beta.jar", "hashes": { "sha512": "0".repeat(128) } }] },
                { "version_type": "release", "files": [{ "primary": true, "url": format!("http://127.0.0.1:{port}/data/{file}"), "filename": name, "hashes": { "sha512": sha512(bytes) } }] },
            ]))
        };
        match path {
            "/v2/project/geyser/version" if has("loaders", "paper") => version("Geyser-Spigot.jar", GEYSER_PAPER, "geyser-spigot.jar"),
            "/v2/project/geyser/version" if has("loaders", "fabric") => version("geyser-fabric-2.9.jar", GEYSER_FABRIC, "geyser-fabric.jar"),
            "/v2/project/floodgate/version" => version("Floodgate-Fabric-2.2.jar", FLOODGATE_FABRIC, "floodgate-fabric.jar"),
            "/v2/project/fabric-api/version" => version("fabric-api-0.100.jar", FABRIC_API, "fabric-api.jar"),
            "/geyser/floodgate/versions/latest/builds/latest" => j(json!({ "version": "2.2.4", "build": 120, "downloads": { "spigot": { "name": "floodgate-spigot.jar", "sha256": if good_checksum { sha256(FLOODGATE_PAPER) } else { "0".repeat(64) } } } })),
            "/data/geyser-spigot.jar" => (200, GEYSER_PAPER.to_vec()),
            "/data/geyser-fabric.jar" => (200, GEYSER_FABRIC.to_vec()),
            "/data/floodgate-fabric.jar" => (200, FLOODGATE_FABRIC.to_vec()),
            "/data/fabric-api.jar" => (200, FABRIC_API.to_vec()),
            "/geyser/floodgate/versions/2.2.4/builds/120/downloads/spigot" => (200, FLOODGATE_PAPER.to_vec()),
            _ => (404, b"no".to_vec()),
        }
    });
    *cell.lock().unwrap() = srv.port;
    srv
}

fn sources<'a>(f: &'a voxelport_core::net::Fetcher, modrinth: &'a str, geyser: &'a str) -> Sources<'a> {
    Sources { fetcher: f, modrinth_api: modrinth, geyser_api: geyser }
}

/// GeyserMC publishes a SHA-256; the fake server needs it to match what it serves.
fn sha256(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

fn urls(srv: &Server) -> (String, String) {
    (srv.api(), format!("{}/geyser", srv.base()))
}

fn list(dir: &std::path::Path) -> Vec<String> {
    names(dir)
}

#[test]
fn paper_gets_geyser_for_its_version_and_floodgate_and_both_are_recorded() {
    let srv = services(true);
    let (f, dir) = (fetcher(), server_dir());
    let (m, g) = urls(&srv);
    let stages = Mutex::new(Vec::new());
    bedrock_install::install(&sources(&f, &m, &g), dir.path(), "paper", "1.21.4", &|p| stages.lock().unwrap().push(p["stage"].as_str().unwrap().to_string())).unwrap();
    assert_eq!(list(&dir.path().join("plugins")), ["Geyser-Spigot.jar", "floodgate-spigot.jar"]);
    assert_eq!(fs::read(dir.path().join("plugins").join("Geyser-Spigot.jar")).unwrap(), GEYSER_PAPER);
    assert_eq!(fs::read(dir.path().join("plugins").join("floodgate-spigot.jar")).unwrap(), FLOODGATE_PAPER);
    assert_eq!(*stages.lock().unwrap(), ["resolve", "download", "download", "done"]);
    let reg: Value = serde_json::from_str(&fs::read_to_string(dir.path().join("voxelport-bedrock.json")).unwrap()).unwrap();
    assert_eq!(reg["files"], json!([{ "dir": "plugins", "name": "Geyser-Spigot.jar" }, { "dir": "plugins", "name": "floodgate-spigot.jar" }]));
    srv.close();
}

#[test]
fn a_geyser_for_another_minecraft_version_is_refused_before_anything_is_written() {
    let srv = services(true);
    let (f, dir) = (fetcher(), server_dir());
    let (m, g) = urls(&srv);
    let e = bedrock_install::install(&sources(&f, &m, &g), dir.path(), "paper", "1.19", &|_| {}).unwrap_err();
    assert_eq!(e, "No Geyser build supports Minecraft 1.19 yet.");
    assert!(list(dir.path()).is_empty(), "nothing was created: {:?}", list(dir.path()));
    let e = bedrock_install::install(&sources(&f, &m, &g), dir.path(), "fabric", "1.19", &|_| {}).unwrap_err();
    assert!(e.contains("isn't available for Minecraft 1.19"), "{e}");
    assert!(list(dir.path()).is_empty());
    assert!(bedrock_install::install(&sources(&f, &m, &g), dir.path(), "vanilla", "1.21.4", &|_| {}).unwrap_err().contains("Paper or Fabric"));
    assert!(bedrock_install::install(&sources(&f, &m, &g), std::path::Path::new("relative"), "paper", "1.21.4", &|_| {}).is_err());
    srv.close();
}

#[test]
fn a_floodgate_download_that_fails_its_checksum_is_not_kept() {
    let srv = services(false);
    let (f, dir) = (fetcher(), server_dir());
    let (m, g) = urls(&srv);
    let e = bedrock_install::install(&sources(&f, &m, &g), dir.path(), "paper", "1.21.4", &|_| {}).unwrap_err();
    assert!(e.contains("verification"), "{e}");
    assert!(!list(&dir.path().join("plugins")).iter().any(|n| n.starts_with("floodgate") || n.starts_with('.')), "{:?}", list(&dir.path().join("plugins")));
    assert!(!dir.path().join("voxelport-bedrock.json").exists(), "no list is written for a failed install");
    srv.close();
}

#[test]
fn reinstalling_replaces_only_our_old_geyser_and_leaves_look_alikes_and_handmade_files() {
    let srv = services(true);
    let (f, dir) = (fetcher(), server_dir());
    let (m, g) = urls(&srv);
    let plugins = dir.path().join("plugins");
    fs::create_dir_all(&plugins).unwrap();
    for n in ["Geyser-Spigot-OLD.jar", "GeyserSkinManager-Spigot.jar", "Handmade.jar"] {
        fs::write(plugins.join(n), b"x").unwrap();
    }
    fs::write(dir.path().join("voxelport-bedrock.json"), json!({ "files": [{ "dir": "plugins", "name": "Geyser-Spigot-OLD.jar" }, { "dir": "plugins", "name": "../../escape.jar" }, { "dir": "elsewhere", "name": "x.jar" }] }).to_string()).unwrap();
    bedrock_install::install(&sources(&f, &m, &g), dir.path(), "paper", "1.21.4", &|_| {}).unwrap();
    assert_eq!(list(&plugins), ["Geyser-Spigot.jar", "GeyserSkinManager-Spigot.jar", "Handmade.jar", "floodgate-spigot.jar"]);
    srv.close();
}

#[test]
fn an_old_install_with_no_list_is_recognised_by_the_exact_geyser_and_floodgate_names() {
    let d = server_dir();
    let plugins = d.path().join("plugins");
    fs::create_dir_all(&plugins).unwrap();
    for n in ["Geyser-Spigot.jar", "floodgate-spigot.jar", "geyser_fabric-2.jar", "GeyserSkinManager-Spigot.jar", "Geyser.jar", "Other.jar"] {
        fs::write(plugins.join(n), b"x").unwrap();
    }
    let mut owned: Vec<String> = bedrock_install::owned_jars(d.path()).into_iter().map(|(_, n)| n).collect();
    owned.sort();
    assert_eq!(owned, ["Geyser-Spigot.jar", "floodgate-spigot.jar", "geyser_fabric-2.jar"]);
    bedrock_install::remove(d.path());
    assert_eq!(list(&plugins), ["Geyser.jar", "GeyserSkinManager-Spigot.jar", "Other.jar"]);
}

#[test]
fn fabric_gets_three_mods_and_keeps_a_fabric_api_the_person_already_has() {
    let srv = services(true);
    let (f, dir) = (fetcher(), server_dir());
    let (m, g) = urls(&srv);
    let mods = dir.path().join("mods");
    fs::create_dir_all(&mods).unwrap();
    fs::write(mods.join("fabric-api-0.99.jar"), b"theirs").unwrap();
    bedrock_install::install(&sources(&f, &m, &g), dir.path(), "fabric", "1.21.4", &|_| {}).unwrap();
    assert_eq!(list(&mods), ["Floodgate-Fabric-2.2.jar", "fabric-api-0.99.jar", "geyser-fabric-2.9.jar"]);
    assert_eq!(fs::read(mods.join("fabric-api-0.99.jar")).unwrap(), b"theirs");
    let reg: Value = serde_json::from_str(&fs::read_to_string(dir.path().join("voxelport-bedrock.json")).unwrap()).unwrap();
    assert_eq!(reg["files"].as_array().unwrap().len(), 2, "Fabric API is never ours to remove");
    bedrock_install::remove(dir.path());
    assert_eq!(list(&mods), ["fabric-api-0.99.jar"]);
    assert!(!dir.path().join("voxelport-bedrock.json").exists());

    // With none there, Fabric API is installed, and still left alone by remove.
    let dir2 = server_dir();
    bedrock_install::install(&sources(&f, &m, &g), dir2.path(), "fabric", "1.21.4", &|_| {}).unwrap();
    assert_eq!(list(&dir2.path().join("mods")), ["Floodgate-Fabric-2.2.jar", "fabric-api-0.100.jar", "geyser-fabric-2.9.jar"]);
    bedrock_install::remove(dir2.path());
    assert_eq!(list(&dir2.path().join("mods")), ["fabric-api-0.100.jar"]);
    srv.close();
}

#[test]
fn the_start_check_says_yes_no_or_that_it_could_not_tell() {
    let srv = services(true);
    let f = fetcher();
    let (m, g) = urls(&srv);
    let s = sources(&f, &m, &g);
    assert_eq!(bedrock_install::geyser_compatible(&s, "paper", "1.21.4"), Some(true));
    assert_eq!(bedrock_install::geyser_compatible(&s, "fabric", "1.21.4"), Some(true));
    assert_eq!(bedrock_install::geyser_compatible(&s, "paper", "1.19"), Some(false));
    srv.close();
    let dead = Sources { fetcher: &f, modrinth_api: "http://127.0.0.1:1/v2", geyser_api: "http://127.0.0.1:1/geyser" };
    assert_eq!(bedrock_install::geyser_compatible(&dead, "paper", "1.21.4"), None, "a failed check never blocks a start");
}

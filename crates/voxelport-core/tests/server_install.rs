//! Version lookup and server install against scripted local copies of the Mojang, Paper and Fabric services over plain
//! HTTP (the test client allows it; the real one never does). New tests: the Electron suite did not cover these paths.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use voxelport_core::mc_versions::{list_versions, resolve_download, Endpoints, USER_AGENT};
use voxelport_core::net::{Algo, Fetcher, HostPolicy};
use voxelport_core::server_install::{install_server_files, InstallFiles, Phase};

struct Server {
    port: u16,
    hits: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}
impl Server {
    fn start(route: impl Fn(&str) -> (u16, Vec<u8>) + Send + 'static) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (hits, stop) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
        let (h2, s2) = (hits.clone(), stop.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut s) = conn else { continue };
                let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = head.split(' ').nth(1).unwrap_or("/").to_string();
                h2.fetch_add(1, Ordering::SeqCst);
                let (status, body) = route(&path);
                let _ = write!(s, "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = s.write_all(&body);
            }
        });
        Server { port, hits, stop }
    }
    fn endpoints(&self) -> Endpoints {
        let base = format!("http://127.0.0.1:{}", self.port);
        Endpoints { vanilla_manifest: format!("{base}/mojang/version_manifest_v2.json"), paper_api: format!("{base}/paper"), fabric_meta: format!("{base}/fabric") }
    }
    fn close(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn fetcher() -> Fetcher {
    let mut policy = HostPolicy::exact(&["127.0.0.1"]);
    policy.https_only = false;
    Fetcher::new(policy, "Server", USER_AGENT)
}

fn jar(version_json: Option<&str>) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file("META-INF/MANIFEST.MF", o).unwrap();
    w.write_all(b"Manifest-Version: 1.0\n").unwrap();
    if let Some(v) = version_json {
        w.start_file("version.json", o).unwrap();
        w.write_all(json!({ "id": v, "name": v }).to_string().as_bytes()).unwrap();
    }
    w.finish().unwrap().into_inner()
}
fn sha1(b: &[u8]) -> String { Sha1::digest(b).iter().map(|x| format!("{x:02x}")).collect() }
fn sha256(b: &[u8]) -> String { Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect() }
fn j(v: Value) -> (u16, Vec<u8>) { (200, v.to_string().into_bytes()) }

/// What the three services say and serve. `vanilla_jar`/`paper_jar`/`fabric_jar` are what the download URLs return;
/// the advertised checksums are of `*_advertised` (default: the real jar).
#[derive(Clone)]
struct World {
    vanilla_jar: Vec<u8>,
    vanilla_sha1: Option<String>,
    paper_jar: Vec<u8>,
    fabric_jar: Vec<u8>,
    manifest_url_host: String,
}
fn good_world() -> World {
    let vanilla = jar(Some("1.21.4"));
    World { vanilla_sha1: Some(sha1(&vanilla)), vanilla_jar: vanilla, paper_jar: jar(Some("1.21.4")), fabric_jar: jar(None), manifest_url_host: String::new() }
}

fn start(w: World) -> Server {
    let port_cell = Arc::new(Mutex::new(0u16));
    let c2 = port_cell.clone();
    let srv = Server::start(move |path| {
        let port = *c2.lock().unwrap();
        let base = if w.manifest_url_host.is_empty() { format!("http://127.0.0.1:{port}") } else { w.manifest_url_host.clone() };
        let path = path.split('?').next().unwrap();
        match path {
            "/mojang/version_manifest_v2.json" => j(json!({ "versions": [
                { "id": "24w01a", "type": "snapshot", "url": format!("{base}/mojang/v/24w01a.json") },
                { "id": "1.21.4", "type": "release", "url": format!("{base}/mojang/v/1.21.4.json") },
                { "id": "1.20.1", "type": "release", "url": format!("{base}/mojang/v/1.20.1.json") },
                { "id": "old", "type": "release", "url": format!("{base}/mojang/v/old.json") },
            ] })),
            "/mojang/v/1.21.4.json" => j(json!({ "downloads": { "server": { "url": format!("http://127.0.0.1:{port}/dl/vanilla.jar"), "sha1": w.vanilla_sha1 } } })),
            "/mojang/v/old.json" => j(json!({ "downloads": {} })),
            "/dl/vanilla.jar" => (200, w.vanilla_jar.clone()),
            "/paper" => j(json!({ "versions": { "1.21": ["1.21.4", "1.21.3"], "1.20": ["1.20.6"] } })),
            "/paper/versions/1.21.4/builds" => j(json!([
                { "id": 100, "channel": "ALPHA", "downloads": { "server:default": { "url": format!("http://127.0.0.1:{port}/dl/paper-100.jar"), "checksums": { "sha256": "0".repeat(64) } } } },
                { "id": 90, "channel": "STABLE", "downloads": { "server:default": { "url": format!("http://127.0.0.1:{port}/dl/paper.jar"), "checksums": { "sha256": sha256(&w.paper_jar) } } } },
                { "id": 80, "channel": "STABLE", "downloads": { "server:default": { "url": format!("http://127.0.0.1:{port}/dl/paper-80.jar"), "checksums": { "sha256": "1".repeat(64) } } } },
            ])),
            "/paper/versions/1.20.6/builds" => j(json!([{ "id": 7, "channel": "BETA", "downloads": { "server:default": { "url": format!("http://127.0.0.1:{port}/dl/paper.jar"), "checksums": { "sha256": sha256(&w.paper_jar) } } } }])),
            "/dl/paper.jar" => (200, w.paper_jar.clone()),
            "/fabric/versions/game" => j(json!([{ "version": "1.21.4", "stable": true }, { "version": "24w01a", "stable": false }])),
            "/fabric/versions/loader/1.21.4" => j(json!([{ "loader": { "version": "0.16.9", "stable": false } }, { "loader": { "version": "0.16.8", "stable": true } }])),
            "/fabric/versions/installer" => j(json!([{ "version": "1.0.1", "stable": true }, { "version": "0.9", "stable": false }])),
            "/fabric/versions/loader/1.21.4/0.16.8/1.0.1/server/jar" => (200, w.fabric_jar.clone()),
            _ => (404, b"no".to_vec()),
        }
    });
    *port_cell.lock().unwrap() = srv.port;
    srv
}

fn req<'a>(dir: &'a Path, ty: &'a str, version: &'a str, props: &'a [(String, String)]) -> InstallFiles<'a> {
    InstallFiles { dir, server_type: ty, version, port: 25570, properties: props }
}
fn files(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort();
    v
}

#[test]
fn version_lists_are_filtered_and_ordered_like_electron() {
    let srv = start(good_world());
    let (f, ep) = (fetcher(), srv.endpoints());
    assert_eq!(list_versions(&f, &ep, "vanilla").unwrap(), ["1.21.4", "1.20.1", "old"], "releases only, in the manifest's order");
    assert_eq!(list_versions(&f, &ep, "paper").unwrap(), ["1.21.4", "1.21.3", "1.20.6"], "newest group first, as published (not alphabetical)");
    assert_eq!(list_versions(&f, &ep, "fabric").unwrap(), ["1.21.4"], "stable only");
    assert_eq!(list_versions(&f, &ep, "forge").unwrap_err(), "Unknown server type: forge");
    srv.close();
}

#[test]
fn vanilla_resolves_with_its_sha1_and_no_build() {
    let srv = start(good_world());
    let r = resolve_download(&fetcher(), &srv.endpoints(), "vanilla", "1.21.4").unwrap();
    assert_eq!((r.file_name, r.build.clone(), r.minecraft_version.as_str()), ("server.jar", None, "1.21.4"));
    assert_eq!(r.checksum.as_ref().map(|c| c.algo), Some(Algo::Sha1));
    assert!(r.url.ends_with("/dl/vanilla.jar"));
    assert_eq!(resolve_download(&fetcher(), &srv.endpoints(), "vanilla", "9.9").unwrap_err(), "Unknown vanilla version: 9.9");
    assert!(resolve_download(&fetcher(), &srv.endpoints(), "vanilla", "old").unwrap_err().contains("has no server download"));
    srv.close();
}

#[test]
fn paper_picks_the_newest_stable_build_and_records_it() {
    let srv = start(good_world());
    let r = resolve_download(&fetcher(), &srv.endpoints(), "paper", "1.21.4").unwrap();
    assert_eq!(r.build.as_deref(), Some("90"), "not the newer ALPHA 100, not the older STABLE 80");
    assert_eq!(r.checksum.as_ref().map(|c| c.algo), Some(Algo::Sha256));
    let only_beta = resolve_download(&fetcher(), &srv.endpoints(), "paper", "1.20.6").unwrap();
    assert_eq!(only_beta.build.as_deref(), Some("7"), "with no stable build the newest of any channel is used");
    assert_eq!(resolve_download(&fetcher(), &srv.endpoints(), "paper", "1.19").unwrap_err(), "Unknown Paper version: 1.19");
    srv.close();
}

#[test]
fn fabric_picks_the_stable_loader_and_installer_and_has_no_checksum() {
    let srv = start(good_world());
    let r = resolve_download(&fetcher(), &srv.endpoints(), "fabric", "1.21.4").unwrap();
    assert_eq!(r.build.as_deref(), Some("loader 0.16.8 / installer 1.0.1"));
    assert!(r.url.ends_with("/fabric/versions/loader/1.21.4/0.16.8/1.0.1/server/jar") && r.checksum.is_none());
    assert_eq!(resolve_download(&fetcher(), &srv.endpoints(), "fabric", "24w01a").unwrap_err(), "Unknown Fabric version: 24w01a");
    srv.close();
}

#[test]
fn a_verified_vanilla_server_is_installed_with_its_files() {
    let srv = start(good_world());
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("srv");
    let props = vec![("gamemode".to_string(), "creative".to_string()), ("online-mode".to_string(), "false".to_string())];
    let phases = Mutex::new(Vec::new());
    let r = install_server_files(&req(&target, "vanilla", "1.21.4", &props), &fetcher(), &srv.endpoints(), &|p| phases.lock().unwrap().push(p)).unwrap();
    assert_eq!(r.minecraft_version, "1.21.4");
    assert_eq!(files(&target), ["eula.txt", "server.jar", "server.properties"], "no temporary files left");
    let p = fs::read_to_string(target.join("server.properties")).unwrap();
    assert!(p.contains("server-port=25570") && p.contains("gamemode=creative") && p.contains("online-mode=true") && !p.contains("online-mode=false"));
    assert!(fs::read_to_string(target.join("eula.txt")).unwrap().contains("eula=true"));
    let phases = phases.lock().unwrap();
    assert_eq!(phases.first(), Some(&Phase::Resolving));
    assert!(phases.iter().any(|p| matches!(p, Phase::Downloading { received, .. } if *received > 0)));
    assert_eq!(phases.last(), Some(&Phase::Verifying));
    srv.close();
}

#[test]
fn paper_and_fabric_install_too_and_fabric_needs_no_version_file() {
    let srv = start(good_world());
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("paper");
    install_server_files(&req(&a, "paper", "1.21.4", &[]), &fetcher(), &srv.endpoints(), &|_| {}).unwrap();
    assert!(a.join("server.jar").is_file());
    let b = dir.path().join("fabric");
    let r = install_server_files(&req(&b, "fabric", "1.21.4", &[]), &fetcher(), &srv.endpoints(), &|_| {}).unwrap();
    assert!(b.join("server.jar").is_file() && r.build.is_some());
    srv.close();
}

#[test]
fn a_jar_of_the_wrong_minecraft_version_is_deleted_and_the_new_folder_removed() {
    let mut w = good_world();
    w.vanilla_jar = jar(Some("1.21.3"));
    w.vanilla_sha1 = Some(sha1(&w.vanilla_jar)); // the checksum is fine: the jar is just not what was asked for
    let srv = start(w);
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("srv");
    let err = install_server_files(&req(&target, "vanilla", "1.21.4", &[]), &fetcher(), &srv.endpoints(), &|_| {}).unwrap_err();
    assert!(err.contains("Minecraft 1.21.3, not the 1.21.4 you selected"), "{err}");
    assert!(!target.exists(), "a folder this call created is removed again");
    // A folder that was already there stays, but empty.
    fs::create_dir(&target).unwrap();
    assert!(install_server_files(&req(&target, "vanilla", "1.21.4", &[]), &fetcher(), &srv.endpoints(), &|_| {}).is_err());
    assert!(target.is_dir() && files(&target).is_empty());
    srv.close();
}

#[test]
fn a_wrong_checksum_leaves_no_jar_and_no_temporary_file() {
    let mut w = good_world();
    w.vanilla_sha1 = Some("0".repeat(40));
    let srv = start(w);
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("srv");
    fs::create_dir(&target).unwrap();
    let err = install_server_files(&req(&target, "vanilla", "1.21.4", &[]), &fetcher(), &srv.endpoints(), &|_| {}).unwrap_err();
    assert!(err.contains("SHA-1 verification"), "{err}");
    assert!(files(&target).is_empty(), "{:?}", files(&target));
    srv.close();
}

#[test]
fn a_vanilla_or_paper_jar_with_no_readable_version_is_refused() {
    let mut w = good_world();
    w.paper_jar = jar(None);
    let srv = start(w);
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("p");
    let err = install_server_files(&req(&target, "paper", "1.21.4", &[]), &fetcher(), &srv.endpoints(), &|_| {}).unwrap_err();
    assert!(err.contains("Couldn't read the Minecraft version"), "{err}");
    assert!(!target.exists());
    srv.close();
}

#[test]
fn a_folder_that_already_holds_a_server_is_refused_before_any_network() {
    let srv = start(good_world());
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("server.properties"), "motd=mine\n").unwrap();
    let before = srv.hits.load(Ordering::SeqCst);
    let err = install_server_files(&req(dir.path(), "vanilla", "1.21.4", &[]), &fetcher(), &srv.endpoints(), &|_| {}).unwrap_err();
    assert!(err.contains("Import Existing Server"));
    assert_eq!(srv.hits.load(Ordering::SeqCst), before);
    assert_eq!(fs::read_to_string(dir.path().join("server.properties")).unwrap(), "motd=mine\n", "nothing was overwritten");
    srv.close();
}

#[test]
fn an_address_off_the_allow_list_is_refused_even_inside_the_api_answer() {
    let mut w = good_world();
    w.manifest_url_host = "http://localhost:1".into();
    let srv = start(w);
    let err = resolve_download(&fetcher(), &srv.endpoints(), "vanilla", "1.21.4").unwrap_err();
    assert!(err.contains("untrusted host"), "{err}");
    srv.close();
}

#[test]
fn a_service_error_is_reported_with_the_address_that_failed() {
    let srv = Server::start(|_| (503, b"down".to_vec()));
    let err = list_versions(&fetcher(), &srv.endpoints(), "vanilla").unwrap_err();
    assert!(err.contains("HTTP 503") && err.contains("version_manifest_v2.json"), "{err}");
    srv.close();
}

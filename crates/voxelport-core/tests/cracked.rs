//! The login/skins plugin install and the cracked-server setup order, against a scripted local copy of Modrinth over plain
//! HTTP (the test client allows it; the real one never does). Ported from Electron's accounts tests, run against a real
//! socket instead of a fake `fetch`.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use voxelport_core::cracked::{has_login_plugin, has_skins_plugin, install_login_plugin, install_skins_plugin, is_cracked, resolve_plugin, set_up_cracked_server, Modrinth, LOGIN_PROJECT, SKINS_PROJECT};
use voxelport_core::addon_registry::installed_addons;
use voxelport_core::net::{Fetcher, HostPolicy};

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    asked: Arc<Mutex<Vec<String>>>,
}
impl Server {
    fn start(route: impl Fn(&str) -> (u16, Vec<u8>) + Send + 'static) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, asked) = (Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(Vec::new())));
        let (s2, a2) = (stop.clone(), asked.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut s) = conn else { continue };
                let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let target = String::from_utf8_lossy(&buf[..n]).split(' ').nth(1).unwrap_or("/").to_string();
                a2.lock().unwrap().push(target.clone());
                let (status, body) = route(&target);
                let _ = write!(s, "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = s.write_all(&body);
            }
        });
        Server { port, stop, asked }
    }
    fn api(&self) -> String { format!("http://127.0.0.1:{}/v2", self.port) }
    fn close(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn fetcher() -> Fetcher {
    let mut p = HostPolicy::exact(&["127.0.0.1"]);
    p.https_only = false;
    Fetcher::new(p, "Server", "test")
}
fn sha512(b: &[u8]) -> String { Sha512::digest(b).iter().map(|x| format!("{x:02x}")).collect() }
fn j(v: Value) -> (u16, Vec<u8>) { (200, v.to_string().into_bytes()) }

const AUTHME_JAR: &[u8] = b"AuthMe jar bytes";
const SKINS_JAR: &[u8] = b"SkinsRestorer jar bytes";

/// A Modrinth with AuthMe and SkinsRestorer for Minecraft 1.21.4 only. `skins_ok` / `authme_ok` switch each one off.
fn modrinth(authme_ok: bool, skins_ok: bool) -> Server {
    let cell = Arc::new(Mutex::new(0u16));
    let c2 = cell.clone();
    let srv = Server::start(move |target| {
        let port = *c2.lock().unwrap();
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let q = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect::<Vec<_>>();
        let has = |k: &str, v: &str| q.iter().any(|(a, b)| a == k && b.contains(v));
        let version = |name: &str, jar: &[u8], ok: bool, dl: &str| -> (u16, Vec<u8>) {
            if !ok || !has("game_versions", "1.21.4") || !has("loaders", "paper") {
                return j(json!([]));
            }
            j(json!([
                { "version_type": "beta", "files": [{ "primary": true, "url": format!("http://127.0.0.1:{port}/data/beta.jar"), "filename": "Beta.jar", "hashes": { "sha512": "0".repeat(128) } }] },
                { "version_type": "release", "files": [{ "primary": false, "url": "http://127.0.0.1:1/other.jar", "filename": "other.jar", "hashes": { "sha512": "1".repeat(128) } }, { "primary": true, "url": format!("http://127.0.0.1:{port}/data/{dl}"), "filename": name, "hashes": { "sha512": sha512(jar) } }] },
            ]))
        };
        match path {
            p if p == format!("/v2/project/{LOGIN_PROJECT}/version") => version("AuthMe-5.7.0.jar", AUTHME_JAR, authme_ok, "authme.jar"),
            p if p == format!("/v2/project/{SKINS_PROJECT}/version") => version("SkinsRestorer.jar", SKINS_JAR, skins_ok, "skins.jar"),
            p if p == format!("/v2/project/{LOGIN_PROJECT}") => j(json!({ "icon_url": "https://cdn.modrinth.com/data/3IEZ9vol/icon.png" })),
            p if p == format!("/v2/project/{SKINS_PROJECT}") => j(json!({ "icon_url": "http://evil.example/icon.png" })),
            "/data/authme.jar" => (200, AUTHME_JAR.to_vec()),
            "/data/skins.jar" => (200, SKINS_JAR.to_vec()),
            _ => (404, b"no".to_vec()),
        }
    });
    *cell.lock().unwrap() = srv.port;
    srv
}

fn server_dir() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("server.properties"), "online-mode=true\nmotd=Mine\nenforce-secure-profile=true\n").unwrap();
    d
}
fn plugins(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir.join("plugins")).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort();
    v
}
fn nop(_: &str, _: Option<&str>) {}

#[test]
fn the_plugin_is_resolved_for_the_right_loaders_and_version_preferring_a_release_and_the_primary_file() {
    let srv = modrinth(true, true);
    let f = fetcher();
    let api = srv.api();
    let m = Modrinth { fetcher: &f, api: &api };
    let r = resolve_plugin(&m, LOGIN_PROJECT, "AuthMe", "1.21.4").unwrap();
    assert_eq!(r.file_name, "AuthMe-5.7.0.jar", "the release, not the newer-listed beta");
    assert!(r.url.ends_with("/data/authme.jar"));
    let asked = srv.asked.lock().unwrap().join("\n");
    let decoded = url::form_urlencoded::parse(asked.split_once('?').unwrap().1.split_whitespace().next().unwrap().as_bytes()).into_owned().collect::<Vec<_>>();
    assert!(decoded.iter().any(|(k, v)| k == "loaders" && v == "[\"paper\",\"spigot\",\"bukkit\"]") && decoded.iter().any(|(k, v)| k == "game_versions" && v == "[\"1.21.4\"]"), "{decoded:?}");
    assert_eq!(resolve_plugin(&m, LOGIN_PROJECT, "AuthMe", "26.3").unwrap_err(), "AuthMe isn't available for Minecraft 26.3 yet.");
    srv.close();
}

#[test]
fn a_download_with_no_hash_or_an_unsafe_name_is_refused() {
    for (hashes, filename) in [(json!({}), "AuthMe.jar"), (json!({ "sha512": "ab".repeat(64) }), "../../evil.jar"), (json!({ "sha512": "ab".repeat(64) }), "evil.exe")] {
        let srv = Server::start(move |_| j(json!([{ "version_type": "release", "files": [{ "primary": true, "url": "http://127.0.0.1:1/x", "filename": filename, "hashes": hashes }] }])));
        let f = fetcher();
        let api = srv.api();
        let err = resolve_plugin(&Modrinth { fetcher: &f, api: &api }, LOGIN_PROJECT, "AuthMe", "1.21.4").unwrap_err();
        assert_eq!(err, "No usable AuthMe download.", "{filename}");
        srv.close();
    }
}

#[test]
fn installing_the_login_plugin_replaces_old_copies_of_it_only_and_records_it() {
    let srv = modrinth(true, true);
    let (f, api) = (fetcher(), srv.api());
    let m = Modrinth { fetcher: &f, api: &api };
    let d = server_dir();
    fs::create_dir(d.path().join("plugins")).unwrap();
    fs::write(d.path().join("plugins").join("AuthMe-5.6.0.jar"), "old").unwrap();
    fs::write(d.path().join("plugins").join("Essentials.jar"), "other").unwrap();
    let stages = Mutex::new(Vec::new());
    let file = install_login_plugin(&m, d.path(), "paper", "1.21.4", &|s, f| stages.lock().unwrap().push((s.to_string(), f.map(str::to_string)))).unwrap();
    assert_eq!(file, "AuthMe-5.7.0.jar");
    assert_eq!(plugins(d.path()), ["AuthMe-5.7.0.jar", "Essentials.jar"]);
    assert_eq!(fs::read(d.path().join("plugins").join("AuthMe-5.7.0.jar")).unwrap(), AUTHME_JAR);
    assert!(has_login_plugin(d.path()));
    let stages = stages.lock().unwrap();
    assert_eq!((stages.first().unwrap().0.as_str(), stages.last().unwrap().0.as_str()), ("resolve", "done"));
    assert!(stages.iter().any(|(s, f)| s == "download" && f.as_deref() == Some("AuthMe-5.7.0.jar")));
    let listed = installed_addons(d.path()).unwrap();
    assert_eq!((listed[0]["id"].clone(), listed[0]["title"].clone(), listed[0]["file"].clone()), (json!(LOGIN_PROJECT), json!("AuthMe"), json!("AuthMe-5.7.0.jar")));
    assert!(listed[0]["icon"].is_string(), "a Modrinth icon address is kept");
    assert!(install_login_plugin(&m, d.path(), "fabric", "1.21.4", &nop).unwrap_err().contains("Paper"));
    srv.close();
}

#[test]
fn a_wrong_hash_installs_nothing_and_leaves_the_folder_as_it_was() {
    let srv = Server::start(|t| {
        if t.contains("/version") { j(json!([{ "version_type": "release", "files": [{ "primary": true, "url": "http://127.0.0.1:1/x", "filename": "AuthMe.jar", "hashes": { "sha512": "ab".repeat(64) } }] }])) } else { (404, vec![]) }
    });
    let (f, api) = (fetcher(), srv.api());
    let d = server_dir();
    assert!(install_login_plugin(&Modrinth { fetcher: &f, api: &api }, d.path(), "paper", "1.21.4", &nop).is_err());
    assert!(!has_login_plugin(d.path()) && installed_addons(d.path()).unwrap().is_empty());
    srv.close();
}

#[test]
fn a_cracked_server_gets_the_login_plugin_first_then_offline_mode_then_skins() {
    let srv = modrinth(true, true);
    let (f, api) = (fetcher(), srv.api());
    let m = Modrinth { fetcher: &f, api: &api };
    let d = server_dir();
    let r = set_up_cracked_server(&m, d.path(), "paper", "1.21.4", &nop);
    assert_eq!((r.cracked, r.skins, r.warnings.len()), (true, true, 0));
    assert!(is_cracked(d.path()) && has_login_plugin(d.path()) && has_skins_plugin(d.path()));
    let props = fs::read_to_string(d.path().join("server.properties")).unwrap();
    assert_eq!(props, "online-mode=false\nmotd=Mine\nenforce-secure-profile=false\n");
    let listed = installed_addons(d.path()).unwrap();
    assert_eq!(listed.len(), 2);
    let skins = listed.iter().find(|a| a["id"] == SKINS_PROJECT).unwrap();
    assert!(skins.get("icon").is_none(), "an icon address that is not Modrinth's own is dropped");
    srv.close();
}

#[test]
fn if_the_login_plugin_cannot_be_installed_offline_mode_is_never_switched_on() {
    let srv = modrinth(false, true);
    let (f, api) = (fetcher(), srv.api());
    let m = Modrinth { fetcher: &f, api: &api };
    let d = server_dir();
    let r = set_up_cracked_server(&m, d.path(), "paper", "1.21.4", &nop);
    assert_eq!((r.cracked, r.skins), (false, false));
    assert!(r.warnings[0].starts_with("Cracked mode was NOT turned on"), "{:?}", r.warnings);
    assert!(!is_cracked(d.path()), "the server still checks accounts");
    assert!(!has_skins_plugin(d.path()), "skins are not even tried");
    assert_eq!(fs::read_to_string(d.path().join("server.properties")).unwrap(), "online-mode=true\nmotd=Mine\nenforce-secure-profile=true\n");
    // A server type that cannot run the plugin gets the same safe outcome.
    let fabric = set_up_cracked_server(&m, d.path(), "fabric", "1.21.4", &nop);
    assert!(!fabric.cracked && !is_cracked(d.path()));
    srv.close();
}

#[test]
fn missing_skins_are_a_warning_and_never_undo_the_working_cracked_setup() {
    let srv = modrinth(true, false);
    let (f, api) = (fetcher(), srv.api());
    let d = server_dir();
    let r = set_up_cracked_server(&Modrinth { fetcher: &f, api: &api }, d.path(), "paper", "1.21.4", &nop);
    assert_eq!((r.cracked, r.skins), (true, false));
    assert!(r.warnings[0].starts_with("Skins couldn't be added"));
    assert!(is_cracked(d.path()) && has_login_plugin(d.path()));
    srv.close();
}

#[test]
fn skins_install_replaces_only_an_old_skins_plugin() {
    let srv = modrinth(true, true);
    let (f, api) = (fetcher(), srv.api());
    let m = Modrinth { fetcher: &f, api: &api };
    let d = server_dir();
    fs::create_dir(d.path().join("plugins")).unwrap();
    fs::write(d.path().join("plugins").join("SkinsRestorer-14.0.jar"), "old").unwrap();
    fs::write(d.path().join("plugins").join("AuthMe-5.7.0.jar"), "must stay").unwrap();
    install_skins_plugin(&m, d.path(), "paper", "1.21.4", &nop).unwrap();
    assert_eq!(plugins(d.path()), ["AuthMe-5.7.0.jar", "SkinsRestorer.jar"]);
    assert!(install_skins_plugin(&m, d.path(), "fabric", "1.21.4", &nop).unwrap_err().contains("Paper"));
    srv.close();
}

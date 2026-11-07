//! The Java download and install against a scripted local "Adoptium" over plain HTTP (the test `Source` allows it; the
//! real one never does). Covers the happy path and every way the download or the archive can be wrong or hostile.
//! These behaviours are new tests: the Electron suite only covered the lookup helpers.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};
use voxelport_core::java::{find_managed_java, install_java, java_root, Progress, Source};

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
fn ok(body: Vec<u8>) -> Reply { Reply { status: 200, headers: vec![], body } }
fn redirect(to: &str) -> Reply { Reply { status: 302, headers: vec![("location".into(), to.into())], body: vec![] } }
fn status(code: u16) -> Reply { Reply { status: code, headers: vec![], body: b"no".to_vec() } }

struct Server {
    port: u16,
    hits: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}
impl Server {
    fn start(route: impl Fn(&str, &str) -> Reply + Send + 'static) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (hits, stop) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
        let (h2, s2) = (hits.clone(), stop.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s2.load(Ordering::SeqCst) { break; }
                let Ok(mut s) = conn else { continue };
                let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let target = head.split(' ').nth(1).unwrap_or("/").to_string();
                let (path, query) = target.split_once('?').unwrap_or((&target, ""));
                h2.fetch_add(1, Ordering::SeqCst);
                let r = route(path, query);
                let mut out = format!("HTTP/1.1 {} X\r\ncontent-length: {}\r\nconnection: close\r\n", r.status, r.body.len());
                for (k, v) in &r.headers { out += &format!("{k}: {v}\r\n"); }
                out += "\r\n";
                let _ = s.write_all(out.as_bytes());
                let _ = s.write_all(&r.body);
            }
        });
        Server { port, hits, stop }
    }
    fn source(&self, max_archive: u64) -> Source {
        Source {
            api_base: format!("http://127.0.0.1:{}/v3/assets/latest", self.port),
            allowed_hosts: vec!["127.0.0.1".into()],
            https_only: false,
            max_archive_bytes: max_archive,
            platform: Some(("windows".into(), "x64".into())),
        }
    }
    fn close(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in entries {
        w.start_file(*name, opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}
fn sha(b: &[u8]) -> String { Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect() }

fn good_zip() -> Vec<u8> {
    zip_of(&[("jdk-21.0.4+7-jre/bin/java.exe", b"MZ fake"), ("jdk-21.0.4+7-jre/lib/modules", b"data"), ("jdk-21.0.4+7-jre/release", b"JAVA_VERSION=21")])
}

/// An Adoptium that serves `archive` at /jre.zip, advertising `checksum` for it.
fn adoptium(archive: Vec<u8>, checksum: String, port_cell: Arc<Mutex<u16>>) -> impl Fn(&str, &str) -> Reply + Send + 'static {
    move |path, query| {
        let port = *port_cell.lock().unwrap();
        if path.starts_with("/v3/assets/latest/21/hotspot") {
            if query.contains("image_type=jre") {
                return ok(json!([{ "binary": { "package": { "link": format!("http://127.0.0.1:{port}/jre.zip"), "name": "OpenJDK21U-jre_x64_windows_hotspot_21.0.4_7.zip", "size": archive.len(), "checksum": checksum } } }]).to_string().into_bytes());
            }
            return ok(b"[]".to_vec());
        }
        if path == "/jre.zip" { return ok(archive.clone()); }
        status(404)
    }
}
fn start_with(archive: Vec<u8>, checksum: String) -> Server {
    let cell = Arc::new(Mutex::new(0u16));
    let s = Server::start(adoptium(archive, checksum, cell.clone()));
    *cell.lock().unwrap() = s.port;
    s
}

fn scratch_left(dir: &Path) -> bool {
    fs::read_dir(java_root(dir)).map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with(".install-"))).unwrap_or(false)
}
fn quiet(_: Progress) {}

#[test]
fn installs_a_verified_jre_and_narrates_each_stage() {
    let archive = good_zip();
    let srv = start_with(archive.clone(), sha(&archive));
    let dir = tempfile::tempdir().unwrap();
    let seen = Mutex::new(Vec::new());
    let done = install_java(dir.path(), 21, &srv.source(10_000_000), &|p| seen.lock().unwrap().push(p)).unwrap();
    assert_eq!(done.major, 21);
    assert!(done.java_path.is_file() && done.java_path.ends_with("temurin-21/bin/java.exe") || done.java_path.ends_with("temurin-21\\bin\\java.exe"), "{:?}", done.java_path);
    assert_eq!(fs::read(dir.path().join("java/temurin-21/release")).unwrap(), b"JAVA_VERSION=21");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.first(), Some(&Progress::Resolve));
    assert!(seen.iter().any(|p| matches!(p, Progress::Download { received, total } if *received == archive.len() as u64 && *total == archive.len() as u64)));
    assert!(seen.iter().position(|p| *p == Progress::Extract) > seen.iter().position(|p| matches!(p, Progress::Download { .. })));
    assert_eq!(seen.last(), Some(&Progress::Done));
    assert!(!scratch_left(dir.path()), "the working folder is removed");
    assert_eq!(find_managed_java(dir.path(), 21).unwrap().java_path, done.java_path);
    srv.close();
}

#[test]
fn an_installed_major_is_not_downloaded_again() {
    let archive = good_zip();
    let srv = start_with(archive.clone(), sha(&archive));
    let dir = tempfile::tempdir().unwrap();
    install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap();
    let before = srv.hits.load(Ordering::SeqCst);
    install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap();
    assert_eq!(srv.hits.load(Ordering::SeqCst), before, "no network the second time");
    srv.close();
}

#[test]
fn a_wrong_checksum_installs_nothing() {
    let srv = start_with(good_zip(), "0".repeat(64));
    let dir = tempfile::tempdir().unwrap();
    let err = install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap_err();
    assert!(err.contains("SHA-256"), "{err}");
    assert!(find_managed_java(dir.path(), 21).is_none() && !scratch_left(dir.path()));
    srv.close();
}

#[test]
fn a_missing_or_malformed_checksum_is_refused_before_downloading() {
    for bad in ["", "abc", &"z".repeat(64)] {
        let srv = start_with(good_zip(), bad.to_string());
        let dir = tempfile::tempdir().unwrap();
        let err = install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap_err();
        assert!(err.contains("valid checksum"), "{bad}: {err}");
        assert_eq!(srv.hits.load(Ordering::SeqCst), 1, "only the API was asked, nothing was downloaded");
        srv.close();
    }
}

#[test]
fn archive_entries_that_escape_the_folder_are_refused() {
    for name in ["../evil.txt", "jdk/../../evil.txt", "/abs-evil.txt", "C:/evil.txt", "..\\evil.txt"] {
        let archive = zip_of(&[("jdk/bin/java.exe", b"MZ"), (name, b"pwned")]);
        let srv = start_with(archive.clone(), sha(&archive));
        let dir = tempfile::tempdir().unwrap();
        let err = install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap_err();
        assert!(err.contains("unsafe path"), "{name}: {err}");
        assert!(find_managed_java(dir.path(), 21).is_none() && !scratch_left(dir.path()), "{name}");
        // Nothing was written next to, above, or at the root of the data folder.
        let parent = dir.path().parent().unwrap();
        assert!(!parent.join("evil.txt").exists() && !dir.path().join("evil.txt").exists() && !dir.path().join("java").join("evil.txt").exists(), "{name}");
        srv.close();
    }
}

#[test]
fn an_archive_without_java_is_refused() {
    let archive = zip_of(&[("jdk/readme.txt", b"hi")]);
    let srv = start_with(archive.clone(), sha(&archive));
    let dir = tempfile::tempdir().unwrap();
    let err = install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap_err();
    assert!(err.contains("did not contain a java executable"), "{err}");
    assert!(find_managed_java(dir.path(), 21).is_none() && !scratch_left(dir.path()));
    srv.close();
}

#[test]
fn an_oversized_archive_is_refused() {
    let archive = good_zip();
    let srv = start_with(archive.clone(), sha(&archive));
    let dir = tempfile::tempdir().unwrap();
    let err = install_java(dir.path(), 21, &srv.source(100), &quiet).unwrap_err();
    assert!(err.contains("unexpectedly large") || err.contains("maximum allowed size"), "{err}");
    assert!(find_managed_java(dir.path(), 21).is_none() && !scratch_left(dir.path()));
    srv.close();
}

#[test]
fn a_relative_redirect_on_an_allowed_host_is_followed() {
    let archive = good_zip();
    let digest = sha(&archive);
    let cell = Arc::new(Mutex::new(0u16));
    let c2 = cell.clone();
    let srv = Server::start(move |path, query| {
        let port = *c2.lock().unwrap();
        match path {
            p if p.starts_with("/v3/assets/latest/21/hotspot") && query.contains("image_type=jre") => {
                ok(json!([{ "binary": { "package": { "link": format!("http://127.0.0.1:{port}/start"), "name": "x.zip", "size": 1, "checksum": digest } } }]).to_string().into_bytes())
            }
            "/start" => redirect("/real.zip"),
            "/real.zip" => ok(archive.clone()),
            _ => ok(b"[]".to_vec()),
        }
    });
    *cell.lock().unwrap() = srv.port;
    let dir = tempfile::tempdir().unwrap();
    install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).expect("a relative redirect on an allowed host is fine");
    srv.close();
}

#[test]
fn a_download_link_on_a_host_that_is_not_allowed_is_refused() {
    let srv = Server::start(|path, query| {
        if path.starts_with("/v3/assets/latest/21/hotspot") && query.contains("image_type=jre") {
            ok(json!([{ "binary": { "package": { "link": "http://localhost/x.zip", "name": "x.zip", "size": 1, "checksum": "a".repeat(64) } } }]).to_string().into_bytes())
        } else {
            ok(b"[]".to_vec())
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let err = install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap_err();
    assert!(err.contains("untrusted host"), "{err}");
    srv.close();
}

#[test]
fn a_redirect_hop_off_the_allow_list_is_refused() {
    let digest = "a".repeat(64);
    let cell = Arc::new(Mutex::new(0u16));
    let c2 = cell.clone();
    let srv = Server::start(move |path, query| {
        let port = *c2.lock().unwrap();
        match path {
            p if p.starts_with("/v3/assets/latest/21/hotspot") && query.contains("image_type=jre") => {
                ok(json!([{ "binary": { "package": { "link": format!("http://127.0.0.1:{port}/start"), "name": "x.zip", "size": 1, "checksum": digest } } }]).to_string().into_bytes())
            }
            "/start" => redirect("http://localhost/elsewhere.zip"),
            _ => ok(b"[]".to_vec()),
        }
    });
    *cell.lock().unwrap() = srv.port;
    let dir = tempfile::tempdir().unwrap();
    let err = install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap_err();
    assert!(err.contains("untrusted host"), "{err}");
    srv.close();
}

#[test]
fn an_http_error_and_an_endless_redirect_are_reported() {
    let srv = Server::start(|_, _| status(503));
    let dir = tempfile::tempdir().unwrap();
    let err = install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap_err();
    assert!(err.contains("HTTP 503"), "{err}");
    srv.close();

    let looping = Server::start(|_, _| redirect("/again"));
    let err = install_java(dir.path(), 21, &looping.source(10_000_000), &quiet).unwrap_err();
    assert!(err.contains("Too many redirects"), "{err}");
    looping.close();
}

#[test]
fn a_jdk_is_used_when_no_jre_is_published() {
    let archive = good_zip();
    let digest = sha(&archive);
    let cell = Arc::new(Mutex::new(0u16));
    let c2 = cell.clone();
    let a2 = archive.clone();
    let srv = Server::start(move |path, query| {
        let port = *c2.lock().unwrap();
        if path.starts_with("/v3/assets/latest/21/hotspot") {
            if query.contains("image_type=jdk") {
                return ok(json!([{ "binary": { "package": { "link": format!("http://127.0.0.1:{port}/jdk.zip"), "name": "OpenJDK21U-jdk_x64_windows_hotspot.zip", "size": 1, "checksum": digest } } }]).to_string().into_bytes());
            }
            return ok(b"[]".to_vec());
        }
        if path == "/jdk.zip" { ok(a2.clone()) } else { status(404) }
    });
    *cell.lock().unwrap() = srv.port;
    let dir = tempfile::tempdir().unwrap();
    assert!(install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).is_ok());
    srv.close();
}

#[test]
fn nothing_published_and_silly_versions_are_reported() {
    let srv = Server::start(|_, _| ok(b"[]".to_vec()));
    let dir = tempfile::tempdir().unwrap();
    assert!(install_java(dir.path(), 21, &srv.source(10_000_000), &quiet).unwrap_err().contains("No Java 21 build is published"));
    for bad in [0, 7, 100] {
        assert_eq!(install_java(dir.path(), bad, &srv.source(10_000_000), &quiet).unwrap_err(), "Invalid Java version requested.");
    }
    srv.close();
}

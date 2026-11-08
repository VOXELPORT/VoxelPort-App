//! Shared by the integration tests: a scripted local HTTP server (the test client allows plain HTTP to 127.0.0.1; the real one never does).
#![allow(dead_code)]

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha512};
use voxelport_core::net::{Fetcher, HostPolicy};

pub struct Server {
    pub port: u16,
    stop: Arc<AtomicBool>,
    asked: Arc<Mutex<Vec<String>>>,
}
impl Server {
    /// `route(method, target, body)` answers one request.
    pub fn start(route: impl Fn(&str, &str, &str) -> (u16, Vec<u8>) + Send + 'static) -> Server {
        Self::start_with(|_| route)
    }
    /// Like `start`, for an answer that needs to name the server's own port (a link to a file on the same server).
    pub fn start_with<R: Fn(&str, &str, &str) -> (u16, Vec<u8>) + Send + 'static>(make: impl FnOnce(u16) -> R) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let route = make(port);
        let (stop, asked) = (Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(Vec::new())));
        let (s2, a2) = (stop.clone(), asked.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut s) = conn else { continue };
                let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                let body_start = loop {
                    let n = s.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break raw.len();
                    }
                    raw.extend_from_slice(&buf[..n]);
                    if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                };
                let head = String::from_utf8_lossy(&raw[..body_start.min(raw.len())]).to_string();
                let length: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse().ok())).unwrap_or(0);
                while raw.len() < body_start + length {
                    let n = s.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let body = String::from_utf8_lossy(&raw[body_start.min(raw.len())..]).to_string();
                let mut first = head.split(' ');
                let (method, target) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("/").to_string());
                a2.lock().unwrap().push(format!("{method} {target}"));
                let (status, out) = route(&method, &target, &body);
                let _ = write!(s, "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", out.len());
                let _ = s.write_all(&out);
            }
        });
        Server { port, stop, asked }
    }
    pub fn api(&self) -> String {
        format!("http://127.0.0.1:{}/v2", self.port)
    }
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
    pub fn close(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

pub fn fetcher() -> Fetcher {
    let mut p = HostPolicy::exact(&["127.0.0.1"]);
    p.https_only = false;
    Fetcher::new(p, "Server", "test")
}
pub fn sha512(b: &[u8]) -> String {
    Sha512::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}
pub fn j(v: Value) -> (u16, Vec<u8>) {
    (200, v.to_string().into_bytes())
}
pub fn query(target: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(target.split_once('?').map_or("", |x| x.1).as_bytes()).into_owned().collect()
}
pub fn server_dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}
pub fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort();
    v
}
pub fn nop(_: Value) {}


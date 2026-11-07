//! Downloads the app is willing to make. Everything that fetches a program or an archive (Java, server jars, later
//! add-ons) goes through here, so the same rules hold for all of it:
//!
//! - every request and every redirect hop must be HTTPS to a host on the caller's allow-list (plain HTTP only when the
//!   caller says so, which only tests do), so a download can never be pointed at this machine or the local network;
//! - the size is capped, a stalled connection is cut, and a body that does not match its published checksum is thrown away;
//! - a file is written beside its destination under a temporary name and moved into place only once it is complete and
//!   verified, so an existing file is never touched by a download that fails.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256};

const MAX_REDIRECTS: u32 = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30);

/// One entry of an allow-list.
#[derive(Clone, Debug)]
pub enum HostRule {
    /// Exactly this host name.
    Exact(String),
    /// This domain and any subdomain of it (`mojang.com` allows `piston-data.mojang.com`, not `evilmojang.com`).
    Domain(String),
}

#[derive(Clone, Debug)]
pub struct HostPolicy {
    pub rules: Vec<HostRule>,
    pub https_only: bool,
}

impl HostPolicy {
    pub fn exact(hosts: &[&str]) -> Self {
        Self { rules: hosts.iter().map(|h| HostRule::Exact((*h).to_string())).collect(), https_only: true }
    }
    pub fn domains(domains: &[&str]) -> Self {
        Self { rules: domains.iter().map(|d| HostRule::Domain((*d).to_string())).collect(), https_only: true }
    }
    pub fn host_allowed(&self, host: &str) -> bool {
        let h = host.to_ascii_lowercase();
        self.rules.iter().any(|r| match r {
            HostRule::Exact(e) => e.eq_ignore_ascii_case(&h),
            HostRule::Domain(d) => {
                let d = d.to_ascii_lowercase();
                h == d || h.ends_with(&format!(".{d}"))
            }
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Algo {
    Sha1,
    Sha256,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Checksum {
    pub algo: Algo,
    pub expected: String,
}

impl Algo {
    fn label(self) -> &'static str {
        match self {
            Algo::Sha1 => "SHA-1",
            Algo::Sha256 => "SHA-256",
        }
    }
}

enum Hasher {
    Sha1(Sha1),
    Sha256(Sha256),
}
impl Hasher {
    fn new(a: Algo) -> Self {
        match a {
            Algo::Sha1 => Hasher::Sha1(Sha1::new()),
            Algo::Sha256 => Hasher::Sha256(Sha256::new()),
        }
    }
    fn update(&mut self, b: &[u8]) {
        match self {
            Hasher::Sha1(h) => h.update(b),
            Hasher::Sha256(h) => h.update(b),
        }
    }
    fn hex(self) -> String {
        let bytes: Vec<u8> = match self {
            Hasher::Sha1(h) => h.finalize().to_vec(),
            Hasher::Sha256(h) => h.finalize().to_vec(),
        };
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// A download client for one purpose. `what` names it in error messages ("Java", "Server").
#[derive(Clone, Debug)]
pub struct Fetcher {
    pub policy: HostPolicy,
    pub what: &'static str,
    pub user_agent: &'static str,
}

impl Fetcher {
    pub fn new(policy: HostPolicy, what: &'static str, user_agent: &'static str) -> Self {
        Self { policy, what, user_agent }
    }

    pub fn check_url(&self, url: &str) -> Result<url::Url, String> {
        let u = url::Url::parse(url).map_err(|_| format!("Invalid {} download URL.", self.what))?;
        let scheme_ok = u.scheme() == "https" || (!self.policy.https_only && u.scheme() == "http");
        let host_ok = u.host_str().map(|h| self.policy.host_allowed(h)).unwrap_or(false);
        if !scheme_ok || !host_ok {
            return Err(format!("Refusing {} download from untrusted host: {}://{}", self.what, u.scheme(), u.host_str().unwrap_or("")));
        }
        Ok(u)
    }

    /// GET following redirects, re-checking the host and scheme of every hop.
    pub fn get(&self, url: &str) -> Result<ureq::Response, String> {
        let agent = ureq::AgentBuilder::new().redirects(0).timeout_connect(CONNECT_TIMEOUT).timeout_read(INACTIVITY_TIMEOUT).user_agent(self.user_agent).build();
        let mut current = self.check_url(url)?;
        for _ in 0..=MAX_REDIRECTS {
            let resp = match agent.get(current.as_str()).call() {
                Ok(r) => r,
                Err(ureq::Error::Status(code, _)) => return Err(format!("{} download failed: HTTP {code}", self.what)),
                Err(e) => return Err(format!("{} download failed: {e}", self.what)),
            };
            let status = resp.status();
            if (300..400).contains(&status) {
                let location = resp.header("location").ok_or_else(|| format!("{} download failed: HTTP {status}", self.what))?;
                let next = current.join(location).map_err(|_| format!("Invalid {} download URL.", self.what))?;
                current = self.check_url(next.as_str())?;
                continue;
            }
            if status != 200 {
                return Err(format!("{} download failed: HTTP {status}", self.what));
            }
            return Ok(resp);
        }
        Err(format!("Too many redirects while downloading {}.", self.what))
    }

    pub fn fetch_json(&self, url: &str, max_bytes: u64) -> Result<Value, String> {
        let resp = self.get(url)?;
        let mut body = Vec::new();
        resp.into_reader().take(max_bytes + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
        if body.len() as u64 > max_bytes {
            return Err(format!("{} response too large.", self.what));
        }
        serde_json::from_slice(&body).map_err(|_| format!("Could not read the {} response.", self.what))
    }

    /// Streams `url` to `dest`. The bytes go to a temporary file beside `dest`, are checked (size while streaming,
    /// checksum at the end), and only then renamed over `dest`; on any failure the temporary file is removed and `dest`
    /// is left exactly as it was. `size_hint` is used for progress when the server sends no length.
    pub fn download(&self, url: &str, dest: &Path, max_bytes: u64, checksum: Option<&Checksum>, size_hint: u64, on_progress: &dyn Fn(u64, u64)) -> Result<(), String> {
        let mut nonce = [0u8; 6];
        let _ = getrandom::getrandom(&mut nonce);
        let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = dest.with_file_name(format!(".{name}.download-{}", nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        let result = self.download_to(url, &tmp, max_bytes, checksum, size_hint, on_progress).and_then(|()| fs::rename(&tmp, dest).map_err(|e| e.to_string()));
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    fn download_to(&self, url: &str, tmp: &Path, max_bytes: u64, checksum: Option<&Checksum>, size_hint: u64, on_progress: &dyn Fn(u64, u64)) -> Result<(), String> {
        let resp = self.get(url)?;
        let declared: u64 = resp.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        if declared > max_bytes {
            return Err(format!("{} file is unexpectedly large.", self.what));
        }
        let total = if declared > 0 { declared } else { size_hint };
        let mut reader = resp.into_reader();
        let mut file = fs::File::create(tmp).map_err(|e| e.to_string())?;
        let mut hasher = checksum.map(|c| Hasher::new(c.algo));
        let (mut received, mut buf) = (0u64, vec![0u8; 64 * 1024]);
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("{} download stalled or failed: {e}", self.what))?;
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > max_bytes {
                return Err(format!("{} file exceeded the maximum allowed size.", self.what));
            }
            if let Some(h) = hasher.as_mut() {
                h.update(&buf[..n]);
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            on_progress(received, total);
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if let (Some(h), Some(c)) = (hasher, checksum) {
            let actual = h.hex();
            if !actual.eq_ignore_ascii_case(&c.expected) {
                return Err(format!("Downloaded {} failed {} verification (expected {}, got {actual}).", self.what, c.algo.label(), c.expected));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_rules_allow_subdomains_but_not_look_alikes() {
        let p = HostPolicy::domains(&["mojang.com", "papermc.io"]);
        for ok in ["mojang.com", "piston-data.mojang.com", "FILL-DATA.PAPERMC.IO"] {
            assert!(p.host_allowed(ok), "{ok}");
        }
        for bad in ["evilmojang.com", "mojang.com.evil.example", "mojang.co", "papermc.io.evil.example", ""] {
            assert!(!p.host_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn urls_must_be_https_to_an_allowed_host() {
        let f = Fetcher::new(HostPolicy::domains(&["mojang.com"]), "Server", "t");
        assert!(f.check_url("https://piston-data.mojang.com/x.jar").is_ok());
        for bad in ["http://piston-data.mojang.com/x.jar", "https://127.0.0.1/x", "https://localhost/x", "https://192.168.1.5/x", "ftp://mojang.com/x", "file:///C:/x", "nope"] {
            assert!(f.check_url(bad).is_err(), "{bad}");
        }
    }
}

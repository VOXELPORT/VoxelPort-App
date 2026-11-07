//! The Bedrock address the relay assigned to a server, remembered in the app's data folder so the next start can advertise it.
//! Ported from `bedrockEndpoint.js`. This is an address cache, not a rewrite of a user's Geyser config or server metadata: a restored
//! device identity must negotiate its own port, so the key includes the device token.

use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::atomic_write;

const FILE: &str = "bedrock-endpoints.json";
const MAX_CACHE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Endpoint {
    pub public_host: String,
    pub public_port: u16,
}

/// What the relay assigned and where Geyser listens locally; both must match what the running server was launched with.
#[derive(Clone, Debug, PartialEq)]
pub struct FullEndpoint {
    pub local_port: u16,
    pub public_host: String,
    pub public_port: u16,
}

fn cache_key(profile_id: &str, token: &str) -> String {
    Sha256::digest(serde_json::to_string(&json!([profile_id, token])).unwrap().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A host of 1 to 253 characters made of valid DNS labels.
pub fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && h.split('.').all(|l| {
        let b = l.as_bytes();
        !b.is_empty() && b.len() <= 63 && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
    })
}

fn read_cache(dir: &Path) -> Map<String, Value> {
    let file = dir.join(FILE);
    if fs::metadata(&file).map(|m| m.len() > MAX_CACHE_BYTES).unwrap_or(true) {
        return Map::new();
    }
    fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn as_endpoint(v: &Value) -> Option<Endpoint> {
    let host = v["publicHost"].as_str().filter(|h| valid_host(h))?;
    let port = v["publicPort"].as_u64().filter(|p| (1..=65535).contains(p))?;
    Some(Endpoint { public_host: host.to_string(), public_port: port as u16 })
}

pub fn read_bedrock_endpoint(dir: &Path, profile_id: &str, token: &str) -> Option<Endpoint> {
    as_endpoint(read_cache(dir).get(&cache_key(profile_id, token))?)
}

pub fn remember_bedrock_endpoint(dir: &Path, profile_id: &str, token: &str, e: &Endpoint) -> Result<(), String> {
    if !valid_host(&e.public_host) || e.public_port == 0 {
        return Err("Invalid Bedrock address from relay.".into());
    }
    let mut cache = read_cache(dir);
    let key = cache_key(profile_id, token);
    if cache.get(&key).and_then(as_endpoint).as_ref() == Some(e) {
        return Ok(());
    }
    cache.insert(key, json!({ "publicHost": e.public_host, "publicPort": e.public_port }));
    atomic_write(&dir.join(FILE), serde_json::to_string_pretty(&Value::Object(cache)).unwrap().as_bytes()).map_err(|e| e.to_string())
}

/// True when the server was launched advertising exactly the address and local port the relay now assigns.
pub fn endpoint_ready(launch: Option<&FullEndpoint>, assigned: Option<&FullEndpoint>) -> bool {
    match (launch, assigned) {
        (Some(l), Some(a)) => valid_host(&l.public_host) && valid_host(&a.public_host) && l == a,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(h: &str, p: u16) -> Endpoint {
        Endpoint { public_host: h.into(), public_port: p }
    }

    #[test]
    fn an_address_is_remembered_per_server_and_per_device() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_bedrock_endpoint(d.path(), "s1", "vp_a"), None);
        remember_bedrock_endpoint(d.path(), "s1", "vp_a", &ep("play.voxelport.in", 26295)).unwrap();
        assert_eq!(read_bedrock_endpoint(d.path(), "s1", "vp_a"), Some(ep("play.voxelport.in", 26295)));
        assert_eq!(read_bedrock_endpoint(d.path(), "s2", "vp_a"), None, "another server");
        assert_eq!(read_bedrock_endpoint(d.path(), "s1", "vp_b"), None, "a restored identity negotiates its own port");
        remember_bedrock_endpoint(d.path(), "s1", "vp_a", &ep("play-eu.voxelport.in", 26301)).unwrap();
        assert_eq!(read_bedrock_endpoint(d.path(), "s1", "vp_a"), Some(ep("play-eu.voxelport.in", 26301)));
    }

    #[test]
    fn the_token_itself_is_never_written() {
        let d = tempfile::tempdir().unwrap();
        remember_bedrock_endpoint(d.path(), "s1", "vp_secret_token_value", &ep("play.voxelport.in", 26295)).unwrap();
        let text = fs::read_to_string(d.path().join(FILE)).unwrap();
        assert!(!text.contains("vp_secret_token_value") && !text.contains("s1"));
    }

    #[test]
    fn a_bad_address_from_the_relay_is_refused() {
        let d = tempfile::tempdir().unwrap();
        for (h, p) in [("", 26000), ("evil host", 26000), ("a..b", 26000), ("-x.example", 26000), ("play.voxelport.in", 0), ("host:1", 26000), ("x/../y", 26000)] {
            assert!(remember_bedrock_endpoint(d.path(), "s1", "t", &ep(h, p)).is_err(), "{h:?}:{p}");
        }
        assert!(!d.path().join(FILE).exists());
    }

    #[test]
    fn a_damaged_or_hand_edited_cache_is_ignored() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join(FILE), "{ nope").unwrap();
        assert_eq!(read_bedrock_endpoint(d.path(), "s1", "t"), None);
        fs::write(d.path().join(FILE), json!({ cache_key("s1", "t"): { "publicHost": "bad host", "publicPort": 5 } }).to_string()).unwrap();
        assert_eq!(read_bedrock_endpoint(d.path(), "s1", "t"), None);
        fs::write(d.path().join(FILE), "[1,2]").unwrap();
        assert_eq!(read_bedrock_endpoint(d.path(), "s1", "t"), None);
        remember_bedrock_endpoint(d.path(), "s1", "t", &ep("play.voxelport.in", 26295)).unwrap();
        assert!(read_bedrock_endpoint(d.path(), "s1", "t").is_some(), "a fresh write replaces the damaged file");
    }

    #[test]
    fn ready_means_the_launch_and_the_assignment_match_exactly() {
        let a = FullEndpoint { local_port: 19132, public_host: "play.voxelport.in".into(), public_port: 26295 };
        assert!(endpoint_ready(Some(&a), Some(&a.clone())));
        for other in [FullEndpoint { local_port: 19133, ..a.clone() }, FullEndpoint { public_port: 26296, ..a.clone() }, FullEndpoint { public_host: "play-eu.voxelport.in".into(), ..a.clone() }] {
            assert!(!endpoint_ready(Some(&a), Some(&other)));
        }
        assert!(!endpoint_ready(None, Some(&a)) && !endpoint_ready(Some(&a), None));
    }
}

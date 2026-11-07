//! Which relay addresses are safe to send the device token to. Ported from `relayUrlSafety.js`.
//!
//! A custom relay URL must be `wss://` unless it points at a loopback/private address: this stops the device token from being sent in
//! cleartext to a remote host by accident (a typo'd scheme or a copy-pasted `ws://` example).

use std::net::{IpAddr, Ipv6Addr};

/// True for `localhost` and for loopback, private and link-local IP *literals*. A DNS name that merely starts with private-looking
/// characters (`fcevil.example`, `10.example.com`) is never treated as an IP address.
pub fn is_private_or_local_host(hostname: &str) -> bool {
    let h = hostname.to_ascii_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h == "localhost" {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let [a, b, ..] = ip.octets();
            a == 127 || a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        Ok(IpAddr::V6(ip)) => {
            let s = h;
            ip == Ipv6Addr::LOCALHOST || s.starts_with("fc") || s.starts_with("fd") || s.starts_with("fe80")
        }
        Err(_) => false, // a plain DNS name, however it is spelled, is never private
    }
}

pub fn is_safe_relay_url(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    match u.scheme() {
        "wss" => true,
        "ws" => u.host_str().is_some_and(is_private_or_local_host),
        _ => false,
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wss_is_always_allowed_any_host() {
        for u in ["wss://relay.voxelport.in", "wss://example.com", "wss://203.0.113.5"] {
            assert!(is_safe_relay_url(u), "{u}");
        }
    }

    #[test]
    fn plain_ws_is_rejected_against_a_remote_host() {
        for u in ["ws://relay.voxelport.in", "ws://example.com", "ws://203.0.113.5", "ws://some-relay.example.com"] {
            assert!(!is_safe_relay_url(u), "{u}");
        }
    }

    #[test]
    fn plain_ws_is_allowed_for_loopback_private_and_link_local_hosts() {
        for u in ["ws://127.0.0.1:8099", "ws://localhost:8099", "ws://10.0.0.5:8099", "ws://172.16.0.1:8099", "ws://192.168.1.20:8099", "ws://169.254.1.1:8099", "ws://[::1]:8099", "ws://[fd00::1]", "ws://[fe80::1]", "ws://127.0.0.1", "ws://localhost"] {
            assert!(is_safe_relay_url(u), "{u}");
        }
    }

    #[test]
    fn other_schemes_and_garbage_are_rejected() {
        for u in ["http://relay.voxelport.in", "https://relay.voxelport.in", "not a url", "", "ftp://x"] {
            assert!(!is_safe_relay_url(u), "{u:?}");
        }
    }

    #[test]
    fn similar_looking_public_ranges_are_excluded() {
        assert!(!is_private_or_local_host("172.32.0.1"), "outside 172.16.0.0/12");
        assert!(!is_private_or_local_host("172.15.0.1"));
        assert!(!is_private_or_local_host("192.169.1.1"));
        assert!(is_private_or_local_host("172.31.255.255"));
    }

    #[test]
    fn dns_names_that_look_like_private_literals_are_not_private() {
        for h in ["fcevil.example", "fdattacker.example", "fe80-test.example", "10.example.com"] {
            assert!(!is_private_or_local_host(h), "{h}");
            assert!(!is_safe_relay_url(&format!("ws://{h}")), "{h}");
        }
    }
}

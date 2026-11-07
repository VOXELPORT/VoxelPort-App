//! Geyser's startup properties for Bedrock players, ported from bedrock.js (bedrockJvmArgs and its checks).
//! Geyser runs NetherNet with a built-in signaling endpoint on `local_port`; the relay forwards that port.

use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BedrockOptions {
    pub local_port: u16,
    /// Both public fields are left out until the relay has assigned an address; they take effect on the next Java start.
    pub public: Option<(String, u16)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BedrockError(pub &'static str);

impl std::fmt::Display for BedrockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for BedrockError {}

/// The fixed JVM arguments for these options, or why they are not acceptable.
pub fn jvm_args(options: &BedrockOptions) -> Result<Vec<String>, BedrockError> {
    if options.local_port == 0 {
        return Err(BedrockError("Invalid Bedrock local port (expected 1-65535)."));
    }
    let p = options.local_port;
    let mut args = vec![
        "-DgeyserTransport=nethernet".to_string(),
        "-DgeyserUdpAddress=0.0.0.0".to_string(),
        format!("-DgeyserUdpPort={p}"),
        format!("-DgeyserSignalingPort={p}"),
        format!("-DgeyserWebrtcPort={p}"),
        "-DgeyserSignalingMode=builtin".to_string(),
    ];
    if let Some((host, port)) = &options.public {
        if *port == 0 {
            return Err(BedrockError("Invalid Bedrock public port (expected 1-65535)."));
        }
        args.push(format!("-DgeyserAdvertiseAddresses={}:{}", advertise_host(host)?, port));
    }
    Ok(args)
}

fn advertise_host(host: &str) -> Result<String, BedrockError> {
    const BAD: BedrockError = BedrockError("Invalid Bedrock public host.");
    if host.is_empty() || host.len() > 253 || host.chars().any(|c| c.is_whitespace() || c == '%') {
        return Err(BAD);
    }
    let inner = if host.starts_with('[') && host.ends_with(']') { &host[1..host.len() - 1] } else { host };
    if inner.parse::<Ipv6Addr>().is_ok() {
        return Ok(format!("[{inner}]"));
    }
    if host.parse::<Ipv4Addr>().is_ok() {
        return Ok(host.to_string());
    }
    let numeric = host.split('.').count() == 4 && host.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let labels_ok = host.trim_end_matches('.').split('.').all(valid_label);
    if numeric || !labels_ok {
        return Err(BAD);
    }
    Ok(host.to_string())
}

fn valid_label(label: &str) -> bool {
    let b = label.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(port: u16, public: Option<(&str, u16)>) -> BedrockOptions {
        BedrockOptions { local_port: port, public: public.map(|(h, p)| (h.to_string(), p)) }
    }

    #[test]
    fn local_only_options_set_nethernet_with_built_in_signaling() {
        let a = jvm_args(&opts(19133, None)).unwrap();
        assert!(a.contains(&"-DgeyserTransport=nethernet".to_string()));
        assert!(a.contains(&"-DgeyserSignalingPort=19133".to_string()));
        assert!(a.contains(&"-DgeyserWebrtcPort=19133".to_string()));
        assert!(a.contains(&"-DgeyserSignalingMode=builtin".to_string()));
        assert!(!a.iter().any(|x| x.contains("AdvertiseAddresses")));
    }

    #[test]
    fn the_public_address_is_advertised_once_assigned() {
        let a = jvm_args(&opts(19133, Some(("play.voxelport.in", 26295)))).unwrap();
        assert!(a.contains(&"-DgeyserAdvertiseAddresses=play.voxelport.in:26295".to_string()));
    }

    #[test]
    fn ipv6_hosts_are_bracketed_and_ipv4_kept() {
        assert_eq!(advertise_host("2001:db8::1").unwrap(), "[2001:db8::1]");
        assert_eq!(advertise_host("[2001:db8::1]").unwrap(), "[2001:db8::1]");
        assert_eq!(advertise_host("203.0.113.9").unwrap(), "203.0.113.9");
    }

    #[test]
    fn bad_ports_and_hosts_are_refused() {
        assert!(jvm_args(&opts(0, None)).is_err());
        assert!(jvm_args(&opts(1, Some(("play.voxelport.in", 0)))).is_err());
        for bad in ["", "has space", "evil.com:1 -Dx=1", "999.1.1.1", "a_b.example", "-lead.example", "fe80::1%eth0"] {
            assert!(advertise_host(bad).is_err(), "{bad} should be refused");
        }
    }
}

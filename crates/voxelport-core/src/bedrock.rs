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

// ─── Which local port Geyser uses ───────────────────────────────────────────

pub const DEFAULT_BEDROCK_PORT: u16 = 19132;

/// A configured Bedrock port, before VoxelPort's startup overrides: read from Geyser's own config file.
pub fn configured_bedrock_port(server_dir: &std::path::Path) -> u16 {
    use regex::Regex;
    let block = Regex::new(r"(?m)^bedrock:[ \t]*\n((?:[ \t]+.*\n|[ \t]*\n|#.*\n)*)").unwrap();
    let port = Regex::new(r#"(?m)^[ \t]+port:[ \t]*(?:(\d{1,5})|'(\d{1,5})'|"(\d{1,5})")[ \t]*(?:#.*)?$"#).unwrap();
    for rel in [["plugins", "Geyser-Spigot", "config.yml"], ["config", "Geyser-Fabric", "config.yml"]] {
        let Ok(text) = std::fs::read_to_string(rel.iter().fold(server_dir.to_path_buf(), |p, part| p.join(part))) else { continue };
        let text = text.replace("\r\n", "\n").replace('\r', "\n") + "\n";
        let found = block.captures(&text).and_then(|b| port.captures(b.get(1)?.as_str()).and_then(|c| c.get(1).or(c.get(2)).or(c.get(3)).and_then(|m| m.as_str().parse::<u32>().ok())));
        if let Some(p) = found.filter(|p| (1..=65535).contains(p)) {
            return p as u16;
        }
    }
    DEFAULT_BEDROCK_PORT
}

/// The one local port (TCP and UDP) for Bedrock: the configured one if it is free, otherwise 19132 or the next free port
/// upward, never one Java, the query listener or the voice plugin uses. Nothing is changed or reserved.
pub fn bedrock_port(server_dir: &std::path::Path, java_port: Option<u16>, query_port: Option<u16>, voice_port: Option<u16>) -> u16 {
    use crate::settings::read_properties_file;
    let mut used: std::collections::HashSet<u16> = [java_port, query_port, voice_port].into_iter().flatten().collect();
    let props = read_properties_file(server_dir);
    let property_port = |key: &str| -> u16 {
        let raw = props.get(key).map(|v| v.trim()).unwrap_or("");
        let n: u32 = if !raw.is_empty() && raw.len() <= 5 && raw.bytes().all(|b| b.is_ascii_digit()) { raw.parse().unwrap_or(0) } else { 0 };
        if (1..=65535).contains(&n) { n as u16 } else { 25565 }
    };
    if java_port.is_none() {
        used.insert(property_port("server-port"));
    }
    if query_port.is_none() && props.get("enable-query").is_some_and(|v| v.trim().eq_ignore_ascii_case("true")) {
        used.insert(property_port("query.port"));
    }
    let configured = configured_bedrock_port(server_dir);
    if !used.contains(&configured) {
        return configured;
    }
    let mut port = DEFAULT_BEDROCK_PORT;
    while used.contains(&port) && port < 65535 {
        port += 1;
    }
    port
}

#[cfg(test)]
mod port_tests {
    use super::*;

    fn geyser_config(dir: &std::path::Path, text: &str) {
        let d = dir.join("plugins").join("Geyser-Spigot");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("config.yml"), text).unwrap();
    }

    #[test]
    fn the_default_is_19132_until_geyser_writes_a_config() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(configured_bedrock_port(d.path()), 19132);
        assert_eq!(bedrock_port(d.path(), Some(25565), None, None), 19132);
    }

    #[test]
    fn the_port_in_geysers_config_is_read_in_every_quoting() {
        for (text, want) in [
            ("bedrock:\n  address: 0.0.0.0\n  port: 19200\n", 19200),
            ("bedrock:\n  port: '19201'\n", 19201),
            ("bedrock:\r\n  port: \"19202\" # note\r\n", 19202),
            ("remote:\n  port: 25565\nbedrock:\n  port: 19203", 19203),
        ] {
            let d = tempfile::tempdir().unwrap();
            geyser_config(d.path(), text);
            assert_eq!(configured_bedrock_port(d.path()), want, "{text:?}");
        }
        let d = tempfile::tempdir().unwrap();
        geyser_config(d.path(), "bedrock:\n  port: 99999\n");
        assert_eq!(configured_bedrock_port(d.path()), 19132, "out of range falls back");
    }

    #[test]
    fn a_port_something_else_uses_is_skipped() {
        let d = tempfile::tempdir().unwrap();
        geyser_config(d.path(), "bedrock:\n  port: 25570\n");
        assert_eq!(bedrock_port(d.path(), Some(25570), None, None), 19132, "Java has the configured port: take the default instead");
        assert_eq!(bedrock_port(d.path(), Some(19132), None, Some(19133)), 25570, "the configured port is free");
        std::fs::write(d.path().join("server.properties"), "server-port=19132\nenable-query=true\nquery.port=19133\n").unwrap();
        geyser_config(d.path(), "bedrock:\n  port: 19132\n");
        assert_eq!(bedrock_port(d.path(), None, None, None), 19134, "Java and query ports read from server.properties");
    }
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

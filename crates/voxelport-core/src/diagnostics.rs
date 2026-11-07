//! The error report a person can save and attach to a support ticket. Ported from `diagnostics.js`.
//!
//! Reports contain no profiles, configuration files, device IDs or raw tokens: the recent output is redacted first (keys, tokens,
//! passwords, web-hook and other addresses stripped of what follows the host, user names in paths, e-mail addresses, IDs, IP
//! addresses, Discord mentions, terminal colour codes and control characters). The redaction is best effort, which the report itself
//! says; the person reads the file before sharing it.

use std::net::Ipv6Addr;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::Value;

use crate::crash_explain::{explain_crash, Lang};

struct Patterns {
    pem: Regex,
    secret: Regex,
    authorization: Regex,
    assignment: Regex,
    url: Regex,
    windows_user: Regex,
    unix_user: Regex,
    email: Regex,
    uuid: Regex,
    ipv4: Regex,
    ipv6: Regex,
    mention: Regex,
    ansi: Regex,
    control: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let rx = |s: &str| Regex::new(s).unwrap();
        Patterns {
            pem: rx(r"(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----"),
            secret: rx(r"\b(?:vp_[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{20,}|mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,})\b"),
            authorization: rx(r"(?i)(authorization\s*[:=]\s*)(?:Bearer|Bot|Basic)\s+[^\s,;]+"),
            assignment: rx(r#"(?i)(["']?[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)"#),
            url: rx(r#"(?i)\b(?:https?|wss?)://[^\s<>"']+"#),
            windows_user: rx(r"(?i)[A-Z]:\\Users\\[^\\\r\n]+"),
            unix_user: rx(r"/(?:home|Users)/[^/\s]+"),
            email: rx(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
            uuid: rx(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"),
            ipv4: rx(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b"),
            ipv6: rx(r"(?i)[0-9a-f:]*:[0-9a-f:]+(?:%[A-Za-z0-9_]+)?"),
            mention: rx(r"<@[!&]?[0-9]+>|@everyone|@here"),
            ansi: rx("\u{1b}\\[[0-9;]*m"),
            control: rx("[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}]"),
        }
    })
}

fn redact_url(m: &Captures) -> String {
    let Ok(mut url) = url::Url::parse(&m[0]) else { return "[url removed]".into() };
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let discord = host.ends_with("discord.com") || host.ends_with("discordapp.com");
    if discord && url.path().contains("/webhooks/") {
        return "[webhook removed]".into();
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn redact_ipv6(m: &Captures) -> String {
    let whole = &m[0];
    let address = whole.split('%').next().unwrap_or(whole);
    if address.parse::<Ipv6Addr>().is_ok() { "[ip removed]".into() } else { whole.to_string() }
}

/// Strips what must not leave this computer from a piece of output.
pub fn redact(text: &str) -> String {
    let p = patterns();
    let s = p.pem.replace_all(text, "[private key removed]");
    let s = p.secret.replace_all(&s, "[secret removed]");
    let s = p.authorization.replace_all(&s, "${1}[secret removed]");
    // Addresses before the generic `token=` rule: that rule would put a space into a query string and cut the address short.
    let s = p.url.replace_all(&s, |m: &Captures| redact_url(m));
    let s = p.assignment.replace_all(&s, "${1}[secret removed]");
    let s = p.windows_user.replace_all(&s, r"C:\Users\[user]");
    let s = p.unix_user.replace_all(&s, "/home/[user]");
    let s = p.email.replace_all(&s, "[email removed]");
    let s = p.uuid.replace_all(&s, "[uuid removed]");
    let s = p.ipv4.replace_all(&s, "[ip removed]");
    let s = p.ipv6.replace_all(&s, |m: &Captures| redact_ipv6(m));
    let s = p.mention.replace_all(&s, "[mention removed]");
    let s = p.ansi.replace_all(&s, "");
    p.control.replace_all(&s, "").into_owned()
}

/// What the report says about the server that was last used.
pub struct ServerFacts<'a> {
    pub server_type: &'a str,
    pub version: &'a str,
    pub build: Option<&'a str>,
    pub port: Option<u64>,
}

pub struct ReportInput<'a> {
    pub version: &'a str,
    pub platform: &'a str,
    pub arch: &'a str,
    pub server: Option<ServerFacts<'a>>,
    pub status: &'a str,
    pub lines: &'a [String],
    /// ISO 8601, UTC.
    pub created: &'a str,
}

/// Signatures of common failures beyond the crash rules, as `(pattern, code, advice)`.
fn extra_codes() -> &'static [(Regex, &'static str, &'static str)] {
    static E: OnceLock<Vec<(Regex, &'static str, &'static str)>> = OnceLock::new();
    E.get_or_init(|| {
        let rx = |s: &str| Regex::new(s).unwrap();
        vec![
            (rx(r"(?i)UnsupportedClassVersionError|compiled by a more recent version"), "JAVA_VERSION", "Check the Java runtime required by this Minecraft or mod version."),
            // Geyser rejects Bedrock joins when it is built for a different Minecraft version than the server. The server itself is
            // fine for Java players.
            (rx(r"(?i)does not support Java Edition|Outdated server! I'm still on|I'm still on [0-9]"), "GEYSER_VERSION_MISMATCH", "Geyser doesn't match this server's Minecraft version, so Bedrock players are disconnected (Java players are unaffected). Re-add Bedrock support so Geyser matches the server, or change the server to a version Geyser supports."),
            // A plugin update that was downloaded but couldn't replace the live jar (it was locked) is staged in plugins/update/ and
            // applied on the next restart.
            (rx(r"(?i)plugins[\\/]update[\\/]|staged (?:the )?update|will be (?:applied|installed) on (?:the )?next restart|update folder"), "PLUGIN_UPDATE_STAGED", "A plugin update has been downloaded and is waiting in plugins/update. Restart the server to apply it. (Informational — not an error.)"),
            (rx(r"(?i)ECONNREFUSED|connection refused"), "CONNECTION_REFUSED", "Check the destination and confirm the local server is running on the configured port."),
            (rx(r"(?i)ENOTFOUND|EAI_AGAIN|no such host|UnknownHostException"), "DNS", "Check the hostname and your DNS connection."),
            (rx(r"(?i)ETIMEDOUT|i/o timeout|handshake timeout|connect timed out"), "TIMEOUT", "Check the destination and connectivity; a timeout alone does not confirm a relay outage."),
        ]
    })
}

/// The whole report as text.
pub fn create_report(input: &ReportInput) -> String {
    let clean = redact(&input.lines.join("\n"));
    let clean_lines: Vec<String> = clean.split('\n').map(str::to_string).collect();
    let diagnoses = explain_crash(&clean_lines, input.server.as_ref().and_then(|s| s.port), input.status == "crashed", Lang::English);
    let mut codes: Vec<String> = diagnoses
        .iter()
        .map(|d: &Value| format!("VP-{}: {}\n{}", d["id"].as_str().unwrap_or("").to_uppercase().replace('-', "_"), d["title"].as_str().unwrap_or(""), d["detail"].as_str().unwrap_or("")))
        .collect();
    for (pattern, code, advice) in extra_codes() {
        if pattern.is_match(&clean) {
            codes.push(format!("VP-{code}: {advice}"));
        }
    }
    let server = match &input.server {
        Some(s) => format!(
            "Server: {} | Minecraft: {}{} | Status: {}",
            if s.server_type.is_empty() { "external/none" } else { s.server_type },
            if s.version.is_empty() { "unknown" } else { s.version },
            s.build.filter(|b| !b.is_empty()).map(|b| format!(" (build {b})")).unwrap_or_default(),
            input.status
        ),
        None => format!("Server: external/none | Minecraft: unknown | Status: {}", input.status),
    };
    let tail: String = {
        let chars: Vec<char> = clean.chars().collect();
        chars[chars.len().saturating_sub(200_000)..].iter().collect()
    };
    [
        "VoxelPort diagnostic report v1".to_string(),
        format!("Created: {}", input.created),
        format!("App: {} | OS: {} {}", input.version, input.platform, input.arch),
        server,
        "Error codes:".to_string(),
        if codes.is_empty() { "VP-NO_MATCH: No known error signature found; review the log below.".to_string() } else { codes.join("\n\n") },
        String::new(),
        "Recent session output (oldest first; bounded excerpt):".to_string(),
        tail,
        String::new(),
        "Review this file before sharing. Automatic redaction is best effort.".to_string(),
        "Attach this .txt file to a Discord support ticket and describe what happened.".to_string(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_tokens_and_passwords_are_removed() {
        let pem = "before\n-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\nafter";
        assert_eq!(redact(pem), "before\n[private key removed]\nafter");
        assert_eq!(redact("id vp_abcdefghij1234567890 end"), "id [secret removed] end");
        assert_eq!(redact("key AIzaSyA1234567890abcdefghij ok"), "key [secret removed] ok");
        assert_eq!(redact("mfa.abcdefghijklmnopqrstuvwx"), "[secret removed]");
        // Built in two pieces so the source never holds a complete token-shaped string.
        assert_eq!(redact(&format!("{}{}", "MTIzNDU2Nzg5", "MDEyMzQ1Njc4OQ.GabcDe.abcdefghijklmnopqrstuvwxyz1")), "[secret removed]");
        assert_eq!(redact("Authorization: Bearer abc.def-ghi"), "Authorization: [secret removed]");
        assert_eq!(redact("authorization=Bot xyz123"), "authorization=[secret removed]");
        assert_eq!(redact(r#"{"deviceToken": "hello world", "x": 1}"#), r#"{"deviceToken": [secret removed], "x": 1}"#);
        assert_eq!(redact("password=hunter2, next"), "password=[secret removed], next");
        assert_eq!(redact("api_key: 'abc def' z"), "api_key: [secret removed] z");
        assert_eq!(redact("API-KEY=zzz"), "API-KEY=[secret removed]");
        assert_eq!(redact("plain text, no secrets"), "plain text, no secrets");
    }

    #[test]
    fn addresses_lose_what_follows_the_host_and_web_hooks_go_entirely() {
        assert_eq!(redact("see https://example.com/path?token=abc#frag now"), "see https://example.com/path now");
        assert_eq!(redact("wss://user:pw@relay.example.com:8443/x?y=1"), "wss://relay.example.com:8443/x");
        assert_eq!(redact("https://discord.com/api/webhooks/123/abcdef"), "[webhook removed]");
        assert_eq!(redact("https://discordapp.com/api/webhooks/123/abcdef?wait=true"), "[webhook removed]");
        assert_eq!(redact("https://discord.com/channels/1/2"), "https://discord.com/channels/1/2");
        assert_eq!(redact("bad http://[oops"), "bad [url removed]");
    }

    #[test]
    fn people_and_machines_are_not_identified() {
        assert_eq!(redact(r"opened C:\Users\Garv Verma\AppData\x.log"), r"opened C:\Users\[user]\AppData\x.log");
        assert_eq!(redact("/home/alice/server/log and /Users/bob/x"), "/home/[user]/server/log and /home/[user]/x");
        assert_eq!(redact("mail me at Someone.Name+tag@Example.co.in please"), "mail me at [email removed] please");
        assert_eq!(redact("uuid 123e4567-e89b-12d3-a456-426614174000 joined"), "uuid [uuid removed] joined");
        assert_eq!(redact("from 192.168.1.20 and 8.8.8.8"), "from [ip removed] and [ip removed]");
        assert_eq!(redact("v6 2001:db8::1 and fe80::1%eth0 and ::1"), "v6 [ip removed] and [ip removed] and [ip removed]");
        assert_eq!(redact("time 12:30:45 stays, ratio 1:2 stays"), "time 12:30:45 stays, ratio 1:2 stays", "things that only look like an IPv6 address are kept");
        assert_eq!(redact("ping <@123456789> <@!99> <@&5> @everyone @here"), "ping [mention removed] [mention removed] [mention removed] [mention removed] [mention removed]");
    }

    #[test]
    fn terminal_colours_and_control_characters_are_dropped_but_line_breaks_stay() {
        assert_eq!(redact("\u{1b}[31mred\u{1b}[0m ok"), "red ok");
        assert_eq!(redact("a\u{0}b\u{7}c\u{b}d\u{1f}e"), "abcde");
        assert_eq!(redact("line1\r\nline2\tx"), "line1\r\nline2\tx");
    }

    fn input<'a>(lines: &'a [String], status: &'a str, server: Option<ServerFacts<'a>>) -> ReportInput<'a> {
        ReportInput { version: "1.2.3", platform: "windows", arch: "x86_64", server, status, lines, created: "2026-11-08T10:00:00.000Z" }
    }

    #[test]
    fn a_report_names_the_app_the_server_and_the_reason_and_never_the_secrets() {
        let lines: Vec<String> = ["[12:00:00] [Server thread/ERROR]: **** FAILED TO BIND TO PORT!", "token=abc123 from 10.0.0.5", "java.lang.OutOfMemoryError: Java heap space"].iter().map(|s| s.to_string()).collect();
        let r = create_report(&input(&lines, "crashed", Some(ServerFacts { server_type: "paper", version: "1.21.4", build: Some("90"), port: Some(25565) })));
        assert!(r.starts_with("VoxelPort diagnostic report v1\nCreated: 2026-11-08T10:00:00.000Z\nApp: 1.2.3 | OS: windows x86_64\nServer: paper | Minecraft: 1.21.4 (build 90) | Status: crashed\nError codes:\n"), "{r}");
        assert!(r.contains("VP-PORT_IN_USE: The port is already in use\nAnother program"), "{r}");
        assert!(r.contains("VP-OUT_OF_MEMORY: The server ran out of memory"), "{r}");
        assert!(r.contains("token=[secret removed] from [ip removed]"), "{r}");
        assert!(!r.contains("abc123") && !r.contains("10.0.0.5"));
        assert!(r.ends_with("Attach this .txt file to a Discord support ticket and describe what happened."));
        assert!(r.contains("Review this file before sharing. Automatic redaction is best effort."));
    }

    #[test]
    fn other_known_failures_get_their_own_codes_and_nothing_known_says_so() {
        let lines: Vec<String> = ["java.lang.UnsupportedClassVersionError: x", "[Geyser] Outdated server! I'm still on 1.21.3", "java.net.UnknownHostException: nope.example", "connect timed out"].iter().map(|s| s.to_string()).collect();
        let r = create_report(&input(&lines, "stopped", None));
        for code in ["VP-JAVA_VERSION:", "VP-GEYSER_VERSION_MISMATCH:", "VP-DNS:", "VP-TIMEOUT:"] {
            assert!(r.contains(code), "{code} in {r}");
        }
        assert!(r.contains("Server: external/none | Minecraft: unknown | Status: stopped"));
        let quiet: Vec<String> = vec!["all fine".into()];
        let r = create_report(&input(&quiet, "stopped", Some(ServerFacts { server_type: "", version: "", build: None, port: None })));
        assert!(r.contains("VP-NO_MATCH: No known error signature found; review the log below."), "{r}");
        assert!(r.contains("Server: external/none | Minecraft: unknown | Status: stopped"), "{r}");
    }

    #[test]
    fn a_crash_nothing_matches_still_gets_the_general_code_and_a_huge_log_is_cut_to_its_end() {
        let mut lines: Vec<String> = (0..30_000).map(|i| format!("line number {i} padding padding")).collect();
        lines.push("the very last line".into());
        let r = create_report(&input(&lines, "crashed", None));
        assert!(r.contains("VP-CRASHED: The server crashed"), "{}", &r[..400]);
        assert!(r.contains("the very last line"));
        assert!(!r.contains("line number 0 padding"), "the start was cut");
        assert!(r.chars().count() < 200_700);
    }
}

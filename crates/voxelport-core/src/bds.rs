//! Mojang's Bedrock Dedicated Server (`bedrock_server.exe`) as a server type of its own: no Java, no jar. Bedrock players (phones,
//! consoles, Minecraft for Windows) join it directly. This is not the Geyser add-on (`bedrock.rs`), which lets Bedrock players into a
//! *Java* server.
//!
//! * Where it comes from: Mojang's own download service names the current Windows build; the zip is fetched from `www.minecraft.net`
//!   only (every redirect hop re-checked), size-capped, and unpacked with the same care as a backup: no path may leave the server
//!   folder, no link is kept, and the unpacked folder must really hold `bedrock_server.exe`. Mojang publishes no checksum for it, so there
//!   is none to compare; HTTPS to those two hosts and the checks on the archive are what protect the download.
//! * What it speaks: the console protocol (`stop`, `kick`, `op`...) and a log format of its own, so the lines are read here, not by the
//!   Java patterns in `server_process`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::net::{Fetcher, HostPolicy};
use crate::server_install::{self, Phase};

/// The profile `type` of this kind of server.
pub const TYPE_ID: &str = "bedrock-server";
pub const LABEL: &str = "Bedrock Server";
pub const EXE: &str = "bedrock_server.exe";
/// What a Bedrock server listens on (UDP) unless told otherwise.
pub const DEFAULT_PORT: i64 = 19132;

const MAX_LINKS_BYTES: u64 = 64 * 1024;
/// The real archive is about 50 MB.
pub const MAX_ZIP_BYTES: u64 = 400 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;

pub fn is_bedrock_server(server_type: &str) -> bool {
    server_type == TYPE_ID
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("fixed pattern"))
}

// ─── Where the download comes from ──────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Endpoints {
    /// Mojang's download-link service.
    pub links_api: String,
}

impl Endpoints {
    pub fn production() -> Self {
        Self { links_api: "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links".into() }
    }
}

/// What this app calls itself to Mojang's download host. Deliberately plain: that host's CDN (Akamai) never answers a request whose
/// user-agent carries a bot-style "(+https://...)" tag (found by trying the real download: it stalls until the client gives up), while
/// `VoxelPort-App/<version>` is answered at once.
pub const USER_AGENT: &str = concat!("VoxelPort-App/", env!("CARGO_PKG_VERSION"));

/// The only two hosts a Bedrock server is ever fetched from.
pub fn fetcher() -> Fetcher {
    Fetcher::new(HostPolicy::exact(&["net-secondary.web.minecraft-services.net", "www.minecraft.net"]), "Bedrock server", USER_AGENT)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
}

/// `1.26.63.1` from `.../bin-win/bedrock-server-1.26.63.1.zip`.
fn version_in_url(url: &str) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let path = url::Url::parse(url).ok()?.path().to_string();
    re(&R, r"^/(?:[A-Za-z0-9_.-]+/)*bin-win/bedrock-server-(\d+(?:\.\d+){2,3})\.zip$").captures(&path).map(|c| c[1].to_string())
}

/// The current release for Windows, as Mojang's service names it.
pub fn latest_release(f: &Fetcher, ep: &Endpoints) -> Result<Release, String> {
    let doc = f.fetch_json(&ep.links_api, MAX_LINKS_BYTES)?;
    let links = doc["result"]["links"].as_array().ok_or("Mojang's download service gave an answer this app does not understand.")?;
    let url = links
        .iter()
        .find(|l| l["downloadType"] == "serverBedrockWindows")
        .and_then(|l| l["downloadUrl"].as_str())
        .ok_or("Mojang's download service lists no Bedrock server for Windows right now.")?;
    f.check_url(url)?;
    let version = version_in_url(url).ok_or("Mojang's download service named a Bedrock server this app does not recognise.")?;
    Ok(Release { version, url: url.to_string() })
}

/// What the version list shows: only the current release (older ones are not listed by Mojang and a Bedrock client must match the server).
pub fn list_versions(f: &Fetcher, ep: &Endpoints) -> Result<Vec<String>, String> {
    Ok(vec![latest_release(f, ep)?.version])
}

// ─── Unpacking ──────────────────────────────────────────────────────────────

/// Unpacks `zip_path` into `dest`, refusing anything that could land outside it (absolute paths, `..`, drive letters, backslashes) and
/// any link, and anything absurdly big. Returns the files and folders it created, in creation order, so a failed install can undo exactly
/// those.
pub fn extract_zip_safely(zip_path: &Path, dest: &Path) -> Result<Vec<PathBuf>, String> {
    let unsafe_err = || "The download holds a file outside its folder, so nothing was installed.".to_string();
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("The download is not a usable archive ({e})."))?;
    if zip.len() > MAX_ENTRIES {
        return Err("The download holds far more files than a Bedrock server does, so nothing was installed.".into());
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        total += zip.by_index(i).map_err(|e| format!("The download is damaged ({e})."))?.size();
    }
    if total > MAX_UNPACKED_BYTES {
        return Err("The download is far bigger than a Bedrock server, so nothing was installed.".into());
    }
    // Look before writing anything: the program must be there, as a plain file at the top.
    if !(0..zip.len()).any(|i| zip.by_index(i).is_ok_and(|e| e.name() == EXE && !e.is_dir() && e.size() > 0)) {
        return Err(format!("The download has no {EXE}, so it is not a Bedrock server. Nothing was installed."));
    }
    let mut made: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<(), String> {
        let mut buf = vec![0u8; 256 * 1024];
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| format!("The download is damaged ({e})."))?;
            let name = entry.name().to_string();
            let is_symlink = entry.unix_mode().is_some_and(|m| m & 0o170_000 == 0o120_000);
            let parts: Vec<&str> = name.trim_end_matches('/').split('/').collect();
            if is_symlink || name.contains('\\') || name.contains(':') || name.starts_with('/') || name.contains('\0') || parts.iter().any(|p| *p == ".." || p.is_empty()) {
                return Err(unsafe_err());
            }
            let mut target = dest.to_path_buf();
            for p in &parts {
                target.push(p);
            }
            if !target.starts_with(dest) {
                return Err(unsafe_err());
            }
            if entry.is_dir() {
                if !target.exists() {
                    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                    made.push(target);
                }
                continue;
            }
            if let Some(parent) = target.parent() {
                if !parent.exists() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    made.push(parent.to_path_buf());
                }
            }
            if target.exists() {
                return Err(format!("{name} is already in the folder, so nothing was installed."));
            }
            let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
            made.push(target);
            loop {
                let n = entry.read(&mut buf).map_err(|e| format!("The download is damaged ({e})."))?;
                if n == 0 {
                    break;
                }
                std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(made),
        Err(e) => {
            undo(&made);
            Err(e)
        }
    }
}

/// Removes what an unpacking created (files first, then folders deepest first); anything that was there before is untouched.
fn undo(made: &[PathBuf]) {
    for p in made.iter().rev() {
        let _ = fs::remove_file(p);
    }
    let mut dirs: Vec<&PathBuf> = made.iter().collect();
    dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for d in dirs {
        let _ = fs::remove_dir(d);
    }
}

// ─── Installing ─────────────────────────────────────────────────────────────

pub struct InstallRequest<'a> {
    pub dir: &'a Path,
    /// The IPv4 port (UDP). The IPv6 one is written next to it.
    pub port: i64,
    /// Shown in Bedrock's server list.
    pub server_name: &'a str,
}

/// The IPv6 port written beside the chosen one, kept apart from it.
pub fn port_v6_for(port: i64) -> i64 {
    if port < 65535 { port + 1 } else { port - 1 }
}

/// Downloads and unpacks the current Bedrock server into `req.dir` and sets its port and name. Blocking. Nothing is written until the
/// folder is known to hold no server, and a folder this call created is removed again if it fails.
pub fn install_server_files(req: &InstallRequest, fetcher: &Fetcher, ep: &Endpoints, on_phase: &dyn Fn(Phase)) -> Result<Release, String> {
    server_install::assert_folder_empty_for_install(req.dir)?;
    let created = !req.dir.exists();
    fs::create_dir_all(req.dir).map_err(|e| format!("Could not create the server folder: {e}"))?;
    let mut extracted: Vec<PathBuf> = Vec::new();
    let result = install_into(req, fetcher, ep, on_phase, &mut extracted);
    if result.is_err() {
        if created {
            let _ = fs::remove_dir_all(req.dir); // this call made the folder, so everything in it is its own
        } else {
            undo(&extracted);
        }
    }
    result
}

fn install_into(req: &InstallRequest, fetcher: &Fetcher, ep: &Endpoints, on_phase: &dyn Fn(Phase), extracted: &mut Vec<PathBuf>) -> Result<Release, String> {
    on_phase(Phase::Resolving);
    let release = latest_release(fetcher, ep)?;

    on_phase(Phase::Downloading { received: 0, total: 0 });
    let zip_path = req.dir.join(".bedrock-server-download.zip");
    fetcher.download(&release.url, &zip_path, MAX_ZIP_BYTES, None, 0, &|received, total| on_phase(Phase::Downloading { received, total }))?;

    on_phase(Phase::Verifying);
    let unpacked = extract_zip_safely(&zip_path, req.dir);
    let _ = fs::remove_file(&zip_path);
    *extracted = unpacked?;

    // The shipped server.properties carries Mojang's defaults and comments: change only the lines this app owns.
    let name = req.server_name.chars().filter(|c| !c.is_control()).collect::<String>();
    let name = name.trim();
    let mut changes = vec![
        ("server-port".to_string(), req.port.to_string()),
        ("server-portv6".to_string(), port_v6_for(req.port).to_string()),
    ];
    if !name.is_empty() {
        // The Bedrock server's file holds text as it is (no Java-style escapes).
        changes.push(("server-name".to_string(), name.chars().take(50).collect::<String>()));
    }
    server_install::update_server_properties_safely(req.dir, &changes).map_err(|e| e.to_string())?;
    Ok(release)
}

/// The program to run for a server folder: a plain file named `bedrock_server.exe` directly inside it (never a link, never a path the
/// profile could point elsewhere).
pub fn server_exe(dir: &Path) -> Result<PathBuf, String> {
    if !dir.is_absolute() {
        return Err("invalid server folder.".into());
    }
    let exe = dir.join(EXE);
    match fs::symlink_metadata(&exe) {
        Ok(m) if m.is_file() => Ok(exe),
        _ => Err(format!("{EXE} is missing from this server's folder. Reinstall the server, or restore it from a backup.")),
    }
}

// ─── The public address (NetherNet) ─────────────────────────────────────────
//
// The real server (1.26) uses the NetherNet transport by default (its own documentation, `bedrock_server_how_to.html`): a client first opens a
// TCP connection to `server-port` (an HTTP signalling handshake), then the two negotiate a UDP connection that carries the game. The signalling
// goes through the relay like any TCP connection; the UDP has to be told where to be reached, or the client is handed the PC's own address and
// can never connect. `server-udp-ports=<public IP>:<public port>:<local port>` is how the server is told, and the relay is that public address.

/// The value for `server-udp-ports`: `19132` when there is no public address, `1.2.3.4:26336:19132` (or `[2001:db8::1]:26336:19132`) when there is.
pub fn udp_ports_value(public_ip: Option<std::net::IpAddr>, public_port: u16, local_port: u16) -> String {
    match public_ip {
        Some(std::net::IpAddr::V4(ip)) => format!("{ip}:{public_port}:{local_port}"),
        Some(std::net::IpAddr::V6(ip)) => format!("[{ip}]:{public_port}:{local_port}"),
        None => local_port.to_string(),
    }
}

/// The address a relay's host name points at (blocking; the server wants an address, not a name). IPv4 first: it is what every relay has.
pub fn resolve_public_ip(host: &str) -> Option<std::net::IpAddr> {
    use std::net::ToSocketAddrs;
    if !crate::bedrock_endpoint::valid_host(host) {
        return None;
    }
    let all: Vec<std::net::IpAddr> = (host, 0u16).to_socket_addrs().ok()?.map(|a| a.ip()).collect();
    all.iter().find(|ip| ip.is_ipv4()).or_else(|| all.first()).copied()
}

// ─── What the server prints ─────────────────────────────────────────────────

/// A log line without its "[2026-11-08 12:00:00:123 INFO]" front (and the "NO LOG FILE! - " some builds print before it). What the
/// server means is the message after that, never a piece of it.
pub fn strip_log_prefix(line: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^(?:NO LOG FILE! - )?\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?::\d{3})? (?:INFO|WARN|WARNING|ERROR|DEBUG)\]\s*").replace(line, "").trim_end().to_string()
}

/// The line the server prints when it is ready for players.
pub fn is_ready(message: &str) -> bool {
    message == "Server started."
}

/// "Player connected: Steve, xuid: 2535..." → Some("Steve").
pub fn player_joined(message: &str) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^Player connected: ([A-Za-z0-9_. -]{1,32}), xuid: ?[0-9]*$").captures(message).map(|c| c[1].to_string())
}

pub fn player_left(message: &str) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^Player disconnected: ([A-Za-z0-9_. -]{1,32}), xuid: ?[0-9]*$").captures(message).map(|c| c[1].to_string())
}

/// A name this server can print (gamertags may hold spaces), so a console button can never carry a second command.
pub fn is_player_name(name: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[A-Za-z0-9_. -]{1,32}$").is_match(name) && !name.trim().is_empty()
}

/// The console buttons this server understands (it has kick, op and deop; its bans are the allow-list).
pub const PLAYER_ACTIONS: [&str; 3] = ["kick", "op", "deop"];

/// The console line for a player button; a name with spaces is quoted.
pub fn player_command(action: &str, name: &str) -> Option<String> {
    if !PLAYER_ACTIONS.contains(&action) || !is_player_name(name) {
        return None;
    }
    Some(format!("{action} \"{name}\""))
}

// ─── Saving for a backup ────────────────────────────────────────────────────
//
// A running Bedrock server is backed up with three commands: `save hold` (stop writing and flush), `save query` (asks whether the files
// are ready; the answer is "Data saved. Files are now ready to be copied." followed by each file's exact length) and `save resume`.

/// The `save query` answer that means the files may be copied.
pub fn is_save_ready(message: &str) -> bool {
    message.starts_with("Data saved. Files are now ready to be copied")
}

/// The answer to `save resume`.
pub fn is_save_resumed(message: &str) -> bool {
    message.starts_with("Changes to the world are resumed")
}

/// The files and lengths of a `save query` answer ("Bedrock level/db/000003.log:2063, Bedrock level/level.dat:1982"). A line that is not
/// such a list gives nothing.
pub fn parse_save_files(message: &str) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    for piece in message.split(", ") {
        let Some((name, len)) = piece.trim().rsplit_once(':') else { return Vec::new() };
        let (name, Ok(len)) = (name.trim(), len.trim().parse::<u64>()) else { return Vec::new() };
        if name.is_empty() || name.contains('\\') || name.contains(':') || name.starts_with('/') || name.split('/').any(|p| p == ".." || p.is_empty()) {
            return Vec::new();
        }
        out.push((name.to_string(), len));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, body) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn the_user_agent_is_plain_because_the_download_host_ignores_bot_style_ones() {
        assert!(USER_AGENT.starts_with("VoxelPort-App/") && !USER_AGENT.contains('(') && !USER_AGENT.contains("http"), "{USER_AGENT}");
        assert_eq!(fetcher().user_agent, USER_AGENT);
    }

    #[test]
    fn the_version_comes_from_the_windows_download_name() {
        assert_eq!(version_in_url("https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.63.1.zip").as_deref(), Some("1.26.63.1"));
        assert_eq!(version_in_url("https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.21.100.zip").as_deref(), Some("1.21.100"));
        for bad in [
            "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.63.1.zip",
            "https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.63.1.zip",
            "https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.63.1.exe",
            "https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-x.y.z.zip",
            "https://www.minecraft.net/bin-win/../evil/bedrock-server-1.2.3.zip",
            "nope",
        ] {
            assert_eq!(version_in_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_public_address_is_written_the_way_the_servers_documentation_shows() {
        use std::net::IpAddr;
        assert_eq!(udp_ports_value(Some("12.19.20.18".parse::<IpAddr>().unwrap()), 19489, 19489), "12.19.20.18:19489:19489");
        assert_eq!(udp_ports_value(Some("110.225.229.41".parse().unwrap()), 26336, 19132), "110.225.229.41:26336:19132");
        assert_eq!(udp_ports_value(Some("2001:db8::2021:26:3".parse().unwrap()), 26336, 19132), "[2001:db8::2021:26:3]:26336:19132");
        assert_eq!(udp_ports_value(None, 26336, 19132), "19132", "with no public address it is just the local port");
        assert_eq!(resolve_public_ip("127.0.0.1"), Some("127.0.0.1".parse().unwrap()));
        assert_eq!(resolve_public_ip("bad host!"), None);
        assert_eq!(resolve_public_ip(""), None);
    }

    #[test]
    fn the_player_lines_are_read_whole() {
        assert_eq!(strip_log_prefix("[2026-11-08 12:00:00:123 INFO] Server started."), "Server started.");
        assert_eq!(strip_log_prefix("NO LOG FILE! - [2026-11-08 12:00:00:123 INFO] Server started."), "Server started.");
        assert_eq!(strip_log_prefix("[2026-11-08 12:00:00 WARN] low"), "low");
        assert!(is_ready("Server started.") && !is_ready("Server started. Now with extra"));
        assert_eq!(player_joined("Player connected: Steve Smith, xuid: 2535412345678"), Some("Steve Smith".into()));
        assert_eq!(player_joined("Player connected: Alex, xuid: "), Some("Alex".into()));
        assert_eq!(player_left("Player disconnected: Steve Smith, xuid: 2535412345678"), Some("Steve Smith".into()));
        // Words a player could type into a name never pass for the server saying them, and a name can never end the line early.
        assert_eq!(player_joined("Player connected: A, xuid: 1\nPlayer connected: B, xuid: 2"), None);
        assert_eq!(player_joined("Player disconnected: Steve, xuid: 1"), None);
        assert_eq!(player_joined("Hello Player connected: Steve, xuid: 1"), None);
    }

    #[test]
    fn player_buttons_are_a_short_fixed_list_with_quoted_names() {
        assert_eq!(player_command("kick", "Steve Smith").as_deref(), Some("kick \"Steve Smith\""));
        assert_eq!(player_command("op", "Alex").as_deref(), Some("op \"Alex\""));
        assert_eq!(player_command("ban", "Alex"), None, "the Bedrock server has no ban command");
        for bad in ["a\"b", "x\ny", "me; stop", "", "   ", &"n".repeat(33)] {
            assert_eq!(player_command("kick", bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_save_answer_gives_files_and_lengths_or_nothing() {
        assert!(is_save_ready("Data saved. Files are now ready to be copied.") && !is_save_ready("A previous save has not been completed."));
        assert!(is_save_resumed("Changes to the world are resumed."));
        assert_eq!(parse_save_files("Bedrock level/db/000003.log:2063, Bedrock level/level.dat:1982"), vec![("Bedrock level/db/000003.log".to_string(), 2063), ("Bedrock level/level.dat".to_string(), 1982)]);
        for not_a_list in ["Saving...", "Data saved. Files are now ready to be copied.", "a:x", "../x:1", "/etc/x:1", "C:/x:1", "a\\b:1"] {
            assert!(parse_save_files(not_a_list).is_empty(), "{not_a_list}");
        }
    }

    #[test]
    fn unpacking_writes_the_files_and_reports_what_it_made() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("a.zip");
        make_zip(&z, &[("bedrock_server.exe", b"MZ"), ("server.properties", b"server-port=19132\n"), ("behavior_packs/vanilla/manifest.json", b"{}")]);
        let out = tempfile::tempdir().unwrap();
        let made = extract_zip_safely(&z, out.path()).unwrap();
        assert!(out.path().join("bedrock_server.exe").is_file() && out.path().join("behavior_packs").join("vanilla").join("manifest.json").is_file());
        assert!(made.len() >= 3);
    }

    #[test]
    fn an_archive_that_could_escape_or_is_not_a_server_installs_nothing() {
        let d = tempfile::tempdir().unwrap();
        for (label, files) in [
            ("dot-dot", vec![("bedrock_server.exe", &b"MZ"[..]), ("../evil.txt", b"x")]),
            ("backslash", vec![("bedrock_server.exe", &b"MZ"[..]), ("a\\b.txt", b"x")]),
            ("drive", vec![("bedrock_server.exe", &b"MZ"[..]), ("C:/x.txt", b"x")]),
            ("absolute", vec![("bedrock_server.exe", &b"MZ"[..]), ("/x.txt", b"x")]),
            ("no program", vec![("server.properties", &b"x"[..])]),
            ("program in a folder", vec![("sub/bedrock_server.exe", &b"MZ"[..])]),
            ("empty program", vec![("bedrock_server.exe", &b""[..])]),
        ] {
            let z = d.path().join(format!("{label}.zip"));
            make_zip(&z, &files);
            let out = tempfile::tempdir().unwrap();
            assert!(extract_zip_safely(&z, out.path()).is_err(), "{label}");
            assert_eq!(fs::read_dir(out.path()).unwrap().count(), 0, "{label}: nothing left behind");
        }
        // A file already in the folder is never overwritten.
        let z = d.path().join("clash.zip");
        make_zip(&z, &[("bedrock_server.exe", b"MZ"), ("server.properties", b"new")]);
        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join("server.properties"), "mine").unwrap();
        assert!(extract_zip_safely(&z, out.path()).is_err());
        assert_eq!(fs::read_to_string(out.path().join("server.properties")).unwrap(), "mine");
        assert!(!out.path().join("bedrock_server.exe").exists(), "what was written before the clash is taken back");
    }

    #[test]
    fn the_program_is_a_plain_file_in_the_server_folder() {
        let d = tempfile::tempdir().unwrap();
        assert!(server_exe(d.path()).unwrap_err().contains("missing"));
        fs::write(d.path().join(EXE), "MZ").unwrap();
        assert_eq!(server_exe(d.path()).unwrap(), d.path().join(EXE));
        assert!(server_exe(Path::new("relative")).is_err());
        let dir_named_like_it = tempfile::tempdir().unwrap();
        fs::create_dir(dir_named_like_it.path().join(EXE)).unwrap();
        assert!(server_exe(dir_named_like_it.path()).is_err());
    }
}

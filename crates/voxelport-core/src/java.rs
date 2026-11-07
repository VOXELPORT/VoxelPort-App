//! Java for Minecraft servers: which version a server needs, whether this PC has it, and a one-click install of
//! Eclipse Temurin into the app's own data folder. Ported from `javaCheck.js` and `javaInstall.js`.
//!
//! Layout: `<data dir>/java/temurin-<major>/` (the extracted JRE root). No administrator rights, no system installer.
//!
//! The download is the part worth being careful about: the build and its SHA-256 come from the official Adoptium API,
//! every request (and every redirect hop) must be HTTPS to one of a few named hosts, the archive size is capped, and
//! the zip is unpacked by this crate with path checks rather than by a system tool, so an entry can never be written
//! outside the target folder.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

// ─── Which Java a Minecraft version needs ───────────────────────────────────

/// Lowest Minecraft version that needs each Java major (newest first). It depends only on the Minecraft version, not on
/// the loader (Paper, Fabric) on top of it.
const JAVA_REQUIREMENTS: &[(&str, u32)] = &[
    ("26.0", 25), // year-based versions (26.1, 26.2, ...) need Java 25
    ("1.20.5", 21),
    ("1.18", 17),
    ("1.17", 16),
    ("0.0", 8),
];

/// Splits on `.` and `-` and reads the leading digits of each part (anything else counts as 0), like `parseInt`.
fn parse_version(v: &str) -> Vec<u64> {
    v.split(['.', '-'])
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            // No digits counts as 0; a number too big for u64 is treated as huge (parseInt gives a huge number too).
            if digits.is_empty() { 0 } else { digits.parse().unwrap_or(u64::MAX) }
        })
        .collect()
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let (pa, pb) = (parse_version(a), parse_version(b));
    for i in 0..pa.len().max(pb.len()) {
        let ord = pa.get(i).copied().unwrap_or(0).cmp(&pb.get(i).copied().unwrap_or(0));
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    std::cmp::Ordering::Equal
}

pub fn required_java_major(mc_version: &str) -> u32 {
    JAVA_REQUIREMENTS.iter().find(|(since, _)| compare_versions(mc_version, since) != std::cmp::Ordering::Less).map(|(_, m)| *m).unwrap_or(8)
}

/// Reads the Java major a server says it needs from one line of its output. Catches the explicit messages Paper and
/// Fabric print as well as the JVM's own `UnsupportedClassVersionError` (class file version N means Java N-44), so a
/// version missing from the table above still gets fixed at run time.
pub fn required_java_from_log(line: &str) -> Option<u32> {
    use std::sync::OnceLock;
    static EXPLICIT: OnceLock<[Regex; 3]> = OnceLock::new();
    static CLASS: OnceLock<Regex> = OnceLock::new();
    let explicit = EXPLICIT.get_or_init(|| {
        [
            Regex::new(r"(?i)requires? (?:running the server with )?Java (\d{1,2})\b").unwrap(),
            Regex::new(r"(?i)Java (\d{1,2}) or (?:above|higher|newer|later) is required").unwrap(),
            Regex::new(r"(?i)needs? (?:at least )?Java (\d{1,2})\b").unwrap(),
        ]
    });
    let class = CLASS.get_or_init(|| Regex::new(r"(?s)UnsupportedClassVersionError.*?class file version (\d{2,3})(?:\.\d+)?").unwrap());
    let sane = |n: u32| (8..=99).contains(&n).then_some(n);
    if let Some(c) = explicit.iter().find_map(|r| r.captures(line)) {
        return sane(c[1].parse().ok()?);
    }
    class.captures(line).and_then(|c| sane(c[1].parse::<u32>().ok()?.checked_sub(44)?))
}

// ─── Running `java -version` ────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct JavaCheck {
    pub found: bool,
    pub major: Option<u32>,
    pub raw: Option<String>,
}

/// The major from the banner `java -version` prints to stderr, e.g. `openjdk version "21.0.2" 2024-01-16` or
/// `java version "1.8.0_351"` (the old scheme counts from `1.`).
pub fn parse_java_banner(stderr: &str) -> Option<u32> {
    let c = Regex::new(r#"version "(\d+)(?:\.(\d+))?"#).unwrap().captures(stderr)?;
    let first: u32 = c[1].parse().ok()?;
    if first == 1 { c.get(2)?.as_str().parse().ok() } else { Some(first) }
}

/// Runs `<java> -version` (with a time limit; Electron had none) and reports what it is. `java_path` is `"java"` for
/// the PATH or an absolute path.
pub async fn check_java(java_path: &str) -> JavaCheck {
    let mut cmd = tokio::process::Command::new(java_path);
    cmd.arg("-version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from a windowed app
    let run = async {
        let out = cmd.output().await.ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stderr).trim().to_string())
    };
    match tokio::time::timeout(Duration::from_secs(15), run).await {
        Ok(Some(stderr)) => JavaCheck { found: true, major: parse_java_banner(&stderr), raw: Some(stderr) },
        _ => JavaCheck { found: false, major: None, raw: None },
    }
}

// ─── Java that VoxelPort installed itself ───────────────────────────────────

pub fn java_root(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join("java")
}

pub fn install_dir(user_data_dir: &Path, major: u32) -> PathBuf {
    java_root(user_data_dir).join(format!("temurin-{major}"))
}

fn java_binary_name() -> &'static str {
    if cfg!(windows) { "java.exe" } else { "java" }
}

/// The java executable inside an extracted JRE folder, or None if absent.
pub fn java_executable_in(dir: &Path) -> Option<PathBuf> {
    [dir.join("bin").join(java_binary_name()), dir.join("Contents").join("Home").join("bin").join(java_binary_name())].into_iter().find(|p| p.is_file())
}

#[derive(Clone, Debug, PartialEq)]
pub struct ManagedJava {
    pub major: u32,
    pub java_path: PathBuf,
}

fn managed_installs(user_data_dir: &Path) -> Vec<(u32, PathBuf)> {
    let Ok(entries) = fs::read_dir(java_root(user_data_dir)) else { return Vec::new() };
    let mut found: Vec<(u32, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let digits = name.strip_prefix("temurin-")?;
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some((digits.parse().ok()?, e.path()))
        })
        .collect();
    found.sort_by_key(|(m, _)| *m);
    found
}

/// The best app-managed Java for `required`: an exact match first, then the lowest installed major above it (Minecraft
/// runs on newer Java, but the closest version is the safest choice).
pub fn find_managed_java(user_data_dir: &Path, required: u32) -> Option<ManagedJava> {
    managed_installs(user_data_dir).into_iter().filter(|(m, _)| *m >= required).find_map(|(major, dir)| java_executable_in(&dir).map(|java_path| ManagedJava { major, java_path }))
}

/// The majors of the Javas VoxelPort installed itself, lowest first.
pub fn list_managed_java(user_data_dir: &Path) -> Vec<u32> {
    managed_installs(user_data_dir).into_iter().filter(|(_, d)| java_executable_in(d).is_some()).map(|(m, _)| m).collect()
}

// ─── Download and install ───────────────────────────────────────────────────

const MAX_REDIRECTS: u32 = 5;
const MAX_API_BYTES: u64 = 2 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024; // a JDK unpacks to roughly 300 MB
const MAX_ENTRIES: usize = 50_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30);

/// Where Java comes from. [`Source::adoptium`] is the only one the app uses; the fields are public so a test can
/// point at a local server over plain HTTP.
#[derive(Clone, Debug)]
pub struct Source {
    pub api_base: String,
    pub allowed_hosts: Vec<String>,
    pub https_only: bool,
    pub max_archive_bytes: u64,
    /// (os, architecture) as Adoptium names them; None means detect from this machine.
    pub platform: Option<(String, String)>,
}

impl Source {
    /// The official Adoptium API, the GitHub release page it links to, and GitHub's release-asset CDN that page
    /// redirects to. Anything else, including an HTTPS to HTTP downgrade, is refused.
    pub fn adoptium() -> Self {
        Self {
            api_base: "https://api.adoptium.net/v3/assets/latest".into(),
            allowed_hosts: ["api.adoptium.net", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].map(String::from).to_vec(),
            https_only: true,
            max_archive_bytes: 400 * 1024 * 1024, // real JRE archives are 45-60 MB
            platform: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Progress {
    Resolve,
    Download { received: u64, total: u64 },
    Extract,
    Done,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Installed {
    pub major: u32,
    pub java_path: PathBuf,
}

fn platform(source: &Source) -> Result<(String, String), String> {
    if let Some(p) = &source.platform {
        return Ok(p.clone());
    }
    let os = match std::env::consts::OS {
        "windows" => "windows",
        other => return Err(format!("Automatic Java install isn't available for {other} in this build.")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        other => return Err(format!("Automatic Java install isn't available for {os}/{other}.")),
    };
    Ok((os.into(), arch.into()))
}

fn check_host(source: &Source, url: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(url).map_err(|_| "Invalid Java download URL.".to_string())?;
    let host_ok = u.host_str().map(|h| source.allowed_hosts.iter().any(|a| a.eq_ignore_ascii_case(h))).unwrap_or(false);
    let scheme_ok = u.scheme() == "https" || (!source.https_only && u.scheme() == "http");
    if !scheme_ok || !host_ok {
        return Err(format!("Refusing Java download from untrusted host: {}://{}", u.scheme(), u.host_str().unwrap_or("")));
    }
    Ok(u)
}

/// GET following redirects, re-checking the host and scheme of every hop.
fn get(source: &Source, url: &str) -> Result<ureq::Response, String> {
    let agent = ureq::AgentBuilder::new().redirects(0).timeout_connect(CONNECT_TIMEOUT).timeout_read(INACTIVITY_TIMEOUT).user_agent("VoxelPort-App").build();
    let mut current = check_host(source, url)?;
    for _ in 0..=MAX_REDIRECTS {
        let resp = match agent.get(current.as_str()).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, _)) => return Err(format!("Java download failed: HTTP {code}")),
            Err(e) => return Err(format!("Java download failed: {e}")),
        };
        let status = resp.status();
        if (300..400).contains(&status) {
            let location = resp.header("location").ok_or_else(|| format!("Java download failed: HTTP {status}"))?;
            let next = current.join(location).map_err(|_| "Invalid Java download URL.".to_string())?;
            current = check_host(source, next.as_str())?;
            continue;
        }
        if status != 200 {
            return Err(format!("Java download failed: HTTP {status}"));
        }
        return Ok(resp);
    }
    Err("Too many redirects while downloading Java.".into())
}

fn fetch_json(source: &Source, url: &str) -> Result<Value, String> {
    let resp = get(source, url)?;
    let mut body = Vec::new();
    resp.into_reader().take(MAX_API_BYTES + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 > MAX_API_BYTES {
        return Err("Adoptium API response too large.".into());
    }
    serde_json::from_slice(&body).map_err(|_| "Could not read the Adoptium API response.".to_string())
}

struct Package {
    link: String,
    name: String,
    size: u64,
    sha256: String,
}

/// Picks the archive for this platform: a JRE if one is published, else a JDK.
fn resolve_package(source: &Source, major: u32) -> Result<Package, String> {
    let (os, arch) = platform(source)?;
    let ext = if os == "windows" { ".zip" } else { ".tar.gz" };
    if ext != ".zip" {
        return Err(format!("Automatic Java install isn't available for {os} in this build."));
    }
    for image_type in ["jre", "jdk"] {
        let url = format!("{}/{major}/hotspot?architecture={arch}&image_type={image_type}&os={os}&vendor=eclipse", source.api_base);
        let assets = fetch_json(source, &url)?;
        let pkg = assets.as_array().and_then(|list| {
            list.iter().filter_map(|a| a.get("binary")?.get("package")).find(|p| p["link"].is_string() && p["name"].as_str().map(|n| n.ends_with(ext)).unwrap_or(false))
        });
        if let Some(p) = pkg {
            let checksum = p["checksum"].as_str().unwrap_or("");
            if checksum.len() != 64 || !checksum.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Adoptium did not provide a valid checksum for this Java build.".into());
            }
            return Ok(Package { link: p["link"].as_str().unwrap().to_string(), name: p["name"].as_str().unwrap().to_string(), size: p["size"].as_u64().unwrap_or(0), sha256: checksum.to_ascii_lowercase() });
        }
    }
    Err(format!("No Java {major} build is published for {os}/{arch}."))
}

fn download(source: &Source, pkg: &Package, dest: &Path, on_progress: &dyn Fn(Progress)) -> Result<(), String> {
    let resp = get(source, &pkg.link)?;
    let declared: u64 = resp.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if declared > source.max_archive_bytes {
        return Err("Java archive is unexpectedly large.".into());
    }
    let total = if declared > 0 { declared } else { pkg.size };
    let mut reader = resp.into_reader();
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let (mut received, mut buf) = (0u64, vec![0u8; 64 * 1024]);
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Java download stalled or failed: {e}"))?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > source.max_archive_bytes {
            return Err("Java archive exceeded the maximum allowed size.".into());
        }
        hash.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        on_progress(Progress::Download { received, total });
    }
    file.sync_all().map_err(|e| e.to_string())?;
    let actual: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if actual != pkg.sha256 {
        return Err(format!("Downloaded Java failed SHA-256 verification (expected {}, got {actual}).", pkg.sha256));
    }
    Ok(())
}

/// Unpacks a zip into `dest`. Every entry name must stay inside `dest` (no `..`, no absolute path, no drive letter),
/// symlinks are refused, and the entry count and unpacked size are capped, so a hostile archive can neither write
/// elsewhere nor fill the disk.
pub fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?).map_err(|e| format!("Could not unpack Java: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err("Could not unpack Java: the archive has too many entries.".into());
    }
    let mut written: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("Could not unpack Java: {e}"))?;
        let name = entry.name().to_string();
        let rel = entry.enclosed_name().filter(|p| p.components().all(|c| matches!(c, Component::Normal(_)))).ok_or_else(|| format!("Could not unpack Java: unsafe path in the archive ({name})."))?;
        if entry.unix_mode().map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
            return Err(format!("Could not unpack Java: the archive contains a link ({name})."));
        }
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = fs::File::create(&out).map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut (&mut entry).take(MAX_UNPACKED_BYTES - written + 1), &mut file).map_err(|e| format!("Could not unpack Java: {e}"))?;
        written += copied;
        if written > MAX_UNPACKED_BYTES {
            return Err("Could not unpack Java: the archive is far larger than a Java runtime.".into());
        }
    }
    Ok(())
}

/// Removes the folder when dropped, so a failed install leaves nothing behind.
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Installs Temurin `major` (if not already present) and returns where its `java` is. Blocking: call it from a worker
/// thread. `on_progress` is told about each stage.
pub fn install_java(user_data_dir: &Path, major: u32, source: &Source, on_progress: &dyn Fn(Progress)) -> Result<Installed, String> {
    if !(8..=99).contains(&major) {
        return Err("Invalid Java version requested.".into());
    }
    if let Some(existing) = find_managed_java(user_data_dir, major).filter(|e| e.major == major) {
        on_progress(Progress::Done);
        return Ok(Installed { major, java_path: existing.java_path });
    }

    on_progress(Progress::Resolve);
    let pkg = resolve_package(source, major)?;

    let root_dir = java_root(user_data_dir);
    fs::create_dir_all(&root_dir).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 4];
    let _ = getrandom::getrandom(&mut nonce);
    let work = root_dir.join(format!(".install-{}", nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    fs::create_dir(&work).map_err(|e| e.to_string())?;
    let _guard = Scratch(work.clone());

    let safe_name: String = pkg.name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_') { c } else { '_' }).collect();
    let archive = work.join(safe_name);
    download(source, &pkg, &archive, on_progress)?;

    on_progress(Progress::Extract);
    let unpacked = work.join("unpacked");
    fs::create_dir(&unpacked).map_err(|e| e.to_string())?;
    extract_zip(&archive, &unpacked)?;

    // Archives hold a single top-level folder (e.g. jdk-21.0.4+7-jre).
    let top: Vec<PathBuf> = fs::read_dir(&unpacked).map_err(|e| e.to_string())?.flatten().filter(|e| !e.file_name().to_string_lossy().starts_with('.')).map(|e| e.path()).collect();
    let root = if top.len() == 1 { top[0].clone() } else { unpacked.clone() };
    if java_executable_in(&root).is_none() {
        return Err("The downloaded Java archive did not contain a java executable.".into());
    }

    let target = install_dir(user_data_dir, major);
    let _ = fs::remove_dir_all(&target);
    fs::rename(&root, &target).map_err(|e| format!("Could not put Java in place: {e}"))?;
    let java_path = java_executable_in(&target).ok_or("The installed Java has no java executable.")?;
    on_progress(Progress::Done);
    Ok(Installed { major, java_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_minecraft_era_maps_to_its_java() {
        for (mc, java) in [("26.1", 25), ("26.2", 25), ("26.1.2", 25), ("1.21.8", 21), ("1.20.5", 21), ("1.20.4", 17), ("1.18.2", 17), ("1.17.1", 16), ("1.16.5", 8)] {
            assert_eq!(required_java_major(mc), java, "{mc}");
        }
    }

    #[test]
    fn odd_version_strings_do_not_panic() {
        assert_eq!(required_java_major(""), 8);
        assert_eq!(required_java_major("not a version"), 8);
        assert_eq!(required_java_major("1.21-rc1"), 21);
        assert_eq!(required_java_major("99999999999999999999.1"), 25);
    }

    #[test]
    fn paper_message_in_the_app_console_is_read() {
        assert_eq!(required_java_from_log("Minecraft 26.1 and newer requires running the server with Java 25 or above. For information on how to update Java, see https://docs.papermc.io/misc/java-install"), Some(25));
    }

    #[test]
    fn other_phrasings_are_read() {
        assert_eq!(required_java_from_log("Java 21 or higher is required to run this server"), Some(21));
        assert_eq!(required_java_from_log("This version of Minecraft requires Java 17"), Some(17));
        assert_eq!(required_java_from_log("Fabric Loader needs Java 25"), Some(25));
    }

    #[test]
    fn unsupported_class_version_maps_to_a_java_major() {
        assert_eq!(required_java_from_log("Exception in thread \"main\" java.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0"), Some(25));
        assert_eq!(required_java_from_log("UnsupportedClassVersionError: ... (class file version 65.0)"), Some(21));
    }

    #[test]
    fn ordinary_server_output_and_silly_numbers_are_ignored() {
        for line in ["Starting minecraft server version 26.1", "Done (4.213s)! For help, type \"help\"", "Steve joined the game", "<Steve> I need Java coffee", "Loading libraries, please wait...", "requires Java 7", "requires Java 100", "UnsupportedClassVersionError (class file version 40.0)"] {
            assert_eq!(required_java_from_log(line), None, "{line}");
        }
    }

    #[test]
    fn java_banners_are_read_in_both_numbering_schemes() {
        assert_eq!(parse_java_banner("openjdk version \"21.0.2\" 2024-01-16\nOpenJDK Runtime Environment"), Some(21));
        assert_eq!(parse_java_banner("java version \"1.8.0_351\""), Some(8));
        assert_eq!(parse_java_banner("openjdk version \"25\" 2025-09-16"), Some(25));
        assert_eq!(parse_java_banner("something else"), None);
    }

    fn fake_jre(root: &Path, folder: &str, mac: bool) -> PathBuf {
        let bin = if mac { root.join("java").join(folder).join("Contents").join("Home").join("bin") } else { root.join("java").join(folder).join("bin") };
        fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(java_binary_name());
        fs::write(&exe, "").unwrap();
        exe
    }

    #[test]
    fn nothing_installed_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(find_managed_java(dir.path(), 21), None);
        assert!(list_managed_java(dir.path()).is_empty());
    }

    #[test]
    fn an_exact_major_wins_then_the_closest_newer_one() {
        let dir = tempfile::tempdir().unwrap();
        fake_jre(dir.path(), "temurin-17", false);
        let j21 = fake_jre(dir.path(), "temurin-21", false);
        fake_jre(dir.path(), "temurin-25", false);
        assert_eq!(find_managed_java(dir.path(), 21), Some(ManagedJava { major: 21, java_path: j21 }));
        assert_eq!(find_managed_java(dir.path(), 18).unwrap().major, 21);
        assert_eq!(find_managed_java(dir.path(), 8).unwrap().major, 17);
        assert_eq!(find_managed_java(dir.path(), 26), None);
        assert_eq!(list_managed_java(dir.path()), vec![17, 21, 25]);
    }

    #[test]
    fn half_installed_and_unrelated_folders_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("java").join("temurin-21")).unwrap();
        fs::create_dir_all(dir.path().join("java").join(".install-abc")).unwrap();
        fs::create_dir_all(dir.path().join("java").join("temurin-")).unwrap();
        fs::create_dir_all(dir.path().join("java").join("temurin-21x")).unwrap();
        fake_jre(dir.path(), "zulu-21", false);
        assert_eq!(find_managed_java(dir.path(), 21), None);
    }

    #[test]
    fn the_macos_bundle_layout_is_understood() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake_jre(dir.path(), "temurin-21", true);
        assert_eq!(java_executable_in(&dir.path().join("java").join("temurin-21")), Some(p));
    }

    #[test]
    fn downloads_are_limited_to_adoptium_and_github_hosts_over_https() {
        let s = Source::adoptium();
        let mut hosts = s.allowed_hosts.clone();
        hosts.sort();
        assert_eq!(hosts, ["api.adoptium.net", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
        assert!(check_host(&s, "https://github.com/adoptium/x.zip").is_ok());
        for bad in ["http://github.com/x", "https://evil.example/x", "https://github.com.evil.example/x", "https://api.adoptium.net.evil.example/", "ftp://github.com/x", "not a url", "file:///C:/x"] {
            assert!(check_host(&s, bad).is_err(), "{bad}");
        }
    }
}

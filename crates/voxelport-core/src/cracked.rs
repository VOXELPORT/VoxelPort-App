//! "Cracked" (offline-mode) servers: let people without a paid Minecraft account join. Ported from `accounts.js`.
//!
//! It is a normal `server.properties` setting, but it removes Minecraft's account check, so anyone can join under any name
//! (an admin's too). That is why `online-mode` is NOT one of the ordinary Settings keys: the only way to change it is the
//! dedicated, confirmed action here, which touches only `online-mode` and `enforce-secure-profile` and leaves every other
//! line as it was. The matching safety net is a one-click login plugin (AuthMe) from Modrinth, installed *before* offline mode
//! is switched on.

use std::fs;
use std::path::Path;

use regex::Regex;
use serde_json::Value;

use crate::addon_registry::{is_icon_url, is_safe_jar_name, register_addon};
use crate::atomic_write;
use crate::net::{Algo, Checksum, Fetcher};
use crate::server_install::MAX_SERVER_JAR_BYTES;

pub const MODRINTH_API: &str = "https://api.modrinth.com/v2";
/// AuthMe ReReloaded, the maintained fork.
pub const LOGIN_PROJECT: &str = "3IEZ9vol";
/// SkinsRestorer: shows each cracked player's own skin.
pub const SKINS_PROJECT: &str = "TsLS8Py5";
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;

fn props_file(dir: &Path) -> Result<std::path::PathBuf, String> {
    if dir.is_absolute() { Ok(dir.join("server.properties")) } else { Err("Invalid server folder.".into()) }
}

/// True when the server lets in players without an account check (`online-mode=false`).
pub fn is_cracked(dir: &Path) -> bool {
    let Ok(file) = props_file(dir) else { return false };
    let Ok(text) = fs::read_to_string(file) else { return false };
    for raw in text.split('\n') {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("online-mode") {
            if let Some(v) = rest.trim_start().strip_prefix('=') {
                return v.trim().eq_ignore_ascii_case("false");
            }
        }
    }
    false // Minecraft's default is on
}

/// Turns cracked mode on or off. Rewrites only the two keys (adding them if missing); the rest of the file, including
/// comments and line endings, is preserved.
pub fn set_cracked(dir: &Path, cracked: bool) -> Result<(), String> {
    let file = props_file(dir)?;
    let value = if cracked { "false" } else { "true" };
    let text = fs::read_to_string(&file).unwrap_or_default();
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = if text.is_empty() { Vec::new() } else { text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect() };
    if lines.last().is_some_and(String::is_empty) {
        lines.pop(); // trailing newline
    }
    let mut seen = [false; 2];
    const KEYS: [&str; 2] = ["online-mode", "enforce-secure-profile"];
    for line in lines.iter_mut() {
        for (i, key) in KEYS.iter().enumerate() {
            if line.strip_prefix(key).is_some_and(|r| r.trim_start().starts_with('=')) {
                *line = format!("{key}={value}");
                seen[i] = true;
            }
        }
    }
    for (i, key) in KEYS.iter().enumerate() {
        if !seen[i] {
            lines.push(format!("{key}={value}"));
        }
    }
    atomic_write(&file, (lines.join(nl) + nl).as_bytes()).map_err(|e| e.to_string())
}

/// Checks a change coming from the page: enabling cracked mode needs an explicit confirmation.
pub fn validate_accounts_change(change: &Value) -> Result<bool, String> {
    let Some(cracked) = change["cracked"].as_bool() else { return Err("Invalid setting.".into()) };
    if cracked && change["confirmed"] != true {
        return Err("Confirm that you understand anyone can join under any name before turning this on.".into());
    }
    Ok(cracked)
}

fn has_jar(dir: &Path, prefix: &str) -> bool {
    let re = Regex::new(&format!(r"(?i)^{prefix}[\w.+-]*\.jar$")).unwrap();
    fs::read_dir(dir.join("plugins")).is_ok_and(|d| d.flatten().any(|e| re.is_match(&e.file_name().to_string_lossy())))
}

pub fn has_login_plugin(dir: &Path) -> bool {
    has_jar(dir, "authme")
}

pub fn has_skins_plugin(dir: &Path) -> bool {
    has_jar(dir, "skinsrestorer")
}

/// What the cracked-server install needs from the network: the client (HTTPS to the allow-listed hosts) and the API root.
pub struct Modrinth<'a> {
    pub fetcher: &'a Fetcher,
    pub api: &'a str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PluginDownload {
    pub url: String,
    pub file_name: String,
    pub checksum: Checksum,
}

/// The Paper-compatible download of a Modrinth plugin for this Minecraft version. The newest release is preferred; a file
/// without a SHA-512, or with an unsafe name, is refused.
pub fn resolve_plugin(m: &Modrinth, project: &str, name: &str, mc_version: &str) -> Result<PluginDownload, String> {
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let url = format!("{}/project/{project}/version?loaders={}&game_versions={}", m.api, enc("[\"paper\",\"spigot\",\"bukkit\"]"), enc(&serde_json::to_string(&[mc_version]).unwrap()));
    let versions = m.fetcher.fetch_json(&url, MAX_JSON_BYTES)?;
    let list: Vec<&Value> = versions.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let pick = list.iter().copied().find(|v| v["version_type"] == "release").or_else(|| list.first().copied()).ok_or_else(|| format!("{name} isn't available for Minecraft {mc_version} yet."))?;
    let files = pick["files"].as_array().cloned().unwrap_or_default();
    let file = files.iter().find(|f| f["primary"] == true).or_else(|| files.first()).ok_or_else(|| format!("No usable {name} download."))?;
    let (sha512, filename, link) = (file["hashes"]["sha512"].as_str().unwrap_or(""), file["filename"].as_str().unwrap_or(""), file["url"].as_str().unwrap_or(""));
    if sha512.is_empty() || !is_safe_jar_name(filename) || link.is_empty() {
        return Err(format!("No usable {name} download."));
    }
    Ok(PluginDownload { url: link.into(), file_name: filename.into(), checksum: Checksum { algo: Algo::Sha512, expected: sha512.into() } })
}

fn install_plugin_jar(m: &Modrinth, dir: &Path, server_type: &str, resolved: &PluginDownload, family: &str, project: &str, title: &str, on_stage: &dyn Fn(&str, Option<&str>)) -> Result<String, String> {
    if server_type != "paper" {
        return Err("This plugin needs a Paper server.".into());
    }
    if !dir.is_absolute() {
        return Err("Invalid server folder.".into());
    }
    let plugins = dir.join("plugins");
    fs::create_dir_all(&plugins).map_err(|e| e.to_string())?;
    on_stage("download", Some(&resolved.file_name));
    let keep = resolved.file_name.clone();
    m.fetcher.download(&resolved.url, &plugins.join(&keep), MAX_SERVER_JAR_BYTES, Some(&resolved.checksum), 0, &|_, _| {})?;
    let re = Regex::new(&format!(r"(?i)^{family}[\w.+-]*\.jar$")).unwrap();
    for e in fs::read_dir(&plugins).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name != keep && re.is_match(&name) {
            let _ = fs::remove_file(e.path());
        }
    }
    // Record it where "Installed" looks, so it shows in the Plugins screen and Remove knows it is VoxelPort's. The icon is a
    // nicety: if Modrinth does not answer, the plugin is still listed.
    let icon = m.fetcher.fetch_json(&format!("{}/project/{project}", m.api), MAX_JSON_BYTES).ok().and_then(|v| v["icon_url"].as_str().filter(|i| is_icon_url(i)).map(str::to_string)).unwrap_or_default();
    let _ = register_addon(dir, project, title, &keep, "plugins", &icon);
    Ok(keep)
}

/// Installs AuthMe into `plugins/` (Paper only), replacing an older copy.
pub fn install_login_plugin(m: &Modrinth, dir: &Path, server_type: &str, version: &str, on_stage: &dyn Fn(&str, Option<&str>)) -> Result<String, String> {
    if server_type != "paper" {
        return Err("The login plugin needs a Paper server.".into());
    }
    on_stage("resolve", None);
    let resolved = resolve_plugin(m, LOGIN_PROJECT, "AuthMe", version)?;
    let file = install_plugin_jar(m, dir, server_type, &resolved, "authme", LOGIN_PROJECT, "AuthMe", on_stage)?;
    on_stage("done", None);
    Ok(file)
}

/// Installs SkinsRestorer into `plugins/` (Paper only), so cracked players show their own skin instead of all being Steve.
pub fn install_skins_plugin(m: &Modrinth, dir: &Path, server_type: &str, version: &str, on_stage: &dyn Fn(&str, Option<&str>)) -> Result<String, String> {
    if server_type != "paper" {
        return Err("The skins plugin needs a Paper server.".into());
    }
    on_stage("resolve", None);
    let resolved = resolve_plugin(m, SKINS_PROJECT, "SkinsRestorer", version)?;
    let file = install_plugin_jar(m, dir, server_type, &resolved, "skinsrestorer", SKINS_PROJECT, "SkinsRestorer", on_stage)?;
    on_stage("done", None);
    Ok(file)
}

#[derive(Debug, PartialEq)]
pub struct CrackedSetup {
    pub cracked: bool,
    pub skins: bool,
    pub warnings: Vec<String>,
}

/// Sets a new Paper server up for cracked players: a login plugin first, then offline mode, then skins. The order is the
/// safety rule: offline mode with no login plugin lets anyone join as the owner and `/op` themselves, so `online-mode` is
/// switched off ONLY once AuthMe is really on disk. If AuthMe cannot be installed the server stays in normal (account-checked)
/// mode. Skins are a nicety and never block. A download problem is a warning, never an error.
pub fn set_up_cracked_server(m: &Modrinth, dir: &Path, server_type: &str, version: &str, on_stage: &dyn Fn(&str, Option<&str>)) -> CrackedSetup {
    let mut warnings = Vec::new();
    let login = install_login_plugin(m, dir, server_type, version, on_stage).and_then(|_| if has_login_plugin(dir) { set_cracked(dir, true) } else { Err("the login plugin did not end up in plugins/".into()) });
    if let Err(e) = login {
        warnings.push(format!("Cracked mode was NOT turned on, because the login plugin couldn't be installed ({e}). Your server still needs a paid Minecraft account to join. You can try again in Settings."));
        return CrackedSetup { cracked: false, skins: false, warnings };
    }
    let skins = match install_skins_plugin(m, dir, server_type, version, on_stage) {
        Ok(_) => true,
        Err(e) => {
            warnings.push(format!("Skins couldn't be added ({e}). Cracked players will all look like Steve or Alex."));
            false
        }
    };
    CrackedSetup { cracked: true, skins, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn props(d: &Path, t: &str) {
        fs::write(d.join("server.properties"), t).unwrap();
    }
    fn read(d: &Path) -> String {
        fs::read_to_string(d.join("server.properties")).unwrap()
    }

    #[test]
    fn a_fresh_or_missing_server_is_premium_only() {
        let d = tmp();
        assert!(!is_cracked(d.path()));
        props(d.path(), "online-mode=true\n");
        assert!(!is_cracked(d.path()));
        props(d.path(), "motd=Hi\n");
        assert!(!is_cracked(d.path()), "key absent: Minecraft defaults to on");
        props(d.path(), "online-mode = FALSE\n");
        assert!(is_cracked(d.path()));
        assert!(!is_cracked(Path::new("relative")));
    }

    #[test]
    fn flipping_it_changes_only_the_two_keys_and_flips_back_exactly() {
        let d = tmp();
        let original = "#Minecraft server properties\n#Mon Oct 12\nmotd=My \\u00e9 SMP\nonline-mode=true\nmax-players=20\ncustom-plugin-key=keep\nenforce-secure-profile=true\n";
        props(d.path(), original);
        set_cracked(d.path(), true).unwrap();
        assert!(is_cracked(d.path()));
        assert_eq!(read(d.path()), original.replace("online-mode=true", "online-mode=false").replace("enforce-secure-profile=true", "enforce-secure-profile=false"));
        set_cracked(d.path(), false).unwrap();
        assert_eq!(read(d.path()), original, "exactly back to how it was");
    }

    #[test]
    fn missing_keys_are_added_crlf_is_kept_and_a_missing_file_is_created() {
        let d = tmp();
        props(d.path(), "motd=Hi\r\nmax-players=5\r\n");
        set_cracked(d.path(), true).unwrap();
        assert_eq!(read(d.path()), "motd=Hi\r\nmax-players=5\r\nonline-mode=false\r\nenforce-secure-profile=false\r\n");
        let fresh = tmp();
        set_cracked(fresh.path(), true).unwrap();
        assert!(is_cracked(fresh.path()));
        assert_eq!(set_cracked(Path::new("relative/dir"), true).unwrap_err(), "Invalid server folder.");
    }

    #[test]
    fn turning_it_on_needs_an_explicit_confirmation_and_turning_it_off_does_not() {
        use serde_json::json;
        assert!(validate_accounts_change(&json!({ "cracked": true })).unwrap_err().contains("Confirm"));
        assert!(validate_accounts_change(&json!({ "cracked": true, "confirmed": "yes" })).unwrap_err().contains("Confirm"));
        assert_eq!(validate_accounts_change(&json!({ "cracked": true, "confirmed": true })), Ok(true));
        assert_eq!(validate_accounts_change(&json!({ "cracked": false })), Ok(false));
        assert!(validate_accounts_change(&json!({ "cracked": "true", "confirmed": true })).unwrap_err().contains("Invalid"));
        assert!(validate_accounts_change(&Value::Null).unwrap_err().contains("Invalid"));
    }

    #[test]
    fn the_ordinary_settings_paths_still_cannot_change_online_mode() {
        use crate::server_install::update_server_properties_safely;
        use crate::settings::validate_settings;
        use serde_json::json;
        assert!(validate_settings(&json!({ "online-mode": false })).unwrap_err().contains("can't be changed"));
        let d = tmp();
        props(d.path(), "online-mode=true\n");
        update_server_properties_safely(d.path(), &[("online-mode".into(), "false".into()), ("enforce-secure-profile".into(), "false".into())]).unwrap();
        assert!(!is_cracked(d.path()));
    }

    #[test]
    fn plugin_jars_are_recognised_by_name() {
        let d = tmp();
        assert!(!has_login_plugin(d.path()));
        fs::create_dir(d.path().join("plugins")).unwrap();
        fs::write(d.path().join("plugins").join("AuthMe-5.7.0.jar"), "x").unwrap();
        fs::write(d.path().join("plugins").join("SkinsRestorer.jar"), "x").unwrap();
        fs::write(d.path().join("plugins").join("NotAuthMe.jar"), "x").unwrap();
        assert!(has_login_plugin(d.path()) && has_skins_plugin(d.path()));
    }
}

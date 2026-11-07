//! The record of add-ons (plugins and mods) VoxelPort itself put in a server folder, `voxelport-addons.json`, so the Plugins
//! screen can list them and Remove only ever touches files VoxelPort installed. Ported from the registry part of
//! `addons.js`. Installing from Modrinth is in `addons.rs`; the cracked-server setup uses `register_addon` here as well.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::atomic_write;

const REGISTRY: &str = "voxelport-addons.json";

/// `[\w.+-]{1,120}\.jar` with ASCII `\w`, as a plain check.
pub fn is_safe_jar_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".jar") else { return false };
    (1..=120).contains(&stem.len()) && stem.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-')) && name.len() <= 124
}

pub fn is_project_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// An icon address is only ever Modrinth's own image host over https, with no credentials or odd ports.
pub fn is_icon_url(value: &str) -> bool {
    if value.len() > 300 {
        return false;
    }
    url::Url::parse(value).is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("cdn.modrinth.com") && u.username().is_empty() && u.password().is_none() && u.port().is_none())
}

fn check_dir(dir: &Path) -> Result<(), String> {
    if dir.is_absolute() { Ok(()) } else { Err("Invalid server folder.".into()) }
}

/// The add-ons VoxelPort installed that are still in the folder, as `{ id, title, file, dir, icon? }`.
pub fn installed_addons(server_dir: &Path) -> Result<Vec<Value>, String> {
    check_dir(server_dir)?;
    let Some(Value::Array(list)) = fs::read_to_string(server_dir.join(REGISTRY)).ok().and_then(|t| serde_json::from_str(&t).ok()) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for a in list {
        let (id, file, dir) = (a["id"].as_str().unwrap_or(""), a["file"].as_str().unwrap_or(""), a["dir"].as_str().unwrap_or(""));
        if !is_project_id(id) || !is_safe_jar_name(file) || !matches!(dir, "plugins" | "mods") || !server_dir.join(dir).join(file).exists() {
            continue;
        }
        let mut entry = json!({ "id": id, "title": a["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(id), "file": file, "dir": dir });
        if let Some(icon) = a["icon"].as_str().filter(|i| is_icon_url(i)) {
            entry["icon"] = json!(icon);
        }
        out.push(entry);
    }
    Ok(out)
}

pub fn save(server_dir: &Path, list: &[Value]) -> Result<(), String> {
    atomic_write(&server_dir.join(REGISTRY), serde_json::to_string_pretty(list).unwrap().as_bytes()).map_err(|e| e.to_string())
}

/// Records a plugin VoxelPort put in the folder by another route (the login and skins plugins of a cracked server), so it
/// shows under "Installed". Replaces an earlier entry for the same project. `icon` is an optional Modrinth icon address.
pub fn register_addon(server_dir: &Path, project_id: &str, title: &str, file: &str, dir: &str, icon: &str) -> Result<(), String> {
    check_dir(server_dir)?;
    if !is_project_id(project_id) {
        return Err("Invalid project.".into());
    }
    if !is_safe_jar_name(file) || !matches!(dir, "plugins" | "mods") {
        return Err("Invalid add-on entry.".into());
    }
    let mut entry = json!({ "id": project_id, "title": if title.is_empty() { project_id.to_string() } else { title.chars().take(100).collect::<String>() }, "file": file, "dir": dir });
    if is_icon_url(icon) {
        entry["icon"] = json!(icon);
    }
    let mut list: Vec<Value> = installed_addons(server_dir)?.into_iter().filter(|a| a["id"] != project_id).collect();
    list.push(entry);
    save(server_dir, &list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jar_names_and_icon_addresses_are_checked() {
        for ok in ["AuthMe-5.7.0.jar", "a.jar", "Skins_Restorer+1.jar"] {
            assert!(is_safe_jar_name(ok), "{ok}");
        }
        for bad in ["../evil.jar", "a/b.jar", ".jar", "x.zip", "has space.jar", &format!("{}.jar", "a".repeat(121))] {
            assert!(!is_safe_jar_name(bad), "{bad}");
        }
        assert!(is_icon_url("https://cdn.modrinth.com/data/x/icon.png"));
        for bad in ["http://cdn.modrinth.com/x.png", "https://evil.example/x.png", "https://cdn.modrinth.com.evil.example/x.png", "https://user:pw@cdn.modrinth.com/x", "https://cdn.modrinth.com:8443/x", "javascript:1"] {
            assert!(!is_icon_url(bad), "{bad}");
        }
    }

    #[test]
    fn a_registered_plugin_is_listed_only_while_its_file_exists() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("plugins")).unwrap();
        std::fs::write(d.path().join("plugins").join("AuthMe.jar"), "x").unwrap();
        register_addon(d.path(), "3IEZ9vol", "AuthMe", "AuthMe.jar", "plugins", "https://cdn.modrinth.com/i.png").unwrap();
        let list = installed_addons(d.path()).unwrap();
        assert_eq!(list, vec![json!({ "id": "3IEZ9vol", "title": "AuthMe", "file": "AuthMe.jar", "dir": "plugins", "icon": "https://cdn.modrinth.com/i.png" })]);
        std::fs::remove_file(d.path().join("plugins").join("AuthMe.jar")).unwrap();
        assert!(installed_addons(d.path()).unwrap().is_empty());
    }

    #[test]
    fn registering_again_replaces_the_entry_and_bad_input_is_refused() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("plugins")).unwrap();
        for f in ["A-1.jar", "A-2.jar"] {
            std::fs::write(d.path().join("plugins").join(f), "x").unwrap();
        }
        register_addon(d.path(), "3IEZ9vol", "AuthMe", "A-1.jar", "plugins", "").unwrap();
        register_addon(d.path(), "3IEZ9vol", "AuthMe", "A-2.jar", "plugins", "https://evil.example/x.png").unwrap();
        let list = installed_addons(d.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["file"], "A-2.jar");
        assert!(list[0].get("icon").is_none(), "a foreign icon address is dropped");
        assert!(register_addon(d.path(), "short", "x", "A-1.jar", "plugins", "").is_err());
        assert!(register_addon(d.path(), "3IEZ9vol", "x", "../A.jar", "plugins", "").is_err());
        assert!(register_addon(d.path(), "3IEZ9vol", "x", "A-1.jar", "elsewhere", "").is_err());
        assert!(register_addon(Path::new("rel"), "3IEZ9vol", "x", "A-1.jar", "plugins", "").is_err());
    }

    #[test]
    fn a_damaged_or_hostile_registry_lists_nothing() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(REGISTRY), "{ nope").unwrap();
        assert!(installed_addons(d.path()).unwrap().is_empty());
        std::fs::write(d.path().join(REGISTRY), json!([{ "id": "3IEZ9vol", "file": "../../x.jar", "dir": "plugins" }, { "id": "bad", "file": "a.jar", "dir": "plugins" }]).to_string()).unwrap();
        assert!(installed_addons(d.path()).unwrap().is_empty());
    }
}

//! Bringing a person's data over from the previous (Electron) VoxelPort app, once, on their say-so.
//!
//! The Electron app keeps its files in `%APPDATA%\voxelport-app`. The device token in there is what ties a person to their public address, custom
//! name and supporter perks, and it is stored the way Electron's `safeStorage` stores it on Windows (Chromium's `os_crypt`): an AES-256 key kept in
//! `Local State`, itself protected by Windows DPAPI for the signed-in user, and the token as `"v10" + 12-byte nonce + AES-GCM ciphertext and tag`.
//! This module reads that format (one way: nothing in the old app's folder is ever written, moved or deleted) and copies across what the new
//! build keeps in the same shape:
//!
//! * the **device token** (so the address, name and perks carry over),
//! * the **server list** (by reference: the server folders themselves stay where they are),
//! * the **backups** of those servers (hard-linked when the disk allows, so they take no extra space, otherwise copied),
//! * the **region and Discord-presence preferences**, the **custom address** cache and the **Bedrock address** cache.
//!
//! What it deliberately does not bring: the Discord sign-in session (signing in again is one click and keeps the new app's own login), the managed
//! Java (fetched again when a server needs it), and the old app's Discord-gate record.
//!
//! The decryption of the key itself needs Windows, so the shell supplies it ([`KeyUnprotect`]); everything else is plain and tested here.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::identity::{is_valid_token, short_id};
use crate::{atomic_write, backups, profiles};

const MAX_SMALL_FILE: u64 = 2 * 1024 * 1024;
const MAX_BACKUP_FILES_PER_SERVER: usize = 5_000;
const MAX_SERVERS: usize = 200;

/// Windows DPAPI for the current user, with no extra entropy (what Chromium uses for its `os_crypt` key). Supplied by the shell.
pub trait KeyUnprotect: Send + Sync {
    fn unprotect(&self, blob: &[u8]) -> Option<Vec<u8>>;
}

// ─── Chromium's os_crypt, read one way ──────────────────────────────────────

fn read_small(file: &Path) -> Option<String> {
    if fs::metadata(file).ok()?.len() > MAX_SMALL_FILE {
        return None;
    }
    fs::read_to_string(file).ok()
}

/// The AES key from the old app's `Local State` (`os_crypt.encrypted_key`: base64 of `"DPAPI"` and the DPAPI-protected key), or None.
pub fn os_crypt_key(legacy: &Path, unprotect: &dyn KeyUnprotect) -> Option<[u8; 32]> {
    let doc: Value = serde_json::from_str(&read_small(&legacy.join("Local State"))?).ok()?;
    let blob = B64.decode(doc["os_crypt"]["encrypted_key"].as_str()?).ok()?;
    let key = unprotect.unprotect(blob.strip_prefix(b"DPAPI".as_slice())?)?;
    key.try_into().ok()
}

/// `"v10" + nonce(12) + ciphertext + tag(16)` opened with the key, or None for anything else (including a damaged or tampered value).
pub fn decrypt_os_crypt(key: &[u8; 32], data: &[u8]) -> Option<Vec<u8>> {
    let rest = data.strip_prefix(b"v10".as_slice())?;
    if rest.len() < 12 + 16 {
        return None;
    }
    Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&rest[..12]), &rest[12..]).ok()
}

/// The inverse, for tests and fixtures only: nothing in the app writes this format.
pub fn encrypt_os_crypt(key: &[u8; 32], nonce: [u8; 12], plain: &[u8]) -> Vec<u8> {
    let sealed = Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(&nonce), plain).expect("encryption cannot fail for these sizes");
    let mut out = b"v10".to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    out
}

// ─── The device token ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum TokenRead {
    /// The old app's device token, valid.
    Found(String),
    /// The old app has no token file.
    Missing,
    /// There is one, but it cannot be read here (the key could not be opened, the value is damaged, or it is not a token).
    Unreadable,
}

pub fn read_token(legacy: &Path, unprotect: &dyn KeyUnprotect) -> TokenRead {
    let file = legacy.join("device-token.json");
    if !file.exists() {
        return TokenRead::Missing;
    }
    let Some(record) = read_small(&file).and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object) else { return TokenRead::Unreadable };
    let token = if let Some(enc) = record["enc"].as_str().filter(|s| !s.is_empty()) {
        os_crypt_key(legacy, unprotect)
            .and_then(|key| decrypt_os_crypt(&key, &B64.decode(enc).ok()?))
            .and_then(|plain| String::from_utf8(plain).ok())
    } else {
        record["token"].as_str().map(str::to_string)
    };
    match token.filter(|t| is_valid_token(t)) {
        Some(t) => TokenRead::Found(t),
        None => TokenRead::Unreadable,
    }
}

// ─── What is there (for the screen: counts, names and a short ID, never the token) ──────

fn is_profile_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn legacy_profiles(legacy: &Path) -> Vec<Value> {
    let Some(doc) = read_small(&legacy.join(profiles::FILE)).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return Vec::new() };
    // Ids are UUIDs (the app made them); anything else is not ours and is never used to name a folder.
    doc["servers"].as_array().map(|a| a.iter().filter(|p| profiles::is_valid(p) && p["id"].as_str().is_some_and(is_profile_id)).take(MAX_SERVERS).cloned().collect()).unwrap_or_default()
}

/// Backup files of one server in the old app's folder: only names this app made, only regular files.
fn legacy_backup_files(legacy: &Path, id: &str) -> Vec<(PathBuf, u64)> {
    if !is_profile_id(id) {
        return Vec::new();
    }
    let Ok(read) = fs::read_dir(legacy.join("backups").join(id)) else { return Vec::new() };
    read.flatten()
        .filter(|e| backups::parse_backup_name(&e.file_name().to_string_lossy()).is_some())
        .filter_map(|e| {
            let m = fs::symlink_metadata(e.path()).ok().filter(|m| m.is_file())?;
            Some((e.path(), m.len()))
        })
        .take(MAX_BACKUP_FILES_PER_SERVER)
        .collect()
}

/// What importing would do, for the screen: only counts, names and the short VoxelPort ID. The old token is opened in memory to make that ID and
/// to compare it with this PC's; it is not part of the answer.
pub fn summarize(legacy: &Path, data_dir: &Path, current_token: &str, unprotect: &dyn KeyUnprotect) -> Value {
    let token = read_token(legacy, unprotect);
    let (identity, vp_id) = match &token {
        TokenRead::Found(t) if t == current_token => ("same", Some(short_id(t))),
        TokenRead::Found(t) => ("new", Some(short_id(t))),
        TokenRead::Missing => ("none", None),
        TokenRead::Unreadable => ("unreadable", None),
    };
    let have = profiles::list(data_dir);
    let mut servers = Vec::new();
    let (mut backup_files, mut backup_bytes, mut inside_old_folder, mut new_servers) = (0usize, 0u64, 0usize, 0usize);
    for p in legacy_profiles(legacy) {
        let dir = p["serverDir"].as_str().unwrap_or_default();
        let id = p["id"].as_str().unwrap_or_default();
        let present = have.iter().any(|h| h["id"] == p["id"] || h["serverDir"].as_str().is_some_and(|d| d.eq_ignore_ascii_case(dir)));
        let folder_exists = Path::new(dir).is_dir();
        let inside = same_prefix(dir, legacy);
        if !present && folder_exists {
            new_servers += 1;
            inside_old_folder += usize::from(inside);
            for (_, size) in legacy_backup_files(legacy, id) {
                backup_files += 1;
                backup_bytes += size;
            }
        }
        servers.push(json!({ "name": p["name"], "type": p["type"], "version": p["version"], "folderExists": folder_exists, "alreadyHere": present }));
    }
    json!({
        "identity": identity,
        "vpId": vp_id,
        "servers": servers,
        "newServers": new_servers,
        "insideOldFolder": inside_old_folder,
        "backupFiles": backup_files,
        "backupBytes": backup_bytes,
    })
}

fn same_prefix(path: &str, root: &Path) -> bool {
    let (p, r): (Vec<_>, Vec<_>) = (
        Path::new(path).components().map(|c| c.as_os_str().to_ascii_lowercase()).collect(),
        root.components().map(|c| c.as_os_str().to_ascii_lowercase()).collect(),
    );
    p.len() > r.len() && p[..r.len()] == r[..]
}

// ─── Bringing it over ───────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, PartialEq)]
pub struct FilesReport {
    pub servers_added: usize,
    pub servers_already_here: usize,
    pub servers_folder_missing: usize,
    pub servers_inside_old_folder: usize,
    pub backups_linked: usize,
    pub backups_copied: usize,
    pub backups_already_here: usize,
    pub preferences: bool,
    pub custom_address: bool,
    pub endpoints: usize,
}

impl FilesReport {
    pub fn to_json(&self) -> Value {
        json!({
            "serversAdded": self.servers_added, "serversAlreadyHere": self.servers_already_here, "serversFolderMissing": self.servers_folder_missing,
            "serversInsideOldFolder": self.servers_inside_old_folder,
            "backupsLinked": self.backups_linked, "backupsCopied": self.backups_copied, "backupsAlreadyHere": self.backups_already_here,
            "preferences": self.preferences, "customAddress": self.custom_address, "endpoints": self.endpoints,
        })
    }
}

/// A hard link when the disk allows (no extra space, instant), otherwise a copy. Never replaces a file that is already there.
fn link_or_copy(from: &Path, to: &Path) -> Result<bool, String> {
    if to.exists() {
        return Err("exists".into());
    }
    if fs::hard_link(from, to).is_ok() {
        return Ok(true);
    }
    let tmp = to.with_extension("zip.partial");
    let result = fs::copy(from, &tmp).and_then(|_| fs::rename(&tmp, to));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map(|()| false).map_err(|e| e.to_string())
}

fn read_json_object(file: &Path) -> Option<Map<String, Value>> {
    read_small(file).and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned())
}

/// Copies the server list, backups, preferences, custom address and Bedrock address cache across. Additive only: whatever the new app
/// already has wins, and the old app's folder is only ever read. `identity_carried` says whether the old device token is now this app's
/// (the Bedrock address cache is keyed by it, so it is only worth copying then).
pub fn import_files(legacy: &Path, data_dir: &Path, identity_carried: bool) -> Result<FilesReport, String> {
    let mut report = FilesReport::default();
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;

    // Servers, then each one's backups.
    for p in legacy_profiles(legacy) {
        let dir = p["serverDir"].as_str().unwrap_or_default();
        if !Path::new(dir).is_dir() {
            report.servers_folder_missing += 1;
            continue;
        }
        let id = p["id"].as_str().unwrap_or_default();
        if profiles::add_existing(data_dir, &p)? {
            report.servers_added += 1;
            report.servers_inside_old_folder += usize::from(same_prefix(dir, legacy));
        } else {
            report.servers_already_here += 1;
            // Listed under another id (a server the person made here in the same folder): not the same server, so its backups stay behind.
            // Listed under this id (an earlier import): carry on, so a backup that did not make it across the first time does now.
            if profiles::get(data_dir, id).is_none() {
                continue;
            }
        }
        let files = legacy_backup_files(legacy, id);
        if files.is_empty() {
            continue;
        }
        let target = data_dir.join("backups").join(id);
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        for (from, _) in files {
            let Some(name) = from.file_name() else { continue };
            match link_or_copy(&from, &target.join(name)) {
                Ok(true) => report.backups_linked += 1,
                Ok(false) => report.backups_copied += 1,
                Err(e) if e == "exists" => report.backups_already_here += 1,
                Err(e) => return Err(format!("Could not bring a backup over: {e}")),
            }
        }
    }

    // Preferences: only the two this app keeps, and only where the new app has not chosen yet.
    if let Some(old) = read_json_object(&legacy.join("preferences.json")) {
        let mut mine = read_json_object(&data_dir.join("preferences.json")).unwrap_or_default();
        let mut changed = false;
        if !mine.contains_key("region") {
            if let Some(r) = old.get("region").and_then(Value::as_str).filter(|r| matches!(*r, "auto" | "in" | "eu")) {
                mine.insert("region".into(), json!(r));
                changed = true;
            }
        }
        if !mine.contains_key("presence") {
            if let Some(b) = old.get("presence").and_then(Value::as_bool) {
                mine.insert("presence".into(), json!(b));
                changed = true;
            }
        }
        if changed {
            atomic_write(&data_dir.join("preferences.json"), Value::Object(mine).to_string().as_bytes()).map_err(|e| e.to_string())?;
            report.preferences = true;
        }
    }

    // The custom address cache (the relay holds the real one; this is what the screen shows before a tunnel is up).
    let mine_has_name = read_json_object(&data_dir.join("custom-address.json")).is_some_and(|m| m.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty()));
    if identity_carried && !mine_has_name {
        if let Some(old) = read_json_object(&legacy.join("custom-address.json")) {
            let name = old.get("name").and_then(Value::as_str).filter(|n| (3..=20).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
            let address = old.get("address").and_then(Value::as_str).filter(|a| crate::bedrock_endpoint::valid_host(a));
            if let (Some(name), Some(address)) = (name, address) {
                let region = old.get("region").and_then(Value::as_str).filter(|r| matches!(*r, "in" | "eu")).unwrap_or("in");
                atomic_write(&data_dir.join("custom-address.json"), json!({ "name": name, "address": address, "region": region }).to_string().as_bytes()).map_err(|e| e.to_string())?;
                report.custom_address = true;
            }
        }
    }

    // The Bedrock address cache: keys include the device token, so they only match when the token came across.
    if identity_carried {
        if let Some(old) = read_json_object(&legacy.join("bedrock-endpoints.json")) {
            let mut mine = read_json_object(&data_dir.join("bedrock-endpoints.json")).unwrap_or_default();
            let known: HashSet<String> = mine.keys().cloned().collect();
            for (key, value) in old.into_iter().take(1000) {
                let ok = key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()) && value["publicHost"].as_str().is_some_and(crate::bedrock_endpoint::valid_host) && value["publicPort"].as_u64().is_some_and(|p| (1..=65535).contains(&p));
                if ok && !known.contains(&key) {
                    mine.insert(key, json!({ "publicHost": value["publicHost"], "publicPort": value["publicPort"] }));
                    report.endpoints += 1;
                }
            }
            if report.endpoints > 0 {
                atomic_write(&data_dir.join("bedrock-endpoints.json"), serde_json::to_string_pretty(&Value::Object(mine)).unwrap().as_bytes()).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DPAPI stand-in: the "protected" key is the key itself, so the reader's own logic is what is tested.
    struct Plain;
    impl KeyUnprotect for Plain {
        fn unprotect(&self, blob: &[u8]) -> Option<Vec<u8>> {
            Some(blob.to_vec())
        }
    }
    struct Refuses;
    impl KeyUnprotect for Refuses {
        fn unprotect(&self, _: &[u8]) -> Option<Vec<u8>> {
            None
        }
    }

    const KEY: [u8; 32] = [7u8; 32];
    const TOKEN: &str = "vp_ABCDEFGHIJKLMNOPQRSTUVWX";
    const OTHER: &str = "vp_zyxwvutsrqponmlkjihgfedcb";

    /// An old app folder as Electron leaves it: a protected key in `Local State` and a token sealed with it.
    fn electron_folder(token: &str) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let mut key_blob = b"DPAPI".to_vec();
        key_blob.extend_from_slice(&KEY);
        fs::write(d.path().join("Local State"), json!({ "os_crypt": { "encrypted_key": B64.encode(key_blob) } }).to_string()).unwrap();
        let sealed = encrypt_os_crypt(&KEY, [3u8; 12], token.as_bytes());
        fs::write(d.path().join("device-token.json"), json!({ "enc": B64.encode(sealed) }).to_string()).unwrap();
        d
    }

    #[test]
    fn a_token_sealed_the_way_electron_does_it_is_read_back() {
        let d = electron_folder(TOKEN);
        assert_eq!(read_token(d.path(), &Plain), TokenRead::Found(TOKEN.into()));
    }

    #[test]
    fn plaintext_tokens_missing_files_and_everything_unreadable_are_told_apart() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_token(d.path(), &Plain), TokenRead::Missing);
        fs::write(d.path().join("device-token.json"), json!({ "token": TOKEN }).to_string()).unwrap();
        assert_eq!(read_token(d.path(), &Plain), TokenRead::Found(TOKEN.into()), "an old plaintext record");
        fs::write(d.path().join("device-token.json"), json!({ "token": "nonsense" }).to_string()).unwrap();
        assert_eq!(read_token(d.path(), &Plain), TokenRead::Unreadable, "not a token");
        fs::write(d.path().join("device-token.json"), "{ broken").unwrap();
        assert_eq!(read_token(d.path(), &Plain), TokenRead::Unreadable);

        let e = electron_folder(TOKEN);
        assert_eq!(read_token(e.path(), &Refuses), TokenRead::Unreadable, "DPAPI refusing the key (another Windows user)");
        fs::remove_file(e.path().join("Local State")).unwrap();
        assert_eq!(read_token(e.path(), &Plain), TokenRead::Unreadable, "no key file");
    }

    #[test]
    fn a_tampered_or_wrongly_keyed_value_is_never_accepted() {
        let sealed = encrypt_os_crypt(&KEY, [1u8; 12], TOKEN.as_bytes());
        assert_eq!(decrypt_os_crypt(&KEY, &sealed).as_deref(), Some(TOKEN.as_bytes()));
        assert!(decrypt_os_crypt(&[8u8; 32], &sealed).is_none(), "wrong key");
        let mut flipped = sealed.clone();
        *flipped.last_mut().unwrap() ^= 1;
        assert!(decrypt_os_crypt(&KEY, &flipped).is_none(), "a changed byte");
        assert!(decrypt_os_crypt(&KEY, b"v11xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").is_none(), "another version prefix");
        assert!(decrypt_os_crypt(&KEY, b"v10short").is_none() && decrypt_os_crypt(&KEY, b"").is_none());
        // A key that is not 32 bytes is no key.
        let d = electron_folder(TOKEN);
        struct Short;
        impl KeyUnprotect for Short {
            fn unprotect(&self, _: &[u8]) -> Option<Vec<u8>> {
                Some(vec![1, 2, 3])
            }
        }
        assert!(os_crypt_key(d.path(), &Short).is_none());
    }

    /// An old app with two servers (one with backups, one whose folder is gone) and settings.
    fn full_old_app(servers_root: &Path) -> tempfile::TempDir {
        let d = electron_folder(TOKEN);
        let (a, b) = (servers_root.join("survival"), servers_root.join("gone"));
        fs::create_dir_all(&a).unwrap();
        let id_a = "11111111-1111-4111-8111-111111111111";
        let profile = |id: &str, name: &str, dir: &Path| json!({ "id": id, "name": name, "type": "paper", "version": "1.21.4", "serverDir": dir.to_string_lossy(), "port": 25565, "minRamMb": 1024, "maxRamMb": 2048, "createdAt": "2026-01-01T00:00:00.000Z", "lastUsedAt": "2026-02-01T00:00:00.000Z", "bedrock": true });
        fs::write(d.path().join("server-profiles.json"), json!({ "version": 2, "servers": [profile(id_a, "Survival", &a), profile("22222222-2222-4222-8222-222222222222", "Gone", &b), { "id": "bad" }] }).to_string()).unwrap();
        let bk = d.path().join("backups").join(id_a);
        fs::create_dir_all(&bk).unwrap();
        fs::write(bk.join("2026-01-02_03-04-05_manual.zip"), b"zip one").unwrap();
        fs::write(bk.join("2026-01-03_03-04-05_auto.zip"), b"zip two").unwrap();
        fs::write(bk.join("notes.txt"), b"not a backup").unwrap();
        fs::write(d.path().join("preferences.json"), json!({ "region": "eu", "presence": false, "theme": "light", "other": 1 }).to_string()).unwrap();
        fs::write(d.path().join("custom-address.json"), json!({ "name": "mycraft", "address": "mycraft.voxelport.in", "region": "eu" }).to_string()).unwrap();
        let key = "0".repeat(64);
        fs::write(d.path().join("bedrock-endpoints.json"), json!({ key.clone(): { "publicHost": "play.voxelport.in", "publicPort": 26335 }, "short": { "publicHost": "x.y", "publicPort": 1 }, "1".repeat(64): { "publicHost": "bad host!", "publicPort": 1 } }).to_string()).unwrap();
        d
    }

    #[test]
    fn the_screen_is_told_what_would_come_over_without_any_secret() {
        let servers = tempfile::tempdir().unwrap();
        let old = full_old_app(servers.path());
        let data = tempfile::tempdir().unwrap();
        let s = summarize(old.path(), data.path(), "vp_currentcurrentcurrentcurrent", &Plain);
        assert_eq!((s["identity"].clone(), s["vpId"].clone()), (json!("new"), json!(short_id(TOKEN))));
        assert_eq!((s["newServers"].clone(), s["backupFiles"].clone(), s["backupBytes"].clone()), (json!(1), json!(2), json!(14)));
        assert_eq!(s["servers"].as_array().unwrap().len(), 2, "the broken entry is not listed");
        assert!(!s.to_string().contains(TOKEN), "the token itself never reaches the screen");
        assert_eq!(summarize(old.path(), data.path(), TOKEN, &Plain)["identity"], "same");
        assert_eq!(summarize(old.path(), data.path(), "x", &Refuses)["identity"], "unreadable");
    }

    #[test]
    fn importing_brings_servers_backups_and_settings_and_leaves_the_old_folder_untouched() {
        let servers = tempfile::tempdir().unwrap();
        let old = full_old_app(servers.path());
        let before: Vec<_> = walk(old.path());
        let data = tempfile::tempdir().unwrap();
        let r = import_files(old.path(), data.path(), true).unwrap();
        assert_eq!((r.servers_added, r.servers_folder_missing, r.servers_already_here), (1, 1, 0));
        assert_eq!(r.backups_linked + r.backups_copied, 2);
        assert!(r.preferences && r.custom_address);
        assert_eq!(r.endpoints, 1, "only the well-formed cache entry");

        let list = profiles::list(data.path());
        assert_eq!(list.len(), 1);
        assert_eq!((list[0]["id"].clone(), list[0]["name"].clone(), list[0]["bedrock"].clone()), (json!("11111111-1111-4111-8111-111111111111"), json!("Survival"), json!(true)));
        let bk = data.path().join("backups").join("11111111-1111-4111-8111-111111111111");
        assert_eq!(fs::read(bk.join("2026-01-02_03-04-05_manual.zip")).unwrap(), b"zip one");
        assert!(!bk.join("notes.txt").exists(), "only files this app made");
        let prefs: Value = serde_json::from_str(&fs::read_to_string(data.path().join("preferences.json")).unwrap()).unwrap();
        assert_eq!(prefs, json!({ "region": "eu", "presence": false }), "only the two it keeps");
        let addr: Value = serde_json::from_str(&fs::read_to_string(data.path().join("custom-address.json")).unwrap()).unwrap();
        assert_eq!(addr, json!({ "name": "mycraft", "address": "mycraft.voxelport.in", "region": "eu" }));
        // Nothing in the old folder changed.
        assert_eq!(walk(old.path()), before);
    }

    fn walk(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        fn go(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for e in fs::read_dir(dir).unwrap().flatten() {
                if e.path().is_dir() {
                    go(root, &e.path(), out);
                } else {
                    out.push((e.path().strip_prefix(root).unwrap().to_string_lossy().into_owned(), fs::read(e.path()).unwrap()));
                }
            }
        }
        go(dir, dir, &mut out);
        out.sort();
        out
    }

    #[test]
    fn what_the_new_app_already_has_wins_and_a_second_import_adds_nothing() {
        let servers = tempfile::tempdir().unwrap();
        let old = full_old_app(servers.path());
        let data = tempfile::tempdir().unwrap();
        fs::write(data.path().join("preferences.json"), json!({ "region": "in", "extra": true }).to_string()).unwrap();
        fs::write(data.path().join("custom-address.json"), json!({ "name": "already", "address": "already.voxelport.in", "region": "in" }).to_string()).unwrap();
        let first = import_files(old.path(), data.path(), true).unwrap();
        let prefs: Value = serde_json::from_str(&fs::read_to_string(data.path().join("preferences.json")).unwrap()).unwrap();
        assert_eq!((prefs["region"].clone(), prefs["presence"].clone(), prefs["extra"].clone()), (json!("in"), json!(false), json!(true)), "the new app's region wins, its extra key stays, the missing one is filled");
        assert!(!first.custom_address, "an address already chosen here is never replaced");
        assert!(fs::read_to_string(data.path().join("custom-address.json")).unwrap().contains("already"));
        let second = import_files(old.path(), data.path(), true).unwrap();
        assert_eq!((second.servers_added, second.servers_already_here, second.backups_already_here, second.endpoints), (0, 1, 2, 0));
        assert_eq!(profiles::list(data.path()).len(), 1);
    }

    #[test]
    fn without_the_identity_the_address_caches_are_left_behind() {
        let servers = tempfile::tempdir().unwrap();
        let old = full_old_app(servers.path());
        let data = tempfile::tempdir().unwrap();
        let r = import_files(old.path(), data.path(), false).unwrap();
        assert!(!r.custom_address && r.endpoints == 0, "they belong to the old device token");
        assert!(!data.path().join("custom-address.json").exists() && !data.path().join("bedrock-endpoints.json").exists());
        assert_eq!(r.servers_added, 1, "the servers still come");
    }

    #[test]
    fn hostile_names_in_the_old_files_cannot_reach_outside_the_folders() {
        let servers = tempfile::tempdir().unwrap();
        let old = electron_folder(TOKEN);
        let dir = servers.path().join("s");
        fs::create_dir_all(&dir).unwrap();
        let evil_id = "../../../escape-me-escape-me-escape00";
        let profile = json!({ "id": evil_id, "name": "Evil", "type": "paper", "version": "1.21.4", "serverDir": dir.to_string_lossy(), "port": 25565, "minRamMb": 1024, "maxRamMb": 2048 });
        fs::write(old.path().join("server-profiles.json"), json!({ "version": 2, "servers": [profile] }).to_string()).unwrap();
        fs::create_dir_all(old.path().join("backups")).unwrap();
        fs::write(old.path().join("backups").join("2026-01-02_03-04-05_manual.zip"), "x").unwrap();
        let data = tempfile::tempdir().unwrap();
        let r = import_files(old.path(), data.path(), true).unwrap();
        assert_eq!((r.servers_added, r.backups_linked + r.backups_copied), (0, 0), "an id that is not a UUID is not ours: nothing comes of it");
        assert!(!servers.path().parent().unwrap().join("escape-me-escape-me-escape00").exists());
    }

    #[test]
    fn a_folder_that_holds_no_old_data_is_simply_empty() {
        let old = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let s = summarize(old.path(), data.path(), TOKEN, &Plain);
        assert_eq!((s["identity"].clone(), s["newServers"].clone()), (json!("none"), json!(0)));
        assert_eq!(import_files(old.path(), data.path(), false).unwrap(), FilesReport::default());
    }
}

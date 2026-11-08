//! Backups and restores of a Bedrock Dedicated Server's world, on real folders. A Bedrock world lives in `worlds/<level-name>` (the name
//! may hold spaces); a Java server's backups and a Bedrock server's are never mixed up.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use voxelport_core::backups::*;

struct S {
    _dir: tempfile::TempDir,
    server: PathBuf,
    backups: PathBuf,
}

fn bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

/// A scratch folder with a Bedrock server in it: a world of two db files, the level file, and the two config files.
fn fake(level: &str) -> S {
    let dir = tempfile::tempdir().unwrap();
    let (server, backups) = (dir.path().join("server"), dir.path().join("backups"));
    let world = server.join("worlds").join(level);
    fs::create_dir_all(world.join("db")).unwrap();
    fs::write(server.join("server.properties"), format!("server-name=Test\nlevel-name={level}\nserver-port=19132\n")).unwrap();
    fs::write(world.join("level.dat"), bytes(2000, 1)).unwrap();
    fs::write(world.join("db").join("000003.log"), bytes(5000, 2)).unwrap();
    fs::write(world.join("db").join("CURRENT"), "MANIFEST-000002\n").unwrap();
    fs::write(server.join("allowlist.json"), "[{\"name\":\"Steve\"}]").unwrap();
    fs::write(server.join("permissions.json"), "[]").unwrap();
    fs::write(server.join("bedrock_server.exe"), "the program").unwrap();
    S { _dir: dir, server, backups }
}

fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
    Utc.epoch_ms_of(Parts { y, mo, d, h, mi, s })
}

fn info() -> BackupInfo {
    BackupInfo { server_type: Some("bedrock-server".into()), version: Some("1.26.63.1".into()), app_version: Some("2.0.0".into()) }
}

fn make(s: &S, reason: &str, now_ms: i64, lengths: Vec<(String, u64)>) -> Result<Created, BackupError> {
    create_backup_bedrock(&BedrockCreateOptions { backup_dir: &s.backups, server_dir: &s.server, reason, info: info(), now_ms, levels: None, lengths }, &|_| {})
}

fn restore(s: &S, name: &str, now_ms: i64) -> Result<Restored, BackupError> {
    restore_backup_bedrock(&RestoreOptions { backup_dir: &s.backups, server_dir: &s.server, name, info: info(), now_ms, max_entries: MAX_ENTRIES }, &|_| {})
}

fn entries(zip: &Path) -> Vec<String> {
    read_backup_info(zip, MAX_ENTRIES).unwrap().entries
}

#[test]
fn a_backup_holds_the_world_and_the_two_config_files_and_nothing_else() {
    let s = fake("Bedrock level");
    let made = make(&s, "manual", at(2026, 11, 8, 12, 0, 0), Vec::new()).unwrap();
    assert_eq!(made.worlds, vec!["Bedrock level".to_string()]);
    let got = entries(&s.backups.join(&made.name));
    for expected in ["voxelport-backup.json", "worlds/Bedrock level/level.dat", "worlds/Bedrock level/db/000003.log", "worlds/Bedrock level/db/CURRENT", "allowlist.json", "permissions.json"] {
        assert!(got.contains(&expected.to_string()), "{expected} in {got:?}");
    }
    assert!(!got.iter().any(|e| e.contains("server.properties") || e.contains("bedrock_server.exe")), "{got:?}");
    let meta = read_backup_info(&s.backups.join(&made.name), MAX_ENTRIES).unwrap().meta;
    assert_eq!((meta["layout"].clone(), meta["levelName"].clone(), meta["serverType"].clone()), ("bedrock".into(), "Bedrock level".into(), "bedrock-server".into()));
    // It shows up in the shared list like any other.
    assert_eq!(list_backups(&s.backups).len(), 1);
}

#[test]
fn a_running_servers_reported_lengths_cut_the_files_to_what_belongs_to_the_save() {
    let s = fake("Bedrock level");
    // The log grew after `save query` said it was 3000 bytes long: only 3000 belong to the saved world.
    let made = make(&s, "manual", at(2026, 11, 8, 12, 0, 0), vec![("Bedrock level/db/000003.log".into(), 3000)]).unwrap();
    let dest = tempfile::tempdir().unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(s.backups.join(&made.name)).unwrap()).unwrap();
    assert_eq!(zip.by_name("worlds/Bedrock level/db/000003.log").unwrap().size(), 3000);
    assert_eq!(zip.by_name("worlds/Bedrock level/level.dat").unwrap().size(), 2000, "files the server did not list are kept whole");
    drop(dest);
}

#[test]
fn a_restore_puts_the_old_world_back_after_saving_the_current_one() {
    let s = fake("Bedrock level");
    let made = make(&s, "manual", at(2026, 11, 8, 12, 0, 0), Vec::new()).unwrap();
    let world = s.server.join("worlds").join("Bedrock level");
    fs::write(world.join("level.dat"), "damaged since").unwrap();
    fs::write(world.join("db").join("new.ldb"), "built since").unwrap();
    fs::write(s.server.join("allowlist.json"), "[]").unwrap();

    let r = restore(&s, &made.name, at(2026, 11, 8, 13, 0, 0)).unwrap();
    assert_eq!((r.level_name.as_str(), r.previous_level_name.as_str()), ("Bedrock level", "Bedrock level"));
    assert_eq!(fs::read(world.join("level.dat")).unwrap(), bytes(2000, 1));
    assert!(!world.join("db").join("new.ldb").exists());
    assert_eq!(fs::read_to_string(s.server.join("allowlist.json")).unwrap(), "[{\"name\":\"Steve\"}]");
    // What was there is saved first, so the restore can be undone.
    let safety = r.safety_backup.expect("a before-restore copy");
    let kept = tempfile::tempdir().unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(s.backups.join(&safety)).unwrap()).unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("worlds/Bedrock level/level.dat").unwrap(), &mut text).unwrap();
    assert_eq!(text, "damaged since");
    drop(kept);
    // No scratch folders are left in the server folder.
    let left: Vec<String> = fs::read_dir(&s.server).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(".vp-")).collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn restoring_a_backup_of_another_world_switches_the_level_name() {
    let s = fake("Old world");
    let made = make(&s, "manual", at(2026, 11, 8, 12, 0, 0), Vec::new()).unwrap();
    // The server now uses a different world.
    fs::remove_dir_all(s.server.join("worlds").join("Old world")).unwrap();
    let other = s.server.join("worlds").join("Second");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("level.dat"), "second").unwrap();
    fs::write(s.server.join("server.properties"), "level-name=Second\n").unwrap();

    let r = restore(&s, &made.name, at(2026, 11, 8, 13, 0, 0)).unwrap();
    assert_eq!((r.level_name.as_str(), r.previous_level_name.as_str()), ("Old world", "Second"));
    assert!(s.server.join("worlds").join("Old world").join("level.dat").is_file());
    assert!(!s.server.join("worlds").join("Second").exists() || fs::read(s.server.join("worlds").join("Second").join("level.dat")).unwrap() == b"second", "the other world is saved, not silently lost");
    let safety = r.safety_backup.unwrap();
    assert!(entries(&s.backups.join(safety)).contains(&"worlds/Second/level.dat".to_string()));
}

#[test]
fn a_server_with_no_world_yet_says_so() {
    let s = fake("Bedrock level");
    fs::remove_dir_all(s.server.join("worlds")).unwrap();
    let e = make(&s, "manual", at(2026, 11, 8, 12, 0, 0), Vec::new()).unwrap_err();
    assert_eq!(e.code, "no-world");
    assert!(list_backups(&s.backups).is_empty(), "no half-written file is left behind");
    assert!(fs::read_dir(&s.backups).map(|d| d.count() == 0).unwrap_or(true));
}

#[test]
fn a_java_backup_and_a_bedrock_one_are_refused_by_the_wrong_kind_of_server() {
    let s = fake("Bedrock level");
    let bedrock = make(&s, "manual", at(2026, 11, 8, 12, 0, 0), Vec::new()).unwrap();
    // A Java backup made in the same backups folder.
    let java = tempfile::tempdir().unwrap();
    fs::create_dir_all(java.path().join("world")).unwrap();
    fs::write(java.path().join("server.properties"), "level-name=world\n").unwrap();
    fs::write(java.path().join("world").join("level.dat"), "j").unwrap();
    let j = create_backup(&CreateOptions { backup_dir: &s.backups, server_dir: java.path(), reason: "manual", info: BackupInfo::default(), now_ms: at(2026, 11, 8, 12, 5, 0), worlds: None, level_names: None }, &|_| {}).unwrap();

    assert_eq!(restore(&s, &j.name, at(2026, 11, 8, 14, 0, 0)).unwrap_err().code, "wrong-kind");
    let on_java = restore_backup(&RestoreOptions { backup_dir: &s.backups, server_dir: java.path(), name: &bedrock.name, info: BackupInfo::default(), now_ms: at(2026, 11, 8, 14, 0, 0), max_entries: MAX_ENTRIES }, &|_| {});
    assert_eq!(on_java.unwrap_err().code, "wrong-kind");
    // Nothing was touched by either refusal, and no "before restore" copy was made.
    assert_eq!(fs::read(java.path().join("world").join("level.dat")).unwrap(), b"j");
    assert_eq!(list_backups(&s.backups).iter().filter(|b| b.reason == "before-restore").count(), 0);
}

/// A zip made by hand, to show what a damaged or hostile backup does.
fn hand_zip(path: &Path, meta: serde_json::Value, files: &[(&str, &[u8])]) {
    let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let opts = zip::write::SimpleFileOptions::default();
    zip.start_file(META_NAME, opts).unwrap();
    zip.write_all(meta.to_string().as_bytes()).unwrap();
    for (name, body) in files {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn a_backup_that_holds_anything_but_its_world_is_not_used() {
    let s = fake("Bedrock level");
    fs::create_dir_all(&s.backups).unwrap();
    let meta = |extra: serde_json::Value| {
        let mut m = serde_json::json!({ "format": 1, "layout": "bedrock", "createdAt": "2026-11-08T12:00:00.000Z", "reason": "manual", "levelName": "Bedrock level", "worlds": ["Bedrock level"], "serverFiles": [] });
        for (k, v) in extra.as_object().unwrap() {
            m[k] = v.clone();
        }
        m
    };
    let world: &[(&str, &[u8])] = &[("worlds/Bedrock level/level.dat", b"x")];
    for (label, m, stray) in [
        ("a server file", meta(serde_json::json!({})), Some(("server.properties", &b"evil"[..]))),
        ("the program", meta(serde_json::json!({})), Some(("bedrock_server.exe", &b"evil"[..]))),
        ("another world", meta(serde_json::json!({})), Some(("worlds/Other/level.dat", &b"x"[..]))),
        ("a way out", meta(serde_json::json!({})), Some(("worlds/Bedrock level/../../x", &b"x"[..]))),
        ("a path as the name", meta(serde_json::json!({ "levelName": "../x", "worlds": ["../x"] })), None),
        ("two worlds in a plain backup", meta(serde_json::json!({ "worlds": ["Bedrock level", "Other"] })), None),
        ("server files", meta(serde_json::json!({ "serverFiles": ["server.jar"] })), None),
        ("a newer format", meta(serde_json::json!({ "format": 2 })), None),
    ] {
        let name = format!("2026-11-08_12-00-0{}_manual.zip", label.len() % 10);
        let mut files: Vec<(&str, &[u8])> = world.to_vec();
        files.extend(stray);
        hand_zip(&s.backups.join(&name), m, &files);
        let before = fs::read(s.server.join("worlds").join("Bedrock level").join("level.dat")).unwrap();
        assert!(restore(&s, &name, at(2026, 11, 8, 13, 0, 0)).is_err(), "{label}");
        assert_eq!(fs::read(s.server.join("worlds").join("Bedrock level").join("level.dat")).unwrap(), before, "{label}: the world is untouched");
        fs::remove_file(s.backups.join(&name)).unwrap();
    }
}

#[test]
fn level_names_with_spaces_are_fine_and_paths_are_not() {
    let s = fake("My Pocket World");
    assert_eq!(bedrock_level_name_of(&s.server), "My Pocket World");
    assert!(bedrock_world_exists(&s.server, "My Pocket World"));
    fs::write(s.server.join("server.properties"), "level-name=../../escape\n").unwrap();
    assert_eq!(bedrock_level_name_of(&s.server), "Bedrock level", "a path is never a level name");
    assert!(!bedrock_world_exists(&s.server, "../x") && !bedrock_world_exists(&s.server, "a/b"));
    fs::remove_file(s.server.join("server.properties")).unwrap();
    assert_eq!(bedrock_level_name_of(&s.server), "Bedrock level");
}

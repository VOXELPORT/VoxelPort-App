//! Backups and restores on real folders. Ported from Electron's `backups.test.js`. Where that suite broke `fs` on purpose to
//! make something fail, these tests make it fail the way it would for a person: a file another program holds open, a read-only
//! file, a damaged zip.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use voxelport_core::backups::*;

struct S {
    _dir: tempfile::TempDir,
    server: PathBuf,
    backups: PathBuf,
}

fn bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}
fn sha(p: &Path) -> String {
    Sha256::digest(fs::read(p).unwrap()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A scratch folder with a fake server in it: a world with a Nether and some region files.
fn fake(level: &str, nether: bool) -> S {
    let dir = tempfile::tempdir().unwrap();
    let (server, backups) = (dir.path().join("server"), dir.path().join("backups"));
    fs::create_dir_all(server.join(level).join("region")).unwrap();
    fs::write(server.join("server.properties"), format!("motd=Test\nlevel-name={level}\nserver-port=25565\n")).unwrap();
    fs::write(server.join(level).join("level.dat"), bytes(2000, 1)).unwrap();
    fs::write(server.join(level).join("region").join("r.0.0.mca"), bytes(50_000, 2)).unwrap();
    fs::write(server.join(level).join("region").join("r.0.1.mca"), bytes(30_000, 3)).unwrap();
    fs::write(server.join(level).join("session.lock"), "held by the running server").unwrap();
    if nether {
        fs::create_dir_all(server.join(format!("{level}_nether")).join("DIM-1")).unwrap();
        fs::write(server.join(format!("{level}_nether")).join("level.dat"), bytes(500, 4)).unwrap();
    }
    fs::write(server.join("ops.json"), "[{\"name\":\"Steve\"}]").unwrap();
    fs::write(server.join("server.jar"), "server executable").unwrap();
    fs::create_dir_all(server.join("plugins")).unwrap();
    fs::write(server.join("plugins").join("keep.yml"), "a plugin file").unwrap();
    S { _dir: dir, server, backups }
}

fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
    Utc.epoch_ms_of(Parts { y, mo, d, h, mi, s })
}

fn make_at(s: &S, reason: &str, now_ms: i64) -> Result<Created, BackupError> {
    create_backup(&CreateOptions { backup_dir: &s.backups, server_dir: &s.server, reason, info: BackupInfo::default(), now_ms, worlds: None, level_names: None }, &|_| {})
}
fn make(s: &S) -> Created {
    make_at(s, "manual", at(2026, 10, 16, 10, 0, 0)).unwrap()
}
fn restore(s: &S, name: &str) -> Result<Restored, BackupError> {
    restore_with(s, name, MAX_ENTRIES)
}
fn restore_with(s: &S, name: &str, max_entries: usize) -> Result<Restored, BackupError> {
    // Each restore gets its own second, so its safety copy never shares a name with an earlier one.
    static NEXT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    restore_backup(&RestoreOptions { backup_dir: &s.backups, server_dir: &s.server, name, info: BackupInfo::default(), now_ms: at(2027, 1, 1, 0, 0, 0) + n * 1000, max_entries }, &|_| {})
}

fn zip_names(file: &Path) -> Vec<String> {
    let mut z = zip::ZipArchive::new(fs::File::open(file).unwrap()).unwrap();
    (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect()
}
fn left_over(server: &Path) -> Vec<String> {
    fs::read_dir(server).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(".vp-")).collect()
}
fn names(dir: &Path) -> Vec<String> {
    list_backups(dir).into_iter().map(|b| b.name).collect()
}

/// A zip with exactly these entries (name, bytes), written by hand so a test can build a trap.
fn craft(path: &Path, entries: &[(&str, &[u8])]) {
    let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (n, d) in entries {
        w.start_file(*n, o).unwrap();
        w.write_all(d).unwrap();
    }
    w.finish().unwrap();
}
fn meta(extra: Value) -> Vec<u8> {
    let mut m = json!({ "format": 1, "createdAt": "x", "reason": "manual", "levelName": "world", "worlds": ["world"] });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    m.to_string().into_bytes()
}

/// A read-only file: copying over it fails, the way a locked or protected file would.
fn make_readonly(p: &Path) {
    let mut perm = fs::metadata(p).unwrap().permissions();
    perm.set_readonly(true);
    fs::set_permissions(p, perm).unwrap();
}
fn make_writable(p: &Path) {
    let mut perm = fs::metadata(p).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perm.set_readonly(false);
    fs::set_permissions(p, perm).unwrap();
}

// ─── Making a backup ─────────────────────────────────────────────────────────

#[test]
fn a_backup_holds_the_world_the_nether_the_jar_and_the_player_lists() {
    let s = fake("world", true);
    let b = make(&s);
    let n = zip_names(&s.backups.join(&b.name));
    for want in ["world/level.dat", "world/region/r.0.0.mca", "world_nether/level.dat", "ops.json", META_NAME, "server.jar"] {
        assert!(n.iter().any(|x| x == want), "{want} in {n:?}");
    }
    assert!(!n.iter().any(|x| x.contains("session.lock")), "the lock the server holds is never saved");
    assert!(!n.iter().any(|x| x.starts_with("plugins/")), "plugins are not included");
    let mut worlds = b.worlds.clone();
    worlds.sort();
    assert_eq!(worlds, ["world", "world_nether"]);
    assert!(b.size > 0);
}

#[test]
fn restoring_includes_the_original_jar_and_the_safety_backup_can_undo_the_jar_change() {
    let s = fake("world", true);
    let jar = s.server.join("server.jar");
    fs::write(&jar, "original server executable").unwrap();
    let b = make(&s);
    let info = read_backup_info(&s.backups.join(&b.name), MAX_ENTRIES).unwrap();
    assert_eq!(info.meta["serverFiles"], json!(["server.jar"]));
    fs::write(&jar, "updated server executable").unwrap();
    let r = restore(&s, &b.name).unwrap();
    assert_eq!(fs::read_to_string(&jar).unwrap(), "original server executable");
    restore(&s, r.safety_backup.as_ref().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(&jar).unwrap(), "updated server executable");
}

#[test]
fn a_world_only_backup_leaves_the_installed_jar_alone() {
    let s = fake("world", true);
    let jar = s.server.join("server.jar");
    fs::remove_file(&jar).unwrap();
    let b = make(&s);
    fs::write(&jar, "keep this installed executable").unwrap();
    restore(&s, &b.name).unwrap();
    assert_eq!(fs::read_to_string(&jar).unwrap(), "keep this installed executable");
}

#[test]
fn a_jar_that_cannot_be_replaced_rolls_back_the_world_and_the_jar() {
    let s = fake("world", true);
    let b = make(&s);
    let jar = s.server.join("server.jar");
    let region = s.server.join("world").join("region").join("r.0.0.mca");
    fs::write(&jar, "current jar").unwrap();
    fs::write(&region, "current world").unwrap();
    make_readonly(&jar); // copying the backup's jar over it fails
    let err = restore(&s, &b.name).unwrap_err();
    make_writable(&jar);
    assert_eq!(err.code, "failed");
    assert!(err.message.contains("restore failed"), "{err}");
    assert_eq!(fs::read_to_string(&jar).unwrap(), "current jar");
    assert_eq!(fs::read_to_string(&region).unwrap(), "current world");
    assert!(left_over(&s.server).is_empty());
}

#[test]
fn backups_are_named_by_time_and_reason_and_listed_newest_first() {
    let s = fake("world", true);
    let early = make_at(&s, "auto", at(2026, 10, 16, 10, 0, 0)).unwrap();
    let late = make_at(&s, "manual", at(2026, 10, 16, 11, 30, 5)).unwrap();
    assert_eq!((early.name.as_str(), late.name.as_str()), ("2026-10-16_10-00-00_auto.zip", "2026-10-16_11-30-05_manual.zip"));
    let list = list_backups(&s.backups);
    assert_eq!(list.iter().map(|b| b.name.clone()).collect::<Vec<_>>(), [late.name.clone(), early.name.clone()]);
    assert_eq!(list.iter().map(|b| b.reason).collect::<Vec<_>>(), ["manual", "auto"]);
    assert_eq!(list[0].created_at, at(2026, 10, 16, 11, 30, 5));
}

#[test]
fn two_backups_in_the_same_second_do_not_overwrite_each_other() {
    let s = fake("world", true);
    let when = at(2026, 1, 2, 3, 4, 5);
    let a = make_at(&s, "manual", when).unwrap();
    let b = make_at(&s, "manual", when).unwrap();
    assert_ne!(a.name, b.name);
    assert_eq!(list_backups(&s.backups).len(), 2);
}

#[test]
fn the_metadata_records_what_the_backup_is() {
    let s = fake("world", true);
    let b = create_backup(&CreateOptions { backup_dir: &s.backups, server_dir: &s.server, reason: "stop", info: BackupInfo { server_type: Some("paper".into()), version: Some("1.21.11".into()), app_version: Some("1.8.0".into()) }, now_ms: at(2026, 10, 16, 10, 0, 0), worlds: None, level_names: None }, &|_| {}).unwrap();
    let m = read_backup_info(&s.backups.join(&b.name), MAX_ENTRIES).unwrap().meta;
    assert_eq!((m["levelName"].clone(), m["reason"].clone(), m["serverType"].clone(), m["version"].clone(), m["appVersion"].clone()), (json!("world"), json!("stop"), json!("paper"), json!("1.21.11"), json!("1.8.0")));
    assert_eq!(m["createdAt"], "2026-10-16T10:00:00.000Z");
}

#[test]
fn a_world_with_another_name_is_found_and_a_path_or_reserved_name_is_ignored() {
    let s = fake("Survival World", false);
    assert_eq!(make(&s).worlds, ["Survival World"]);
    let t = fake("world", true);
    for bad in ["../../secrets", "", "plugins", "Mods", ".hidden", "a/b", "con:x"] {
        fs::write(t.server.join("server.properties"), format!("level-name={bad}\n")).unwrap();
        assert_eq!(level_name_of(&t.server), "world", "{bad:?}");
    }
}

#[test]
fn with_no_world_yet_it_says_so_plainly_and_leaves_nothing_behind() {
    let s = fake("world", true);
    fs::remove_dir_all(s.server.join("world")).unwrap();
    fs::remove_dir_all(s.server.join("world_nether")).unwrap();
    let e = make_at(&s, "manual", at(2026, 1, 1, 0, 0, 0)).unwrap_err();
    assert_eq!(e.code, "no-world");
    assert!(e.message.to_lowercase().contains("start the server once"));
    assert!(!s.backups.exists() || fs::read_dir(&s.backups).unwrap().next().is_none());
}

/// Holds a file open so nothing else can read it: a program that has it locked.
#[cfg(windows)]
fn lock_file(p: &Path, share: u32) -> fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new().read(true).share_mode(share).open(p).unwrap()
}

#[cfg(windows)]
#[test]
fn a_file_that_cannot_be_read_fails_the_backup_and_leaves_no_half_written_file() {
    let s = fake("world", true);
    let _held = lock_file(&s.server.join("world").join("region").join("r.0.1.mca"), 0);
    let e = make_at(&s, "manual", at(2026, 1, 1, 0, 0, 0)).unwrap_err();
    assert_eq!(e.code, "failed");
    assert!(fs::read_dir(&s.backups).unwrap().next().is_none(), "no .partial, no zip");
}

#[test]
fn progress_is_reported_while_zipping_and_finishes_at_100_percent() {
    let s = fake("world", true);
    let seen = std::cell::RefCell::new(Vec::new());
    create_backup(&CreateOptions { backup_dir: &s.backups, server_dir: &s.server, reason: "manual", info: BackupInfo::default(), now_ms: 0, worlds: None, level_names: None }, &|p| seen.borrow_mut().push(p)).unwrap();
    let seen = seen.borrow();
    assert!(seen.len() >= 2 && seen.iter().all(|p| p.phase == "zipping"));
    assert_eq!(seen[0].done, 0);
    assert_eq!(seen.last().unwrap().done, seen.last().unwrap().total);
}

#[test]
fn a_list_of_folders_is_only_for_the_copy_made_before_a_restore() {
    let s = fake("world", true);
    let e = create_backup(&CreateOptions { backup_dir: &s.backups, server_dir: &s.server, reason: "manual", info: BackupInfo::default(), now_ms: 0, worlds: Some(vec!["world".into()]), level_names: None }, &|_| {}).unwrap_err();
    assert_eq!(e.code, "invalid");
    let e = create_backup(&CreateOptions { backup_dir: &s.backups, server_dir: &s.server, reason: "bogus", info: BackupInfo::default(), now_ms: 0, worlds: None, level_names: None }, &|_| {}).unwrap_err();
    assert_eq!(e.message, "Unknown backup reason.");
}

// ─── Restoring ───────────────────────────────────────────────────────────────

#[test]
fn restoring_puts_the_world_back_exactly_even_after_it_was_wrecked() {
    let s = fake("world", true);
    let region = s.server.join("world").join("region").join("r.0.0.mca");
    let before = sha(&region);
    let b = make(&s);
    fs::write(&region, "corrupted by a creeper").unwrap();
    fs::remove_file(s.server.join("world").join("region").join("r.0.1.mca")).unwrap();
    fs::write(s.server.join("world").join("new-junk.txt"), "built after the backup").unwrap();
    fs::write(s.server.join("ops.json"), "[]").unwrap();

    let r = restore(&s, &b.name).unwrap();
    assert_eq!(sha(&region), before);
    assert!(s.server.join("world").join("region").join("r.0.1.mca").exists());
    assert!(!s.server.join("world").join("new-junk.txt").exists(), "what was built after the backup is gone from the world");
    assert_eq!(fs::read_to_string(s.server.join("ops.json")).unwrap(), "[{\"name\":\"Steve\"}]");
    assert_eq!(r.level_name, "world");
    assert!(s.server.join("plugins").join("keep.yml").exists(), "plugins are not touched");
    assert!(s.server.join("server.jar").exists());
}

#[test]
fn before_restoring_the_current_world_is_saved_so_a_restore_can_be_undone() {
    let s = fake("world", true);
    let b = make_at(&s, "manual", at(2026, 10, 1, 8, 0, 0)).unwrap();
    fs::write(s.server.join("world").join("important-new-build.txt"), "two hours of work").unwrap();
    let r = restore(&s, &b.name).unwrap();
    let safety = r.safety_backup.clone().unwrap();
    assert!(safety.ends_with("_before-restore.zip"), "{safety}");
    assert!(!s.server.join("world").join("important-new-build.txt").exists());
    restore(&s, &safety).unwrap();
    assert_eq!(fs::read_to_string(s.server.join("world").join("important-new-build.txt")).unwrap(), "two hours of work");
}

#[test]
fn no_temporary_folders_are_left_after_a_restore() {
    let s = fake("world", true);
    let b = make(&s);
    restore(&s, &b.name).unwrap();
    assert!(left_over(&s.server).is_empty());
}

#[test]
fn restoring_a_backup_that_used_another_world_name_reports_it_so_level_name_can_follow() {
    let s = fake("oldworld", false);
    let b = make(&s);
    fs::remove_dir_all(s.server.join("oldworld")).unwrap();
    fs::create_dir(s.server.join("newworld")).unwrap();
    fs::write(s.server.join("newworld").join("level.dat"), "x").unwrap();
    fs::write(s.server.join("server.properties"), "level-name=newworld\n").unwrap();
    let r = restore(&s, &b.name).unwrap();
    assert_eq!((r.level_name.as_str(), r.previous_level_name.as_str()), ("oldworld", "newworld"));
    assert!(s.server.join("oldworld").join("level.dat").exists());
    assert!(!s.server.join("newworld").exists(), "the other world was moved out of the way (and saved in the safety backup)");
}

#[cfg(windows)]
#[test]
fn if_the_swap_fails_half_way_the_old_world_is_put_back_untouched() {
    let s = fake("world", true);
    let b = make(&s);
    let region = s.server.join("world").join("region").join("r.0.0.mca");
    fs::write(&region, "the world as it is now").unwrap();
    // Readable (so the safety copy works) but a folder holding it cannot be moved: the Nether move fails after the world moved.
    let _held = lock_file(&s.server.join("world_nether").join("level.dat"), 1);
    let e = restore(&s, &b.name).unwrap_err();
    drop(_held);
    assert_eq!(e.code, "failed");
    assert!(e.message.contains("left as it was"), "{e}");
    assert_eq!(fs::read_to_string(&region).unwrap(), "the world as it is now");
    assert!(s.server.join("world_nether").join("level.dat").exists());
    assert!(left_over(&s.server).is_empty());
}

#[test]
fn a_name_that_is_not_one_of_ours_is_refused_including_path_tricks() {
    let s = fake("world", true);
    for bad in ["../../etc/passwd", "x.zip", "2026-10-16_10-00-00_auto.zip/../../x", "..\\..\\x.zip", ""] {
        assert_eq!(restore(&s, bad).unwrap_err().code, "bad-name", "{bad:?}");
        assert_eq!(delete_backup(&s.backups, bad).unwrap_err().code, "bad-name", "{bad:?}");
    }
}

#[test]
fn a_zip_that_is_not_a_backup_or_is_damaged_is_refused_before_anything_is_touched() {
    let s = fake("world", true);
    fs::create_dir_all(&s.backups).unwrap();
    let world_before = sha(&s.server.join("world").join("level.dat"));
    craft(&s.backups.join("2026-01-01_00-00-00_manual.zip"), &[("hello.txt", b"hello")]);
    assert_eq!(restore(&s, "2026-01-01_00-00-00_manual.zip").unwrap_err().code, "not-voxelport");

    let good = make_at(&s, "manual", at(2026, 2, 1, 1, 1, 1)).unwrap();
    let path = s.backups.join(&good.name);
    let all = fs::read(&path).unwrap();
    fs::write(&path, &all[..all.len() / 2]).unwrap();
    assert_eq!(restore(&s, &good.name).unwrap_err().code, "bad-backup");

    assert_eq!(sha(&s.server.join("world").join("level.dat")), world_before, "the world was not touched");
    assert!(left_over(&s.server).is_empty());
}

#[test]
fn a_backup_that_writes_outside_the_server_folder_zip_slip_is_refused() {
    let s = fake("world", true);
    fs::create_dir_all(&s.backups).unwrap();
    let name = "2026-02-02_02-02-02_manual.zip";
    for evil in ["../../evil.txt", "world/../../evil.txt", "..\\..\\evil.txt", "/abs-evil.txt", "C:/evil.txt", "world/a:stream"] {
        craft(&s.backups.join(name), &[(META_NAME, &meta(json!({}))), ("world/level.dat", b"x"), (evil, b"pwned")]);
        let e = restore(&s, name).unwrap_err();
        assert_eq!(e.code, "unsafe", "{evil}: {e}");
        let root = s._dir.path();
        assert!(!root.join("evil.txt").exists() && !s.server.join("evil.txt").exists() && !root.parent().unwrap().join("evil.txt").exists(), "{evil}");
        fs::remove_file(s.backups.join(name)).unwrap();
        for f in fs::read_dir(&s.backups).unwrap().flatten() {
            let _ = fs::remove_file(f.path()); // the safety copies of earlier attempts
        }
    }
    assert!(left_over(&s.server).is_empty());
}

#[test]
fn metadata_that_names_other_folders_like_plugins_cannot_make_a_restore_replace_them() {
    let s = fake("world", true);
    fs::create_dir_all(&s.backups).unwrap();
    let claims: [(&str, Value, &str); 3] = [
        ("2026-06-01_01-01-01_manual.zip", json!({ "levelName": "plugins", "worlds": ["plugins"] }), "plugins/level.dat"),
        ("2026-06-02_01-01-01_manual.zip", json!({ "levelNames": ["plugins"], "worlds": ["world", "plugins"] }), "world/level.dat"),
        ("2026-06-03_01-01-01_before-restore.zip", json!({ "reason": "before-restore", "levelNames": ["plugins", "mods"], "worlds": ["world", "plugins"] }), "world/level.dat"),
    ];
    for (name, extra, entry) in claims {
        craft(&s.backups.join(name), &[(META_NAME, &meta(extra)), (entry, b"x"), ("plugins/evil.jar", b"evil")]);
        assert_eq!(restore(&s, name).unwrap_err().code, "bad-backup", "{name}");
    }
    assert_eq!(fs::read_to_string(s.server.join("plugins").join("keep.yml")).unwrap(), "a plugin file");
    assert!(!s.server.join("plugins").join("evil.jar").exists());
}

#[test]
fn a_backup_holding_a_symbolic_link_is_refused_and_the_current_world_is_left_alone() {
    let s = fake("world", true);
    fs::create_dir_all(&s.backups).unwrap();
    let name = "2026-04-04_04-04-04_manual.zip";
    let mut w = zip::ZipWriter::new(fs::File::create(s.backups.join(name)).unwrap());
    let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file(META_NAME, o).unwrap();
    w.write_all(&meta(json!({}))).unwrap();
    w.start_file("world/level.dat", o).unwrap();
    w.write_all(b"x").unwrap();
    w.add_symlink("world/escape", "/etc/passwd", o).unwrap();
    w.finish().unwrap();
    let before = fs::read(s.server.join("world").join("level.dat")).unwrap();
    assert_eq!(restore(&s, name).unwrap_err().code, "unsafe");
    assert_eq!(fs::read(s.server.join("world").join("level.dat")).unwrap(), before);
    assert!(left_over(&s.server).is_empty(), "no half-unpacked folder left behind");
}

#[test]
fn a_backup_with_more_entries_than_any_world_has_is_refused_and_restores_under_the_limit() {
    let s = fake("world", true);
    fs::create_dir_all(&s.backups).unwrap();
    let name = "2026-05-05_05-05-05_manual.zip";
    craft(&s.backups.join(name), &[(META_NAME, &meta(json!({}))), ("world/level.dat", b"x"), ("world/a", b"1"), ("world/b", b"2"), ("world/c", b"3")]);
    assert_eq!(restore_with(&s, name, 3).unwrap_err().code, "too-big");
    assert!(restore_with(&s, name, 100).is_ok(), "the same backup restores when it is under the limit");
    assert!((100_000..=5_000_000).contains(&MAX_ENTRIES), "high enough for any real world, low enough to stop a trap");
}

// ─── A restore saves everything it is about to move ──────────────────────────

#[test]
fn restoring_one_world_while_the_server_points_at_another_saves_the_current_world_of_both_names() {
    let s = fake("world", false);
    let b = make_at(&s, "manual", at(2026, 10, 1, 8, 0, 0)).unwrap();
    fs::write(s.server.join("world").join("two-hours-of-work.txt"), "the changed world").unwrap();
    fs::write(s.server.join("server.properties"), "level-name=world2\n").unwrap();
    let r = restore(&s, &b.name).unwrap();
    let safety = r.safety_backup.clone().unwrap();
    assert!(safety.ends_with("_before-restore.zip"));
    assert!(!s.server.join("world").join("two-hours-of-work.txt").exists(), "the restore replaced it");
    assert!(zip_names(&s.backups.join(&safety)).contains(&"world/two-hours-of-work.txt".to_string()));
    fs::write(s.server.join("server.properties"), "level-name=world\n").unwrap();
    restore(&s, &safety).unwrap();
    assert_eq!(fs::read_to_string(s.server.join("world").join("two-hours-of-work.txt")).unwrap(), "the changed world");
}

#[test]
fn both_worlds_are_in_the_copy_when_both_exist_and_each_comes_back_from_it() {
    let s = fake("world", false);
    let b = make_at(&s, "manual", at(2026, 10, 1, 8, 0, 0)).unwrap();
    fs::create_dir(s.server.join("creative")).unwrap();
    fs::write(s.server.join("creative").join("level.dat"), "creative world").unwrap();
    fs::write(s.server.join("creative").join("castle.txt"), "a castle").unwrap();
    fs::write(s.server.join("world").join("house.txt"), "a house").unwrap();
    fs::write(s.server.join("server.properties"), "level-name=creative\n").unwrap();
    let r = restore(&s, &b.name).unwrap();
    let safety = r.safety_backup.clone().unwrap();
    let n = zip_names(&s.backups.join(&safety));
    assert!(n.contains(&"creative/castle.txt".to_string()) && n.contains(&"world/house.txt".to_string()), "{n:?}");
    assert!(!s.server.join("creative").exists(), "the other world was moved out of the way");
    restore(&s, &safety).unwrap();
    assert_eq!(fs::read_to_string(s.server.join("world").join("house.txt")).unwrap(), "a house");
    assert_eq!(fs::read_to_string(s.server.join("creative").join("castle.txt")).unwrap(), "a castle", "the second world comes back too");
}

#[test]
fn if_a_restore_fails_after_the_player_lists_were_replaced_they_are_put_back_as_they_were() {
    let s = fake("world", true);
    fs::write(s.server.join("whitelist.json"), "[\"from the backup\"]").unwrap();
    let b = make(&s);
    fs::write(s.server.join("whitelist.json"), "[\"current whitelist\"]").unwrap();
    fs::write(s.server.join("ops.json"), "[\"current ops\"]").unwrap();
    fs::write(s.server.join("banned-ips.json"), "[\"current bans\"]").unwrap();
    make_readonly(&s.server.join("ops.json")); // replacing it fails, after whitelist.json was already replaced
    let e = restore(&s, &b.name).unwrap_err();
    make_writable(&s.server.join("ops.json"));
    assert_eq!(e.code, "failed");
    assert_eq!(fs::read_to_string(s.server.join("whitelist.json")).unwrap(), "[\"current whitelist\"]");
    assert_eq!(fs::read_to_string(s.server.join("ops.json")).unwrap(), "[\"current ops\"]");
    assert_eq!(fs::read_to_string(s.server.join("banned-ips.json")).unwrap(), "[\"current bans\"]");
    assert!(left_over(&s.server).is_empty());
}

// ─── Housekeeping ────────────────────────────────────────────────────────────

fn dummy(dir: &Path, specs: &[(&str, usize)]) {
    fs::create_dir_all(dir).unwrap();
    for (n, size) in specs {
        fs::write(dir.join(n), vec![0u8; *size]).unwrap();
    }
}

#[test]
fn retention_keeps_the_newest_automatic_backups_and_never_touches_manual_ones() {
    let d = tempfile::tempdir().unwrap();
    dummy(d.path(), &[("2026-10-01_10-00-00_manual.zip", 10), ("2026-10-02_10-00-00_auto.zip", 10), ("2026-10-03_10-00-00_auto.zip", 10), ("2026-10-04_10-00-00_stop.zip", 10), ("2026-10-05_10-00-00_auto.zip", 10)]);
    let mut removed = apply_retention(d.path(), 2, AUTO_BUDGET_BYTES);
    removed.sort();
    assert_eq!(removed, ["2026-10-02_10-00-00_auto.zip", "2026-10-03_10-00-00_auto.zip"]);
    assert_eq!(names(d.path()), ["2026-10-05_10-00-00_auto.zip", "2026-10-04_10-00-00_stop.zip", "2026-10-01_10-00-00_manual.zip"]);
}

#[test]
fn retention_also_trims_by_total_size_but_always_keeps_the_newest_two() {
    let d = tempfile::tempdir().unwrap();
    dummy(d.path(), &[("2026-10-01_10-00-00_auto.zip", 400), ("2026-10-02_10-00-00_auto.zip", 400), ("2026-10-03_10-00-00_auto.zip", 400), ("2026-10-04_10-00-00_auto.zip", 400)]);
    apply_retention(d.path(), 10, 900);
    assert_eq!(names(d.path()), ["2026-10-04_10-00-00_auto.zip", "2026-10-03_10-00-00_auto.zip"]);
    apply_retention(d.path(), 10, 1);
    assert_eq!(list_backups(d.path()).len(), 2, "never below the newest two, however small the budget");
}

#[test]
fn only_the_last_three_before_restore_copies_are_kept() {
    let d = tempfile::tempdir().unwrap();
    let specs: Vec<(String, usize)> = (1..=5).map(|n| (format!("2026-10-0{n}_10-00-00_before-restore.zip"), 5)).collect();
    dummy(d.path(), &specs.iter().map(|(n, s)| (n.as_str(), *s)).collect::<Vec<_>>());
    apply_retention(d.path(), 5, AUTO_BUDGET_BYTES);
    assert_eq!(list_backups(d.path()).len(), 3);
    assert_eq!(names(d.path())[2], "2026-10-03_10-00-00_before-restore.zip");
}

#[test]
fn only_our_own_file_names_are_listed() {
    let d = tempfile::tempdir().unwrap();
    dummy(d.path(), &[("notes.txt", 1), ("2026-10-01_10-00-00_auto.zip.partial", 1), ("2026-10-01_10-00-00_oops.zip", 1), ("2026-10-01_10-00-00_auto.zip", 1)]);
    assert_eq!(names(d.path()), ["2026-10-01_10-00-00_auto.zip"]);
    assert!(list_backups(&d.path().join("missing")).is_empty());
}

#[test]
fn deleting_a_backup_removes_just_that_file() {
    let s = fake("world", true);
    let a = make_at(&s, "manual", at(2026, 6, 1, 1, 0, 0)).unwrap();
    let b = make_at(&s, "manual", at(2026, 6, 1, 2, 0, 0)).unwrap();
    delete_backup(&s.backups, &a.name).unwrap();
    assert_eq!(names(&s.backups), [b.name]);
}

// ─── Settings ────────────────────────────────────────────────────────────────

#[test]
fn backup_settings_default_to_on_every_30_minutes_keeping_5() {
    for p in [json!({}), Value::Null] {
        assert_eq!(backup_settings(&p), BackupSettings { auto: true, interval_min: 30, keep: 5 });
    }
}

#[test]
fn stored_settings_are_used_and_out_of_range_ones_fall_back_to_the_defaults() {
    assert_eq!(backup_settings(&json!({ "backups": { "auto": false, "intervalMin": 60, "keep": 10 } })), BackupSettings { auto: false, interval_min: 60, keep: 10 });
    assert_eq!(backup_settings(&json!({ "backups": { "auto": "yes", "intervalMin": 1, "keep": 999 } })), BackupSettings { auto: true, interval_min: 30, keep: 5 });
}

#[test]
fn settings_from_the_screen_are_checked() {
    let ok = validate_backup_settings(&json!({ "auto": false, "intervalMin": "15", "keep": 3 })).unwrap();
    assert_eq!((ok["auto"].clone(), ok["intervalMin"].clone(), ok["keep"].clone()), (json!(false), json!(15), json!(3)));
    assert_eq!(validate_backup_settings(&json!({ "keep": 7 })).unwrap().len(), 1);
    for bad in [json!({ "auto": "yes" }), json!({ "intervalMin": 2 }), json!({ "keep": 0 }), json!({ "keep": 1.5 }), Value::Null] {
        assert!(validate_backup_settings(&bad).is_err(), "{bad}");
    }
    assert_eq!(validate_backup_settings(&json!({ "intervalMin": 2 })).unwrap_err(), "Minutes between backups must be between 5 and 720.");
}

#[test]
fn local_time_names_convert_both_ways_for_any_clock() {
    // A clock that is three hours ahead of UTC: the name shows local time, createdAt is the real moment.
    struct Plus3;
    impl LocalTime for Plus3 {
        fn parts_of(&self, ms: i64) -> Parts { Utc.parts_of(ms + 3 * 3_600_000) }
        fn epoch_ms_of(&self, p: Parts) -> i64 { Utc.epoch_ms_of(p) - 3 * 3_600_000 }
    }
    let real = at(2026, 10, 16, 10, 0, 0);
    let p = Plus3.parts_of(real);
    assert_eq!((p.h, p.d), (13, 16));
    assert_eq!(Plus3.epoch_ms_of(p), real);
    assert_eq!(iso_utc(real), "2026-10-16T10:00:00.000Z");
    assert_eq!(parse_backup_name("2026-10-16_10-00-00_auto.zip"), Some((real, "auto")), "the default reads names as UTC");
    assert_eq!(parse_backup_name("2026-10-16_10-00-00_auto-2.zip").map(|x| x.1), Some("auto"));
    assert_eq!(parse_backup_name("2026-10-16_10-00-00_nope.zip"), None);
}

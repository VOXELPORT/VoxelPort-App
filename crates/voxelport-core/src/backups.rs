//! Server backups. A backup is one `.zip` with the world folders, `server.jar` and the player lists, plus a
//! `voxelport-backup.json` that says what it is. Restoring puts them back, after saving a "before restore" copy of what is
//! there now, so a restore can always be undone. Ported from `backups.js`.
//!
//! This module only deals with files. Telling a running server to save first, the schedule and the screens' wiring live in the
//! shell. Everything here is blocking: call it from a worker thread.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

use crate::settings::read_properties_file;

pub const META_NAME: &str = "voxelport-backup.json";
const FORMAT: i64 = 1;
const REASONS: [&str; 4] = ["auto", "manual", "stop", "before-restore"];
/// The small files worth keeping with the world: who is allowed in, who is an operator.
pub const CONFIG_FILES: [&str; 4] = ["whitelist.json", "ops.json", "banned-players.json", "banned-ips.json"];
const SERVER_JAR: &str = "server.jar";
/// Held open by the running server and recreated on start: never part of a backup.
const SKIP_FILES: [&str; 1] = ["session.lock"];

const MB: u64 = 1024 * 1024;
const GB: u64 = 1024 * MB;
pub const DEFAULTS: (bool, i64, i64) = (true, 30, 5); // auto, intervalMin, keep
pub const INTERVAL_RANGE: (i64, i64) = (5, 720);
pub const KEEP_RANGE: (i64, i64) = (1, 30);
/// Automatic backups of one server never take more than this; the oldest go first (always keeping the newest two).
pub const AUTO_BUDGET_BYTES: u64 = 5 * GB;
const KEEP_BEFORE_RESTORE: usize = 3;
const MAX_RESTORE_BYTES: u64 = 200 * GB;
/// A real world is a few thousand files; a backup with millions of entries is a trap, not a world.
pub const MAX_ENTRIES: usize = 1_000_000;
const MAX_LEVEL_NAMES: usize = 8; // a before-restore copy can hold the worlds of a few level names, never a crowd
const SPARE_BYTES: u64 = 200 * MB; // never fill the disk to the last byte
const MAX_META_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct BackupError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for BackupError {}
fn fail(code: &'static str, message: impl Into<String>) -> BackupError {
    BackupError { code, message: message.into() }
}

// ─── Local time ──────────────────────────────────────────────────────────────

/// A calendar date and time as a wall clock shows it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Parts {
    pub y: i32,
    pub mo: u32,
    pub d: u32,
    pub h: u32,
    pub mi: u32,
    pub s: u32,
}

/// Backup names carry the computer's local time (as in Electron); this converts between that and real time. The shell installs
/// one that knows the Windows time zone; the default reads local time as UTC, which is exact for tests.
pub trait LocalTime: Send + Sync {
    fn parts_of(&self, epoch_ms: i64) -> Parts;
    fn epoch_ms_of(&self, p: Parts) -> i64;
}

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub struct Utc;
impl LocalTime for Utc {
    fn parts_of(&self, ms: i64) -> Parts {
        let secs = ms.div_euclid(1000);
        let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
        let rem = secs.rem_euclid(86_400);
        Parts { y: y as i32, mo: mo as u32, d: d as u32, h: (rem / 3600) as u32, mi: (rem % 3600 / 60) as u32, s: (rem % 60) as u32 }
    }
    fn epoch_ms_of(&self, p: Parts) -> i64 {
        (days_from_civil(i64::from(p.y), i64::from(p.mo), i64::from(p.d)) * 86_400 + i64::from(p.h) * 3600 + i64::from(p.mi) * 60 + i64::from(p.s)) * 1000
    }
}

static LOCAL: OnceLock<Box<dyn LocalTime>> = OnceLock::new();

/// Installs the clock that turns local time into real time (once, at start-up).
pub fn set_local_time(clock: Box<dyn LocalTime>) {
    let _ = LOCAL.set(clock);
}
fn local() -> &'static dyn LocalTime {
    LOCAL.get_or_init(|| Box::new(Utc)).as_ref()
}

/// A moment in real time as the local wall clock shows it.
pub fn local_parts_of(epoch_ms: i64) -> Parts {
    local().parts_of(epoch_ms)
}

/// `2026-10-16T11:30:05.000Z` for a moment in real time.
pub fn iso_utc(ms: i64) -> String {
    let p = Utc.parts_of(ms);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", p.y, p.mo, p.d, p.h, p.mi, p.s, ms.rem_euclid(1000))
}

// ─── Settings ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BackupSettings {
    pub auto: bool,
    pub interval_min: i64,
    pub keep: i64,
}

impl BackupSettings {
    pub fn to_json(self) -> Value {
        json!({ "auto": self.auto, "intervalMin": self.interval_min, "keep": self.keep })
    }
}

/// A profile's backup settings, with defaults filled in and values kept in range.
pub fn backup_settings(profile: &Value) -> BackupSettings {
    let s = &profile["backups"];
    let clamp = |v: &Value, (lo, hi): (i64, i64), fallback: i64| v.as_i64().filter(|n| (lo..=hi).contains(n)).unwrap_or(fallback);
    BackupSettings { auto: s["auto"].as_bool().unwrap_or(DEFAULTS.0), interval_min: clamp(&s["intervalMin"], INTERVAL_RANGE, DEFAULTS.1), keep: clamp(&s["keep"], KEEP_RANGE, DEFAULTS.2) }
}

fn js_integer(v: &Value) -> Option<i64> {
    let f = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (f.fract() == 0.0 && f.is_finite()).then_some(f as i64)
}

/// Checks settings coming from the screen. Only what is present is returned.
pub fn validate_backup_settings(input: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let Some(map) = input.as_object() else { return Err("Invalid backup settings.".into()) };
    let mut out = serde_json::Map::new();
    if let Some(a) = map.get("auto").filter(|v| !v.is_null()) {
        out.insert("auto".into(), json!(a.as_bool().ok_or("Automatic backups must be on or off.")?));
    }
    for (key, (lo, hi), label) in [("intervalMin", INTERVAL_RANGE, "Minutes between backups"), ("keep", KEEP_RANGE, "Backups to keep")] {
        let Some(v) = map.get(key).filter(|v| !v.is_null()) else { continue };
        let n = js_integer(v).filter(|n| (lo..=hi).contains(n)).ok_or_else(|| format!("{label} must be between {lo} and {hi}."))?;
        out.insert(key.into(), json!(n));
    }
    Ok(out)
}

// ─── Names ───────────────────────────────────────────────────────────────────

fn name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_(auto|manual|stop|before-restore)(?:-(\d+))?\.zip$").unwrap())
}

/// `(created_at ms, reason)` for a backup file name, or None when it is not one of ours.
pub fn parse_backup_name(name: &str) -> Option<(i64, &'static str)> {
    let c = name_re().captures(name)?;
    let n = |i: usize| c[i].parse::<u32>().unwrap_or(0);
    let reason = REASONS.into_iter().find(|r| *r == &c[7])?;
    Some((local().epoch_ms_of(Parts { y: c[1].parse().unwrap_or(1970), mo: n(2), d: n(3), h: n(4), mi: n(5), s: n(6) }), reason))
}

fn stamp(now_ms: i64) -> String {
    let p = local().parts_of(now_ms);
    format!("{:04}-{:02}-{:02}_{:02}-{:02}-{:02}", p.y, p.mo, p.d, p.h, p.mi, p.s)
}

fn unique_name(dir: &Path, now_ms: i64, reason: &str) -> String {
    let base = format!("{}_{reason}", stamp(now_ms));
    let mut name = format!("{base}.zip");
    let mut i = 2;
    while dir.join(&name).exists() {
        name = format!("{base}-{i}.zip");
        i += 1;
    }
    name
}

#[derive(Clone, Debug, PartialEq)]
pub struct BackupEntry {
    pub name: String,
    pub created_at: i64,
    pub reason: &'static str,
    pub size: u64,
}

impl BackupEntry {
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "createdAt": self.created_at, "reason": self.reason, "size": self.size })
    }
}

/// Backups of one server, newest first.
pub fn list_backups(dir: &Path) -> Vec<BackupEntry> {
    let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<BackupEntry> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let (created_at, reason) = parse_backup_name(&name)?;
            let meta = fs::metadata(e.path()).ok().filter(|m| m.is_file())?;
            Some(BackupEntry { name, created_at, reason, size: meta.len() })
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.name.cmp(&a.name)));
    out
}

// ─── What a backup contains ──────────────────────────────────────────────────

/// A world folder name must be a plain name: never a path.
fn is_plain_name(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 100 && !s.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c <= '\u{1f}') && s != "." && s != ".." && !s.starts_with('.')
}

/// Folders a server keeps for other things: a world may never be called one of these, whatever a file says.
const RESERVED_FOLDERS: [&str; 8] = ["plugins", "mods", "config", "logs", "libraries", "versions", "cache", "crash-reports"];

/// A name a world folder may have: a plain name that is not one of the server's own folders.
pub fn is_world_name(s: &str) -> bool {
    is_plain_name(s) && !RESERVED_FOLDERS.contains(&s.to_lowercase().as_str())
}

/// The level-name from `server.properties` ("world" when it is missing or not a plain name).
pub fn level_name_of(server_dir: &Path) -> String {
    match read_properties_file(server_dir).get("level-name") {
        Some(n) if is_world_name(n) => n.clone(),
        _ => "world".into(),
    }
}

/// The three folders a world can be spread over (Paper keeps the Nether and the End next to it).
pub fn world_names_for(level: &str) -> [String; 3] {
    [level.to_string(), format!("{level}_nether"), format!("{level}_the_end")]
}

fn is_real_directory(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

pub fn existing_worlds(server_dir: &Path, level: &str) -> Vec<String> {
    world_names_for(level).into_iter().filter(|w| is_real_directory(&server_dir.join(w))).collect()
}

struct FileItem {
    abs: PathBuf,
    rel: String,
    size: u64,
    mtime: std::time::SystemTime,
    /// Copy no more than this many bytes (a Bedrock server tells exactly how much of each file belongs to the saved world).
    limit: Option<u64>,
}

/// Every regular file under `abs`. Symbolic links are never followed (and never saved).
fn collect_files(abs: &Path, rel: &str, out: &mut Vec<FileItem>) -> std::io::Result<()> {
    for entry in fs::read_dir(abs)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_FILES.contains(&name.as_str()) {
            continue;
        }
        let ft = entry.file_type()?;
        let rel_path = format!("{rel}/{name}");
        if ft.is_dir() {
            collect_files(&entry.path(), &rel_path, out)?;
        } else if ft.is_file() {
            let m = entry.metadata()?;
            out.push(FileItem { abs: entry.path(), rel: rel_path, size: m.len(), mtime: m.modified().unwrap_or(std::time::UNIX_EPOCH), limit: None });
        }
    }
    Ok(())
}

/// Free space on the volume holding `dir`, if this platform can say.
pub fn free_bytes(dir: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let mut probe = dir.to_path_buf();
        while !probe.exists() {
            probe = probe.parent()?.to_path_buf();
        }
        let wide: Vec<u16> = probe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free: u64 = 0;
        // SAFETY: `wide` is NUL-terminated and `free` is a valid out-pointer; the other two out-pointers are allowed to be null.
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
        (ok != 0).then_some(free)
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        None
    }
}

// ─── Making a backup ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct BackupInfo {
    pub server_type: Option<String>,
    pub version: Option<String>,
    pub app_version: Option<String>,
}

pub struct CreateOptions<'a> {
    pub backup_dir: &'a Path,
    pub server_dir: &'a Path,
    pub reason: &'a str,
    pub info: BackupInfo,
    /// The moment of the backup (ms since 1970); the name is its local time.
    pub now_ms: i64,
    /// Only for "before-restore": the exact folders to save (which can belong to two level names).
    pub worlds: Option<Vec<String>>,
    pub level_names: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Progress {
    pub phase: &'static str,
    pub done: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Created {
    pub name: String,
    pub size: u64,
    pub created_at: i64,
    pub reason: &'static str,
    pub worlds: Vec<String>,
}

impl Created {
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "size": self.size, "createdAt": self.created_at, "reason": self.reason, "worlds": self.worlds })
    }
}

fn dos_time(t: std::time::SystemTime) -> zip::DateTime {
    let ms = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let p = Utc.parts_of(ms);
    let year = p.y.clamp(1980, 2107) as u16;
    zip::DateTime::from_date_and_time(year, p.mo as u8, p.d as u8, p.h as u8, p.mi as u8, (p.s & !1) as u8).unwrap_or_default()
}

/// Zips the world(s) of a server into `backup_dir`. The file only gets its final name once it has been written and checked, so a
/// half-finished backup can never be mistaken for a good one.
pub fn create_backup(o: &CreateOptions, on_progress: &dyn Fn(Progress)) -> Result<Created, BackupError> {
    let reason = REASONS.into_iter().find(|r| *r == o.reason).ok_or_else(|| fail("invalid", "Unknown backup reason."))?;
    if (o.worlds.is_some() || o.level_names.is_some()) && reason != "before-restore" {
        return Err(fail("invalid", "A list of folders is only for the copy made before a restore."));
    }
    let mut level = level_name_of(o.server_dir);
    let mut levels: Option<Vec<String>> = None;
    let worlds: Vec<String> = if let Some(only) = &o.worlds {
        let mut seen = HashSet::new();
        let worlds: Vec<String> = only.iter().filter(|w| seen.insert((*w).clone()) && is_world_name(w) && is_real_directory(&o.server_dir.join(w))).cloned().collect();
        // Every folder belongs to a level name: those given, plus whatever the folders themselves are called.
        let base_of = |w: &str| w.strip_suffix("_nether").or_else(|| w.strip_suffix("_the_end")).unwrap_or(w).to_string();
        let mut all: Vec<String> = Vec::new();
        for l in std::iter::once(level.clone()).chain(o.level_names.clone().unwrap_or_default()).chain(worlds.iter().map(|w| base_of(w))) {
            if is_world_name(&l) && !all.contains(&l) {
                all.push(l);
            }
        }
        all.truncate(MAX_LEVEL_NAMES);
        if let Some(l) = all.iter().find(|l| worlds.contains(l)) {
            level = l.clone(); // the one the backup is "of": it must be in the zip
        }
        levels = Some(all);
        worlds
    } else {
        existing_worlds(o.server_dir, &level)
    };
    if worlds.is_empty() {
        return Err(fail("no-world", "There is no world to back up yet. Start the server once so it creates one."));
    }

    let mut files: Vec<FileItem> = Vec::new();
    for w in &worlds {
        collect_files(&o.server_dir.join(w), w, &mut files).map_err(|e| fail("failed", format!("The backup failed: {e}")))?;
    }
    for f in CONFIG_FILES.iter().copied().chain([SERVER_JAR]) {
        let abs = o.server_dir.join(f);
        match fs::symlink_metadata(&abs) {
            Ok(m) if m.is_file() => files.push(FileItem { abs, rel: f.to_string(), size: m.len(), mtime: m.modified().unwrap_or(std::time::UNIX_EPOCH), limit: None }),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) if f == SERVER_JAR => return Err(fail("failed", format!("Could not back up server.jar: {e}"))),
            Err(_) => {}
        }
    }
    let total: u64 = files.iter().map(|f| f.size).sum();

    fs::create_dir_all(o.backup_dir).map_err(|e| fail("failed", format!("The backup failed: {e}")))?;
    if let Some(free) = free_bytes(o.backup_dir) {
        if free < total + SPARE_BYTES {
            return Err(fail("disk-full", format!("Not enough free disk space for a backup (needs about {} MB).", total.div_ceil(MB))));
        }
    }

    let name = unique_name(o.backup_dir, o.now_ms, reason);
    let partial = o.backup_dir.join(format!("{name}.partial"));
    let has_jar = files.iter().any(|f| f.rel == SERVER_JAR);
    let mut meta = json!({
        "format": FORMAT,
        "createdAt": iso_utc(o.now_ms),
        "reason": reason,
        "levelName": level,
        "worlds": worlds,
        "serverFiles": if has_jar { json!([SERVER_JAR]) } else { json!([]) },
    });
    if let Some(l) = &levels {
        meta["levelNames"] = json!(l);
    }
    meta["serverType"] = json!(o.info.server_type);
    meta["version"] = json!(o.info.version);
    meta["appVersion"] = json!(o.info.app_version);

    let result = write_zip(&partial, &meta, &files, total, on_progress).and_then(|()| {
        // Prove the zip can be opened and has a world in it.
        let written = read_backup_info(&partial, MAX_ENTRIES)?;
        if written.meta["levelName"] != json!(level) {
            return Err(fail("bad-backup", "The backup could not be verified."));
        }
        fs::rename(&partial, o.backup_dir.join(&name)).map_err(|e| fail("failed", format!("The backup failed: {e}")))
    });
    if let Err(e) = result {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    let size = fs::metadata(o.backup_dir.join(&name)).map(|m| m.len()).unwrap_or(0);
    Ok(Created { created_at: parse_backup_name(&name).map(|(t, _)| t).unwrap_or(o.now_ms), name, size, reason, worlds })
}

fn write_zip(partial: &Path, meta: &Value, files: &[FileItem], total: u64, on_progress: &dyn Fn(Progress)) -> Result<(), BackupError> {
    let failed = |e: &dyn std::fmt::Display| fail("failed", format!("The backup failed: {e}"));
    let file = fs::File::create(partial).map_err(|e| failed(&e))?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let opts = |mtime: zip::DateTime, large: bool| zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).unix_permissions(0o644).last_modified_time(mtime).large_file(large);
    zip.start_file(META_NAME, opts(dos_time(std::time::SystemTime::now()), false)).map_err(|e| failed(&e))?;
    zip.write_all(serde_json::to_string_pretty(meta).unwrap().as_bytes()).map_err(|e| failed(&e))?;
    let mut done = 0u64;
    on_progress(Progress { phase: "zipping", done, total });
    let mut buf = vec![0u8; 256 * 1024];
    for f in files {
        // One file at a time, so a world with thousands of files never opens thousands at once.
        let mut input = fs::File::open(&f.abs).map_err(|e| failed(&e))?;
        zip.start_file(&f.rel, opts(dos_time(f.mtime), f.size >= 4 * GB)).map_err(|e| failed(&e))?;
        let mut remaining = f.limit.unwrap_or(u64::MAX);
        while remaining > 0 {
            let want = buf.len().min(usize::try_from(remaining).unwrap_or(usize::MAX));
            let n = input.read(&mut buf[..want]).map_err(|e| failed(&e))?;
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n]).map_err(|e| failed(&e))?;
            remaining -= n as u64;
            done += n as u64;
        }
        on_progress(Progress { phase: "zipping", done, total });
    }
    let mut out = zip.finish().map_err(|e| failed(&e))?;
    out.flush().map_err(|e| failed(&e))?;
    let file = out.into_inner().map_err(|e| failed(&e.to_string()))?;
    file.sync_all().map_err(|e| failed(&e))?;
    Ok(())
}

// ─── Reading a backup ────────────────────────────────────────────────────────

/// The folders a backup's metadata may name: its own world's three, plus (before-restore copies only) those of the other worlds
/// it lists.
fn allowed_folders(meta: &Value) -> HashSet<String> {
    let mut levels: Vec<String> = vec![meta["levelName"].as_str().unwrap_or("").to_string()];
    if meta["reason"] == "before-restore" {
        if let Some(a) = meta["levelNames"].as_array() {
            levels.extend(a.iter().take(MAX_LEVEL_NAMES).filter_map(|v| v.as_str().map(str::to_string)));
        }
    }
    levels.into_iter().filter(|l| is_world_name(l)).flat_map(|l| world_names_for(&l)).collect()
}

pub struct BackupContents {
    pub meta: Value,
    pub entries: Vec<String>,
    pub uncompressed: u64,
}

/// Opens a backup and reads its contents list and `voxelport-backup.json`, without extracting anything. Errors when it is not a
/// readable VoxelPort backup.
pub fn read_backup_info(file: &Path, max_entries: usize) -> Result<BackupContents, BackupError> {
    let bad = |e: &dyn std::fmt::Display| fail("bad-backup", format!("That backup file is damaged ({e})."));
    let f = fs::File::open(file).map_err(|e| fail("bad-backup", format!("That backup file can't be read ({e}).")))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| fail("bad-backup", format!("That backup file can't be read ({e}).")))?;
    if zip.len() > max_entries {
        return Err(fail("too-big", "That backup is too big to restore."));
    }
    let (mut entries, mut meta, mut uncompressed) = (Vec::new(), None, 0u64);
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| bad(&e))?;
        if entry.name().ends_with('/') {
            continue;
        }
        entries.push(entry.name().to_string());
        uncompressed += entry.size();
        if entry.name() == META_NAME {
            let mut bytes = Vec::new();
            (&mut entry).take(MAX_META_BYTES + 1).read_to_end(&mut bytes).map_err(|e| bad(&e))?;
            if bytes.len() as u64 > MAX_META_BYTES {
                return Err(bad(&"metadata is too large"));
            }
            meta = Some(serde_json::from_slice::<Value>(&bytes).map_err(|e| bad(&e))?);
        }
    }
    let Some(meta) = meta else { return Err(fail("not-voxelport", "That file is not a VoxelPort backup.")) };
    if meta["layout"] == "bedrock" {
        check_bedrock_backup(&meta, &entries)?;
        return Ok(BackupContents { meta, entries, uncompressed });
    }
    // A backup may only ever put back the folders of its own world, whatever its metadata claims.
    let own = allowed_folders(&meta);
    let worlds_ok = meta["worlds"].as_array().is_some_and(|w| !w.is_empty() && w.iter().all(|x| x.as_str().is_some_and(|s| own.contains(s))));
    if meta["format"] != json!(FORMAT) || !meta["levelName"].as_str().is_some_and(is_world_name) || !worlds_ok {
        return Err(fail("bad-backup", "That backup is from a newer VoxelPort or is damaged."));
    }
    let level = meta["levelName"].as_str().unwrap_or("");
    if !entries.contains(&format!("{level}/level.dat")) {
        return Err(fail("bad-backup", "That backup has no world in it."));
    }
    if let Some(sf) = meta.get("serverFiles").filter(|v| !v.is_null()) {
        let ok = sf.as_array().is_some_and(|a| a.len() <= 1 && a.iter().all(|f| f.as_str() == Some(SERVER_JAR) && entries.iter().any(|e| e == SERVER_JAR)));
        if !ok {
            return Err(fail("bad-backup", "That backup has invalid server files."));
        }
    }
    Ok(BackupContents { meta, entries, uncompressed })
}

/// Extracts every file of a backup into `dest`, refusing any name that would land outside it and any link.
fn extract_all(file: &Path, dest: &Path, on_bytes: &mut dyn FnMut(u64)) -> Result<(), BackupError> {
    let unsafe_err = || fail("unsafe", "That backup contains a file outside its folder, so it was not restored.");
    let f = fs::File::open(file).map_err(|e| fail("bad-backup", format!("That backup file can't be read ({e}).")))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| fail("bad-backup", format!("That backup file is damaged ({e}).")))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| fail("bad-backup", format!("That backup file is damaged ({e}).")))?;
        let name = entry.name().to_string();
        // VoxelPort never makes a link, so one here is not ours.
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
        if name.ends_with('/') {
            fs::create_dir_all(&target).map_err(|e| fail("failed", e.to_string()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| fail("failed", e.to_string()))?;
        }
        let mut out = fs::File::create(&target).map_err(|e| fail("failed", e.to_string()))?;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = entry.read(&mut buf).map_err(|e| fail("bad-backup", format!("That backup file is damaged ({e}).")))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| fail("failed", e.to_string()))?;
            on_bytes(n as u64);
        }
    }
    Ok(())
}

// ─── Restoring ───────────────────────────────────────────────────────────────

/// Windows can briefly refuse to move a folder a virus scanner is looking at: try a few times.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 4 && matches!(e.kind(), std::io::ErrorKind::PermissionDenied) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(250 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

fn rm_quiet(p: &Path) {
    let _ = fs::remove_dir_all(p).or_else(|_| fs::remove_file(p));
}

pub struct RestoreOptions<'a> {
    pub backup_dir: &'a Path,
    pub server_dir: &'a Path,
    pub name: &'a str,
    pub info: BackupInfo,
    pub now_ms: i64,
    pub max_entries: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Restored {
    pub level_name: String,
    pub previous_level_name: String,
    pub safety_backup: Option<String>,
    /// When the backup carried its own `server.jar`: the type and Minecraft version it was.
    pub restored_server: Option<(String, String)>,
}

/// Puts a backup back. The server must be stopped. First saves what is there now as a "before-restore" backup (if that fails,
/// nothing is touched), then unpacks into a temporary folder, checks it, and only then swaps the folders over. If the swap
/// fails half way, everything is put back as it was. The caller sets `level-name` in `server.properties`.
pub fn restore_backup(o: &RestoreOptions, on_progress: &dyn Fn(Progress)) -> Result<Restored, BackupError> {
    if parse_backup_name(o.name).is_none() {
        return Err(fail("bad-name", "That is not one of VoxelPort's backups."));
    }
    let file = o.backup_dir.join(o.name);
    if !file.exists() {
        return Err(fail("missing", "That backup is gone."));
    }
    let phase = |phase: &'static str| on_progress(Progress { phase, done: 0, total: 0 });
    phase("checking");
    let BackupContents { meta, uncompressed, .. } = read_backup_info(&file, o.max_entries)?;
    if meta["layout"] == "bedrock" {
        return Err(fail("wrong-kind", "That backup is from a Bedrock server, so it can't be put back on a Java server."));
    }
    if uncompressed > MAX_RESTORE_BYTES {
        return Err(fail("too-big", "That backup is too big to restore."));
    }
    if let Some(free) = free_bytes(o.server_dir) {
        if (free as f64) < uncompressed as f64 * 1.05 + SPARE_BYTES as f64 {
            return Err(fail("disk-full", format!("Not enough free disk space to restore (needs about {} MB).", uncompressed.div_ceil(MB))));
        }
    }

    let backup_level = meta["levelName"].as_str().unwrap_or("world").to_string();
    let backup_worlds: Vec<String> = meta["worlds"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let previous = level_name_of(o.server_dir);
    // Every folder the swap below moves out of the way (and deletes) must be in the copy made first: the current world's, and the
    // ones the backup is about to replace, which can be another world's.
    let mut touched: Vec<String> = Vec::new();
    for w in world_names_for(&previous).into_iter().chain(world_names_for(&backup_level)).chain(backup_worlds.iter().cloned()) {
        if !touched.contains(&w) {
            touched.push(w);
        }
    }
    let to_save: Vec<String> = touched.iter().filter(|w| is_real_directory(&o.server_dir.join(w))).cloned().collect();
    let mut safety = None;
    if !to_save.is_empty() {
        phase("saving-current");
        safety = Some(create_backup(
            &CreateOptions { backup_dir: o.backup_dir, server_dir: o.server_dir, reason: "before-restore", info: o.info.clone(), now_ms: o.now_ms, worlds: Some(to_save), level_names: Some(vec![previous.clone(), backup_level.clone()]) },
            &|_| {},
        )?);
    }

    let id = o.now_ms.max(0);
    let tmp = o.server_dir.join(format!(".vp-restore-{id}"));
    let old = o.server_dir.join(format!(".vp-old-{id}"));
    let (mut moved, mut placed, mut lists_kept, mut lists_added) = (Vec::<String>::new(), Vec::<String>::new(), Vec::<String>::new(), Vec::<String>::new());
    let swap = (|| -> Result<(), BackupError> {
        fs::create_dir_all(&tmp).map_err(|e| fail("failed", e.to_string()))?;
        let mut done = 0u64;
        on_progress(Progress { phase: "unpacking", done, total: uncompressed });
        extract_all(&file, &tmp, &mut |n| {
            done += n;
            on_progress(Progress { phase: "unpacking", done, total: uncompressed });
        })?;
        if !tmp.join(&backup_level).join("level.dat").exists() {
            return Err(fail("bad-backup", "That backup has no world in it."));
        }
        phase("swapping");
        fs::create_dir_all(&old).map_err(|e| fail("failed", e.to_string()))?;
        for w in &touched {
            if !is_real_directory(&o.server_dir.join(w)) {
                continue;
            }
            rename_with_retry(&o.server_dir.join(w), &old.join(w)).map_err(|e| fail("failed", e.to_string()))?;
            moved.push(w.clone());
        }
        for w in &backup_worlds {
            if !is_real_directory(&tmp.join(w)) {
                continue;
            }
            rename_with_retry(&tmp.join(w), &o.server_dir.join(w)).map_err(|e| fail("failed", e.to_string()))?;
            placed.push(w.clone());
        }
        let server_files: Vec<String> = meta["serverFiles"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        for f in CONFIG_FILES.iter().map(|s| s.to_string()).chain(server_files) {
            let from = tmp.join(&f);
            if !from.exists() {
                continue;
            }
            let to = o.server_dir.join(&f);
            // Never follow a server-root link when replacing an executable or list.
            match fs::symlink_metadata(&to) {
                Ok(m) if !m.is_file() => return Err(fail("unsafe", "A server file is not a regular file, so it was not replaced.")),
                Ok(_) => {
                    fs::copy(&to, old.join(&f)).map_err(|e| fail("failed", e.to_string()))?;
                    lists_kept.push(f.clone());
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => lists_added.push(f.clone()),
                Err(e) => return Err(fail("failed", e.to_string())),
            }
            fs::copy(&from, &to).map_err(|e| fail("failed", e.to_string()))?;
        }
        Ok(())
    })();
    if let Err(err) = swap {
        // Put everything back the way it was.
        for w in &placed {
            rm_quiet(&o.server_dir.join(w));
        }
        for w in &moved {
            let _ = rename_with_retry(&old.join(w), &o.server_dir.join(w)); // keep going: the rest still matters
        }
        for f in &lists_kept {
            let _ = fs::copy(old.join(f), o.server_dir.join(f));
        }
        for f in &lists_added {
            rm_quiet(&o.server_dir.join(f));
        }
        rm_quiet(&tmp);
        rm_quiet(&old);
        return Err(if err.code == "failed" { fail("failed", format!("The restore failed and your world was left as it was: {}", err.message)) } else { err });
    }
    rm_quiet(&tmp);
    rm_quiet(&old); // the "before restore" backup holds the previous world

    let version_ok = |v: &str| (1..=80).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'));
    let has_jar = meta["serverFiles"].as_array().is_some_and(|a| a.iter().any(|f| f == SERVER_JAR));
    let restored_server = match (has_jar, meta["serverType"].as_str(), meta["version"].as_str()) {
        (true, Some(t @ ("vanilla" | "paper" | "fabric")), Some(v)) if version_ok(v) => Some((t.to_string(), v.to_string())),
        _ => None,
    };
    Ok(Restored { level_name: backup_level, previous_level_name: previous, safety_backup: safety.map(|s| s.name), restored_server })
}

// ─── Bedrock Dedicated Server worlds ─────────────────────────────────────────
//
// A Bedrock server keeps its world in `worlds/<level-name>` (the level name may hold spaces), and the files that go with it are
// `allowlist.json` and `permissions.json`. A backup of one is the same kind of zip with `"layout": "bedrock"` in its metadata, so the list,
// the schedule, the retention and the screens are shared; only what is saved and put back differs. A Java server's backup and a Bedrock
// one are never mixed up: each refuses the other.

pub const BEDROCK_WORLDS_DIR: &str = "worlds";
/// Who may join and what they may do.
pub const BEDROCK_CONFIG_FILES: [&str; 2] = ["allowlist.json", "permissions.json"];
const BEDROCK_DEFAULT_LEVEL: &str = "Bedrock level";

/// The level-name from `server.properties` ("Bedrock level" when it is missing or not a plain name).
pub fn bedrock_level_name_of(server_dir: &Path) -> String {
    match crate::settings::read_properties_file_raw(server_dir).get("level-name") {
        Some(n) if is_plain_name(n) => n.clone(),
        _ => BEDROCK_DEFAULT_LEVEL.into(),
    }
}

pub fn bedrock_world_exists(server_dir: &Path, level: &str) -> bool {
    is_plain_name(level) && is_real_directory(&server_dir.join(BEDROCK_WORLDS_DIR).join(level))
}

/// What the entries of a Bedrock backup may be: its metadata, the two config files, and files inside the worlds it names.
fn check_bedrock_backup(meta: &Value, entries: &[String]) -> Result<(), BackupError> {
    let bad = || fail("bad-backup", "That backup is from a newer VoxelPort or is damaged.");
    let level = meta["levelName"].as_str().filter(|l| is_plain_name(l)).ok_or_else(bad)?;
    let worlds: Vec<&str> = meta["worlds"].as_array().ok_or_else(bad)?.iter().filter_map(Value::as_str).collect();
    let single = meta["reason"] != "before-restore";
    if meta["format"] != json!(FORMAT) || worlds.is_empty() || worlds.len() > MAX_LEVEL_NAMES || !worlds.contains(&level) || !worlds.iter().all(|w| is_plain_name(w)) || (single && worlds.len() != 1) {
        return Err(bad());
    }
    if meta["serverFiles"].as_array().is_some_and(|a| !a.is_empty()) {
        return Err(fail("bad-backup", "That backup has invalid server files."));
    }
    if !entries.iter().any(|e| *e == format!("{BEDROCK_WORLDS_DIR}/{level}/level.dat")) {
        return Err(fail("bad-backup", "That backup has no world in it."));
    }
    let allowed = |e: &str| e == META_NAME || BEDROCK_CONFIG_FILES.contains(&e) || worlds.iter().any(|w| e.starts_with(&format!("{BEDROCK_WORLDS_DIR}/{w}/")));
    if let Some(stray) = entries.iter().find(|e| !allowed(e)) {
        return Err(fail("bad-backup", format!("That backup holds a file it should not ({stray}), so it was not used.")));
    }
    Ok(())
}

pub struct BedrockCreateOptions<'a> {
    pub backup_dir: &'a Path,
    pub server_dir: &'a Path,
    pub reason: &'a str,
    pub info: BackupInfo,
    pub now_ms: i64,
    /// Only for "before-restore": every level to save (default: the server's own).
    pub levels: Option<Vec<String>>,
    /// What `save query` reported for a running server: each file under `worlds/` ("<level>/db/000003.log") and how many bytes of it belong
    /// to the saved world. Empty for a stopped server, whose files are all complete.
    pub lengths: Vec<(String, u64)>,
}

/// Zips the world of a Bedrock server (and its allow-list and permissions) into `backup_dir`. Same promise as [`create_backup`]: the file only
/// gets its final name once it has been written and checked.
pub fn create_backup_bedrock(o: &BedrockCreateOptions, on_progress: &dyn Fn(Progress)) -> Result<Created, BackupError> {
    let reason = REASONS.into_iter().find(|r| *r == o.reason).ok_or_else(|| fail("invalid", "Unknown backup reason."))?;
    if o.levels.is_some() && reason != "before-restore" {
        return Err(fail("invalid", "A list of worlds is only for the copy made before a restore."));
    }
    let own = bedrock_level_name_of(o.server_dir);
    let wanted: Vec<String> = o.levels.clone().unwrap_or_else(|| vec![own.clone()]);
    let mut seen = HashSet::new();
    let levels: Vec<String> = wanted.into_iter().filter(|l| seen.insert(l.clone()) && bedrock_world_exists(o.server_dir, l)).take(MAX_LEVEL_NAMES).collect();
    if levels.is_empty() {
        return Err(fail("no-world", "There is no world to back up yet. Start the server once so it creates one."));
    }
    let level = if levels.contains(&own) { own } else { levels[0].clone() };

    let exact: std::collections::HashMap<&str, u64> = o.lengths.iter().map(|(f, n)| (f.as_str(), *n)).collect();
    let mut files: Vec<FileItem> = Vec::new();
    for l in &levels {
        let mut found: Vec<FileItem> = Vec::new();
        collect_files(&o.server_dir.join(BEDROCK_WORLDS_DIR).join(l), &format!("{BEDROCK_WORLDS_DIR}/{l}"), &mut found).map_err(|e| fail("failed", format!("The backup failed: {e}")))?;
        for mut f in found {
            if let Some(len) = f.rel.strip_prefix(&format!("{BEDROCK_WORLDS_DIR}/")).and_then(|r| exact.get(r)) {
                f.limit = Some(*len);
                f.size = f.size.min(*len);
            }
            files.push(f);
        }
    }
    for f in BEDROCK_CONFIG_FILES {
        let abs = o.server_dir.join(f);
        if let Ok(m) = fs::symlink_metadata(&abs) {
            if m.is_file() {
                files.push(FileItem { abs, rel: f.to_string(), size: m.len(), mtime: m.modified().unwrap_or(std::time::UNIX_EPOCH), limit: None });
            }
        }
    }
    let total: u64 = files.iter().map(|f| f.size).sum();
    fs::create_dir_all(o.backup_dir).map_err(|e| fail("failed", format!("The backup failed: {e}")))?;
    if let Some(free) = free_bytes(o.backup_dir) {
        if free < total + SPARE_BYTES {
            return Err(fail("disk-full", format!("Not enough free disk space for a backup (needs about {} MB).", total.div_ceil(MB))));
        }
    }

    let name = unique_name(o.backup_dir, o.now_ms, reason);
    let partial = o.backup_dir.join(format!("{name}.partial"));
    let mut meta = json!({
        "format": FORMAT,
        "layout": "bedrock",
        "createdAt": iso_utc(o.now_ms),
        "reason": reason,
        "levelName": level,
        "worlds": levels,
        "serverFiles": [],
    });
    meta["serverType"] = json!(o.info.server_type);
    meta["version"] = json!(o.info.version);
    meta["appVersion"] = json!(o.info.app_version);

    let result = write_zip(&partial, &meta, &files, total, on_progress).and_then(|()| {
        let written = read_backup_info(&partial, MAX_ENTRIES)?; // proves it opens, has the world, and holds nothing else
        if written.meta["levelName"] != json!(level) {
            return Err(fail("bad-backup", "The backup could not be verified."));
        }
        fs::rename(&partial, o.backup_dir.join(&name)).map_err(|e| fail("failed", format!("The backup failed: {e}")))
    });
    if let Err(e) = result {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    let size = fs::metadata(o.backup_dir.join(&name)).map(|m| m.len()).unwrap_or(0);
    Ok(Created { created_at: parse_backup_name(&name).map(|(t, _)| t).unwrap_or(o.now_ms), name, size, reason, worlds: levels })
}

/// Puts a Bedrock backup back. Same promises as [`restore_backup`]: the server must be stopped, what is there now is saved first, the
/// swap is undone if it fails half way, and a backup of a Java server is refused. The caller sets `level-name` in `server.properties`.
pub fn restore_backup_bedrock(o: &RestoreOptions, on_progress: &dyn Fn(Progress)) -> Result<Restored, BackupError> {
    if parse_backup_name(o.name).is_none() {
        return Err(fail("bad-name", "That is not one of VoxelPort's backups."));
    }
    let file = o.backup_dir.join(o.name);
    if !file.exists() {
        return Err(fail("missing", "That backup is gone."));
    }
    let phase = |phase: &'static str| on_progress(Progress { phase, done: 0, total: 0 });
    phase("checking");
    let BackupContents { meta, uncompressed, .. } = read_backup_info(&file, o.max_entries)?;
    if meta["layout"] != "bedrock" {
        return Err(fail("wrong-kind", "That backup is from a Java server, so it can't be put back on a Bedrock server."));
    }
    if uncompressed > MAX_RESTORE_BYTES {
        return Err(fail("too-big", "That backup is too big to restore."));
    }
    if let Some(free) = free_bytes(o.server_dir) {
        if (free as f64) < uncompressed as f64 * 1.05 + SPARE_BYTES as f64 {
            return Err(fail("disk-full", format!("Not enough free disk space to restore (needs about {} MB).", uncompressed.div_ceil(MB))));
        }
    }
    let backup_level = meta["levelName"].as_str().unwrap_or(BEDROCK_DEFAULT_LEVEL).to_string();
    let backup_worlds: Vec<String> = meta["worlds"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let previous = bedrock_level_name_of(o.server_dir);
    // Every world the swap moves out of the way (and deletes) must be in the copy made first.
    let mut touched: Vec<String> = Vec::new();
    for w in std::iter::once(previous.clone()).chain(backup_worlds.iter().cloned()) {
        if !touched.contains(&w) {
            touched.push(w);
        }
    }
    let to_save: Vec<String> = touched.iter().filter(|w| bedrock_world_exists(o.server_dir, w)).cloned().collect();
    let mut safety = None;
    if !to_save.is_empty() {
        phase("saving-current");
        safety = Some(create_backup_bedrock(
            &BedrockCreateOptions { backup_dir: o.backup_dir, server_dir: o.server_dir, reason: "before-restore", info: o.info.clone(), now_ms: o.now_ms, levels: Some(to_save), lengths: Vec::new() },
            &|_| {},
        )?);
    }

    let id = o.now_ms.max(0);
    let tmp = o.server_dir.join(format!(".vp-restore-{id}"));
    let old = o.server_dir.join(format!(".vp-old-{id}"));
    let worlds_dir = o.server_dir.join(BEDROCK_WORLDS_DIR);
    let (mut moved, mut placed, mut lists_kept, mut lists_added) = (Vec::<String>::new(), Vec::<String>::new(), Vec::<String>::new(), Vec::<String>::new());
    let swap = (|| -> Result<(), BackupError> {
        fs::create_dir_all(&tmp).map_err(|e| fail("failed", e.to_string()))?;
        let mut done = 0u64;
        on_progress(Progress { phase: "unpacking", done, total: uncompressed });
        extract_all(&file, &tmp, &mut |n| {
            done += n;
            on_progress(Progress { phase: "unpacking", done, total: uncompressed });
        })?;
        if !tmp.join(BEDROCK_WORLDS_DIR).join(&backup_level).join("level.dat").exists() {
            return Err(fail("bad-backup", "That backup has no world in it."));
        }
        phase("swapping");
        fs::create_dir_all(old.join(BEDROCK_WORLDS_DIR)).map_err(|e| fail("failed", e.to_string()))?;
        fs::create_dir_all(&worlds_dir).map_err(|e| fail("failed", e.to_string()))?;
        for w in &touched {
            if !bedrock_world_exists(o.server_dir, w) {
                continue;
            }
            rename_with_retry(&worlds_dir.join(w), &old.join(BEDROCK_WORLDS_DIR).join(w)).map_err(|e| fail("failed", e.to_string()))?;
            moved.push(w.clone());
        }
        for w in &backup_worlds {
            let from = tmp.join(BEDROCK_WORLDS_DIR).join(w);
            if !is_real_directory(&from) {
                continue;
            }
            rename_with_retry(&from, &worlds_dir.join(w)).map_err(|e| fail("failed", e.to_string()))?;
            placed.push(w.clone());
        }
        for f in BEDROCK_CONFIG_FILES {
            let from = tmp.join(f);
            if !from.exists() {
                continue;
            }
            let to = o.server_dir.join(f);
            match fs::symlink_metadata(&to) {
                Ok(m) if !m.is_file() => return Err(fail("unsafe", "A server file is not a regular file, so it was not replaced.")),
                Ok(_) => {
                    fs::copy(&to, old.join(f)).map_err(|e| fail("failed", e.to_string()))?;
                    lists_kept.push(f.to_string());
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => lists_added.push(f.to_string()),
                Err(e) => return Err(fail("failed", e.to_string())),
            }
            fs::copy(&from, &to).map_err(|e| fail("failed", e.to_string()))?;
        }
        Ok(())
    })();
    if let Err(err) = swap {
        for w in &placed {
            rm_quiet(&worlds_dir.join(w));
        }
        for w in &moved {
            let _ = rename_with_retry(&old.join(BEDROCK_WORLDS_DIR).join(w), &worlds_dir.join(w));
        }
        for f in &lists_kept {
            let _ = fs::copy(old.join(f), o.server_dir.join(f));
        }
        for f in &lists_added {
            rm_quiet(&o.server_dir.join(f));
        }
        rm_quiet(&tmp);
        rm_quiet(&old);
        return Err(if err.code == "failed" { fail("failed", format!("The restore failed and your world was left as it was: {}", err.message)) } else { err });
    }
    rm_quiet(&tmp);
    rm_quiet(&old); // the "before restore" backup holds the previous world
    Ok(Restored { level_name: backup_level, previous_level_name: previous, safety_backup: safety.map(|s| s.name), restored_server: None })
}

// ─── Housekeeping ────────────────────────────────────────────────────────────

pub fn delete_backup(backup_dir: &Path, name: &str) -> Result<(), BackupError> {
    if parse_backup_name(name).is_none() {
        return Err(fail("bad-name", "That is not one of VoxelPort's backups."));
    }
    let _ = fs::remove_file(backup_dir.join(name));
    Ok(())
}

/// Removes old automatic backups: keeps the newest `keep` of the automatic ones (and the ones made when the server stopped), then
/// trims further while they take more than the budget (never below the newest two). Manual backups are never removed here;
/// "before restore" copies keep only the last few. Returns the names removed.
pub fn apply_retention(backup_dir: &Path, keep: usize, budget_bytes: u64) -> Vec<String> {
    let all = list_backups(backup_dir);
    let mut removed = Vec::new();
    let mut drop_one = |b: &BackupEntry| {
        if fs::remove_file(backup_dir.join(&b.name)).is_ok() {
            removed.push(b.name.clone());
        }
    };
    let automatic: Vec<&BackupEntry> = all.iter().filter(|b| b.reason == "auto" || b.reason == "stop").collect();
    automatic.iter().skip(keep).for_each(|b| drop_one(b));
    let mut kept: Vec<&BackupEntry> = automatic.into_iter().take(keep).collect();
    let mut total: u64 = kept.iter().map(|b| b.size).sum();
    while kept.len() > 2 && total > budget_bytes {
        let oldest = kept.pop().expect("more than two");
        total -= oldest.size;
        drop_one(oldest);
    }
    all.iter().filter(|b| b.reason == "before-restore").skip(KEEP_BEFORE_RESTORE).for_each(|b| drop_one(b));
    removed
}

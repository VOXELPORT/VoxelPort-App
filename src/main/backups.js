'use strict';

// World backups. A backup is one .zip with the server's world folders (and the small player lists), plus
// a voxelport-backup.json that says what it is. Restoring puts them back, after saving a "before restore"
// copy of what is there now, so a restore can always be undone.
//
// This module only deals with files. Telling a running server to save first, and the schedule, are in main.js.

const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { parseProperties } = require('./serverSettings');

const META_NAME = 'voxelport-backup.json';
const FORMAT = 1;
const REASONS = ['auto', 'manual', 'stop', 'before-restore'];
const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_(auto|manual|stop|before-restore)(?:-(\d+))?\.zip$/;
// The small files worth keeping with the world: who is allowed in, who is an operator.
const CONFIG_FILES = ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json'];
// Held open by the running server, and recreated on start: never part of a backup.
const SKIP_FILES = new Set(['session.lock']);

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DEFAULTS = { auto: true, intervalMin: 30, keep: 5 };
const INTERVAL_RANGE = [5, 720];
const KEEP_RANGE = [1, 30];
// Automatic backups of one server never take more than this; the oldest go first (always keeping the newest two).
const AUTO_BUDGET_BYTES = 5 * GB;
const KEEP_BEFORE_RESTORE = 3;
const MAX_RESTORE_BYTES = 200 * GB;
// A real world is a few thousand files; a backup with millions of entries is a trap, not a world.
const LIMITS = { entries: 1_000_000 };
const SPARE_BYTES = 200 * MB; // never fill the disk to the last byte

class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** A profile's backup settings, with defaults filled in and values kept in range. */
function backupSettings(profile) {
  const s = (profile && profile.backups) || {};
  const clamp = (v, [lo, hi], fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);
  return {
    auto: typeof s.auto === 'boolean' ? s.auto : DEFAULTS.auto,
    intervalMin: clamp(s.intervalMin, INTERVAL_RANGE, DEFAULTS.intervalMin),
    keep: clamp(s.keep, KEEP_RANGE, DEFAULTS.keep),
  };
}

/** Checks settings coming from the screen. Throws when something is out of range. */
function validateBackupSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid backup settings.');
  const out = {};
  if (input.auto !== undefined) {
    if (typeof input.auto !== 'boolean') throw new Error('Automatic backups must be on or off.');
    out.auto = input.auto;
  }
  for (const [key, range] of [['intervalMin', INTERVAL_RANGE], ['keep', KEEP_RANGE]]) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < range[0] || n > range[1]) throw new Error(`${key === 'keep' ? 'Backups to keep' : 'Minutes between backups'} must be between ${range[0]} and ${range[1]}.`);
    out[key] = n;
  }
  return out;
}

// ─── Names ───────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** { createdAt (ms), reason } for a backup file name, or null when it is not one of ours. */
function parseBackupName(name) {
  const m = NAME_RE.exec(String(name));
  if (!m) return null;
  const [, y, mo, d, h, mi, s, reason] = m;
  return { createdAt: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime(), reason };
}

function uniqueName(dir, date, reason) {
  const base = `${stamp(date)}_${reason}`;
  let name = `${base}.zip`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.zip`;
  return name;
}

/** Backups of one server, newest first. */
function listBackups(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const parsed = parseBackupName(name);
    if (!parsed) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) out.push({ name, createdAt: parsed.createdAt, reason: parsed.reason, size: st.size });
    } catch { /* removed meanwhile */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

// ─── What a backup contains ──────────────────────────────────────────────────

/** A world folder name must be a plain name: never a path. */
function isPlainName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 100 && !/[\\/:*?"<>|\x00-\x1f]/.test(s) && s !== '.' && s !== '..' && !s.startsWith('.');
}

/** The level-name from server.properties ("world" when it is missing or not a plain name). */
function levelNameOf(serverDir) {
  try {
    const props = parseProperties(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'));
    const name = props.get('level-name');
    if (isPlainName(name)) return name;
  } catch { /* no server.properties yet */ }
  return 'world';
}

/** The three folders a world can be spread over (Paper keeps the Nether and the End next to it). */
function worldNamesFor(level) {
  return [level, `${level}_nether`, `${level}_the_end`];
}

function isRealDirectory(p) {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

function existingWorlds(serverDir, level) {
  return worldNamesFor(level).filter((w) => isRealDirectory(path.join(serverDir, w)));
}

/** Every regular file under `abs`, as { abs, rel, size, mtime }. Symlinks are never followed. */
function collectFiles(abs, rel, out) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_FILES.has(entry.name)) continue;
    const full = path.join(abs, entry.name);
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) collectFiles(full, relPath, out);
    else if (entry.isFile()) {
      const st = fs.statSync(full);
      out.push({ abs: full, rel: relPath, size: st.size, mtime: st.mtime });
    }
  }
  return out;
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

// ─── Making a backup ─────────────────────────────────────────────────────────

/**
 * Zips the world(s) of a server into `backupDir`. The file only gets its final name once it has been
 * written and checked, so a half-finished backup can never be mistaken for a good one.
 *
 * `info`: { serverType, version, appVersion } is written into the backup for later reference.
 */
async function createBackup({ backupDir, serverDir, reason, info = {}, onProgress = () => {}, now = new Date() }) {
  if (!REASONS.includes(reason)) throw new Error('Unknown backup reason.');
  const level = levelNameOf(serverDir);
  const worlds = existingWorlds(serverDir, level);
  if (!worlds.length) throw new BackupError('no-world', 'There is no world to back up yet. Start the server once so it creates one.');

  const files = [];
  for (const w of worlds) collectFiles(path.join(serverDir, w), w, files);
  for (const f of CONFIG_FILES) {
    const abs = path.join(serverDir, f);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) files.push({ abs, rel: f, size: st.size, mtime: st.mtime });
    } catch { /* not there */ }
  }
  const total = files.reduce((n, f) => n + f.size, 0);

  fs.mkdirSync(backupDir, { recursive: true });
  const free = freeBytes(backupDir);
  if (free !== null && free < total + SPARE_BYTES) {
    throw new BackupError('disk-full', `Not enough free disk space for a backup (needs about ${Math.ceil(total / MB)} MB).`);
  }

  const name = uniqueName(backupDir, now, reason);
  const partial = path.join(backupDir, `${name}.partial`);
  const meta = {
    format: FORMAT,
    createdAt: now.toISOString(),
    reason,
    levelName: level,
    worlds,
    serverType: info.serverType || null,
    version: info.version || null,
    appVersion: info.appVersion || null,
  };

  try {
    const zip = new yazl.ZipFile();
    const out = fs.createWriteStream(partial);
    const finished = new Promise((resolve, reject) => {
      out.on('close', resolve);
      out.on('error', reject);
      zip.outputStream.on('error', reject);
    });
    zip.outputStream.pipe(out);
    zip.addBuffer(Buffer.from(JSON.stringify(meta, null, 2)), META_NAME);

    let done = 0;
    onProgress({ phase: 'zipping', done, total });
    for (const f of files) {
      // One file at a time, so a world with thousands of files never opens thousands at once.
      await new Promise((resolve, reject) => {
        const counter = new Transform({
          transform(chunk, _enc, cb) { done += chunk.length; cb(null, chunk); },
        });
        const rs = fs.createReadStream(f.abs);
        rs.on('error', reject);
        counter.on('error', reject);
        counter.on('end', () => { onProgress({ phase: 'zipping', done, total }); resolve(); });
        rs.pipe(counter);
        zip.addReadStream(counter, f.rel, { mtime: f.mtime, mode: 0o100644, compress: true });
      });
    }
    zip.end();
    await finished;

    const written = await readBackupInfo(partial); // proves the zip can be opened and has a world in it
    if (!written.meta || written.meta.levelName !== level) throw new BackupError('bad-backup', 'The backup could not be verified.');
    fs.renameSync(partial, path.join(backupDir, name));
  } catch (err) {
    try { fs.rmSync(partial, { force: true }); } catch { /* nothing to clean */ }
    if (err instanceof BackupError) throw err;
    throw new BackupError('failed', `The backup failed: ${err.message}`);
  }

  const st = fs.statSync(path.join(backupDir, name));
  return { name, size: st.size, createdAt: parseBackupName(name).createdAt, reason, worlds };
}

// ─── Reading a backup ────────────────────────────────────────────────────────

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

/**
 * Opens a backup and reads its contents list and voxelport-backup.json, without extracting anything.
 * Throws when it is not a readable VoxelPort backup.
 */
async function readBackupInfo(file) {
  let zip;
  try {
    zip = await openZip(file);
  } catch (err) {
    throw new BackupError('bad-backup', `That backup file can't be read (${err.message}).`);
  }
  return new Promise((resolve, reject) => {
    const entries = [];
    let meta = null;
    let uncompressed = 0;
    const fail = (err) => { zip.close(); reject(err instanceof BackupError ? err : new BackupError('bad-backup', `That backup file is damaged (${err.message}).`)); };
    zip.on('error', fail);
    let seen = 0;
    zip.on('entry', (entry) => {
      if (++seen > LIMITS.entries) { fail(new BackupError('too-big', 'That backup is too big to restore.')); return; }
      if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
      entries.push(entry.fileName);
      uncompressed += entry.uncompressedSize;
      if (entry.fileName !== META_NAME) { zip.readEntry(); return; }
      zip.openReadStream(entry, (err, stream) => {
        if (err) { fail(err); return; }
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => { size += c.length; if (size > 64 * 1024) stream.destroy(new Error('metadata is too large')); else chunks.push(c); });
        stream.on('error', fail);
        stream.on('end', () => {
          try { meta = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { fail(e); return; }
          zip.readEntry();
        });
      });
    });
    zip.on('end', () => {
      zip.close();
      if (!meta) { reject(new BackupError('not-voxelport', 'That file is not a VoxelPort backup.')); return; }
      // A backup may only ever put back the folders of its own world, whatever its metadata claims.
      const ownFolders = isPlainName(meta.levelName) ? worldNamesFor(meta.levelName) : [];
      if (meta.format !== FORMAT || !Array.isArray(meta.worlds) || !meta.worlds.length || !meta.worlds.every((w) => ownFolders.includes(w))) {
        reject(new BackupError('bad-backup', 'That backup is from a newer VoxelPort or is damaged.'));
        return;
      }
      if (!entries.includes(`${meta.levelName}/level.dat`)) { reject(new BackupError('bad-backup', 'That backup has no world in it.')); return; }
      resolve({ meta, entries, uncompressed });
    });
    zip.readEntry();
  });
}

/** Extracts every file of a backup into `destDir`, refusing any name that would land outside it. */
function extractAll(file, destDir, onBytes) {
  return openZip(file).then((zip) => new Promise((resolve, reject) => {
    const root = path.resolve(destDir) + path.sep;
    const fail = (err) => { zip.close(); reject(err); };
    zip.on('error', fail);
    zip.on('end', () => { zip.close(); resolve(); });
    zip.on('entry', (entry) => {
      const name = entry.fileName;
      const target = path.resolve(destDir, ...name.split('/'));
      const isSymlink = ((entry.externalFileAttributes >>> 16) & 0xF000) === 0xA000; // VoxelPort never makes one, so one here is not ours
      if (isSymlink || !target.startsWith(root) || name.includes('\\') || name.includes(':') || path.isAbsolute(name)) { fail(new BackupError('unsafe', 'That backup contains a file outside its folder, so it was not restored.')); return; }
      if (/\/$/.test(name)) { fs.mkdirSync(target, { recursive: true }); zip.readEntry(); return; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      zip.openReadStream(entry, (err, rs) => {
        if (err) { fail(err); return; }
        const ws = fs.createWriteStream(target);
        rs.on('data', (c) => onBytes(c.length));
        rs.on('error', fail);
        ws.on('error', fail);
        ws.on('close', () => zip.readEntry());
        rs.pipe(ws);
      });
    });
    zip.readEntry();
  }));
}

// ─── Restoring ───────────────────────────────────────────────────────────────

function renameWithRetry(from, to) {
  // Windows can briefly refuse to move a folder a virus scanner is looking at.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      const until = Date.now() + 250 * (attempt + 1);
      while (Date.now() < until) { /* short wait */ }
    }
  }
}

const rmQuiet = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };

/**
 * Puts a backup back. The server must be stopped. First saves what is there now as a "before-restore"
 * backup (if that fails, nothing is touched), then unpacks into a temporary folder, checks it, and only
 * then swaps the folders over. If the swap fails half way, the old world is put back.
 *
 * Returns { levelName, previousLevelName, safetyBackup }. The caller sets level-name in server.properties.
 */
async function restoreBackup({ backupDir, serverDir, name, info = {}, onProgress = () => {} }) {
  if (!parseBackupName(name)) throw new BackupError('bad-name', 'That is not one of VoxelPort\'s backups.');
  const file = path.join(backupDir, name);
  if (!fs.existsSync(file)) throw new BackupError('missing', 'That backup is gone.');

  onProgress({ phase: 'checking' });
  const { meta, uncompressed } = await readBackupInfo(file);
  if (uncompressed > MAX_RESTORE_BYTES) throw new BackupError('too-big', 'That backup is too big to restore.');
  const free = freeBytes(serverDir);
  if (free !== null && free < uncompressed * 1.05 + SPARE_BYTES) {
    throw new BackupError('disk-full', `Not enough free disk space to restore (needs about ${Math.ceil(uncompressed / MB)} MB).`);
  }

  const previousLevel = levelNameOf(serverDir);
  let safety = null;
  if (existingWorlds(serverDir, previousLevel).length) {
    onProgress({ phase: 'saving-current' });
    safety = await createBackup({ backupDir, serverDir, reason: 'before-restore', info });
  }

  const id = Date.now();
  const tmp = path.join(serverDir, `.vp-restore-${id}`);
  const old = path.join(serverDir, `.vp-old-${id}`);
  const moved = [];
  const placed = [];
  try {
    fs.mkdirSync(tmp, { recursive: true });
    let done = 0;
    onProgress({ phase: 'unpacking', done, total: uncompressed });
    await extractAll(file, tmp, (n) => { done += n; onProgress({ phase: 'unpacking', done, total: uncompressed }); });
    if (!fs.existsSync(path.join(tmp, meta.levelName, 'level.dat'))) throw new BackupError('bad-backup', 'That backup has no world in it.');

    onProgress({ phase: 'swapping' });
    fs.mkdirSync(old, { recursive: true });
    const touched = new Set([...worldNamesFor(previousLevel), ...worldNamesFor(meta.levelName)]);
    for (const w of touched) {
      if (!isRealDirectory(path.join(serverDir, w))) continue;
      renameWithRetry(path.join(serverDir, w), path.join(old, w));
      moved.push(w);
    }
    for (const w of meta.worlds) {
      if (!isRealDirectory(path.join(tmp, w))) continue;
      renameWithRetry(path.join(tmp, w), path.join(serverDir, w));
      placed.push(w);
    }
    for (const f of CONFIG_FILES) {
      const from = path.join(tmp, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(serverDir, f));
    }
  } catch (err) {
    // Put everything back the way it was.
    for (const w of placed) rmQuiet(path.join(serverDir, w));
    for (const w of moved) { try { renameWithRetry(path.join(old, w), path.join(serverDir, w)); } catch { /* keep going: the rest still matters */ } }
    rmQuiet(tmp);
    rmQuiet(old);
    if (err instanceof BackupError) throw err;
    throw new BackupError('failed', `The restore failed and your world was left as it was: ${err.message}`);
  }
  rmQuiet(tmp);
  rmQuiet(old); // the "before restore" backup holds the previous world
  return { levelName: meta.levelName, previousLevelName: previousLevel, safetyBackup: safety ? safety.name : null };
}

// ─── Housekeeping ────────────────────────────────────────────────────────────

function deleteBackup(backupDir, name) {
  if (!parseBackupName(name)) throw new BackupError('bad-name', 'That is not one of VoxelPort\'s backups.');
  fs.rmSync(path.join(backupDir, name), { force: true });
}

/**
 * Removes old automatic backups: keeps the newest `keep` of the automatic ones (and the ones made when the
 * server stopped), then trims further while they take more than the budget (never below the newest two).
 * Manual backups are never removed here; "before restore" copies keep only the last few.
 * Returns the names removed.
 */
function applyRetention(backupDir, { keep = DEFAULTS.keep, budgetBytes = AUTO_BUDGET_BYTES } = {}) {
  const all = listBackups(backupDir);
  const removed = [];
  const drop = (b) => { try { fs.rmSync(path.join(backupDir, b.name), { force: true }); removed.push(b.name); } catch { /* try again next time */ } };

  const automatic = all.filter((b) => b.reason === 'auto' || b.reason === 'stop');
  automatic.slice(keep).forEach(drop);
  let kept = automatic.slice(0, keep);
  let total = kept.reduce((n, b) => n + b.size, 0);
  while (kept.length > 2 && total > budgetBytes) {
    const oldest = kept.pop();
    total -= oldest.size;
    drop(oldest);
  }
  all.filter((b) => b.reason === 'before-restore').slice(KEEP_BEFORE_RESTORE).forEach(drop);
  return removed;
}

module.exports = {
  BackupError, backupSettings, validateBackupSettings, parseBackupName, listBackups, levelNameOf, worldNamesFor,
  existingWorlds, createBackup, readBackupInfo, restoreBackup, deleteBackup, applyRetention,
  META_NAME, DEFAULTS, INTERVAL_RANGE, KEEP_RANGE, CONFIG_FILES, LIMITS,
};

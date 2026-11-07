'use strict';

// Runs backups for the app: makes a running server save first, keeps the schedule, never lets two jobs
// touch the same server at once, and keeps old backups tidy. The file work itself is in backups.js.

const path = require('path');
const backups = require('./backups');
const { stripLogPrefix } = require('./serverProcess');

// What a Minecraft server says when `save-all` is done ("Saved the game"; older versions: "Saved the world").
const SAVED_RE = /^Saved the (?:game|world)$/i; // the whole message, after the log prefix: chat can't pass for it
const PROFILE_ID_RE = /^[0-9a-f-]{36}$/i;
const SAVE_WAIT_MS = 60 * 1000;
const CHECK_EVERY_MS = 60 * 1000;
// A "server stopped" backup is skipped when the last one is this recent.
const RECENT_MS = 2 * 60 * 1000;
const PROGRESS_EVERY_MS = 250;

class BackupService {
  /**
   * @param userDataDir        where VoxelPort keeps its files, or a function that returns it (backups go in <it>/backups/<server id>)
   * @param getProfile         (id) => the server's profile or null
   * @param updateProfile      (id, changes) => updated profile
   * @param serverProc         the running server: { child, status, sendCommand(cmd), on/off('log') }
   * @param isActive           (id) => true while that server's process is running
   * @param send               (channel, payload) => tells the screen
   * @param appVersion         written into each backup
   * @param now / setTimer / clearTimer   replaceable for tests
   */
  constructor({ userDataDir, getProfile, updateProfile, serverProc, isActive, send, appVersion = '', now = Date.now, setTimer = setInterval, clearTimer = clearInterval, saveWaitMs = SAVE_WAIT_MS }) {
    Object.assign(this, { userDataDir, getProfile, updateProfile, serverProc, isActive, send, appVersion, now, setTimer, clearTimer, saveWaitMs });
    this.busy = new Set();
    this.lastAt = new Map(); // server id -> when its last backup finished (ms)
    this.dirty = new Map(); // server id -> true when a player was on since the last backup
    this.timer = null;
    this.watching = null; // the server id the schedule is running for
  }

  dirFor(id) {
    // Profile ids are random UUIDs; anything else (a path, "..") must never become part of a folder name.
    if (typeof id !== 'string' || !PROFILE_ID_RE.test(id)) throw new Error('Invalid server id.');
    const root = typeof this.userDataDir === 'function' ? this.userDataDir() : this.userDataDir;
    return path.join(root, 'backups', id);
  }

  isBusy(id) {
    return this.busy.has(id);
  }

  /** What the Backups screen shows. */
  describe(id) {
    const profile = this.getProfile(id);
    if (!profile) throw new Error('Server profile not found.');
    const dir = this.dirFor(id);
    const level = backups.levelNameOf(profile.serverDir);
    return {
      backups: backups.listBackups(dir),
      settings: backups.backupSettings(profile),
      dir,
      busy: this.isBusy(id),
      running: this.isActive(id),
      hasWorld: backups.existingWorlds(profile.serverDir, level).length > 0,
    };
  }

  setSettings(id, input) {
    const profile = this.getProfile(id);
    if (!profile) throw new Error('Server profile not found.');
    const changes = backups.validateBackupSettings(input);
    const merged = { ...backups.backupSettings(profile), ...changes };
    this.updateProfile(id, { backups: merged });
    if (changes.keep !== undefined) backups.applyRetention(this.dirFor(id), { keep: merged.keep });
    return merged;
  }

  /**
   * Makes a backup now. `reason`: 'manual' | 'auto' | 'stop'. If the server is running it is told to save
   * and to hold its saves while the files are copied; saving is always switched back on afterwards.
   */
  async create(id, reason = 'manual') {
    const profile = this.getProfile(id);
    if (!profile) return { ok: false, error: 'Server profile not found.' };
    if (this.busy.has(id)) return { ok: false, error: 'A backup or restore is already running for this server.', code: 'busy' };
    if (this.isActive(id) && this.serverProc.status !== 'online') {
      return { ok: false, error: 'The server is starting or stopping. Try again in a moment.', code: 'not-ready' };
    }
    this.busy.add(id);

    const live = this.isActive(id) && this.serverProc.status === 'online';
    let savingHeld = false;
    let lastSent = 0;
    const progress = (p) => {
      if (p.done !== undefined && p.done !== p.total && this.now() - lastSent < PROGRESS_EVERY_MS) return;
      lastSent = this.now();
      this.send('backup:progress', { profileId: id, reason, ...p });
    };
    try {
      this.send('backup:progress', { profileId: id, reason, phase: 'starting' });
      if (live) {
        this.send('server:log', '[VoxelPort] Saving the world for a backup…');
        savingHeld = true;
        this.serverProc.sendCommand('save-off');
        const saved = this._waitForLog(SAVED_RE, this.saveWaitMs);
        this.serverProc.sendCommand('save-all flush');
        if (!(await saved)) this.send('server:log', '[VoxelPort] The server was slow to save; backing up what is on disk.');
      }
      const result = await backups.createBackup({
        backupDir: this.dirFor(id),
        serverDir: profile.serverDir,
        reason,
        info: { serverType: profile.type, version: profile.version, appVersion: this.appVersion },
        onProgress: progress,
      });
      const kept = backups.backupSettings(profile).keep;
      backups.applyRetention(this.dirFor(id), { keep: kept });
      this.lastAt.set(id, this.now());
      this.dirty.set(id, this.isActive(id) && this.serverProc.online && this.serverProc.online.size > 0);
      this.send('backup:progress', { profileId: id, reason, phase: 'done', backup: result });
      if (live) this.send('server:log', `[VoxelPort] Backup saved (${result.name}).`);
      return { ok: true, backup: result };
    } catch (err) {
      const code = err.code || 'failed';
      this.send('backup:progress', { profileId: id, reason, phase: 'failed', code, error: err.message });
      if (live) this.send('server:log', `[VoxelPort] Backup failed: ${err.message}`);
      return { ok: false, error: err.message, code };
    } finally {
      if (savingHeld && this.isActive(id)) this.serverProc.sendCommand('save-on');
      this.busy.delete(id);
    }
  }

  /** Puts a backup back. The server must be stopped. Returns { ok, ... } and updates level-name if needed. */
  async restore(id, name, { setLevelName }) {
    const profile = this.getProfile(id);
    if (!profile) return { ok: false, error: 'Server profile not found.' };
    if (this.isActive(id)) return { ok: false, error: 'Stop the server first. A running server would write over the restored world.', code: 'running' };
    if (this.busy.has(id)) return { ok: false, error: 'A backup or restore is already running for this server.', code: 'busy' };
    this.busy.add(id);
    try {
      const res = await backups.restoreBackup({
        backupDir: this.dirFor(id),
        serverDir: profile.serverDir,
        name,
        info: { serverType: profile.type, version: profile.version, appVersion: this.appVersion },
        onProgress: (p) => this.send('backup:progress', { profileId: id, reason: 'restore', ...p }),
      });
      if (res.levelName !== res.previousLevelName) setLevelName(profile.serverDir, res.levelName);
      if (res.restoredServer) this.updateProfile(id, res.restoredServer);
      this.lastAt.set(id, this.now());
      this.dirty.set(id, false);
      this.send('backup:progress', { profileId: id, reason: 'restore', phase: 'done' });
      return { ok: true, ...res };
    } catch (err) {
      const code = err.code || 'failed';
      this.send('backup:progress', { profileId: id, reason: 'restore', phase: 'failed', code, error: err.message });
      return { ok: false, error: err.message, code };
    } finally {
      this.busy.delete(id);
    }
  }

  delete(id, name) {
    if (!this.getProfile(id)) throw new Error('Server profile not found.');
    if (this.busy.has(id)) throw new Error('A backup or restore is running; try again in a moment.');
    backups.deleteBackup(this.dirFor(id), name);
    return { ok: true };
  }

  // ─── The schedule ──────────────────────────────────────────────────────────

  /** The server just came online: start checking whether it is time for a backup. */
  onServerOnline(id) {
    this.stopSchedule();
    const newest = backups.listBackups(this.dirFor(id))[0];
    if (newest) this.lastAt.set(id, Math.max(this.lastAt.get(id) || 0, newest.createdAt));
    this.dirty.set(id, true);
    this.watching = id;
    this.timer = this.setTimer(() => this._tick(), CHECK_EVERY_MS);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  /** A player joined or left. Only a world someone was in is worth another backup. */
  onPlayers(id, count) {
    if (count > 0) this.dirty.set(id, true);
  }

  /** The server stopped. A clean stop gets one last backup, so the finished state is always saved. */
  onServerExit(id, { clean }) {
    this.stopSchedule();
    const profile = this.getProfile(id);
    if (!clean || !profile || !backups.backupSettings(profile).auto) return Promise.resolve();
    const hasAny = backups.listBackups(this.dirFor(id)).length > 0;
    const recent = this.now() - (this.lastAt.get(id) || 0) < RECENT_MS;
    if (recent || (hasAny && !this.dirty.get(id))) return Promise.resolve();
    return this.create(id, 'stop');
  }

  stopSchedule() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.watching = null;
  }

  async _tick() {
    const id = this.watching;
    if (!id || !this.isActive(id) || this.serverProc.status !== 'online') return;
    const profile = this.getProfile(id);
    if (!profile) return;
    const s = backups.backupSettings(profile);
    if (!s.auto || this.busy.has(id)) return;
    const due = this.now() - (this.lastAt.get(id) || 0) >= s.intervalMin * 60 * 1000;
    const hasAny = backups.listBackups(this.dirFor(id)).length > 0;
    if (!due || (hasAny && !this.dirty.get(id))) return;
    await this.create(id, 'auto');
  }

  _waitForLog(re, ms) {
    return new Promise((resolve) => {
      const onLog = (line) => { if (re.test(stripLogPrefix(line))) { done(true); } };
      const timer = setTimeout(() => done(false), ms);
      const done = (ok) => { clearTimeout(timer); this.serverProc.off('log', onLog); resolve(ok); };
      this.serverProc.on('log', onLog);
    });
  }
}

module.exports = { BackupService, SAVED_RE };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { BackupService } = require('../src/main/backupService');

// A profile id is a random UUID, and the service refuses anything else.
const ID = '3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f';
const backups = require('../src/main/backups');

/**
 * A fake running server and a fake profile store, so the service can be tested without Electron:
 * `commands` records what the service typed into the server's console, and the fake answers
 * "save-all flush" with "Saved the game" the way a real server does.
 */
function rig(t, { status = 'online', active = true, answerSave = true, saveWaitMs = 40 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-svc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(path.join(serverDir, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), crypto.randomBytes(300));
  fs.writeFileSync(path.join(serverDir, 'world', 'region', 'r.0.0.mca'), crypto.randomBytes(5000));

  const profiles = new Map([[ID, { id: ID, name: 'Survival', type: 'paper', version: '1.21.11', serverDir }]]);
  const proc = new EventEmitter();
  proc.status = status;
  proc.online = new Set();
  proc.commands = [];
  proc.sendCommand = (cmd) => {
    proc.commands.push(cmd);
    if (cmd === 'save-all flush' && answerSave) setImmediate(() => proc.emit('log', '[Server thread/INFO]: Saved the game'));
  };
  const state = { active, now: 1_000_000_000 };
  const sent = [];
  let timerFn = null;
  const service = new BackupService({
    userDataDir: root,
    getProfile: (id) => profiles.get(id) || null,
    updateProfile: (id, changes) => { const p = { ...profiles.get(id), ...changes }; profiles.set(id, p); return p; },
    serverProc: proc,
    isActive: (id) => state.active && id === ID,
    send: (channel, payload) => sent.push([channel, payload]),
    appVersion: '9.9.9',
    now: () => state.now,
    setTimer: (fn) => { timerFn = fn; return { unref() {} }; },
    clearTimer: () => { timerFn = null; },
    saveWaitMs,
  });
  return { root, serverDir, profiles, proc, state, sent, service, tick: () => timerFn && timerFn(), hasTimer: () => timerFn !== null };
}

const kinds = (r) => backups.listBackups(r.service.dirFor(ID)).map((b) => b.reason);

// ─── Making a backup of a running server ─────────────────────────────────────

test('a running server is told to save, held still while it is copied, and switched back on', async (t) => {
  const r = rig(t);
  const res = await r.service.create(ID, 'manual');
  assert.equal(res.ok, true);
  assert.deepEqual(r.proc.commands, ['save-off', 'save-all flush', 'save-on'], 'in exactly that order');
  assert.deepEqual(kinds(r), ['manual']);
  assert.equal(r.service.isBusy(ID), false);
});

test('saving is switched back on even when the backup fails', async (t) => {
  const r = rig(t);
  fs.rmSync(path.join(r.serverDir, 'world'), { recursive: true });
  const res = await r.service.create(ID, 'manual');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no-world');
  assert.equal(r.proc.commands.at(-1), 'save-on', 'the server must never be left unable to save');
  assert.equal(r.service.isBusy(ID), false);
});

test('a server that never says it saved does not hang the backup', async (t) => {
  const r = rig(t, { answerSave: false, saveWaitMs: 30 });
  const res = await r.service.create(ID, 'manual');
  assert.equal(res.ok, true);
  assert.ok(r.sent.some(([c, p]) => c === 'server:log' && /slow to save/.test(p)));
  assert.equal(r.proc.commands.at(-1), 'save-on');
});

test('a stopped server needs no save commands', async (t) => {
  const r = rig(t, { active: false, status: 'stopped' });
  const res = await r.service.create(ID, 'manual');
  assert.equal(res.ok, true);
  assert.deepEqual(r.proc.commands, []);
});

test('while the server is starting or stopping, a backup is refused instead of copying a moving target', async (t) => {
  for (const status of ['starting', 'stopping']) {
    const r = rig(t, { status });
    const res = await r.service.create(ID, 'manual');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'not-ready');
    assert.deepEqual(r.proc.commands, []);
  }
});

test('two backups at once for one server are refused: one runs, the other is told to wait', async (t) => {
  const r = rig(t, { active: false });
  const first = r.service.create(ID, 'manual');
  const second = await r.service.create(ID, 'manual');
  assert.equal(second.code, 'busy');
  assert.equal((await first).ok, true);
  assert.equal(kinds(r).length, 1);
});

test('progress and the result are reported to the screen, tagged with the server', async (t) => {
  const r = rig(t, { active: false });
  await r.service.create(ID, 'manual');
  const events = r.sent.filter(([c]) => c === 'backup:progress').map(([, p]) => p);
  assert.equal(events[0].phase, 'starting');
  assert.equal(events.at(-1).phase, 'done');
  assert.ok(events.every((e) => e.profileId === ID));
  assert.ok(events.at(-1).backup.name.endsWith('_manual.zip'));
});

test('a failure is reported with a code the screen can explain', async (t) => {
  const r = rig(t, { active: false });
  fs.rmSync(path.join(r.serverDir, 'world'), { recursive: true });
  await r.service.create(ID, 'manual');
  const last = r.sent.filter(([c]) => c === 'backup:progress').at(-1)[1];
  assert.equal(last.phase, 'failed');
  assert.equal(last.code, 'no-world');
});

test('an unknown server is reported, not thrown', async (t) => {
  const r = rig(t);
  assert.deepEqual(await r.service.create('nope', 'manual'), { ok: false, error: 'Server profile not found.' });
});

// ─── The schedule ────────────────────────────────────────────────────────────

test('when the server is online and a backup is due, the schedule makes an automatic one', async (t) => {
  const r = rig(t);
  r.service.onServerOnline(ID);
  assert.ok(r.hasTimer());
  await r.tick();
  assert.deepEqual(kinds(r), ['auto'], 'a server with no backups gets its first one on the first check');
});

test('it waits for the interval (30 minutes by default) between automatic backups', async (t) => {
  const r = rig(t);
  r.service.onServerOnline(ID);
  await r.tick();
  r.service.onPlayers(ID, 1); // someone was on
  r.state.now += 10 * 60 * 1000;
  await r.tick();
  assert.equal(kinds(r).length, 1, 'only 10 minutes later: not yet');
  r.state.now += 21 * 60 * 1000;
  await r.tick();
  assert.equal(kinds(r).length, 2, '31 minutes later: due');
});

test('a world nobody has been in since the last backup is not backed up again', async (t) => {
  const r = rig(t);
  r.service.onServerOnline(ID);
  await r.tick();
  r.state.now += 3 * 60 * 60 * 1000; // three hours with nobody on
  await r.tick();
  assert.equal(kinds(r).length, 1);
  r.service.onPlayers(ID, 2);
  await r.tick();
  assert.equal(kinds(r).length, 2);
});

test('with automatic backups switched off, the schedule does nothing', async (t) => {
  const r = rig(t);
  r.service.setSettings(ID, { auto: false });
  r.service.onServerOnline(ID);
  await r.tick();
  assert.deepEqual(kinds(r), []);
});

test('the interval setting is used', async (t) => {
  const r = rig(t);
  r.service.setSettings(ID, { intervalMin: 5 });
  r.service.onServerOnline(ID);
  await r.tick();
  r.service.onPlayers(ID, 1);
  r.state.now += 6 * 60 * 1000;
  await r.tick();
  assert.equal(kinds(r).length, 2);
});

test('the schedule stops when the server is no longer running', async (t) => {
  const r = rig(t);
  r.service.onServerOnline(ID);
  r.state.active = false;
  await r.tick();
  assert.deepEqual(kinds(r), []);
  r.service.stopSchedule();
  assert.equal(r.hasTimer(), false);
});

test('a backup made by an earlier run counts: restarting the app does not back up again at once', async (t) => {
  const r = rig(t, { active: false });
  await r.service.create(ID, 'manual'); // the clock is the fake one, so the file name uses real time
  const newest = backups.listBackups(r.service.dirFor(ID))[0];
  r.state.now = newest.createdAt + 5 * 60 * 1000;
  r.state.active = true;
  const fresh = new BackupService({ ...r.service, userDataDir: r.root, now: () => r.state.now, setTimer: () => ({ unref() {} }), clearTimer() {} });
  fresh.onServerOnline(ID);
  fresh.onPlayers(ID, 1);
  await fresh._tick();
  assert.equal(kinds(r).length, 1, 'only 5 minutes since the last backup');
});

// ─── When the server stops ───────────────────────────────────────────────────

test('a clean stop gets one last backup', async (t) => {
  const r = rig(t, { active: false, status: 'stopped' });
  r.service.onServerOnline(ID);
  r.service.onPlayers(ID, 1);
  r.state.active = false;
  await r.service.onServerExit(ID, { clean: true });
  assert.deepEqual(kinds(r), ['stop']);
  assert.equal(r.hasTimer(), false);
});

test('a crash gets no automatic backup, so a broken world never replaces a good one', async (t) => {
  const r = rig(t, { active: false, status: 'stopped' });
  await r.service.onServerExit(ID, { clean: false });
  assert.deepEqual(kinds(r), []);
});

test('no stop backup right after another, and none when automatic backups are off', async (t) => {
  const r = rig(t, { active: false, status: 'stopped' });
  await r.service.create(ID, 'manual');
  r.service.dirty.set(ID, true);
  await r.service.onServerExit(ID, { clean: true });
  assert.deepEqual(kinds(r), ['manual'], 'a backup was just made');

  const off = rig(t, { active: false, status: 'stopped' });
  off.service.setSettings(ID, { auto: false });
  await off.service.onServerExit(ID, { clean: true });
  assert.deepEqual(kinds(off), []);
});

// ─── Restoring, settings, deleting ───────────────────────────────────────────

test('a running server cannot be restored over', async (t) => {
  const r = rig(t, { active: false });
  const made = await r.service.create(ID, 'manual');
  r.state.active = true;
  const res = await r.service.restore(ID, made.backup.name, { setLevelName() {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'running');
});

test('restoring puts the world back and frees the server again', async (t) => {
  const r = rig(t, { active: false });
  const region = path.join(r.serverDir, 'world', 'region', 'r.0.0.mca');
  const original = fs.readFileSync(region);
  const made = await r.service.create(ID, 'manual');
  fs.writeFileSync(region, 'ruined');
  const res = await r.service.restore(ID, made.backup.name, { setLevelName() { assert.fail('the world name did not change'); } });
  assert.equal(res.ok, true);
  assert.deepEqual(fs.readFileSync(region), original);
  assert.equal(r.service.isBusy(ID), false);
  assert.ok(kinds(r).includes('before-restore'));
});

test('restoring a world with another name updates level-name through the callback', async (t) => {
  const r = rig(t, { active: false });
  const made = await r.service.create(ID, 'manual');
  fs.renameSync(path.join(r.serverDir, 'world'), path.join(r.serverDir, 'other'));
  fs.writeFileSync(path.join(r.serverDir, 'server.properties'), 'level-name=other\n');
  const calls = [];
  const res = await r.service.restore(ID, made.backup.name, { setLevelName: (dir, level) => calls.push([dir, level]) });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [[r.serverDir, 'world']]);
});

test('a failed restore reports why and frees the server', async (t) => {
  const r = rig(t, { active: false });
  const res = await r.service.restore(ID, '2020-01-01_00-00-00_manual.zip', { setLevelName() {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing');
  assert.equal(r.service.isBusy(ID), false);
});

test('settings are saved on the profile, checked, and lowering "keep" trims old backups at once', async (t) => {
  const r = rig(t, { active: false });
  for (let i = 1; i <= 4; i++) {
    fs.mkdirSync(r.service.dirFor(ID), { recursive: true });
    fs.writeFileSync(path.join(r.service.dirFor(ID), `2026-10-0${i}_10-00-00_auto.zip`), 'x');
  }
  const saved = r.service.setSettings(ID, { keep: 2, intervalMin: 60 });
  assert.deepEqual(saved, { auto: true, intervalMin: 60, keep: 2 });
  assert.deepEqual(r.profiles.get(ID).backups, saved);
  assert.equal(kinds(r).length, 2);
  assert.throws(() => r.service.setSettings(ID, { keep: 0 }));
  assert.throws(() => r.service.setSettings('nope', { keep: 3 }));
});

test('describe gives the screen everything it shows', async (t) => {
  const r = rig(t, { active: false });
  await r.service.create(ID, 'manual');
  const d = r.service.describe(ID);
  assert.equal(d.backups.length, 1);
  assert.deepEqual(d.settings, { auto: true, intervalMin: 30, keep: 5 });
  assert.equal(d.hasWorld, true);
  assert.equal(d.running, false);
  assert.equal(d.busy, false);
  assert.ok(d.dir.endsWith(path.join('backups', ID)));
});

test('a backup can be deleted, but not while a job is running on that server', async (t) => {
  const r = rig(t, { active: false });
  const made = await r.service.create(ID, 'manual');
  r.service.busy.add(ID);
  assert.throws(() => r.service.delete(ID, made.backup.name), /running/);
  r.service.busy.delete(ID);
  r.service.delete(ID, made.backup.name);
  assert.deepEqual(kinds(r), []);
});

// ─── The "saved" line is the server's, not a player's ────────────────────────

test('K3: only the server\'s own "Saved the game" counts, in the Vanilla and the Paper format', async (t) => {
  const r = rig(t, { answerSave: false, saveWaitMs: 400 });
  r.proc.sendCommand = (cmd) => {
    r.proc.commands.push(cmd);
    if (cmd === 'save-all flush') {
      setImmediate(() => {
        r.proc.emit('log', '[12:00:00 INFO]: <Steve> Saved the game'); // a player typing it
        r.proc.emit('log', '[12:00:00 INFO]: [Not Secure] <Steve> Saved the game');
        r.proc.emit('log', '[12:00:00 INFO]: <Steve> x: Saved the world');
      });
    }
  };
  const res = await r.service.create(ID, 'manual');
  assert.equal(res.ok, true);
  assert.ok(r.sent.some(([c, p]) => c === 'server:log' && /slow to save/.test(p)), 'chat did not end the wait');
});

test('K3: the real "Saved the game" line ends the wait, in both log formats', async (t) => {
  for (const line of ['[12:00:00] [Server thread/INFO]: Saved the game', '[12:00:00 INFO]: Saved the game', '[12:00:00 INFO]: Saved the world']) {
    const r = rig(t, { answerSave: false, saveWaitMs: 400 });
    r.proc.sendCommand = (cmd) => { r.proc.commands.push(cmd); if (cmd === 'save-all flush') setImmediate(() => r.proc.emit('log', line)); };
    const res = await r.service.create(ID, 'manual');
    assert.equal(res.ok, true);
    assert.ok(!r.sent.some(([c, p]) => c === 'server:log' && /slow to save/.test(p)), line);
  }
});

// ─── H1: an id is never part of a path ───────────────────────────────────────

test('H1: dirFor only accepts a profile id, never something that reaches outside the backups folder', (t) => {
  const r = rig(t);
  assert.equal(path.basename(r.service.dirFor(ID)), ID);
  assert.equal(path.basename(path.dirname(r.service.dirFor(ID))), 'backups');
  for (const bad of ['../x', '..', '../../etc', 'srv1', '', ID + '/..', ID.replace(/.$/, 'g'), undefined, null, 5, {}]) {
    assert.throws(() => r.service.dirFor(bad), /Invalid server id/, String(bad));
  }
});

test('H1: the backup actions refuse a bad id before touching anything', async (t) => {
  const r = rig(t);
  const outside = path.join(r.root, 'keep.txt');
  fs.writeFileSync(outside, 'not a backup');
  assert.throws(() => r.service.delete('../x', '2026-01-01_00-00-00_manual.zip'), /Server profile not found|Invalid server id/);
  assert.equal((await r.service.create('../x', 'manual')).ok, false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'not a backup');
  assert.ok(!fs.existsSync(path.join(r.root, 'backups', '..', 'x')));
});

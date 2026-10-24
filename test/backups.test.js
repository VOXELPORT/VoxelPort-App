'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');
const yauzl = require('yauzl');
const backups = require('../src/main/backups');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A scratch folder with a fake server in it: a world with a Nether and some region files. */
function fakeServer(t, { level = 'world', withNether = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-backup-'));
  // Let pending archive closes finish, and retry transient Windows directory locks.
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const serverDir = path.join(root, 'server');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(path.join(serverDir, level, 'region'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.properties'), `motd=Test\nlevel-name=${level}\nserver-port=25565\n`);
  fs.writeFileSync(path.join(serverDir, level, 'level.dat'), crypto.randomBytes(2000));
  fs.writeFileSync(path.join(serverDir, level, 'region', 'r.0.0.mca'), crypto.randomBytes(50_000));
  fs.writeFileSync(path.join(serverDir, level, 'region', 'r.0.1.mca'), crypto.randomBytes(30_000));
  fs.writeFileSync(path.join(serverDir, level, 'session.lock'), 'held by the running server');
  if (withNether) {
    fs.mkdirSync(path.join(serverDir, `${level}_nether`, 'DIM-1'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, `${level}_nether`, 'level.dat'), crypto.randomBytes(500));
  }
  fs.writeFileSync(path.join(serverDir, 'ops.json'), '[{"name":"Steve"}]');
  fs.writeFileSync(path.join(serverDir, 'server.jar'), 'server executable');
  fs.mkdirSync(path.join(serverDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'plugins', 'keep.yml'), 'a plugin file');
  return { root, serverDir, backupDir, level };
}

function listZipNames(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const names = [];
      zip.on('entry', (e) => { names.push(e.fileName); zip.readEntry(); });
      zip.on('error', reject);
      zip.on('close', () => resolve(names));
      zip.readEntry();
    });
  });
}

const make = (s, reason = 'manual', extra = {}) => backups.createBackup({ backupDir: s.backupDir, serverDir: s.serverDir, reason, ...extra });

// ─── Making a backup ─────────────────────────────────────────────────────────

test('a backup holds the world, the Nether, server jar and player lists', async (t) => {
  const s = fakeServer(t);
  const b = await make(s);
  const names = await listZipNames(path.join(s.backupDir, b.name));
  assert.ok(names.includes('world/level.dat'));
  assert.ok(names.includes('world/region/r.0.0.mca'));
  assert.ok(names.includes('world_nether/level.dat'));
  assert.ok(names.includes('ops.json'));
  assert.ok(names.includes(backups.META_NAME));
  assert.ok(!names.some((n) => n.includes('session.lock')), 'the lock the server holds is never saved');
  assert.ok(names.includes('server.jar'), 'the server executable is saved');
  assert.ok(!names.some((n) => n.startsWith('plugins/')), 'plugins are not included');
  assert.deepEqual(b.worlds.sort(), ['world', 'world_nether']);
  assert.ok(b.size > 0);
});

test('restoring includes the original jar and the safety backup can undo the jar change', async (t) => {
  const s = fakeServer(t);
  const jar = path.join(s.serverDir, 'server.jar');
  fs.writeFileSync(jar, 'original server executable');
  const b = await make(s);
  const { meta } = await backups.readBackupInfo(path.join(s.backupDir, b.name));
  assert.deepEqual(meta.serverFiles, ['server.jar']);
  fs.writeFileSync(jar, 'updated server executable');
  const result = await backups.restoreBackup({ ...s, name: b.name });
  assert.equal(fs.readFileSync(jar, 'utf8'), 'original server executable');
  await backups.restoreBackup({ ...s, name: result.safetyBackup });
  assert.equal(fs.readFileSync(jar, 'utf8'), 'updated server executable');
});

test('a world-only backup leaves the currently installed jar alone', async (t) => {
  const s = fakeServer(t);
  const jar = path.join(s.serverDir, 'server.jar');
  fs.unlinkSync(jar);
  const b = await make(s);
  fs.writeFileSync(jar, 'keep this installed executable');
  await backups.restoreBackup({ ...s, name: b.name });
  assert.equal(fs.readFileSync(jar, 'utf8'), 'keep this installed executable');
});

test('jar restore failure rolls back the world and current jar', async (t) => {
  const s = fakeServer(t);
  const b = await make(s);
  const jar = path.join(s.serverDir, 'server.jar');
  const region = path.join(s.serverDir, 'world', 'region', 'r.0.0.mca');
  fs.writeFileSync(jar, 'current jar');
  fs.writeFileSync(region, 'current world');
  const original = fs.copyFileSync;
  fs.copyFileSync = (from, to, ...rest) => {
    if (String(from).includes('.vp-restore-') && String(from).endsWith('server.jar')) throw new Error('jar write failed');
    return original(from, to, ...rest);
  };
  t.after(() => { fs.copyFileSync = original; });
  await assert.rejects(backups.restoreBackup({ ...s, name: b.name }), /restore failed/);
  assert.equal(fs.readFileSync(jar, 'utf8'), 'current jar');
  assert.equal(fs.readFileSync(region, 'utf8'), 'current world');
});

test('the backup is named by time and why it was made, and shows up in the list, newest first', async (t) => {
  const s = fakeServer(t);
  const early = await make(s, 'auto', { now: new Date(2026, 9, 16, 10, 0, 0) });
  const late = await make(s, 'manual', { now: new Date(2026, 9, 16, 11, 30, 5) });
  assert.equal(early.name, '2026-10-16_10-00-00_auto.zip');
  assert.equal(late.name, '2026-10-16_11-30-05_manual.zip');
  const list = backups.listBackups(s.backupDir);
  assert.deepEqual(list.map((b) => b.name), [late.name, early.name]);
  assert.deepEqual(list.map((b) => b.reason), ['manual', 'auto']);
  assert.equal(list[0].createdAt, new Date(2026, 9, 16, 11, 30, 5).getTime());
});

test('two backups in the same second do not overwrite each other', async (t) => {
  const s = fakeServer(t);
  const when = new Date(2026, 0, 2, 3, 4, 5);
  const a = await make(s, 'manual', { now: when });
  const b = await make(s, 'manual', { now: when });
  assert.notEqual(a.name, b.name);
  assert.equal(backups.listBackups(s.backupDir).length, 2);
});

test('the metadata records what the backup is', async (t) => {
  const s = fakeServer(t);
  const b = await make(s, 'stop', { info: { serverType: 'paper', version: '1.21.11', appVersion: '1.8.0' } });
  const { meta } = await backups.readBackupInfo(path.join(s.backupDir, b.name));
  assert.equal(meta.levelName, 'world');
  assert.equal(meta.reason, 'stop');
  assert.equal(meta.serverType, 'paper');
  assert.equal(meta.version, '1.21.11');
  assert.equal(meta.appVersion, '1.8.0');
});

test('a world with another name (level-name) is found and backed up', async (t) => {
  const s = fakeServer(t, { level: 'Survival World', withNether: false });
  const b = await make(s);
  assert.deepEqual(b.worlds, ['Survival World']);
});

test('a level-name that is a path, not a name, is ignored: the default world is used', (t) => {
  const s = fakeServer(t);
  fs.writeFileSync(path.join(s.serverDir, 'server.properties'), 'level-name=../../secrets\n');
  assert.equal(backups.levelNameOf(s.serverDir), 'world');
  fs.writeFileSync(path.join(s.serverDir, 'server.properties'), 'level-name=\n');
  assert.equal(backups.levelNameOf(s.serverDir), 'world');
});

test('with no world yet, it says so plainly and leaves nothing behind', async (t) => {
  const s = fakeServer(t);
  fs.rmSync(path.join(s.serverDir, 'world'), { recursive: true });
  fs.rmSync(path.join(s.serverDir, 'world_nether'), { recursive: true });
  await assert.rejects(make(s), (err) => err.code === 'no-world' && /start the server once/i.test(err.message));
  assert.deepEqual(fs.existsSync(s.backupDir) ? fs.readdirSync(s.backupDir) : [], []);
});

test('a failed backup leaves no half-written file that could pass for a good one', async (t) => {
  const s = fakeServer(t);
  const original = fs.createReadStream;
  fs.createReadStream = (file, ...rest) => {
    if (String(file).endsWith('r.0.1.mca')) throw new Error('disk error');
    return original.call(fs, file, ...rest);
  };
  t.after(() => { fs.createReadStream = original; });
  await assert.rejects(make(s), (err) => err.code === 'failed');
  fs.createReadStream = original;
  assert.deepEqual(fs.readdirSync(s.backupDir), []);
});

// ─── Restoring ───────────────────────────────────────────────────────────────

test('failed backup closes its output before deleting the partial file', async (t) => {
  const s = fakeServer(t);
  const originalWrite = fs.createWriteStream;
  const originalRemove = fs.rmSync;
  let output, checked = false;
  t.mock.method(fs, 'createWriteStream', (...args) => {
    output = originalWrite.apply(fs, args);
    return output;
  });
  t.mock.method(fs, 'rmSync', (file, ...args) => {
    if (String(file).endsWith('.partial')) {
      checked = true;
      assert.equal(output.closed, true, 'partial file must be closed before deletion');
    }
    return originalRemove.call(fs, file, ...args);
  });
  await assert.rejects(make(s, 'manual', { onProgress() { throw new Error('early failure'); } }),
    (err) => err.code === 'failed');
  assert.equal(checked, true);
  assert.equal(output.closed, true);
  assert.deepEqual(fs.readdirSync(s.backupDir), []);
  t.mock.restoreAll();
});

test('restoring puts the world back exactly, even after it was wrecked', async (t) => {
  const s = fakeServer(t);
  const region = path.join(s.serverDir, 'world', 'region', 'r.0.0.mca');
  const before = sha(region);
  const b = await make(s);

  fs.writeFileSync(region, 'corrupted by a creeper');
  fs.rmSync(path.join(s.serverDir, 'world', 'region', 'r.0.1.mca'));
  fs.writeFileSync(path.join(s.serverDir, 'world', 'new-junk.txt'), 'built after the backup');
  fs.writeFileSync(path.join(s.serverDir, 'ops.json'), '[]');

  const res = await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name });
  assert.equal(sha(region), before);
  assert.ok(fs.existsSync(path.join(s.serverDir, 'world', 'region', 'r.0.1.mca')));
  assert.ok(!fs.existsSync(path.join(s.serverDir, 'world', 'new-junk.txt')), 'what was built after the backup is gone from the world');
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'ops.json'), 'utf8'), '[{"name":"Steve"}]');
  assert.equal(res.levelName, 'world');
  assert.ok(fs.existsSync(path.join(s.serverDir, 'plugins', 'keep.yml')), 'plugins are not touched');
  assert.ok(fs.existsSync(path.join(s.serverDir, 'server.jar')));
});

test('before restoring, the current world is saved, so a restore can be undone', async (t) => {
  const s = fakeServer(t);
  const b = await make(s, 'manual', { now: new Date(2026, 9, 1, 8, 0, 0) });
  fs.writeFileSync(path.join(s.serverDir, 'world', 'important-new-build.txt'), 'two hours of work');

  const res = await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name });
  assert.match(res.safetyBackup, /_before-restore\.zip$/);
  assert.ok(!fs.existsSync(path.join(s.serverDir, 'world', 'important-new-build.txt')));

  // Restoring the safety copy brings the new build back.
  await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: res.safetyBackup });
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'world', 'important-new-build.txt'), 'utf8'), 'two hours of work');
});

test('no temporary folders are left in the server folder after a restore', async (t) => {
  const s = fakeServer(t);
  const b = await make(s);
  await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name });
  assert.deepEqual(fs.readdirSync(s.serverDir).filter((n) => n.startsWith('.vp-')), []);
});

test('restoring a backup that used another world name reports it, so level-name can follow', async (t) => {
  const s = fakeServer(t, { level: 'oldworld', withNether: false });
  const b = await make(s);
  // The server has since been switched to a different world.
  fs.rmSync(path.join(s.serverDir, 'oldworld'), { recursive: true });
  fs.mkdirSync(path.join(s.serverDir, 'newworld'));
  fs.writeFileSync(path.join(s.serverDir, 'newworld', 'level.dat'), 'x');
  fs.writeFileSync(path.join(s.serverDir, 'server.properties'), 'level-name=newworld\n');

  const res = await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name });
  assert.equal(res.levelName, 'oldworld');
  assert.equal(res.previousLevelName, 'newworld');
  assert.ok(fs.existsSync(path.join(s.serverDir, 'oldworld', 'level.dat')));
  assert.ok(!fs.existsSync(path.join(s.serverDir, 'newworld')), 'the other world was moved out of the way (and saved in the safety backup)');
});

test('if the swap fails half way, the old world is put back untouched', async (t) => {
  const s = fakeServer(t);
  const b = await make(s);
  const region = path.join(s.serverDir, 'world', 'region', 'r.0.0.mca');
  fs.writeFileSync(region, 'the world as it is now');

  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    // The first moves set the old world aside; fail when the restored one is moved in.
    if (String(from).includes('.vp-restore-') && ++calls === 1) { const e = new Error('simulated failure'); e.code = 'EIO'; throw e; }
    return real(from, to);
  };
  t.after(() => { fs.renameSync = real; });

  await assert.rejects(
    backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name }),
    (err) => err.code === 'failed' && /left as it was/.test(err.message),
  );
  fs.renameSync = real;
  assert.equal(fs.readFileSync(region, 'utf8'), 'the world as it is now');
  assert.ok(fs.existsSync(path.join(s.serverDir, 'world_nether', 'level.dat')));
  assert.deepEqual(fs.readdirSync(s.serverDir).filter((n) => n.startsWith('.vp-')), []);
});

test('a name that is not one of our backups is refused, including path tricks', async (t) => {
  const s = fakeServer(t);
  for (const bad of ['../../etc/passwd', 'x.zip', '2026-10-16_10-00-00_auto.zip/../../x', '..\\..\\x.zip', '']) {
    await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: bad }), (e) => e.code === 'bad-name');
    assert.throws(() => backups.deleteBackup(s.backupDir, bad), (e) => e.code === 'bad-name');
  }
});

test('a zip that is not a VoxelPort backup, or is damaged, is refused before anything is touched', async (t) => {
  const s = fakeServer(t);
  fs.mkdirSync(s.backupDir, { recursive: true });
  const worldBefore = sha(path.join(s.serverDir, 'world', 'level.dat'));

  // A real zip, but not ours: no voxelport-backup.json.
  const plain = new yazl.ZipFile();
  plain.addBuffer(Buffer.from('hello'), 'hello.txt');
  plain.end();
  const foreign = path.join(s.backupDir, '2026-01-01_00-00-00_manual.zip');
  await new Promise((resolve) => plain.outputStream.pipe(fs.createWriteStream(foreign)).on('close', resolve));
  await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: path.basename(foreign) }), (e) => e.code === 'not-voxelport');

  // A damaged one.
  const good = await make(s, 'manual', { now: new Date(2026, 1, 1, 1, 1, 1) });
  const goodPath = path.join(s.backupDir, good.name);
  const bytes = fs.readFileSync(goodPath);
  fs.writeFileSync(goodPath, bytes.subarray(0, Math.floor(bytes.length / 2)));
  await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: good.name }), (e) => e.code === 'bad-backup');

  assert.equal(sha(path.join(s.serverDir, 'world', 'level.dat')), worldBefore, 'the world was not touched');
  assert.deepEqual(fs.readdirSync(s.serverDir).filter((n) => n.startsWith('.vp-')), []);
});

test('a backup that tries to write outside the server folder (zip slip) is refused', async (t) => {
  const s = fakeServer(t);
  fs.mkdirSync(s.backupDir, { recursive: true });
  // yazl will not write ".." names, so make a normal one of the same length and patch the bytes.
  const zip = new yazl.ZipFile();
  const meta = { format: 1, createdAt: new Date().toISOString(), reason: 'manual', levelName: 'world', worlds: ['world'] };
  zip.addBuffer(Buffer.from(JSON.stringify(meta)), backups.META_NAME);
  zip.addBuffer(Buffer.from('x'), 'world/level.dat');
  zip.addBuffer(Buffer.from('pwned'), 'ab/cd/evil.txt');
  zip.end();
  const chunks = [];
  await new Promise((resolve) => zip.outputStream.on('data', (c) => chunks.push(c)).on('end', resolve));
  const patched = Buffer.from(Buffer.concat(chunks).toString('latin1').split('ab/cd/evil.txt').join('../../evil.txt'), 'latin1');
  const name = '2026-02-02_02-02-02_manual.zip';
  fs.writeFileSync(path.join(s.backupDir, name), patched);

  await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name }));
  assert.ok(!fs.existsSync(path.join(s.root, 'evil.txt')) && !fs.existsSync(path.join(path.dirname(s.root), 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(s.serverDir, '..', '..', 'evil.txt')));
});

test('metadata that names other folders (like plugins) cannot make a restore replace them', async (t) => {
  const s = fakeServer(t);
  fs.mkdirSync(s.backupDir, { recursive: true });
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ format: 1, createdAt: 'x', reason: 'manual', levelName: 'world', worlds: ['world', 'plugins'] })), backups.META_NAME);
  zip.addBuffer(Buffer.from('x'), 'world/level.dat');
  zip.addBuffer(Buffer.from('evil'), 'plugins/evil.jar');
  zip.end();
  const name = '2026-03-03_03-03-03_manual.zip';
  await new Promise((resolve) => zip.outputStream.pipe(fs.createWriteStream(path.join(s.backupDir, name))).on('close', resolve));

  await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name }), (e) => e.code === 'bad-backup');
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'plugins', 'keep.yml'), 'utf8'), 'a plugin file');
  assert.ok(!fs.existsSync(path.join(s.serverDir, 'plugins', 'evil.jar')));
});

// ─── Housekeeping ────────────────────────────────────────────────────────────

/** Backup files that are only the right name and size: retention only looks at names and sizes. */
function dummyBackups(dir, specs) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, size] of specs) fs.writeFileSync(path.join(dir, name), Buffer.alloc(size));
}

test('retention keeps the newest automatic backups and never touches manual ones', (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ret-')), 'b');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  dummyBackups(dir, [
    ['2026-10-01_10-00-00_manual.zip', 10],
    ['2026-10-02_10-00-00_auto.zip', 10],
    ['2026-10-03_10-00-00_auto.zip', 10],
    ['2026-10-04_10-00-00_stop.zip', 10],
    ['2026-10-05_10-00-00_auto.zip', 10],
  ]);
  const removed = backups.applyRetention(dir, { keep: 2 });
  assert.deepEqual(removed.sort(), ['2026-10-02_10-00-00_auto.zip', '2026-10-03_10-00-00_auto.zip']);
  assert.deepEqual(backups.listBackups(dir).map((b) => b.name), ['2026-10-05_10-00-00_auto.zip', '2026-10-04_10-00-00_stop.zip', '2026-10-01_10-00-00_manual.zip']);
});

test('retention also trims by total size, but always keeps the newest two', (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ret-')), 'b');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  dummyBackups(dir, [
    ['2026-10-01_10-00-00_auto.zip', 400],
    ['2026-10-02_10-00-00_auto.zip', 400],
    ['2026-10-03_10-00-00_auto.zip', 400],
    ['2026-10-04_10-00-00_auto.zip', 400],
  ]);
  backups.applyRetention(dir, { keep: 10, budgetBytes: 900 });
  assert.deepEqual(backups.listBackups(dir).map((b) => b.name), ['2026-10-04_10-00-00_auto.zip', '2026-10-03_10-00-00_auto.zip']);
  backups.applyRetention(dir, { keep: 10, budgetBytes: 1 });
  assert.equal(backups.listBackups(dir).length, 2, 'never below the newest two, however small the budget');
});

test('only the last three "before restore" copies are kept', (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ret-')), 'b');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  dummyBackups(dir, [1, 2, 3, 4, 5].map((d) => [`2026-10-0${d}_10-00-00_before-restore.zip`, 5]));
  backups.applyRetention(dir, {});
  assert.equal(backups.listBackups(dir).length, 3);
  assert.equal(backups.listBackups(dir)[2].name, '2026-10-03_10-00-00_before-restore.zip');
});

test('only our own file names are listed: other files in the folder are ignored', (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ret-')), 'b');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  dummyBackups(dir, [['notes.txt', 1], ['2026-10-01_10-00-00_auto.zip.partial', 1], ['2026-10-01_10-00-00_oops.zip', 1], ['2026-10-01_10-00-00_auto.zip', 1]]);
  assert.deepEqual(backups.listBackups(dir).map((b) => b.name), ['2026-10-01_10-00-00_auto.zip']);
  assert.deepEqual(backups.listBackups(path.join(dir, 'missing')), []);
});

test('deleting a backup removes just that file', async (t) => {
  const s = fakeServer(t);
  const a = await make(s, 'manual', { now: new Date(2026, 5, 1, 1, 0, 0) });
  const b = await make(s, 'manual', { now: new Date(2026, 5, 1, 2, 0, 0) });
  backups.deleteBackup(s.backupDir, a.name);
  assert.deepEqual(backups.listBackups(s.backupDir).map((x) => x.name), [b.name]);
});

// ─── Settings ────────────────────────────────────────────────────────────────

test('backup settings default to on, every 30 minutes, keeping 5', () => {
  assert.deepEqual(backups.backupSettings({}), { auto: true, intervalMin: 30, keep: 5 });
  assert.deepEqual(backups.backupSettings(null), { auto: true, intervalMin: 30, keep: 5 });
});

test('stored settings are used, and out-of-range ones fall back to the defaults', () => {
  assert.deepEqual(backups.backupSettings({ backups: { auto: false, intervalMin: 60, keep: 10 } }), { auto: false, intervalMin: 60, keep: 10 });
  assert.deepEqual(backups.backupSettings({ backups: { auto: 'yes', intervalMin: 1, keep: 999 } }), { auto: true, intervalMin: 30, keep: 5 });
});

test('settings from the screen are checked', () => {
  assert.deepEqual(backups.validateBackupSettings({ auto: false, intervalMin: '15', keep: 3 }), { auto: false, intervalMin: 15, keep: 3 });
  assert.deepEqual(backups.validateBackupSettings({ keep: 7 }), { keep: 7 });
  assert.throws(() => backups.validateBackupSettings({ auto: 'yes' }));
  assert.throws(() => backups.validateBackupSettings({ intervalMin: 2 }));
  assert.throws(() => backups.validateBackupSettings({ keep: 0 }));
  assert.throws(() => backups.validateBackupSettings({ keep: 1.5 }));
  assert.throws(() => backups.validateBackupSettings(null));
});

test('progress is reported while zipping', async (t) => {
  const s = fakeServer(t);
  const seen = [];
  await make(s, 'manual', { onProgress: (p) => seen.push(p) });
  assert.ok(seen.length >= 2 && seen.every((p) => p.phase === 'zipping'));
  assert.equal(seen[0].done, 0);
  assert.equal(seen.at(-1).done, seen.at(-1).total, 'finishes at 100%');
});

// ─── Archives that are traps ─────────────────────────────────────────────────

/** A backup file whose entries are exactly `files` ({ name, data, mode? }), with the metadata a real one has. */
async function craftedBackup(s, name, files) {
  fs.mkdirSync(s.backupDir, { recursive: true });
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ format: 1, createdAt: new Date().toISOString(), reason: 'manual', levelName: 'world', worlds: ['world'] })), backups.META_NAME);
  for (const f of files) zip.addBuffer(Buffer.from(f.data), f.name, f.mode ? { mode: f.mode } : undefined);
  zip.end();
  await new Promise((resolve) => zip.outputStream.pipe(fs.createWriteStream(path.join(s.backupDir, name))).on('close', resolve));
}

test('a backup holding a symbolic link is refused, and the current world is left alone', async (t) => {
  const s = fakeServer(t);
  await craftedBackup(s, '2026-04-04_04-04-04_manual.zip', [
    { name: 'world/level.dat', data: 'x' },
    { name: 'world/escape', data: '/etc/passwd', mode: 0o120777 }, // a symlink entry
  ]);
  const before = fs.readFileSync(path.join(s.serverDir, 'world', 'level.dat'));
  await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: '2026-04-04_04-04-04_manual.zip' }), (e) => e.code === 'unsafe');
  assert.deepEqual(fs.readFileSync(path.join(s.serverDir, 'world', 'level.dat')), before);
  assert.deepEqual(fs.readdirSync(s.serverDir).filter((n) => n.startsWith('.vp-')), [], 'no half-unpacked folder left behind');
});

test('a backup with more entries than any world has is refused', async (t) => {
  const s = fakeServer(t);
  await craftedBackup(s, '2026-05-05_05-05-05_manual.zip', [
    { name: 'world/level.dat', data: 'x' }, { name: 'world/a', data: '1' }, { name: 'world/b', data: '2' }, { name: 'world/c', data: '3' },
  ]);
  const old = backups.LIMITS.entries;
  backups.LIMITS.entries = 3;
  try {
    await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: '2026-05-05_05-05-05_manual.zip' }), (e) => e.code === 'too-big');
    backups.LIMITS.entries = 100;
    const res = await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: '2026-05-05_05-05-05_manual.zip' });
    assert.ok(res, 'the same backup restores when it is under the limit');
  } finally {
    backups.LIMITS.entries = old;
  }
});

test('the entry limit is high enough for any real world and low enough to stop a trap', () => {
  assert.ok(backups.LIMITS.entries >= 100_000 && backups.LIMITS.entries <= 5_000_000);
});

// ─── A restore saves everything it is about to move ──────────────────────────

test('D1: restoring a backup of one world while the server points at another saves the current world of both names', async (t) => {
  const s = fakeServer(t, { withNether: false });
  const b = await make(s, 'manual', { now: new Date(2026, 9, 1, 8, 0, 0) });
  // The player keeps building in `world`, then the server is switched to `world2`.
  fs.writeFileSync(path.join(s.serverDir, 'world', 'two-hours-of-work.txt'), 'the changed world');
  fs.writeFileSync(path.join(s.serverDir, 'server.properties'), 'level-name=world2\n');

  const res = await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name });
  assert.match(res.safetyBackup, /_before-restore\.zip$/);
  assert.ok(!fs.existsSync(path.join(s.serverDir, 'world', 'two-hours-of-work.txt')), 'the restore replaced it');

  // The copy made first holds the world that was replaced, so the restore can be undone.
  const names = await listZipNames(path.join(s.backupDir, res.safetyBackup));
  assert.ok(names.includes('world/two-hours-of-work.txt'));
  fs.writeFileSync(path.join(s.serverDir, 'server.properties'), 'level-name=world\n');
  await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: res.safetyBackup });
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'world', 'two-hours-of-work.txt'), 'utf8'), 'the changed world');
});

test('D1: both worlds are in the copy when both exist, and each comes back from it', async (t) => {
  const s = fakeServer(t, { withNether: false });
  const b = await make(s, 'manual', { now: new Date(2026, 9, 1, 8, 0, 0) });
  fs.mkdirSync(path.join(s.serverDir, 'creative'));
  fs.writeFileSync(path.join(s.serverDir, 'creative', 'level.dat'), 'creative world');
  fs.writeFileSync(path.join(s.serverDir, 'creative', 'castle.txt'), 'a castle');
  fs.writeFileSync(path.join(s.serverDir, 'world', 'house.txt'), 'a house');
  fs.writeFileSync(path.join(s.serverDir, 'server.properties'), 'level-name=creative\n');

  const res = await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name });
  const names = await listZipNames(path.join(s.backupDir, res.safetyBackup));
  assert.ok(names.includes('creative/castle.txt'));
  assert.ok(names.includes('world/house.txt'));
  assert.ok(!fs.existsSync(path.join(s.serverDir, 'creative')), 'the other world was moved out of the way');

  await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: res.safetyBackup });
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'world', 'house.txt'), 'utf8'), 'a house');
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'creative', 'castle.txt'), 'utf8'), 'a castle', 'the second world comes back too');
});

test('D1b: if a restore fails after the player lists were replaced, they are put back as they were', async (t) => {
  const s = fakeServer(t);
  fs.writeFileSync(path.join(s.serverDir, 'whitelist.json'), '["from the backup"]');
  const b = await make(s);
  fs.writeFileSync(path.join(s.serverDir, 'whitelist.json'), '["current whitelist"]');
  fs.writeFileSync(path.join(s.serverDir, 'ops.json'), '["current ops"]');
  fs.writeFileSync(path.join(s.serverDir, 'banned-ips.json'), '["current bans"]');

  const real = fs.copyFileSync;
  fs.copyFileSync = (from, to, ...rest) => {
    if (String(to) === path.join(s.serverDir, 'ops.json')) { const e = new Error('simulated failure'); e.code = 'EIO'; throw e; } // after whitelist.json was replaced
    return real(from, to, ...rest);
  };
  t.after(() => { fs.copyFileSync = real; });
  await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name }), (e) => e.code === 'failed');
  fs.copyFileSync = real;

  assert.equal(fs.readFileSync(path.join(s.serverDir, 'whitelist.json'), 'utf8'), '["current whitelist"]');
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'ops.json'), 'utf8'), '["current ops"]');
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'banned-ips.json'), 'utf8'), '["current bans"]');
  assert.deepEqual(fs.readdirSync(s.serverDir).filter((n) => n.startsWith('.vp-')), []);
});

test('D1: a backup cannot name the server\'s own folders as worlds, even in a copy that claims to be a before-restore one', async (t) => {
  const s = fakeServer(t);
  fs.mkdirSync(s.backupDir, { recursive: true });
  const claims = [
    ['2026-06-01_01-01-01_manual.zip', { reason: 'manual', levelName: 'plugins', worlds: ['plugins'] }, 'plugins/level.dat'],
    ['2026-06-02_01-01-01_manual.zip', { reason: 'manual', levelName: 'world', levelNames: ['plugins'], worlds: ['world', 'plugins'] }, 'world/level.dat'],
    ['2026-06-03_01-01-01_before-restore.zip', { reason: 'before-restore', levelName: 'world', levelNames: ['plugins', 'mods'], worlds: ['world', 'plugins'] }, 'world/level.dat'],
  ];
  for (const [name, extra, entry] of claims) {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify({ format: 1, createdAt: 'x', ...extra })), backups.META_NAME);
    zip.addBuffer(Buffer.from('x'), entry);
    zip.addBuffer(Buffer.from('evil'), 'plugins/evil.jar');
    zip.end();
    await new Promise((resolve) => zip.outputStream.pipe(fs.createWriteStream(path.join(s.backupDir, name))).on('close', resolve));
    await assert.rejects(backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name }), (e) => e.code === 'bad-backup', name);
  }
  assert.equal(fs.readFileSync(path.join(s.serverDir, 'plugins', 'keep.yml'), 'utf8'), 'a plugin file');
  assert.ok(!fs.existsSync(path.join(s.serverDir, 'plugins', 'evil.jar')));
});

test('D1: a level-name that is one of the server\'s own folders is not used as a world', (t) => {
  const s = fakeServer(t);
  fs.writeFileSync(path.join(s.serverDir, 'server.properties'), 'level-name=plugins\n');
  assert.equal(backups.levelNameOf(s.serverDir), 'world');
});

// ─── H3: waiting for Windows to let go of a folder does not freeze the app ───

test('H3: while a folder move is retried (a scanner has it open), the app keeps running', async (t) => {
  const s = fakeServer(t);
  const b = await make(s);
  const real = fs.renameSync;
  let refusals = 0;
  fs.renameSync = (from, to) => {
    if (String(from).includes('.vp-restore-') && refusals < 2) { refusals++; const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return real(from, to);
  };
  t.after(() => { fs.renameSync = real; });

  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  try {
    await backups.restoreBackup({ backupDir: s.backupDir, serverDir: s.serverDir, name: b.name });
  } finally {
    clearInterval(timer);
    fs.renameSync = real;
  }
  assert.equal(refusals, 2, 'the move really was retried');
  assert.ok(ticks >= 15, `the event loop kept running during the 750 ms of waiting (${ticks} ticks)`);
});

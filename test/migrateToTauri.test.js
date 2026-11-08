'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const M = require('../src/main/migrateToTauri');

// ─── a signer that writes minisign / Tauri-format keys and signatures, so the check is tested end to end ───
function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = crypto.randomBytes(8);
  const keyFile = `untrusted comment: minisign public key: ${keyId.toString('hex').toUpperCase()}\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`;
  return { privateKey, keyId, publicKey: Buffer.from(keyFile).toString('base64') };
}
function sign(key, data, { file, version, algorithm = 'ED', trusted } = {}) {
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  const sig = crypto.sign(null, message, key.privateKey);
  const comment = trusted ?? `timestamp:1\tfile:${file}\tversion:${version}`;
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment)]), key.privateKey);
  const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from(algorithm), key.keyId, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`;
  return Buffer.from(text).toString('base64');
}

const FILE = 'VoxelPort_2.0.0_x64-setup.exe';
const URL_OK = `https://github.com/VOXELPORT/VoxelPort-App/releases/download/v2.0.0/${FILE}`;

test('BLAKE2b-512 written out here agrees with Node\'s own, at every block boundary', () => {
  for (const size of [0, 1, 2, 63, 64, 127, 128, 129, 255, 256, 257, 383, 384, 385, 1000, 4096, 100003]) {
    const data = crypto.randomBytes(size);
    assert.equal(M.blake2b512(data).toString('hex'), crypto.createHash('blake2b512').update(data).digest('hex'), `size ${size}`);
  }
  assert.equal(M.blake2b512(Buffer.from('abc')).toString('hex'), 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
});

test('a correct signature is accepted, with either kind of minisign signature', () => {
  const key = makeKey();
  const data = crypto.randomBytes(5000);
  for (const algorithm of ['ED', 'Ed']) {
    assert.equal(M.verifySignature({ data, signature: sign(key, data, { file: FILE, version: '2.0.0', algorithm }), publicKey: key.publicKey, file: FILE, version: '2.0.0' }), true);
  }
});

test('a signature is refused when the file, the key, the version or the name is not the one signed', () => {
  const key = makeKey();
  const other = makeKey();
  const data = crypto.randomBytes(3000);
  const signature = sign(key, data, { file: FILE, version: '2.0.0' });
  const check = (over) => M.verifySignature({ data, signature, publicKey: key.publicKey, file: FILE, version: '2.0.0', ...over });
  const flipped = Buffer.from(data); flipped[100] ^= 1;
  assert.throws(() => check({ data: flipped }), /does not match the file/);
  assert.throws(() => check({ data: Buffer.concat([data, Buffer.from([0])]) }), /does not match the file/);
  assert.throws(() => check({ publicKey: other.publicKey }), /key VoxelPort does not use/);
  assert.throws(() => check({ version: '2.0.1' }), /different version/, 'an old installer cannot be passed off as a newer version');
  assert.throws(() => check({ file: 'VoxelPort_2.0.0_evil.exe' }), /different file/);
  // the trusted comment is signed too: editing it (say, to claim another version) breaks the signature
  const text = Buffer.from(signature, 'base64').toString('utf8').replace('version:2.0.0', 'version:9.9.9');
  assert.throws(() => check({ signature: Buffer.from(text).toString('base64'), version: '9.9.9' }), /altered/);
  // the same key with the file signed under a key id of another key
  const wrongId = makeKey(); wrongId.privateKey = key.privateKey;
  assert.throws(() => check({ signature: sign(wrongId, data, { file: FILE, version: '2.0.0' }) }), /key VoxelPort does not use/);
});

test('malformed signatures and keys are refused, not crashed on', () => {
  const key = makeKey();
  const data = Buffer.from('x');
  for (const signature of ['', 'AAAA', Buffer.from('untrusted comment: x\nnotbase64!!\n').toString('base64'), Buffer.from('a\nb\nc\nd').toString('base64')]) {
    assert.throws(() => M.verifySignature({ data, signature, publicKey: key.publicKey, file: FILE, version: '2.0.0' }), (err) => err.step === 'signature');
  }
  assert.throws(() => M.verifySignature({ data, signature: sign(key, data, { file: FILE, version: '2.0.0' }), publicKey: 'AAAA', file: FILE, version: '2.0.0' }), (err) => err.step === 'signature');
});

test('the real update key, as the new app has it, parses', () => {
  const key = M.parsePublicKey(M.PUBLIC_KEY);
  assert.equal(key.key.length, 32);
  assert.equal(key.keyId.toString('hex'), '758d407100 0c8377'.replace(' ', ''));
});

test('only an installer attached to a release of this project, named the build\'s way, for the announced version, is allowed', () => {
  const ok = (url, version = '2.0.0') => M.isAllowedInstallerUrl(url, version);
  assert.equal(ok(URL_OK), true);
  assert.equal(ok('https://github.com/VOXELPORT/VoxelPort-App/releases/download/v2.0.0-beta.1/VoxelPort_2.0.0-beta.1_x64-setup.exe', '2.0.0-beta.1'), true);
  for (const bad of [
    URL_OK.replace('https', 'http'),
    URL_OK.replace('github.com', 'github.com.evil.example'),
    URL_OK.replace('github.com', 'evil.example'),
    URL_OK.replace('github.com/', 'user:pw@github.com/'),
    URL_OK.replace('github.com', 'github.com:444'),
    URL_OK.replace('VOXELPORT', 'someone-else'),
    URL_OK.replace('VoxelPort-App', 'other-repo'),
    URL_OK.replace('/v2.0.0/', '/v1.9.9/'),
    URL_OK.replace('/download/', '/raw/'),
    `${URL_OK}?token=1`,
    `${URL_OK}#x`,
    URL_OK.replace(FILE, '..%2F..%2Fevil.exe'),
    URL_OK.replace(FILE, 'VoxelPort_2.0.0_x64-setup.msi'),
    URL_OK.replace(FILE, 'VoxelPort_2.0.1_x64-setup.exe'),
    'file:///C:/Windows/System32/cmd.exe',
    'not a url',
  ]) assert.equal(ok(bad), false, bad);
});

test('the manifest must name a version, a signature and an allowed Windows installer', () => {
  const good = { version: '2.0.0', platforms: { 'windows-x86_64': { signature: 'abc', url: URL_OK } } };
  assert.deepEqual({ ...M.parseManifest(good) }, { version: '2.0.0', url: URL_OK, signature: 'abc', file: FILE });
  for (const bad of [null, {}, { version: '2.0', platforms: good.platforms }, { version: '2.0.0' }, { version: '2.0.0', platforms: { 'windows-x86_64': { url: URL_OK } } },
    { version: '2.0.0', platforms: { 'windows-x86_64': { signature: 'abc', url: 'https://evil.example/x.exe' } } }, { version: '../x', platforms: good.platforms }]) {
    assert.throws(() => M.parseManifest(bad), (err) => err.step === 'manifest');
  }
  assert.ok(M.parseManifest({ version: '2.0.0', platforms: { 'windows-x86_64': { signature: 'abc', url: 'http://127.0.0.1:1/x.exe' } } }, { allowAnyUrl: true }), 'the tests\' stand-in server may be used where the test says so');
});

test('which kind of copy this is decides what the button can do', () => {
  const exists = (yes) => ({ existsSync: () => yes });
  const base = { platform: 'win32', isPackaged: true, windowsStore: false, env: {}, execPath: 'C:\\Apps\\VoxelPort\\VoxelPort.exe', fs: exists(true) };
  assert.equal(M.detectMode(base), 'installed');
  assert.equal(M.detectMode({ ...base, fs: exists(false) }), 'portable', 'no uninstaller next to it: nothing to remove');
  assert.equal(M.detectMode({ ...base, env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\VoxelPort-Portable.exe' } }), 'portable');
  assert.equal(M.detectMode({ ...base, windowsStore: true }), 'store');
  assert.equal(M.detectMode({ ...base, isPackaged: false }), 'none', 'a development run never removes anything');
  assert.equal(M.detectMode({ ...base, platform: 'linux' }), 'none');
  assert.equal(M.detectMode({ ...base, platform: 'darwin' }), 'none');
});

// ─── the whole flow, with a stand-in for the network, the installer, the new app and the shell ───

/** Everything a run needs; `over` replaces parts. The "installer" writes the new program; the "new app" answers with the handoff file. */
function world(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-migrate-'));
  const key = makeKey();
  const installer = crypto.randomBytes(20000);
  const version = '2.0.0';
  const sig = sign(key, installer, { file: FILE, version });
  const w = {
    root, key, installer, calls: [], events: [], launched: [], removalArgs: null,
    installDir: path.join(root, 'new-install'),
    dataDir: path.join(root, 'new-data'),
    tmpDir: path.join(root, 'tmp'),
    answer: { ok: true, identity: 'imported' },
    manifest: { version, platforms: { 'windows-x86_64': { signature: sig, url: URL_OK } } },
    installerBytes: installer,
    installerExit: 0,
    quits: 0,
    ...over,
  };
  fs.mkdirSync(w.dataDir, { recursive: true });
  const bodyOf = (bytes, type) => ({ ok: true, status: 200, url: URL_OK, headers: { get: (n) => (n.toLowerCase() === 'content-length' ? String(bytes.length) : null) }, json: async () => JSON.parse(bytes.toString()), body: (async function* () { for (let i = 0; i < bytes.length; i += 4096) yield bytes.subarray(i, i + 4096); })() });
  w.fetch = over.fetch || (async (url) => {
    w.calls.push(['fetch', String(url)]);
    if (String(url) === M.MANIFEST_URL) return bodyOf(Buffer.from(JSON.stringify(w.manifest)));
    return { ...bodyOf(w.installerBytes), url: w.finalUrl || String(url) };
  });
  w.spawn = over.spawn || ((file, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => {};
    child.kill = () => {};
    if (path.basename(file) === FILE) {
      w.calls.push(['installer', args]);
      setImmediate(() => {
        if (w.installerExit === 0) { fs.mkdirSync(w.installDir, { recursive: true }); fs.writeFileSync(path.join(w.installDir, M.NEW_APP_EXE), 'exe'); }
        child.emit('exit', w.installerExit);
      });
    } else if (file === path.join(w.installDir, M.NEW_APP_EXE)) {
      w.calls.push(['launch', args]);
      w.launched.push(args);
      if (w.answer) setTimeout(() => fs.writeFileSync(path.join(w.dataDir, M.HANDOFF_FILE), JSON.stringify(w.answer)), 30);
    } else if (/powershell/i.test(file)) {
      w.calls.push(['removal', args]);
      w.removalArgs = args;
      w.removalOpts = opts;
    }
    return child;
  });
  w.migration = M.createMigration({
    fetch: w.fetch, spawn: w.spawn, platform: 'win32', isPackaged: true, windowsStore: false, env: { LOCALAPPDATA: root, APPDATA: root, SystemRoot: 'C:\\Windows' },
    execPath: path.join(root, 'old', 'VoxelPort.exe'), pid: 4321, publicKey: key.publicKey, installDir: w.installDir, newAppDataDir: w.dataDir, tmpDir: w.tmpDir,
    shortcuts: { desktop: path.join(root, 'Desktop', 'VoxelPort.lnk'), startMenu: path.join(root, 'Start', 'VoxelPort.lnk') },
    fs: { ...fs, existsSync: (p) => (String(p).endsWith('Uninstall VoxelPort.exe') ? true : fs.existsSync(p)) },
    beforeInstall: async () => { w.calls.push(['stopped']); if (w.stopFails) throw new Error('stop failed'); },
    quit: () => { w.quits += 1; },
    timeouts: { quitDelay: 10, poll: 10, handoff: 600, install: 2000 },
    ...(over.options || {}),
  });
  w.migration.on('progress', (e) => w.events.push(e));
  return w;
}
const names = (w) => w.calls.map((c) => c[0]);
const done = (w) => fs.rmSync(w.root, { recursive: true, force: true });

test('the happy path: check, download, verify, stop, install, import, remove, in that order, and the old app quits', async () => {
  const w = world();
  const result = await w.migration.start();
  assert.deepEqual({ ok: result.ok, mode: result.mode, version: result.version, identity: result.identity }, { ok: true, mode: 'installed', version: '2.0.0', identity: 'imported' });
  assert.deepEqual(names(w), ['fetch', 'fetch', 'stopped', 'installer', 'launch', 'removal']);
  assert.deepEqual(w.calls.find((c) => c[0] === 'installer')[1], ['/S', `/D=${w.installDir}`], 'silent, into the chosen folder, with /D last');
  assert.deepEqual(w.launched, [[M.FLAG]], 'the new app is told, by the switch, to bring the data over');
  assert.deepEqual([...new Set(w.events.map((e) => e.phase))], ['checking', 'downloading', 'verifying', 'stopping', 'installing', 'importing', 'removing', 'done']);
  assert.ok(w.events.some((e) => e.phase === 'downloading' && e.percent === 99 || e.percent > 0), 'progress is reported');
  assert.ok(fs.existsSync(path.join(w.tmpDir, FILE)), 'the verified installer was written for running');
  assert.deepEqual(fs.readFileSync(path.join(w.tmpDir, FILE)), w.installer);
  // the removal is handed to PowerShell through a fixed launcher, with every value in an environment variable (never in a command line)
  const args = w.removalArgs;
  const env = w.removalOpts.env;
  assert.equal(env.VP_OLD_PID, '4321');
  assert.equal(env.VP_NEW_EXE, path.join(w.installDir, M.NEW_APP_EXE));
  assert.equal(env.VP_OLD_EXE, path.join(w.root, 'old', 'VoxelPort.exe'));
  assert.equal(env.VP_UNINSTALLER, path.join(w.root, 'old', 'Uninstall VoxelPort.exe'));
  assert.ok(env.VP_SCRIPT.endsWith('voxelport-remove-old.ps1'));
  assert.equal(args[args.indexOf('-EncodedCommand') + 1], Buffer.from(M.LAUNCHER, 'utf16le').toString('base64'));
  assert.ok(!args.some((a) => a.includes(w.root)), 'no path appears on the command line');
  // Started `detached`, PowerShell has no console and exits without running the script; started as a plain child, it is killed with this app (found by
  // running it for real). Hence the launcher, and these options.
  assert.equal(w.removalOpts.detached, undefined, 'the removal must not start PowerShell detached');
  assert.equal(w.removalOpts.windowsHide, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(w.quits, 1, 'and then this app ends so it can be removed');
  done(w);
});

test('nothing is stopped, written or run when the signature is wrong, however the download went', async () => {
  const flipped = (bytes) => { const b = Buffer.from(bytes); b[7] ^= 1; return b; };
  for (const tweak of [
    (w) => { w.installerBytes = flipped(w.installer); },
    (w) => { w.manifest.version = '2.0.1'; w.manifest.platforms['windows-x86_64'].url = URL_OK.replace('v2.0.0', 'v2.0.1').replace('2.0.0_', '2.0.1_'); },
    (w) => { w.manifest.platforms['windows-x86_64'].signature = sign(makeKey(), w.installer, { file: FILE, version: '2.0.0' }); },
  ]) {
    const w = world();
    tweak(w);
    const result = await w.migration.start();
    assert.equal(result.ok, false);
    assert.equal(result.step, 'signature');
    assert.equal(result.installed, false);
    assert.deepEqual(names(w), ['fetch', 'fetch'], 'no stop, no installer, no launch, no removal');
    assert.equal(fs.existsSync(w.tmpDir), false, 'not even written to disk');
    done(w);
  }
});

test('a download sent somewhere else, a download that is too big, and a failed download all stop before anything is run', async () => {
  let w = world({ });
  w.finalUrl = 'https://evil.example/VoxelPort.exe';
  let result = await w.migration.start();
  assert.equal(result.step, 'download');
  assert.deepEqual(names(w), ['fetch', 'fetch']);
  done(w);

  w = world();
  w.finalUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/file';
  result = await w.migration.start();
  assert.equal(result.ok, true, 'GitHub\'s own file host is where release downloads are served from');
  done(w);

  w = world();
  w.installerBytes = crypto.randomBytes(61 * 1024 * 1024);
  result = await w.migration.start();
  assert.equal(result.step, 'download');
  assert.deepEqual(names(w), ['fetch', 'fetch']);
  done(w);

  w = world({ fetch: async (url) => { if (String(url) === M.MANIFEST_URL) return { ok: true, json: async () => w.manifest }; throw new Error('offline'); } });
  result = await w.migration.start();
  assert.equal(result.step, 'download');
  done(w);

  w = world({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  result = await w.migration.start();
  assert.equal(result.step, 'manifest');
  assert.deepEqual(await w.migration.info(), { available: false, mode: 'installed' }, 'nothing is offered until the new app is published');
  done(w);
});

test('info offers the move only when the new app is really published, and says what this copy can do', async () => {
  const w = world();
  const info = await w.migration.info();
  assert.deepEqual(info, { available: true, mode: 'installed', version: '2.0.0', canInstall: true, downloadPage: M.DOWNLOAD_PAGE });
  done(w);
  const store = world({ options: { windowsStore: true } });
  assert.deepEqual(await store.migration.info(), { available: true, mode: 'store', version: '2.0.0', canInstall: false, downloadPage: M.DOWNLOAD_PAGE });
  assert.deepEqual(await store.migration.start(), { ok: false, step: 'unsupported', error: 'This copy cannot install the new VoxelPort by itself.' });
  assert.deepEqual(names(store), ['fetch'], 'the Store copy never downloads or installs anything');
  done(store);
  const dev = world({ options: { isPackaged: false } });
  assert.deepEqual(await dev.migration.info(), { available: false, mode: 'none' });
  assert.equal((await dev.migration.start()).step, 'unsupported');
  assert.deepEqual(names(dev), [], 'a development run does not even look');
  done(dev);
});

test('if the installer fails or is blocked, this app is left alone and the person is told it was not installed', async () => {
  let w = world({ installerExit: 5 });
  let result = await w.migration.start();
  assert.deepEqual({ ok: result.ok, step: result.step, installed: result.installed }, { ok: false, step: 'install', installed: false });
  assert.ok(!names(w).includes('removal') && !names(w).includes('launch'));
  done(w);

  w = world({ spawn: (file, args) => { const child = new EventEmitter(); child.unref = () => {}; child.kill = () => {}; if (path.basename(file) === FILE) setImmediate(() => child.emit('error', new Error('EACCES'))); return child; } });
  result = await w.migration.start();
  assert.deepEqual({ ok: result.ok, step: result.step, blocked: result.blocked }, { ok: false, step: 'install', blocked: true }, 'Windows refusing to run it is its own case (the page for a manual download is offered)');
  done(w);
});

test('if bringing the data over fails or never answers, this app is NOT removed', async () => {
  let w = world();
  w.answer = { ok: false, error: 'Stop the public address first.' };
  let result = await w.migration.start();
  assert.deepEqual({ ok: result.ok, step: result.step, installed: result.installed, error: result.error }, { ok: false, step: 'import', installed: true, error: 'Stop the public address first.' });
  assert.ok(!names(w).includes('removal'));
  assert.equal(w.quits, 0);
  done(w);

  w = world();
  w.answer = null;
  result = await w.migration.start();
  assert.deepEqual({ ok: result.ok, step: result.step, installed: result.installed }, { ok: false, step: 'timeout', installed: true });
  assert.ok(!names(w).includes('removal'));
  done(w);

  w = world();
  w.installerExit = 0;
  const original = w.spawn;
  w.migration = M.createMigration({ ...{ fetch: w.fetch, platform: 'win32', isPackaged: true, windowsStore: false, env: { LOCALAPPDATA: w.root, APPDATA: w.root }, execPath: path.join(w.root, 'old', 'VoxelPort.exe'), pid: 1, publicKey: w.key.publicKey, installDir: w.installDir, newAppDataDir: w.dataDir, tmpDir: w.tmpDir, fs: { ...fs, existsSync: (p) => (String(p).endsWith('Uninstall VoxelPort.exe') ? true : fs.existsSync(p)) }, timeouts: { poll: 10, handoff: 100, install: 1000, quitDelay: 1 } },
    spawn: (file, args, opts) => { if (file.endsWith(M.NEW_APP_EXE)) throw new Error('EPERM'); return original(file, args, opts); } });
  result = await w.migration.start();
  assert.deepEqual({ ok: result.ok, step: result.step, installed: result.installed }, { ok: false, step: 'launch', installed: true });
  done(w);
});

test('a stale answer from an earlier try is never mistaken for this one', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.dataDir, M.HANDOFF_FILE), JSON.stringify({ ok: true, identity: 'stale' }));
  w.answer = { ok: false, error: 'fresh no' };
  const result = await w.migration.start();
  assert.equal(result.step, 'import');
  assert.equal(result.error, 'fresh no');
  done(w);
});

test('stopping the server can cancel the move before anything is installed', async () => {
  const w = world();
  w.stopFails = true;
  const result = await w.migration.start();
  assert.equal(result.ok, false);
  assert.ok(!names(w).includes('installer'));
  assert.equal(fs.existsSync(w.tmpDir), false);
  done(w);
});

test('a portable copy installs and imports but never tries to remove itself', async () => {
  const w = world({ options: { env: { LOCALAPPDATA: undefined, APPDATA: undefined, PORTABLE_EXECUTABLE_FILE: 'C:\\x\\VoxelPort-Portable.exe' } } });
  const result = await w.migration.start();
  assert.deepEqual({ ok: result.ok, mode: result.mode }, { ok: true, mode: 'portable' });
  assert.ok(names(w).includes('launch') && !names(w).includes('removal'));
  assert.equal(w.events.at(-1).phase, 'done');
  assert.equal(w.quits, 0);
  done(w);
});

test('two presses at once do the work once', async () => {
  const w = world();
  const [a, b] = await Promise.all([w.migration.start(), w.migration.start()]);
  assert.deepEqual([a.ok, b.step].sort(), ['busy', true].sort());
  assert.equal(names(w).filter((n) => n === 'installer').length, 1);
  done(w);
});

// ─── the removal script, run for real in PowerShell against stand-ins ───

const psValues = (v) => ({ VP_SCRIPT: v.script, VP_OLD_PID: String(v.oldPid ?? 0), VP_UNINSTALLER: v.uninstaller, VP_OLD_EXE: v.oldExe, VP_NEW_EXE: v.newExe, VP_DESKTOP: v.desktop || '', VP_START_MENU: v.startMenu || '', VP_LOG: v.log || '' });
const runScript = (v, timeout = 60000) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', v.script], { timeout, env: { ...process.env, ...psValues(v) } });

test('the removal script waits for the old app, runs the uninstaller, and puts shortcuts the uninstaller removed back, pointing at the new app', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-remove-'));
  try {
    const old = path.join(root, 'old a'); fs.mkdirSync(old); // a space in the path, as in "Program Files"
    const oldExe = path.join(old, 'VoxelPort.exe'); fs.writeFileSync(oldExe, 'old');
    const newExe = path.join(root, 'VoxelPort-new.exe'); fs.writeFileSync(newExe, 'new');
    const desktop = path.join(root, 'VoxelPort.lnk'); fs.writeFileSync(desktop, 'a shortcut');
    const neverHad = path.join(root, 'NeverHad.lnk'); // the person had no such shortcut: none must appear
    // The stand-in uninstaller removes the old program and the shortcut by name, like electron-builder's does.
    const uninstaller = path.join(old, 'uninstall.cmd');
    fs.writeFileSync(uninstaller, `@echo off\r\ndel "${oldExe}"\r\ndel "${desktop}"\r\n`);
    const script = path.join(root, 'remove.ps1'); fs.writeFileSync(script, M.REMOVAL_SCRIPT);
    const log = path.join(root, 'remove.log');
    runScript({ script, uninstaller, oldExe, newExe, desktop, startMenu: neverHad, log });
    assert.equal(fs.existsSync(oldExe), false, 'the old program is gone');
    assert.equal(fs.existsSync(desktop), true, 'the desktop shortcut the person had is back');
    assert.equal(fs.existsSync(neverHad), false, 'a shortcut the person never had is not invented');
    const shell = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut('${desktop.replace(/'/g, "''")}').TargetPath`], { encoding: 'utf8' }).trim();
    assert.equal(shell.toLowerCase(), fs.realpathSync.native(newExe).toLowerCase(), 'and it points at the new app');
    assert.match(fs.readFileSync(log, 'utf8'), /the old program is gone[\s\S]*put back[\s\S]*done/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the removal script gives up quietly, leaving everything, if the uninstaller does not remove the old program', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-remove-'));
  try {
    const oldExe = path.join(root, 'VoxelPort.exe'); fs.writeFileSync(oldExe, 'old');
    const uninstaller = path.join(root, 'uninstall.cmd'); fs.writeFileSync(uninstaller, '@echo off\r\nrem does nothing\r\n');
    const script = path.join(root, 'remove.ps1');
    // a short wait for this test: the script's 90 s limit is what the real one uses
    fs.writeFileSync(script, M.REMOVAL_SCRIPT.replace('AddSeconds(90)', 'AddSeconds(3)'));
    let code = 0;
    try { runScript({ script, uninstaller, oldExe, newExe: oldExe, log: path.join(root, 'l.log') }); } catch (err) { code = err.status; }
    assert.equal(code, 2);
    assert.equal(fs.existsSync(oldExe), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the removal keeps running after the app that started it has exited, and waits for that app first (the way Node ties children to their parent would otherwise kill it)', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-outlive-'));
  try {
    const oldExe = path.join(root, 'VoxelPort.exe'); fs.writeFileSync(oldExe, 'old');
    const newExe = path.join(root, 'new.exe'); fs.writeFileSync(newExe, 'new');
    const uninstaller = path.join(root, 'uninstall.cmd'); fs.writeFileSync(uninstaller, `@echo off\r\ndel "${oldExe}"\r\n`);
    const log = path.join(root, 'remove.log');
    // This plays the old app: it starts the removal exactly as the app does (through the module's own invocation, with the same spawn options), then exits.
    const parent = path.join(root, 'parent.cjs');
    fs.writeFileSync(parent, `
const { spawn } = require('child_process');
const fs = require('fs');
const M = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main', 'migrateToTauri.js'))});
const script = ${JSON.stringify(path.join(root, 'remove.ps1'))};
fs.writeFileSync(script, M.REMOVAL_SCRIPT);
const inv = M.removalInvocation({ script, oldPid: process.pid, uninstaller: ${JSON.stringify(uninstaller)}, oldExe: ${JSON.stringify(oldExe)}, newExe: ${JSON.stringify(newExe)}, log: ${JSON.stringify(log)} }, process.env);
const child = spawn(inv.file, inv.args, { windowsHide: true, stdio: 'ignore', env: inv.env });
child.unref();
setTimeout(() => process.exit(0), 2500);
`);
    execFileSync(process.execPath, [parent], { stdio: 'ignore', timeout: 30000 });
    const end = Date.now() + 40000;
    while (fs.existsSync(oldExe) && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
    assert.equal(fs.existsSync(oldExe), false, 'the old program was removed after its app had exited');
    const logEnd = Date.now() + 15000;
    while (!/done/.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') && Date.now() < logEnd) await new Promise((r) => setTimeout(r, 250));
    assert.match(fs.readFileSync(log, 'utf8'), /waiting for the old app[\s\S]*running the uninstaller[\s\S]*the old program is gone/);
  } finally { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(root, { recursive: true, force: true }); }
});

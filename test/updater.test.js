'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Updater } = require('../src/main/updater');

test('start() no-ops on an unpackaged (dev) run — never touches electron-updater', () => {
  const u = new Updater();
  u.start({ isPackaged: false, platform: 'win32' });
  assert.equal(u.autoUpdater, null);
  assert.equal(u.checkTimer, null);
});

test('start() no-ops on non-Windows platforms', () => {
  const u = new Updater();
  u.start({ isPackaged: true, platform: 'linux' });
  assert.equal(u.autoUpdater, null);
  u.start({ isPackaged: true, platform: 'darwin' });
  assert.equal(u.autoUpdater, null);
});

test('start() no-ops in the Microsoft Store build — the Store delivers updates', () => {
  const u = new Updater();
  u.start({ isPackaged: true, platform: 'win32', windowsStore: true });
  assert.equal(u.autoUpdater, null);
  assert.equal(u.checkTimer, null);
});

test('install() does nothing if no update has actually finished downloading', () => {
  const u = new Updater();
  // autoUpdater is null (never started) — install() must not throw or assume it exists.
  assert.doesNotThrow(() => u.install());
  assert.equal(u.readyToInstall, false);
});

test('stop() is safe to call even if start() never ran', () => {
  const u = new Updater();
  assert.doesNotThrow(() => u.stop());
});

// ── The Settings "Check for updates" button: checkNow() ────────────────────────────────────────────
function checking(emitWhat, { rejects = false } = {}) {
  const u = new Updater();
  let calls = 0;
  u.autoUpdater = {
    checkForUpdates: () => {
      calls++;
      if (rejects) return Promise.reject(new Error('offline'));
      setImmediate(() => { for (const [event, arg] of emitWhat) u.emit(event, arg); });
      return Promise.resolve();
    },
  };
  return { u, calls: () => calls };
}

test('checkNow() says why a build cannot update itself', async () => {
  const store = new Updater(); store.start({ isPackaged: true, platform: 'win32', windowsStore: true });
  assert.deepEqual(await store.checkNow(), { status: 'unsupported', reason: 'store' });
  const dev = new Updater(); dev.start({ isPackaged: false, platform: 'win32' });
  assert.deepEqual(await dev.checkNow(), { status: 'unsupported', reason: 'dev' });
  const linux = new Updater(); linux.start({ isPackaged: true, platform: 'linux' });
  assert.deepEqual(await linux.checkNow(), { status: 'unsupported', reason: 'platform' });
  assert.deepEqual(await new Updater().checkNow(), { status: 'unsupported', reason: 'dev' }, 'before start() it is never a crash');
});

test('checkNow() reports up to date, an update that is downloading, and one that is ready', async () => {
  assert.deepEqual(await checking([['not-available']]).u.checkNow(), { status: 'up-to-date' });
  assert.deepEqual(await checking([['available', '1.17.0']]).u.checkNow(), { status: 'available', version: '1.17.0' });
  assert.deepEqual(await checking([['downloaded', '1.17.0']]).u.checkNow(), { status: 'downloaded', version: '1.17.0' });
});

test('checkNow() with an update already downloaded answers at once, without asking GitHub again', async () => {
  const { u, calls } = checking([['not-available']]);
  u.readyToInstall = true; u.downloadedVersion = '1.17.0';
  assert.deepEqual(await u.checkNow(), { status: 'downloaded', version: '1.17.0' });
  assert.equal(calls(), 0);
});

test('checkNow() turns a failed check, an error event and a silence into an error', async () => {
  assert.deepEqual(await checking([], { rejects: true }).u.checkNow(), { status: 'error' });
  assert.deepEqual(await checking([['error', 'boom']]).u.checkNow(), { status: 'error' });
  assert.deepEqual(await checking([]).u.checkNow(20), { status: 'error' }, 'no answer within the time limit');
});

test('presses made during one check share it, and it cleans up after itself', async () => {
  const { u, calls } = checking([['not-available']]);
  const [a, b] = await Promise.all([u.checkNow(), u.checkNow()]);
  assert.deepEqual(a, { status: 'up-to-date' }); assert.deepEqual(b, a);
  assert.equal(calls(), 1);
  assert.equal(u.pendingCheck, null);
  for (const event of ['not-available', 'available', 'downloaded', 'error']) assert.equal(u.listenerCount(event), 0, event);
  assert.deepEqual(await u.checkNow(), { status: 'up-to-date' }, 'a later press checks again');
  assert.equal(calls(), 2);
});

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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOrCreateToken, replaceToken } = require('../src/main/token');

const NEW_TOKEN = 'vp_restoredtoken_abcdefghijkl';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + s, 'utf8'),
  decryptString: (b) => { const s = b.toString('utf8'); if (!s.startsWith('ENC:')) throw new Error('no'); return s.slice(4); },
};
const copies = (dir) => fs.readdirSync(dir).filter((n) => /^device-token\.unreadable-.+\.json$/.test(n));

test('replacing keeps a copy of the old token file, then the new token is what loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-replace-'));
  try {
    const old = loadOrCreateToken(dir, safeStorage).token;
    const before = fs.readFileSync(path.join(dir, 'device-token.json'), 'utf8');
    replaceToken(dir, NEW_TOKEN, safeStorage);
    assert.equal(copies(dir).length, 1);
    assert.equal(fs.readFileSync(path.join(dir, copies(dir)[0]), 'utf8'), before, 'the copy is the file as it was');
    const again = loadOrCreateToken(dir, safeStorage);
    assert.deepEqual([again.token, again.unreadable], [NEW_TOKEN, false]);
    assert.notEqual(again.token, old);
    assert.ok(!fs.readFileSync(path.join(dir, 'device-token.json'), 'utf8').includes(NEW_TOKEN), 'stored encrypted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without OS encryption the new token is stored the way tokens always were', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-replace-'));
  try {
    loadOrCreateToken(dir, null);
    replaceToken(dir, NEW_TOKEN, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'device-token.json'), 'utf8')).token, NEW_TOKEN);
    assert.equal(loadOrCreateToken(dir, null).token, NEW_TOKEN);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('with no token file yet there is nothing to copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-replace-'));
  try {
    replaceToken(dir, NEW_TOKEN, safeStorage);
    assert.equal(copies(dir).length, 0);
    assert.equal(loadOrCreateToken(dir, safeStorage).token, NEW_TOKEN);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an invalid token is refused and the file is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-replace-'));
  try {
    const old = loadOrCreateToken(dir, safeStorage).token;
    assert.throws(() => replaceToken(dir, 'nope', safeStorage));
    assert.equal(copies(dir).length, 0);
    assert.equal(loadOrCreateToken(dir, safeStorage).token, old);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

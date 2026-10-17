'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOrCreateToken, isValidToken, maskToken } = require('../src/main/token');

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-token-'));
}

/** A minimal in-memory stand-in for Electron's safeStorage. */
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (str) => Buffer.from('ENC:' + str, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('not encrypted by this fake');
      return s.slice(4);
    },
  };
}

test('creates a valid token on first run and stores it encrypted when safeStorage is available', () => {
  const dir = tmpUserData();
  const { token, encryptedAtRest } = loadOrCreateToken(dir, fakeSafeStorage(true));
  assert.equal(isValidToken(token), true);
  assert.equal(encryptedAtRest, true);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'device-token.json'), 'utf8'));
  assert.equal(typeof onDisk.enc, 'string');
  assert.equal(onDisk.token, undefined, 'the raw token must never be written alongside the encrypted form');
});

test('the same token is returned across repeated loads (persisted identity)', () => {
  const dir = tmpUserData();
  const first = loadOrCreateToken(dir, fakeSafeStorage(true));
  const second = loadOrCreateToken(dir, fakeSafeStorage(true));
  assert.equal(first.token, second.token);
});

test('falls back to plaintext storage when safeStorage is unavailable, still returns a usable token', () => {
  const dir = tmpUserData();
  const { token, encryptedAtRest } = loadOrCreateToken(dir, fakeSafeStorage(false));
  assert.equal(isValidToken(token), true);
  assert.equal(encryptedAtRest, false);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'device-token.json'), 'utf8'));
  assert.equal(onDisk.token, token);
});

test('works with no safeStorage argument at all (plain Node / safeStorage undefined)', () => {
  const dir = tmpUserData();
  const { token } = loadOrCreateToken(dir);
  assert.equal(isValidToken(token), true);
});

// ─── Migration: plaintext -> encrypted, preserving the exact token ────────

test('migrates an existing plaintext token to encrypted storage WITHOUT changing its value', () => {
  const dir = tmpUserData();
  fs.mkdirSync(dir, { recursive: true });
  const original = 'vp_' + 'a'.repeat(24);
  fs.writeFileSync(path.join(dir, 'device-token.json'), JSON.stringify({ token: original }));

  const { token: afterFirstLoad } = loadOrCreateToken(dir, fakeSafeStorage(true));
  assert.equal(afterFirstLoad, original, 'must preserve the existing device identity, never mint a new one');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'device-token.json'), 'utf8'));
  assert.equal(typeof onDisk.enc, 'string', 'should now be stored encrypted');

  const { token: afterSecondLoad } = loadOrCreateToken(dir, fakeSafeStorage(true));
  assert.equal(afterSecondLoad, original, 'still the same token after the migration round-trips through encrypted storage');
});

test('a corrupted encrypted record does not crash the app, and is not overwritten', () => {
  const dir = tmpUserData();
  fs.mkdirSync(dir, { recursive: true });
  const bad = JSON.stringify({ enc: 'not-valid-base64-cipher' });
  fs.writeFileSync(path.join(dir, 'device-token.json'), bad);
  let loaded;
  assert.doesNotThrow(() => { loaded = loadOrCreateToken(dir, fakeSafeStorage(true)); });
  assert.equal(isValidToken(loaded.token), true);
  assert.equal(loaded.unreadable, true);
  assert.equal(fs.readFileSync(path.join(dir, 'device-token.json'), 'utf8'), bad);
});

// ─── Masking ────────────────────────────────────────────────────────────────

test('maskToken never reveals the full token', () => {
  const token = 'vp_' + 'b'.repeat(24);
  const masked = maskToken(token);
  assert.equal(masked.endsWith(token.slice(-4)), true);
  assert.equal(masked.includes(token.slice(0, 20)), false);
});

test('maskToken handles invalid input safely', () => {
  assert.doesNotThrow(() => maskToken(null));
  assert.doesNotThrow(() => maskToken(undefined));
  assert.doesNotThrow(() => maskToken(''));
});

// ─── An unreadable token file is never replaced ─────────────────────────────

const unreadableCopies = (dir) => fs.readdirSync(dir).filter((n) => /^device-token\.unreadable-.+\.json$/.test(n));

test('C2: the token survives a keyring outage and comes back when it is unlocked', () => {
  const dir = tmpUserData();
  const first = loadOrCreateToken(dir, fakeSafeStorage(true));
  const file = path.join(dir, 'device-token.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(first.unreadable, false);

  const during = loadOrCreateToken(dir, fakeSafeStorage(false)); // keyring locked
  assert.equal(during.unreadable, true);
  assert.equal(isValidToken(during.token), true, 'a temporary token is used meanwhile');
  assert.notEqual(during.token, first.token);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the saved file is untouched');
  assert.equal(unreadableCopies(dir).length, 1, 'and a copy is kept for recovery');

  const after = loadOrCreateToken(dir, fakeSafeStorage(true)); // unlocked again
  assert.equal(after.token, first.token, 'the original token is back');
  assert.equal(after.unreadable, false);
});

test('C2: a failed decrypt does not overwrite the file, and repeated launches do not pile up copies', () => {
  const dir = tmpUserData();
  const file = path.join(dir, 'device-token.json');
  const bad = JSON.stringify({ enc: Buffer.from('wrong key').toString('base64') });
  fs.writeFileSync(file, bad);
  for (let i = 0; i < 3; i++) {
    const r = loadOrCreateToken(dir, fakeSafeStorage(true));
    assert.equal(r.unreadable, true);
    assert.equal(isValidToken(r.token), true);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), bad);
  const copies = unreadableCopies(dir);
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), bad);
});

test('C2: a damaged token file is left alone too, and the temporary token is never saved', () => {
  const dir = tmpUserData();
  const file = path.join(dir, 'device-token.json');
  fs.writeFileSync(file, '{"enc": "trunc');
  const r = loadOrCreateToken(dir, fakeSafeStorage(true));
  assert.equal(r.unreadable, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"enc": "trunc');
  assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.tmp-')), 'nothing was written for the temporary token');
  assert.equal(fs.readFileSync(path.join(dir, unreadableCopies(dir)[0]), 'utf8'), '{"enc": "trunc');
});

test('C2: only when there was no token file at all is a new token written', () => {
  const dir = tmpUserData();
  const r = loadOrCreateToken(dir, fakeSafeStorage(true));
  assert.equal(r.unreadable, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'device-token.json'), 'utf8')).enc.length > 0, true);
  assert.deepEqual(unreadableCopies(dir), []);
});

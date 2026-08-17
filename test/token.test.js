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

test('a corrupted encrypted record does not crash the app (regenerates rather than throwing)', () => {
  const dir = tmpUserData();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'device-token.json'), JSON.stringify({ enc: 'not-valid-base64-cipher' }));
  assert.doesNotThrow(() => loadOrCreateToken(dir, fakeSafeStorage(true)));
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

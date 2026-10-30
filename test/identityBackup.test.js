'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shortId, passphraseProblem, encrypt, decrypt, ITERATIONS } = require('../src/main/identityBackup');

// Generated with Node crypto and shared with the Android app's tests: both sides must open and produce exactly this.
const PASS = 'correct horse battery staple';
const TOKEN = 'vp_testtoken_abcdefghijkl';
const VP_ID = '0c67f05015ae';
const SALT = Buffer.from('0123456789abcdef');
const IV = Buffer.from('abcdefghijkl');
const BLOB = { v: 1, kdf: 'pbkdf2-sha256', i: 600000, salt: 'MDEyMzQ1Njc4OWFiY2RlZg', iv: 'YWJjZGVmZ2hpamts', ct: 'MsyHgM7Ii1e5kIcAq93ktU1lKVGATxIQ5uoB0Q9AYm_7XG9-hIDvmT8' };

test('the id is the first 12 hex digits of sha256 of the code', () => {
  assert.equal(shortId(TOKEN), VP_ID);
});

test('the fixed vector decrypts', () => {
  assert.equal(decrypt(BLOB, PASS, VP_ID), TOKEN);
});

test('the same salt and iv give the identical blob', () => {
  assert.deepEqual(encrypt(TOKEN, PASS, { salt: SALT, iv: IV }), BLOB);
  assert.equal(ITERATIONS, 600000);
});

test('a fresh encryption round-trips and never repeats', () => {
  const a = encrypt(TOKEN, PASS, { iterations: 200000 });
  const b = encrypt(TOKEN, PASS, { iterations: 200000 });
  assert.notEqual(a.ct, b.ct);
  assert.equal(decrypt(a, PASS, VP_ID), TOKEN);
});

test('a passphrase typed in another Unicode form is the same passphrase', () => {
  const blob = encrypt(TOKEN, 'café au lait 123', { iterations: 200000 });
  assert.equal(decrypt(blob, 'café au lait 123', VP_ID), TOKEN);
});

test('a wrong passphrase does not open it', () => {
  assert.equal(decrypt(BLOB, 'correct horse battery stapl3', VP_ID), null);
});

test('a changed blob does not open', () => {
  const flipped = Buffer.from(BLOB.ct, 'base64url'); flipped[3] ^= 1;
  assert.equal(decrypt({ ...BLOB, ct: flipped.toString('base64url') }, PASS, VP_ID), null);
  assert.equal(decrypt({ ...BLOB, ct: BLOB.ct.slice(0, -4) }, PASS, VP_ID), null);
  assert.equal(decrypt({ ...BLOB, salt: Buffer.from('0123456789abcdeg').toString('base64url') }, PASS, VP_ID), null);
});

test('a blob filed under another address does not open', () => {
  assert.equal(decrypt(BLOB, PASS, '000000000000'), null);
});

test('a blob with the wrong shape is refused without throwing', () => {
  const bad = [null, undefined, 'x', {}, { ...BLOB, v: 2 }, { ...BLOB, kdf: 'scrypt' }, { ...BLOB, i: 199999 }, { ...BLOB, i: 2000001 }, { ...BLOB, i: 600000.5 }, { ...BLOB, i: '600000' },
    { ...BLOB, salt: 'AAAA' }, { ...BLOB, iv: 'AAAA' }, { ...BLOB, ct: 'AA' }, { ...BLOB, ct: undefined }];
  for (const b of bad) assert.equal(decrypt(b, PASS, VP_ID), null, JSON.stringify(b));
});

test('a result that is not a valid code is refused even with the right passphrase', () => {
  const blob = encrypt('not a token', PASS, { iterations: 200000 });
  assert.equal(decrypt(blob, PASS, shortId('not a token')), null);
});

test('passphrase rules: 12 characters, 5 different ones', () => {
  assert.equal(passphraseProblem('short one'), 'too_short');
  assert.equal(passphraseProblem('12345678901'), 'too_short');
  assert.equal(passphraseProblem('aaaaaaaaaaaa'), 'too_simple');
  assert.equal(passphraseProblem('abababababab'), 'too_simple');
  assert.equal(passphraseProblem('abcdabcdabcd'), 'too_simple');
  assert.equal(passphraseProblem('abcdeabcdeab'), null);
  assert.equal(passphraseProblem(PASS), null);
  assert.equal(passphraseProblem('éééééé'), 'too_short', 'counted after NFC: six characters');
});

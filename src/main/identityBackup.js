'use strict';

const crypto = require('crypto');
const { isValidToken } = require('./token');

/**
 * Backs up this install's address code (the device token behind its public port and custom address) to the person's
 * Discord account. The code is encrypted HERE with a passphrase only the person knows, before it is sent: the
 * accounts service keeps an opaque blob and can never read it. The format is shared with the Android app, so either
 * can open the other's backup:
 *   key  = PBKDF2-HMAC-SHA256(passphrase in Unicode NFC, UTF-8, salt 16 bytes, 600,000 rounds) -> 32 bytes
 *   blob = AES-256-GCM(key, iv 12 bytes, aad "voxelport-identity-v1|<12-character id>", the code in UTF-8) = ciphertext + 16-byte tag
 *   sent as { v:1, kdf:"pbkdf2-sha256", i, salt, iv, ct } with base64url (no padding) fields.
 */

const ITERATIONS = 600000;
const MIN_ITERATIONS = 200000;
const MAX_ITERATIONS = 2000000;
const MIN_PASSPHRASE = 12;
const AAD_PREFIX = 'voxelport-identity-v1|';

/** The 12-character VoxelPort ID of a code: what the apps and the accounts service show and match on. */
function shortId(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
}

const normalize = (s) => String(s).normalize('NFC');

/** 'too_short' | 'too_simple' | null. Same rules as Android: 12+ characters and at least 5 different ones. */
function passphraseProblem(raw) {
  const p = normalize(raw);
  if (p.length < MIN_PASSPHRASE) return 'too_short';
  if (new Set(p.split('')).size < 5) return 'too_simple';
  return null;
}

function key(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(Buffer.from(normalize(passphrase), 'utf8'), salt, iterations, 32, 'sha256');
}

/** The blob to send. salt and iv are fresh random bytes unless a test fixes them. */
function encrypt(token, passphrase, { salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), iterations = ITERATIONS } = {}) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key(passphrase, salt, iterations), iv);
  cipher.setAAD(Buffer.from(AAD_PREFIX + shortId(token), 'utf8'));
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, kdf: 'pbkdf2-sha256', i: iterations, salt: salt.toString('base64url'), iv: iv.toString('base64url'), ct: ct.toString('base64url') };
}

/** The code, or null if the passphrase is wrong, the blob was changed, or it belongs to another address (vpId). */
function decrypt(blob, passphrase, vpId) {
  try {
    if (!blob || blob.v !== 1 || blob.kdf !== 'pbkdf2-sha256') return null;
    const iterations = blob.i;
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
    const salt = Buffer.from(String(blob.salt), 'base64url');
    const iv = Buffer.from(String(blob.iv), 'base64url');
    const ct = Buffer.from(String(blob.ct), 'base64url');
    if (salt.length !== 16 || iv.length !== 12 || ct.length < 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(passphrase, salt, iterations), iv);
    decipher.setAAD(Buffer.from(AAD_PREFIX + vpId, 'utf8'));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const token = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString('utf8');
    // Only a code that really is the one this backup was filed under is accepted.
    return isValidToken(token) && shortId(token) === vpId ? token : null;
  } catch {
    return null;
  }
}

module.exports = { shortId, passphraseProblem, encrypt, decrypt, ITERATIONS, MIN_PASSPHRASE };

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_RE = /^vp_[A-Za-z0-9_-]{10,}$/;

/**
 * A device token identifies this install to the relay. Like the mod, VoxelPort
 * generates one automatically on first run — no signup, no Discord. It is stored
 * in the app's userData directory and reused on every launch.
 *
 * At rest it's protected with Electron's safeStorage when the OS-backed
 * encryption it wraps (DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux) is available (item 13). safeStorage is optional here, not
 * mandatory: `available` tells the caller whether OS-backed encryption is
 * actually in effect, so this never becomes a silent false sense of
 * security on a machine without a working secret store (e.g. some minimal
 * Linux setups without a keyring daemon) — the token is still generated and
 * still works, just stored in plaintext on that machine, exactly as every
 * previous version of the app already did.
 */
function generateDeviceToken() {
  return 'vp_' + crypto.randomBytes(18).toString('base64url');
}

function tokenFile(userDataDir) {
  return path.join(userDataDir, 'device-token.json');
}

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

function atomicWrite(file, contents) {
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * safeStorage is an Electron API and isn't available to plain Node test
 * runs — callers (main.js) pass it in explicitly rather than this module
 * requiring('electron') itself, which keeps this file unit-testable without
 * an Electron process.
 */
function loadOrCreateToken(userDataDir, safeStorage) {
  const file = tokenFile(userDataDir);
  const canEncrypt = !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());

  // Only a file that does not exist at all may be replaced by a new token. One that is there but can't be read right
  // now (a locked keyring, a failed decrypt, a damaged file) holds the person's identity, and with it their custom
  // address, so it is left exactly as it is.
  let raw = null;
  let existed = true;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') existed = false;
  }

  let record = null;
  if (raw !== null) {
    try { record = JSON.parse(raw); } catch { record = null; }
  }

  if (record && typeof record === 'object') {
    let token = null;
    if (record.enc && canEncrypt) {
      try {
        token = safeStorage.decryptString(Buffer.from(record.enc, 'base64'));
      } catch {
        token = null; // can't be decrypted now: handled below, never overwritten
      }
    } else if (typeof record.token === 'string') {
      // Plaintext legacy record (or safeStorage unavailable this run).
      token = record.token;
    }

    if (isValidToken(token)) {
      // Opportunistically migrate a plaintext token to encrypted storage
      // now that safeStorage is available — the token value itself is
      // preserved exactly, only its on-disk representation changes.
      if (!record.enc && canEncrypt) {
        try {
          persist(file, token, safeStorage);
        } catch {
          // best-effort; the plaintext copy still works next launch
        }
      }
      return { token, encryptedAtRest: !!record.enc || canEncrypt && isValidToken(token), unreadable: false };
    }
  }

  if (existed) {
    // Keep a copy for recovery, and run on a token that lives only for this session. The file itself stays where it is,
    // so once the keyring is unlocked the next launch gets the original token back.
    keepUnreadableCopy(userDataDir, file, raw);
    return { token: generateDeviceToken(), encryptedAtRest: false, unreadable: true };
  }

  const token = generateDeviceToken();
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    persist(file, token, safeStorage);
  } catch {
    // best-effort persistence; a transient token still works for this session
  }
  return { token, encryptedAtRest: canEncrypt, unreadable: false };
}

const UNREADABLE_RE = /^device-token\.unreadable-.+\.json$/;

/** device-token.unreadable-<time>.json beside the original, unless a copy with the same contents is already there. */
function keepUnreadableCopy(userDataDir, file, raw) {
  try {
    const bytes = raw !== null ? Buffer.from(raw, 'utf8') : fs.readFileSync(file);
    for (const name of fs.readdirSync(userDataDir)) {
      if (UNREADABLE_RE.test(name) && fs.readFileSync(path.join(userDataDir, name)).equals(bytes)) return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(userDataDir, `device-token.unreadable-${stamp}.json`), bytes, { mode: 0o600 });
  } catch {
    // best-effort: the original is still untouched
  }
}

function persist(file, token, safeStorage) {
  const canEncrypt = !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
  if (canEncrypt) {
    const enc = safeStorage.encryptString(token).toString('base64');
    atomicWrite(file, JSON.stringify({ enc }, null, 2));
  } else {
    atomicWrite(file, JSON.stringify({ token }, null, 2));
  }
}

/**
 * Swaps the stored token for another one (restoring an address from the person's Discord backup). The file that is there
 * now is copied aside first, exactly like an unreadable one, so the address this PC had can still be recovered by hand.
 * Throws if the new token is not valid or cannot be written; the old file is only replaced by a complete new one.
 */
function replaceToken(userDataDir, token, safeStorage) {
  if (!isValidToken(token)) throw new Error('invalid token');
  const file = tokenFile(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  if (fs.existsSync(file)) keepUnreadableCopy(userDataDir, file, null);
  persist(file, token, safeStorage);
}

/** Never logs or returns the real token — only for the "•••• last 4" style UI hint. */
function maskToken(token) {
  if (!isValidToken(token)) return '••••••••';
  return '••••••••' + token.slice(-4);
}

module.exports = { loadOrCreateToken, replaceToken,generateDeviceToken, isValidToken, maskToken };

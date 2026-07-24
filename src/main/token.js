'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * A device token identifies this install to the relay. Like the mod, VoxelPort
 * generates one automatically on first run — no signup, no Discord. It is stored
 * in the app's userData directory and reused on every launch.
 */
function generateDeviceToken() {
  return 'vp_' + crypto.randomBytes(18).toString('base64url');
}

function loadOrCreateToken(userDataDir) {
  const file = path.join(userDataDir, 'device-token.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.token === 'string' && /^vp_[A-Za-z0-9_-]{10,}$/.test(parsed.token)) {
      return parsed.token;
    }
  } catch {
    // no token yet — fall through and create one
  }
  const token = generateDeviceToken();
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  } catch {
    // best-effort persistence; a transient token still works for this session
  }
  return token;
}

module.exports = { loadOrCreateToken, generateDeviceToken };

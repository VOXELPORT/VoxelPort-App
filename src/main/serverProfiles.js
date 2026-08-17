'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getServerDir } = require('./serverInstall');

const KNOWN_TYPES = new Set(['vanilla', 'paper', 'fabric']);
const STORE_VERSION = 2;

function profilesPath(userDataDir) {
  return path.join(userDataDir, 'server-profiles.json');
}

function legacyConfigPath(userDataDir) {
  return path.join(userDataDir, 'server-config.json');
}

/**
 * Validates a profile shape (item 27). Every profile loaded from disk goes
 * through this before it's trusted — a corrupt/hand-edited entry is dropped
 * rather than crashing the app or being used to spawn a process.
 */
function isValidProfile(p) {
  return !!p && typeof p === 'object'
    && typeof p.id === 'string' && p.id.length > 0
    && typeof p.name === 'string' && p.name.trim().length > 0
    && KNOWN_TYPES.has(p.type)
    && typeof p.version === 'string' && p.version.length > 0
    && typeof p.serverDir === 'string' && path.isAbsolute(p.serverDir)
    && Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535
    && Number.isInteger(p.minRamMb) && p.minRamMb >= 256 && p.minRamMb <= 131072
    && Number.isInteger(p.maxRamMb) && p.maxRamMb >= p.minRamMb && p.maxRamMb <= 131072;
}

function newId() {
  return crypto.randomUUID();
}

function emptyStore() {
  return { version: STORE_VERSION, servers: [] };
}

function loadRaw(userDataDir) {
  try {
    const raw = fs.readFileSync(profilesPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.servers)) return parsed;
  } catch {
    // no store yet, or it's corrupt — treated the same as "doesn't exist".
  }
  return null;
}

/** Atomic write: temp file in the same directory, then rename over the target. */
function saveRaw(userDataDir, store) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = profilesPath(userDataDir);
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * One-time, idempotent migration from the old single-server
 * server-config.json into the new multi-profile store. Runs at most once:
 * if server-profiles.json already exists (even if empty), migration never
 * runs again, so re-launching the app after migrating — or after the user
 * deletes the migrated profile — never resurrects it. The legacy file is
 * renamed to a `.migrated-backup` suffix rather than deleted, and no server
 * files (jar/world/etc.) are touched at all.
 */
function migrateLegacyIfNeeded(userDataDir) {
  const existing = loadRaw(userDataDir);
  if (existing) return existing;

  let legacy = null;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyConfigPath(userDataDir), 'utf8'));
  } catch {
    const fresh = emptyStore();
    saveRaw(userDataDir, fresh);
    return fresh;
  }

  const now = new Date().toISOString();
  const minRamMb = Number.isInteger(legacy && legacy.minRamMb) ? legacy.minRamMb : 1024;
  // Some earlier builds of the app never persisted serverDir at all (it was
  // implicitly always the single default install location) -- fall back to
  // that same conventional path rather than dropping a real, already-
  // installed server's profile just because the field is missing.
  const legacyServerDir = (legacy && typeof legacy.serverDir === 'string' && legacy.serverDir)
    ? legacy.serverDir
    : getServerDir(userDataDir);
  const profile = {
    id: newId(),
    name: 'My Server',
    type: legacy && legacy.type,
    version: legacy && legacy.version,
    serverDir: legacyServerDir,
    port: Number(legacy && legacy.port),
    minRamMb,
    maxRamMb: Number.isInteger(legacy && legacy.maxRamMb) ? legacy.maxRamMb : minRamMb,
    createdAt: now,
    lastUsedAt: now,
  };

  const store = isValidProfile(profile) ? { version: STORE_VERSION, servers: [profile] } : emptyStore();
  saveRaw(userDataDir, store);

  try {
    fs.renameSync(legacyConfigPath(userDataDir), legacyConfigPath(userDataDir) + '.migrated-backup');
  } catch {
    // best-effort — the new store is already saved and is what the app trusts from here on.
  }

  return store;
}

function loadProfiles(userDataDir) {
  const store = migrateLegacyIfNeeded(userDataDir);
  const valid = store.servers.filter(isValidProfile);
  if (valid.length !== store.servers.length) {
    saveRaw(userDataDir, { version: STORE_VERSION, servers: valid });
  }
  return valid;
}

function listProfiles(userDataDir) {
  return loadProfiles(userDataDir);
}

function getProfile(userDataDir, id) {
  return loadProfiles(userDataDir).find((p) => p.id === id) || null;
}

function createProfile(userDataDir, input) {
  const now = new Date().toISOString();
  const minRamMb = Number(input.minRamMb);
  const profile = {
    id: newId(),
    name: String(input.name || '').trim() || 'My Server',
    type: input.type,
    version: input.version,
    serverDir: input.serverDir,
    port: Number(input.port),
    minRamMb,
    maxRamMb: Number(input.maxRamMb),
    createdAt: now,
    lastUsedAt: now,
  };
  if (!isValidProfile(profile)) throw new Error('Invalid server profile.');

  const profiles = loadProfiles(userDataDir);
  profiles.push(profile);
  saveRaw(userDataDir, { version: STORE_VERSION, servers: profiles });
  return profile;
}

function updateProfile(userDataDir, id, changes) {
  const profiles = loadProfiles(userDataDir);
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error('Server profile not found.');

  const merged = { ...profiles[idx], ...changes, id: profiles[idx].id };
  if (changes.port !== undefined) merged.port = Number(changes.port);
  if (changes.minRamMb !== undefined) merged.minRamMb = Number(changes.minRamMb);
  if (changes.maxRamMb !== undefined) merged.maxRamMb = Number(changes.maxRamMb);
  if (typeof merged.name === 'string') merged.name = merged.name.trim();
  if (!isValidProfile(merged)) throw new Error('Invalid server profile.');

  profiles[idx] = merged;
  saveRaw(userDataDir, { version: STORE_VERSION, servers: profiles });
  return merged;
}

function touchProfile(userDataDir, id) {
  try {
    updateProfile(userDataDir, id, { lastUsedAt: new Date().toISOString() });
  } catch {
    // best-effort bookkeeping — never let this break the caller's real action
  }
}

/**
 * Removes a profile from VoxelPort's records only. Deliberately never
 * touches serverDir — deleting the world/jar/config is a distinct, explicit
 * action this module does not implement (item 9).
 */
function deleteProfile(userDataDir, id) {
  const profiles = loadProfiles(userDataDir);
  const next = profiles.filter((p) => p.id !== id);
  saveRaw(userDataDir, { version: STORE_VERSION, servers: next });
  return next.length !== profiles.length;
}

module.exports = {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  touchProfile,
  isValidProfile,
  loadProfiles,
  KNOWN_TYPES,
};

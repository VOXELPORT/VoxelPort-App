'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile, isValidProfile,
} = require('../src/main/serverProfiles');

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-profiles-'));
}

function baseInput(overrides = {}) {
  return {
    name: 'Survival SMP',
    type: 'paper',
    version: '1.21.4',
    serverDir: path.join(os.tmpdir(), 'vp-survival-' + Math.random().toString(36).slice(2)),
    port: 25565,
    minRamMb: 2048,
    maxRamMb: 4096,
    ...overrides,
  };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

test('createProfile persists a profile with a stable UUID id', () => {
  const dir = tmpUserData();
  const p = createProfile(dir, baseInput());
  assert.match(p.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const listed = listProfiles(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, p.id);
});

test('getProfile finds by id, not by name', () => {
  const dir = tmpUserData();
  const a = createProfile(dir, baseInput({ name: 'Same Name' }));
  const b = createProfile(dir, baseInput({ name: 'Same Name', port: 25566 }));
  assert.notEqual(a.id, b.id);
  assert.equal(getProfile(dir, a.id).port, 25565);
  assert.equal(getProfile(dir, b.id).port, 25566);
});

test('updateProfile changes fields and keeps the same id', () => {
  const dir = tmpUserData();
  const p = createProfile(dir, baseInput());
  const updated = updateProfile(dir, p.id, { name: 'Renamed', maxRamMb: 8192 });
  assert.equal(updated.id, p.id);
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.maxRamMb, 8192);
  assert.equal(getProfile(dir, p.id).name, 'Renamed');
});

test('updateProfile rejects an invalid resulting profile (min > max RAM)', () => {
  const dir = tmpUserData();
  const p = createProfile(dir, baseInput());
  assert.throws(() => updateProfile(dir, p.id, { minRamMb: 9000, maxRamMb: 4096 }));
});

test('deleteProfile removes only the targeted profile and leaves the server folder untouched', () => {
  const dir = tmpUserData();
  const p = createProfile(dir, baseInput());
  fs.mkdirSync(p.serverDir, { recursive: true });
  fs.writeFileSync(path.join(p.serverDir, 'world-marker.txt'), 'irreplaceable world data');

  const ok = deleteProfile(dir, p.id);
  assert.equal(ok, true);
  assert.equal(listProfiles(dir).length, 0);
  assert.equal(fs.existsSync(path.join(p.serverDir, 'world-marker.txt')), true);
});

test('deleting a profile that does not exist returns false without throwing', () => {
  const dir = tmpUserData();
  assert.equal(deleteProfile(dir, 'not-a-real-id'), false);
});

// ─── Duplicate names ────────────────────────────────────────────────────────

test('duplicate profile names are allowed (ids are the real identity)', () => {
  const dir = tmpUserData();
  const a = createProfile(dir, baseInput({ name: 'Modded' }));
  const b = createProfile(dir, baseInput({ name: 'Modded', port: 25567 }));
  const all = listProfiles(dir);
  assert.equal(all.length, 2);
  assert.notEqual(a.id, b.id);
});

// ─── Multiple saved profiles ────────────────────────────────────────────────

test('supports several saved profiles independently', () => {
  const dir = tmpUserData();
  const names = ['Survival', 'Creative', 'Modded'];
  for (const [i, name] of names.entries()) {
    createProfile(dir, baseInput({ name, port: 25565 + i }));
  }
  const all = listProfiles(dir);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((p) => p.name).sort(), names.sort());
});

// ─── Corrupt config ─────────────────────────────────────────────────────────

test('a corrupt server-profiles.json does not crash the app — starts fresh instead', () => {
  const dir = tmpUserData();
  fs.writeFileSync(path.join(dir, 'server-profiles.json'), '{ not valid json');
  assert.doesNotThrow(() => listProfiles(dir));
  assert.deepEqual(listProfiles(dir), []);
});

test('an invalid profile entry (item 27) is dropped on load without crashing, valid ones survive', () => {
  const dir = tmpUserData();
  const good = createProfile(dir, baseInput({ name: 'Good' }));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'server-profiles.json'), 'utf8'));
  raw.servers.push({ id: 'bad', name: '', type: 'not-a-real-type', port: 999999 });
  fs.writeFileSync(path.join(dir, 'server-profiles.json'), JSON.stringify(raw));

  const loaded = listProfiles(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, good.id);
});

test('isValidProfile rejects a relative serverDir and out-of-range port', () => {
  assert.equal(isValidProfile({
    id: 'x', name: 'n', type: 'paper', version: '1.21', serverDir: 'relative/path',
    port: 25565, minRamMb: 1024, maxRamMb: 2048,
  }), false);
  assert.equal(isValidProfile({
    id: 'x', name: 'n', type: 'paper', version: '1.21', serverDir: path.join(os.tmpdir(), 'x'),
    port: 70000, minRamMb: 1024, maxRamMb: 2048,
  }), false);
});

// ─── Migration from the old single-server config ───────────────────────────

test('migration converts an existing server-config.json into a profile, preserving all fields', () => {
  const dir = tmpUserData();
  const serverDir = path.join(dir, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.jar'), 'not a real jar, just a marker');
  fs.writeFileSync(path.join(dir, 'server-config.json'), JSON.stringify({
    type: 'paper', version: '1.21.4', port: 25565, minRamMb: 2048, maxRamMb: 4096, serverDir,
  }));

  const profiles = listProfiles(dir);
  assert.equal(profiles.length, 1);
  const p = profiles[0];
  assert.equal(p.type, 'paper');
  assert.equal(p.version, '1.21.4');
  assert.equal(p.port, 25565);
  assert.equal(p.minRamMb, 2048);
  assert.equal(p.maxRamMb, 4096);
  assert.equal(p.serverDir, serverDir);
  assert.equal(typeof p.name, 'string');

  // world/jar data untouched
  assert.equal(fs.existsSync(path.join(serverDir, 'server.jar')), true);
  // old config preserved as a backup, not deleted
  assert.equal(fs.existsSync(path.join(dir, 'server-config.json.migrated-backup')), true);
});

test('migration runs at most once and is idempotent even if called repeatedly', () => {
  const dir = tmpUserData();
  const serverDir = path.join(dir, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server-config.json'), JSON.stringify({
    type: 'vanilla', version: '1.21.4', port: 25565, serverDir,
  }));

  const first = listProfiles(dir);
  assert.equal(first.length, 1);
  const firstId = first[0].id;

  // Simulate a second app launch: call listProfiles again.
  const second = listProfiles(dir);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, firstId, 'must not create a second profile from the same legacy file');

  // Even deleting the migrated profile must not resurrect it from the
  // (now-renamed) legacy file on a third load.
  deleteProfile(dir, firstId);
  const third = listProfiles(dir);
  assert.equal(third.length, 0);
});

test('migration with no legacy config just starts with an empty profile list', () => {
  const dir = tmpUserData();
  const profiles = listProfiles(dir);
  assert.deepEqual(profiles, []);
});

test('migration does not generate a device token or touch token storage', () => {
  const dir = tmpUserData();
  fs.writeFileSync(path.join(dir, 'server-config.json'), JSON.stringify({
    type: 'vanilla', version: '1.21.4', port: 25565, serverDir: path.join(dir, 'server'),
  }));
  listProfiles(dir);
  assert.equal(fs.existsSync(path.join(dir, 'device-token.json')), false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFileSync } = require('../src/main/atomicWrite');
const { setCracked } = require('../src/main/accounts');
const { updateServerPropertiesSafely, writeServerProperties } = require('../src/main/serverInstall');
const { installBedrockSupport } = require('../src/main/bedrock');
const { installAddon, installedAddons } = require('../src/main/addons');
const serverProfiles = require('../src/main/serverProfiles');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vp-atomic-'));
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));

/** While `fn` runs, the step that moves a finished temporary file into place fails, as a full disk or a power cut would. */
async function withFailingRename(fn) {
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).includes('.tmp-')) { const e = new Error('simulated failure'); e.code = 'EIO'; throw e; }
    return real(from, to);
  };
  try { return await fn(); } finally { fs.renameSync = real; }
}

test('H4: the new contents replace the old in one step, and nothing is left behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'data.json');
  atomicWriteFileSync(file, 'one');
  atomicWriteFileSync(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(leftovers(dir), []);
});

test('H4: if writing fails, the old file is exactly as it was and the temporary file is removed', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, 'the old contents');
  await withFailingRename(() => assert.throws(() => atomicWriteFileSync(file, 'the new contents'), /simulated failure/));
  assert.equal(fs.readFileSync(file, 'utf8'), 'the old contents');
  assert.deepEqual(leftovers(dir), []);
});

test('H4: if the data cannot even be written, the old file is untouched', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, 'the old contents');
  assert.throws(() => atomicWriteFileSync(file, { not: 'a string' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'the old contents');
  assert.deepEqual(leftovers(dir), []);
});

test('H4: server.properties is kept whole when setCracked, updateServerPropertiesSafely or writeServerProperties fail', async () => {
  for (const [what, change] of [
    ['setCracked', (dir) => setCracked(dir, true)],
    ['updateServerPropertiesSafely', (dir) => updateServerPropertiesSafely(dir, { motd: 'new motd' })],
    ['writeServerProperties', (dir) => writeServerProperties(dir, { port: 25570 })],
  ]) {
    const dir = tmpDir();
    const original = 'motd=old\nonline-mode=true\nmax-players=20\n';
    fs.writeFileSync(path.join(dir, 'server.properties'), original);
    await withFailingRename(() => assert.throws(() => change(dir), /simulated failure/, what));
    assert.equal(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), original, what);
    assert.deepEqual(leftovers(dir), [], what);
  }
});

test('H4: the add-on and Bedrock lists are never left half written', async () => {
  const dir = tmpDir();
  const SHA = 'a'.repeat(128);
  const fetchImpl = async (url) => ({
    ok: true, status: 200,
    json: async () => (url.includes('/version')
      ? [{ version_type: 'release', dependencies: [], files: [{ primary: true, filename: 'Thing-1.0.jar', url: 'https://cdn.modrinth.com/x.jar', hashes: { sha512: SHA } }] }]
      : {}),
  });
  const download = async (url, dest) => { fs.writeFileSync(dest, 'jar'); };
  fs.mkdirSync(path.join(dir, 'plugins'));
  await withFailingRename(() => assert.rejects(installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: 'AAAAAAAA', title: 'Thing', fetchImpl, download }), /simulated failure/));
  assert.deepEqual(leftovers(dir), []);
  assert.deepEqual(installedAddons(dir), []);

  const geyserFetch = async (url) => ({
    ok: true, status: 200,
    json: async () => ({ version: '2.0', build: 1, downloads: { spigot: { name: url.includes('floodgate') ? 'floodgate-spigot.jar' : 'Geyser-Spigot.jar', sha256: 'b'.repeat(64) } } }),
  });
  await withFailingRename(() => assert.rejects(installBedrockSupport({ serverDir: dir, type: 'paper', version: '26.2', fetchImpl: geyserFetch, download }), /simulated failure/));
  assert.deepEqual(leftovers(dir), []);
  assert.ok(!fs.existsSync(path.join(dir, 'voxelport-bedrock.json')));
});

test('H4: the server list file is kept whole when saving fails', async () => {
  const dir = tmpDir();
  serverProfiles.createProfile(dir, { name: 'One', type: 'paper', version: '1.21.4', serverDir: path.join(dir, 's1'), port: 25565, minRamMb: 1024, maxRamMb: 1024 });
  const file = path.join(dir, 'server-profiles.json');
  const before = fs.readFileSync(file, 'utf8');
  await withFailingRename(() => assert.throws(() => serverProfiles.createProfile(dir, { name: 'Two', type: 'paper', version: '1.21.4', serverDir: path.join(dir, 's2'), port: 25566, minRamMb: 1024, maxRamMb: 1024 }), /simulated failure/));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(leftovers(dir), []);
});

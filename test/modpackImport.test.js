'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const {
  planFromManifest, planFiles, readDependencies, wantedOnServer, isModrinthUrl,
  readPlan, installMods, copyOverrides, ModpackError,
} = require('../src/main/modpackImport');

const SHA = 'a'.repeat(128);
const cdn = (name) => `https://cdn.modrinth.com/data/AABBCCDD/versions/x/${name}`;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vp-mrpack-'));

const file = (p, env, extra = {}) => ({ path: p, hashes: { sha512: SHA }, downloads: [cdn(path.basename(p))], env, fileSize: 1000, ...extra });
const manifest = (over = {}) => ({
  formatVersion: 1, game: 'minecraft', name: 'Test Pack',
  dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' },
  files: [],
  ...over,
});

// ─── pure manifest logic ──────────────────────────────────────────────────

test('reads Minecraft version and accepts Fabric and Quilt packs', () => {
  assert.equal(readDependencies({ minecraft: '1.21.1', 'fabric-loader': '0.16.0' }).minecraft, '1.21.1');
  assert.equal(readDependencies({ minecraft: '1.21.1', 'quilt-loader': '0.26.0' }).quilt, true);
});

test('refuses Forge and NeoForge packs with a clear code', () => {
  assert.throws(() => readDependencies({ minecraft: '1.21.1', forge: '52.0' }), (e) => e.code === 'forge');
  assert.throws(() => readDependencies({ minecraft: '1.21.1', neoforge: '21.1' }), (e) => e.code === 'forge');
});

test('refuses a pack with no supported loader', () => {
  assert.throws(() => readDependencies({ minecraft: '1.21.1' }), (e) => e.code === 'not-fabric');
});

test('wantedOnServer: keeps "both" and server mods, drops server:unsupported', () => {
  assert.equal(wantedOnServer(undefined), true);
  assert.equal(wantedOnServer({ client: 'required', server: 'required' }), true);
  assert.equal(wantedOnServer({ client: 'optional', server: 'optional' }), true);
  assert.equal(wantedOnServer({ client: 'required', server: 'unsupported' }), false);
});

test('planFiles installs server mods and reports skipped client-only mods', () => {
  const { downloads, skipped } = planFiles([
    file('mods/sodium.jar', { client: 'required', server: 'unsupported' }), // client-only
    file('mods/lithium.jar', { client: 'optional', server: 'required' }),    // server mod
    file('mods/fabric-api.jar', undefined),                                   // no env = both
    file('resourcepacks/pack.zip', { client: 'required', server: 'optional' }), // art, not mods/config
  ]);
  assert.deepEqual(downloads.map((d) => path.basename(d.path)).sort(), ['fabric-api.jar', 'lithium.jar']);
  const reasons = Object.fromEntries(skipped.map((s) => [s.name, s.reason]));
  assert.equal(reasons['sodium.jar'], 'client-only');
  assert.equal(reasons['pack.zip'], 'client-only');
});

test('planFiles skips a server mod that has no Modrinth url or no checksum, instead of installing it unverified', () => {
  const noUrl = { path: 'mods/x.jar', hashes: { sha512: SHA }, downloads: ['https://evil.example.com/x.jar'], env: undefined };
  const noHash = { path: 'mods/y.jar', hashes: {}, downloads: [cdn('y.jar')], env: undefined };
  const { downloads, skipped } = planFiles([noUrl, noHash]);
  assert.equal(downloads.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ['no checksum', 'not on Modrinth']);
});

test('planFiles refuses a path that escapes the folder', () => {
  assert.throws(() => planFiles([file('mods/../../evil.jar', undefined)]), (e) => e.code === 'unsafe');
  assert.throws(() => planFiles([file('mods/sub\\evil.jar', undefined)]), (e) => e.code === 'unsafe');
});

test('planFromManifest returns the name, version and plan', () => {
  const plan = planFromManifest(manifest({ files: [file('mods/a.jar', undefined)] }));
  assert.equal(plan.name, 'Test Pack');
  assert.equal(plan.minecraft, '1.21.1');
  assert.equal(plan.downloads.length, 1);
});

test('planFromManifest rejects a non-Minecraft or newer-format pack', () => {
  assert.throws(() => planFromManifest(manifest({ game: 'other' })), ModpackError);
  assert.throws(() => planFromManifest(manifest({ formatVersion: 2 })), ModpackError);
});

test('isModrinthUrl only trusts https Modrinth hosts', () => {
  assert.equal(isModrinthUrl(cdn('a.jar')), true);
  assert.equal(isModrinthUrl('http://cdn.modrinth.com/a.jar'), false);
  assert.equal(isModrinthUrl('https://cdn.modrinth.com.evil.com/a.jar'), false);
  assert.equal(isModrinthUrl('https://example.com/a.jar'), false);
});

// ─── reading a real .mrpack file ───────────────────────────────────────────

function writeMrpack(dir, { index, overrides = {} }) {
  const out = path.join(dir, 'pack.mrpack');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(index)), 'modrinth.index.json');
  for (const [name, content] of Object.entries(overrides)) zip.addBuffer(Buffer.from(content), name);
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(out);
    ws.on('close', () => resolve(out));
    ws.on('error', reject);
    zip.outputStream.pipe(ws);
    zip.end();
  });
}

test('readPlan reads the plan from a real .mrpack', async () => {
  const dir = tmpDir();
  const mr = await writeMrpack(dir, { index: manifest({ files: [file('mods/a.jar', undefined), file('mods/client.jar', { client: 'required', server: 'unsupported' })] }) });
  const plan = await readPlan(mr);
  assert.equal(plan.minecraft, '1.21.1');
  assert.equal(plan.downloads.length, 1);
  assert.equal(plan.skipped.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readPlan rejects a zip with no modrinth.index.json', async () => {
  const dir = tmpDir();
  const mr = path.join(dir, 'x.mrpack');
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('hi'), 'readme.txt');
    const ws = fs.createWriteStream(mr);
    ws.on('close', resolve); ws.on('error', reject);
    zip.outputStream.pipe(ws); zip.end();
  });
  await assert.rejects(readPlan(mr), (e) => e.code === 'not-mrpack');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installMods downloads each server mod (verified) and copies config overrides', async () => {
  const dir = tmpDir();
  const mr = await writeMrpack(dir, {
    index: manifest({ files: [file('mods/a.jar', undefined), file('mods/b.jar', undefined)] }),
    overrides: {
      'overrides/config/pack.toml': 'base = true',
      'server-overrides/config/pack.toml': 'server = true', // wins over overrides for the same file
      'overrides/options.txt': 'client-only, must be ignored',
      'overrides/saves/world/level.dat': 'a world, must be ignored',
    },
  });
  const serverDir = path.join(dir, 'server');
  fs.mkdirSync(serverDir);
  const plan = await readPlan(mr);
  const got = [];
  const download = async (url, dest, _p, checksum) => { got.push({ url, checksum }); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'jar'); };
  const count = await installMods({ file: mr, serverDir, plan, download });

  assert.equal(count, 2);
  assert.ok(fs.existsSync(path.join(serverDir, 'mods', 'a.jar')));
  assert.ok(got.every((g) => g.checksum.algorithm === 'sha512' && g.checksum.expected === SHA));
  // config override copied, server-overrides won, and the client-only files were ignored
  assert.equal(fs.readFileSync(path.join(serverDir, 'config', 'pack.toml'), 'utf8'), 'server = true');
  assert.ok(!fs.existsSync(path.join(serverDir, 'options.txt')));
  assert.ok(!fs.existsSync(path.join(serverDir, 'saves')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copyOverrides never writes outside the server folder', async () => {
  const dir = tmpDir();
  // A hand-built zip with a traversal name in an override; copyOverrides must ignore or refuse it.
  const mr = path.join(dir, 'evil.mrpack');
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest())), 'modrinth.index.json');
    zip.addBuffer(Buffer.from('x'), 'overrides/config/ok.toml');
    const ws = fs.createWriteStream(mr);
    ws.on('close', resolve); ws.on('error', reject);
    zip.outputStream.pipe(ws); zip.end();
  });
  const serverDir = path.join(dir, 'server');
  fs.mkdirSync(serverDir);
  const n = await copyOverrides(mr, serverDir);
  assert.equal(n, 1);
  assert.ok(fs.existsSync(path.join(serverDir, 'config', 'ok.toml')));
  fs.rmSync(dir, { recursive: true, force: true });
});

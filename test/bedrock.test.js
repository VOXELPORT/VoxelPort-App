'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  bedrockSupported, resolveBedrockJars, installBedrockSupport, removeBedrockSupport, bedrockPort,
} = require('../src/main/bedrock');

const sha = (c) => c.repeat(64);

function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  };
}

const GEYSER_ROUTES = {
  '/geyser/versions/latest/builds/latest': { version: '2.11.3', build: 1251, downloads: { spigot: { name: 'Geyser-Spigot.jar', sha256: sha('a') } } },
  '/floodgate/versions/latest/builds/latest': { version: '2.2.5', build: 141, downloads: { spigot: { name: 'floodgate-spigot.jar', sha256: sha('b') } } },
};

function modrinth(file, type = 'release') {
  return [{ version_type: type, files: [{ primary: true, url: `https://cdn.modrinth.com/data/x/${file}`, filename: file, hashes: { sha512: 'f'.repeat(128) } }] }];
}

const MODRINTH_ROUTES = {
  '/project/fabric-api/version': modrinth('fabric-api-0.161.0+26.2.jar'),
  '/project/geyser/version': modrinth('Geyser-Fabric-2.11.3-b1251.jar'),
  '/project/floodgate/version': modrinth('Floodgate-Fabric-2.2.6-b67.jar', 'beta'),
};

test('bedrockSupported is Paper and Fabric only', () => {
  assert.equal(bedrockSupported('paper'), true);
  assert.equal(bedrockSupported('fabric'), true);
  assert.equal(bedrockSupported('vanilla'), false);
});

test('Paper resolves pinned Geyser/Floodgate builds with sha256', async () => {
  const jars = await resolveBedrockJars('paper', '26.2', fakeFetch(GEYSER_ROUTES));
  assert.equal(jars.length, 2);
  assert.equal(jars[0].url, 'https://download.geysermc.org/v2/projects/geyser/versions/2.11.3/builds/1251/downloads/spigot');
  assert.deepEqual(jars[0].checksum, { algorithm: 'sha256', expected: sha('a') });
  assert.equal(jars[1].fileName, 'floodgate-spigot.jar');
  assert.ok(jars.every((j) => j.dir === 'plugins'));
});

test('Fabric resolves version-matched jars from Modrinth with sha512', async () => {
  const jars = await resolveBedrockJars('fabric', '26.2', fakeFetch(MODRINTH_ROUTES));
  assert.deepEqual(jars.map((j) => j.fileName), ['fabric-api-0.161.0+26.2.jar', 'Geyser-Fabric-2.11.3-b1251.jar', 'Floodgate-Fabric-2.2.6-b67.jar']);
  assert.ok(jars.every((j) => j.dir === 'mods' && j.checksum.algorithm === 'sha512'));
});

test('Vanilla and unavailable versions give a clear error', async () => {
  await assert.rejects(resolveBedrockJars('vanilla', '26.2', fakeFetch({})), /Paper or Fabric/);
  await assert.rejects(resolveBedrockJars('fabric', '1.0', fakeFetch({ '/project/': [] })), /isn't available for Minecraft 1\.0/);
});

test('unsafe file names from an API are refused', async () => {
  const routes = { ...GEYSER_ROUTES, '/geyser/versions/latest/builds/latest': { version: '1', build: 1, downloads: { spigot: { name: '../evil.jar', sha256: sha('a') } } } };
  await assert.rejects(resolveBedrockJars('paper', '26.2', fakeFetch(routes)), /No Paper download/);
});

test('install writes jars, replaces old Geyser copies, keeps an existing Fabric API, and can be removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-bedrock-'));
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'mods', 'fabric-api-0.150.0.jar'), 'old api');
  fs.writeFileSync(path.join(dir, 'mods', 'Geyser-Fabric-2.0.0-b1.jar'), 'old geyser');
  fs.writeFileSync(path.join(dir, 'mods', 'sodium.jar'), 'other mod');

  const downloaded = [];
  const download = async (url, dest) => { downloaded.push(path.basename(dest)); fs.writeFileSync(dest, url); };
  const res = await installBedrockSupport({ serverDir: dir, type: 'fabric', version: '26.2', fetchImpl: fakeFetch(MODRINTH_ROUTES), download });

  assert.deepEqual(downloaded, ['Geyser-Fabric-2.11.3-b1251.jar', 'Floodgate-Fabric-2.2.6-b67.jar']); // Fabric API kept
  const mods = fs.readdirSync(path.join(dir, 'mods')).sort();
  assert.deepEqual(mods, ['Floodgate-Fabric-2.2.6-b67.jar', 'Geyser-Fabric-2.11.3-b1251.jar', 'fabric-api-0.150.0.jar', 'sodium.jar']);
  assert.equal(res.port, 19132);

  removeBedrockSupport(dir);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mods')).sort(), ['fabric-api-0.150.0.jar', 'sodium.jar']);
});

test('bedrockPort reads Geyser\'s generated config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-bedrock-'));
  assert.equal(bedrockPort(dir), 19132);
  fs.mkdirSync(path.join(dir, 'plugins', 'Geyser-Spigot'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'Geyser-Spigot', 'config.yml'),
    '# Geyser config\nbedrock:\n  # The IP address\n  address: 0.0.0.0\n  port: 19200\n  clone-remote-port: false\nremote:\n  port: 25565\n');
  assert.equal(bedrockPort(dir), 19200);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const { readRuntimeInfo, readPlugins, readStagedUpdates, versionFromFileName } = require('../src/main/runtimeInfo');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-runtime-'));
}

function makeJar(jarPath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const out = fs.createWriteStream(jarPath);
    out.on('close', resolve); out.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
    for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
    zip.end();
  });
}

test('versionFromFileName pulls a version out of common jar names', () => {
  assert.equal(versionFromFileName('Geyser-Spigot-2.11.3.jar'), '2.11.3');
  assert.equal(versionFromFileName('ViaVersion-5.1.1.jar'), '5.1.1');
  assert.equal(versionFromFileName('floodgate-spigot-2.2.6-b67.jar'), '2.2.6-b67');
  assert.equal(versionFromFileName('Geyser-Spigot.jar'), null);
});

test('readPlugins finds known plugins/mods and ignores non-jars and look-alikes', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'plugins', 'Geyser-Spigot-2.11.3.jar'), 'x');
  fs.writeFileSync(path.join(dir, 'plugins', 'floodgate-spigot-2.2.6.jar'), 'x');
  fs.writeFileSync(path.join(dir, 'plugins', 'GeyserSkinManager-Spigot.jar'), 'x'); // look-alike, not matched
  fs.writeFileSync(path.join(dir, 'plugins', 'readme.txt'), 'x'); // not a jar
  fs.writeFileSync(path.join(dir, 'mods', 'ViaVersion-5.1.1.jar'), 'x');

  const found = readPlugins(dir).map((p) => `${p.key}@${p.version}`).sort();
  assert.deepEqual(found, ['floodgate@2.2.6', 'geyser@2.11.3', 'viaversion@5.1.1']);
});

test('readRuntimeInfo reads the real MC version from the jar plus plugin versions', async () => {
  const dir = tmpDir();
  await makeJar(path.join(dir, 'server.jar'), { 'version.json': JSON.stringify({ id: '26.2' }) });
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'plugins', 'Geyser-Spigot-2.11.3.jar'), 'x');

  const info = await readRuntimeInfo(dir);
  assert.equal(info.minecraftVersion, '26.2');
  assert.equal(info.plugins.length, 1);
  assert.equal(info.plugins[0].key, 'geyser');
  assert.equal(info.plugins[0].version, '2.11.3');
});

test('readRuntimeInfo returns null version for a Fabric-style jar with no version.json', async () => {
  const dir = tmpDir();
  await makeJar(path.join(dir, 'server.jar'), { 'fabric-server-launch.properties': 'x' });
  const info = await readRuntimeInfo(dir);
  assert.equal(info.minecraftVersion, null);
});

test('readStagedUpdates finds jars waiting in plugins/update and mods/update', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'plugins', 'update'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'mods', 'update'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'update', 'Geyser-Spigot.jar'), 'x');
  fs.writeFileSync(path.join(dir, 'plugins', 'update', 'notes.txt'), 'x'); // ignored
  fs.writeFileSync(path.join(dir, 'mods', 'update', 'SomeMod.jar'), 'x');
  const staged = readStagedUpdates(dir).map((s) => `${s.dir}/${s.name}`).sort();
  assert.deepEqual(staged, ['mods/SomeMod.jar', 'plugins/Geyser-Spigot.jar']);
});

test('readStagedUpdates is empty (not an error) when there is no update folder', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'plugins'));
  assert.deepEqual(readStagedUpdates(dir), []);
});

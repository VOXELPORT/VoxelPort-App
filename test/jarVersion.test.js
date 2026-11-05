'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const { readJarMinecraftVersion } = require('../src/main/jarVersion');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-jar-test-'));
}

// Writes a jar (zip) with the given entries { name: Buffer|string } and returns its path.
function makeJar(entries) {
  const dir = tmpDir();
  const jarPath = path.join(dir, 'server.jar');
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const out = fs.createWriteStream(jarPath);
    out.on('close', () => resolve(jarPath));
    out.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    }
    zip.end();
  });
}

test('reads the Minecraft version from a Paper/Vanilla-style jar version.json', async () => {
  const jar = await makeJar({
    'version.json': JSON.stringify({ id: '26.2', name: '26.2', world_version: 4567 }),
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
  });
  assert.equal(await readJarMinecraftVersion(jar), '26.2');
});

test('returns null for a Fabric-style launcher jar with no version.json', async () => {
  const jar = await makeJar({
    'fabric-server-launch.properties': 'launch.mainClass=net.fabricmc.loader.impl.launch.knot.KnotServer\n',
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
  });
  assert.equal(await readJarMinecraftVersion(jar), null);
});

test('returns null (not a throw) when version.json is not valid JSON', async () => {
  const jar = await makeJar({ 'version.json': 'this is not json {' });
  assert.equal(await readJarMinecraftVersion(jar), null);
});

test('returns null when version.json has no string id', async () => {
  const jar = await makeJar({ 'version.json': JSON.stringify({ name: 'no id here' }) });
  assert.equal(await readJarMinecraftVersion(jar), null);
});

test('rejects on a genuinely unreadable (non-zip) file', async () => {
  const dir = tmpDir();
  const bad = path.join(dir, 'server.jar');
  fs.writeFileSync(bad, 'definitely not a zip archive');
  await assert.rejects(() => readJarMinecraftVersion(bad));
});

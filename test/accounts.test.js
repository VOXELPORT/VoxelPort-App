'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isCracked, setCracked, validateAccountsChange, hasLoginPlugin, resolveLoginPlugin, installLoginPlugin,
} = require('../src/main/accounts');
const { updateServerPropertiesSafely } = require('../src/main/serverInstall');
const { validateSettings } = require('../src/main/serverSettings');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vp-acc-'));
const props = (dir, text) => fs.writeFileSync(path.join(dir, 'server.properties'), text);
const read = (dir) => fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');

test('a fresh or missing server is premium-only', () => {
  const dir = tmpDir();
  assert.equal(isCracked(dir), false); // no file yet
  props(dir, 'online-mode=true\n');
  assert.equal(isCracked(dir), false);
  props(dir, 'motd=Hi\n'); // key absent: Minecraft defaults to on
  assert.equal(isCracked(dir), false);
});

test('setCracked flips only online-mode and enforce-secure-profile, keeping every other line', () => {
  const dir = tmpDir();
  const original = '#Minecraft server properties\n#Mon Oct 12\nmotd=My \\u00e9 SMP\nonline-mode=true\nmax-players=20\ncustom-plugin-key=keep\nenforce-secure-profile=true\n';
  props(dir, original);
  setCracked(dir, true);
  assert.equal(isCracked(dir), true);
  assert.equal(read(dir), original.replace('online-mode=true', 'online-mode=false').replace('enforce-secure-profile=true', 'enforce-secure-profile=false'));
  setCracked(dir, false);
  assert.equal(read(dir), original); // exactly back to how it was
  assert.equal(isCracked(dir), false);
});

test('setCracked adds the keys when missing, keeps CRLF, and creates a missing file', () => {
  const dir = tmpDir();
  props(dir, 'motd=Hi\r\nmax-players=5\r\n');
  setCracked(dir, true);
  assert.equal(read(dir), 'motd=Hi\r\nmax-players=5\r\nonline-mode=false\r\nenforce-secure-profile=false\r\n');
  const fresh = tmpDir();
  setCracked(fresh, true);
  assert.equal(isCracked(fresh), true);
});

test('setCracked rejects non-booleans and relative folders (no path or value tricks)', () => {
  const dir = tmpDir();
  assert.throws(() => setCracked(dir, 'false'), /Invalid setting/);
  assert.throws(() => setCracked(dir, 1), /Invalid setting/);
  assert.throws(() => setCracked('relative/dir', true), /Invalid server folder/);
});

test('turning cracked mode on needs an explicit confirmation; turning it off does not', () => {
  assert.throws(() => validateAccountsChange({ cracked: true }), /Confirm/);
  assert.throws(() => validateAccountsChange({ cracked: true, confirmed: 'yes' }), /Confirm/);
  assert.equal(validateAccountsChange({ cracked: true, confirmed: true }), true);
  assert.equal(validateAccountsChange({ cracked: false }), false);
  assert.throws(() => validateAccountsChange({ cracked: 'true', confirmed: true }), /Invalid/);
  assert.throws(() => validateAccountsChange(null), /Invalid/);
});

test('the ordinary Settings paths still cannot change online-mode', () => {
  assert.throws(() => validateSettings({ 'online-mode': false }), /can't be changed/);
  const dir = tmpDir();
  props(dir, 'online-mode=true\n');
  updateServerPropertiesSafely(dir, { 'online-mode': 'false', 'enforce-secure-profile': 'false' });
  assert.equal(isCracked(dir), false);
});

function fakeModrinth(versions) {
  return async (url) => {
    assert.match(url, /^https:\/\/api\.modrinth\.com\/v2\/project\/3IEZ9vol\/version\?/);
    return { ok: true, status: 200, json: async () => versions };
  };
}
const good = {
  version_type: 'release',
  files: [{ primary: true, url: 'https://cdn.modrinth.com/data/3IEZ9vol/versions/x/AuthMe-5.7.0.jar', filename: 'AuthMe-5.7.0.jar', hashes: { sha512: 'ab'.repeat(64) } }],
};

test('resolveLoginPlugin asks Modrinth for the right loaders and version, and demands a hash', async () => {
  let asked = '';
  const fetchImpl = async (url) => { asked = decodeURIComponent(url); return fakeModrinth([good])(url); };
  const jar = await resolveLoginPlugin('1.21.4', fetchImpl);
  assert.match(asked, /loaders=\["paper","spigot","bukkit"\]/);
  assert.match(asked, /game_versions=\["1\.21\.4"\]/);
  assert.equal(jar.fileName, 'AuthMe-5.7.0.jar');
  assert.equal(jar.checksum.algorithm, 'sha512');

  await assert.rejects(resolveLoginPlugin('26.3', fakeModrinth([])), /isn't available for Minecraft 26.3/);
  const noHash = { ...good, files: [{ ...good.files[0], hashes: {} }] };
  await assert.rejects(resolveLoginPlugin('26.3', fakeModrinth([noHash])), /No usable/);
  const evil = { ...good, files: [{ ...good.files[0], filename: '../../evil.jar' }] };
  await assert.rejects(resolveLoginPlugin('26.3', fakeModrinth([evil])), /No usable/);
});

test('installLoginPlugin downloads into plugins/ with the checksum, replaces old copies, Paper only', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'plugins', 'AuthMe-5.6.0.jar'), 'old');
  fs.writeFileSync(path.join(dir, 'plugins', 'Essentials.jar'), 'other plugin');
  let got;
  const download = async (url, dest, _p, checksum) => { got = { url, dest, checksum }; fs.writeFileSync(dest, 'new'); };
  const res = await installLoginPlugin({ serverDir: dir, type: 'paper', version: '1.21.4', fetchImpl: fakeModrinth([good]), download });
  assert.equal(res.file, 'AuthMe-5.7.0.jar');
  assert.equal(got.dest, path.join(dir, 'plugins', 'AuthMe-5.7.0.jar'));
  assert.equal(got.checksum.expected, 'ab'.repeat(64));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plugins')).sort(), ['AuthMe-5.7.0.jar', 'Essentials.jar']); // only the old AuthMe went
  assert.equal(hasLoginPlugin(dir), true);

  await assert.rejects(installLoginPlugin({ serverDir: dir, type: 'fabric', version: '1.21.4', fetchImpl: fakeModrinth([good]), download }), /Paper/);
  assert.equal(hasLoginPlugin(tmpDir()), false);
});

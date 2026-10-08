'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findManagedJava, javaExecutableIn, ALLOWED_HOSTS } = require('../src/main/javaInstall');

const exe = process.platform === 'win32' ? 'java.exe' : 'java';

function fakeJre(root, folder, layout = 'plain') {
  const bin = layout === 'mac'
    ? path.join(root, 'java', folder, 'Contents', 'Home', 'bin')
    : path.join(root, 'java', folder, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, exe), '');
  return path.join(bin, exe);
}

test('findManagedJava returns null when nothing is installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-java-'));
  assert.equal(findManagedJava(dir, 21), null);
});

test('findManagedJava prefers an exact major, then the closest newer one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-java-'));
  fakeJre(dir, 'temurin-17');
  const j21 = fakeJre(dir, 'temurin-21');
  fakeJre(dir, 'temurin-25');

  assert.deepEqual(findManagedJava(dir, 21), { major: 21, javaPath: j21 });
  assert.equal(findManagedJava(dir, 18).major, 21, 'closest newer than 18 is 21');
  assert.equal(findManagedJava(dir, 8).major, 17);
  assert.equal(findManagedJava(dir, 26), null, 'nothing new enough');
});

test('findManagedJava ignores folders without a java executable and unrelated names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-java-'));
  fs.mkdirSync(path.join(dir, 'java', 'temurin-21'), { recursive: true }); // half-installed
  fs.mkdirSync(path.join(dir, 'java', '.install-abc'), { recursive: true });
  fakeJre(dir, 'zulu-21');
  assert.equal(findManagedJava(dir, 21), null);
});

test('javaExecutableIn understands the macOS bundle layout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-java-'));
  const p = fakeJre(dir, 'temurin-21', 'mac');
  assert.equal(javaExecutableIn(path.join(dir, 'java', 'temurin-21')), p);
});

test('downloads are limited to Adoptium and GitHub release hosts', () => {
  assert.deepEqual([...ALLOWED_HOSTS].sort(), [
    'api.adoptium.net', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
  ]);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveInside, listDir, readTextFile, writeTextFile, isEditable } = require('../src/main/serverFiles');

function server() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-files-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=hi\n');
  fs.writeFileSync(path.join(dir, 'ops.json'), '[]');
  fs.writeFileSync(path.join(dir, 'server.jar'), Buffer.from([0x50, 0x4b, 0, 1]));
  fs.writeFileSync(path.join(dir, 'latest.log'), 'log');
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'plugins', 'config.yml'), 'a: 1\n');
  return dir;
}

test('resolveInside accepts paths inside the server folder', () => {
  const dir = server();
  assert.equal(resolveInside(dir, ''), fs.realpathSync(dir));
  assert.equal(resolveInside(dir, 'plugins/config.yml'), path.join(fs.realpathSync(dir), 'plugins', 'config.yml'));
  assert.equal(resolveInside(dir, '/plugins'), path.join(fs.realpathSync(dir), 'plugins'));
});

test('resolveInside rejects traversal, absolute paths and NUL bytes', () => {
  const dir = server();
  for (const bad of ['..', '../x', 'plugins/../../x', '..\\x', 'C:\\Windows', 'C:/Windows', 'a\0b']) {
    assert.throws(() => resolveInside(dir, bad), /not allowed/, bad);
  }
  assert.throws(() => resolveInside('relative/dir', ''), /not found/);
  assert.throws(() => resolveInside(dir, 5), /not allowed/);
});

test('resolveInside rejects a link that leaves the folder', (t) => {
  const dir = server();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  try { fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction'); } catch { t.skip('cannot create links here'); return; }
  assert.throws(() => resolveInside(dir, 'escape'), /not allowed/);
  assert.throws(() => readTextFile(dir, 'escape/secret.txt'), /not allowed/);
  assert.throws(() => writeTextFile(dir, 'escape/secret.txt', 'x'), /not allowed/);
});

test('listDir lists folders first and marks which files can be edited', () => {
  const dir = server();
  const { path: p, entries } = listDir(dir, '');
  assert.equal(p, '');
  assert.deepEqual(entries.map((e) => e.name), ['plugins', 'latest.log', 'ops.json', 'server.jar', 'server.properties']);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName.plugins.dir, true);
  assert.equal(byName['ops.json'].editable, true);
  assert.equal(byName['server.jar'].editable, false);
  assert.equal(byName['latest.log'].editable, false); // read-only
  assert.equal(listDir(dir, 'plugins').path, 'plugins');
});

test('readTextFile reads text, refuses binaries and unknown types', () => {
  const dir = server();
  assert.equal(readTextFile(dir, 'server.properties').text, 'motd=hi\n');
  assert.equal(readTextFile(dir, 'latest.log').readOnly, true);
  assert.throws(() => readTextFile(dir, 'server.jar'), /cannot be opened/);
  fs.writeFileSync(path.join(dir, 'bin.txt'), Buffer.from([65, 0, 66]));
  assert.throws(() => readTextFile(dir, 'bin.txt'), /not plain text/);
  assert.throws(() => readTextFile(dir, 'missing.txt'), /does not exist/);
  assert.throws(() => readTextFile(dir, 'plugins'), /cannot be opened|not a file/);
});

test('readTextFile refuses a file over the size limit', () => {
  const dir = server();
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(512 * 1024 + 1));
  assert.throws(() => readTextFile(dir, 'big.txt'), /too large/);
  assert.equal(isEditable('big.txt', 512 * 1024 + 1), false);
});

test('writeTextFile saves an existing text file and leaves no temp files', () => {
  const dir = server();
  writeTextFile(dir, 'server.properties', 'motd=changed\n');
  assert.equal(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), 'motd=changed\n');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
});

test('writeTextFile will not create files, edit logs, or touch binaries', () => {
  const dir = server();
  assert.throws(() => writeTextFile(dir, 'new.txt', 'x'), /does not exist/);
  assert.throws(() => writeTextFile(dir, 'latest.log', 'x'), /cannot be edited/);
  assert.throws(() => writeTextFile(dir, 'server.jar', 'x'), /cannot be edited/);
  assert.throws(() => writeTextFile(dir, '../evil.txt', 'x'), /not allowed/);
  assert.throws(() => writeTextFile(dir, 'plugins', 'x'), /cannot be edited/);
});

test('writeTextFile refuses invalid JSON and keeps the old file', () => {
  const dir = server();
  assert.throws(() => writeTextFile(dir, 'ops.json', '[{'), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(dir, 'ops.json'), 'utf8'), '[]');
  writeTextFile(dir, 'ops.json', '[{"name":"a"}]');
  assert.equal(fs.readFileSync(path.join(dir, 'ops.json'), 'utf8'), '[{"name":"a"}]');
});

test('writeTextFile refuses non-text and oversize input', () => {
  const dir = server();
  assert.throws(() => writeTextFile(dir, 'server.properties', 5), /Nothing to save/);
  assert.throws(() => writeTextFile(dir, 'server.properties', 'x'.repeat(512 * 1024 + 1)), /too large/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkDeletable } = require('../src/main/serverRemoval');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-rm-')); }
function server(parent, name = 'srv', files = ['server.properties']) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

test('a normal server folder can be deleted', () => {
  const dir = server(tmp());
  assert.deepEqual(checkDeletable(dir), { ok: true });
});

test('a folder with a jar and a world or logs also counts as a server', () => {
  const root = tmp();
  const dir = server(root, 'a', ['paper.jar', 'eula.txt']);
  assert.equal(checkDeletable(dir).ok, true);
  const jarOnly = server(root, 'b', ['tool.jar']);
  assert.deepEqual(checkDeletable(jarOnly), { ok: false, reason: 'not-a-server' });
});

test('a folder that is not clearly a server is refused', () => {
  const dir = server(tmp(), 'docs', ['notes.txt']);
  assert.deepEqual(checkDeletable(dir), { ok: false, reason: 'not-a-server' });
});

test('drive roots, relative paths, files and missing folders are refused', () => {
  assert.equal(checkDeletable(path.parse(os.tmpdir()).root).reason, 'too-broad');
  assert.equal(checkDeletable('relative/dir').reason, 'not-a-folder');
  assert.equal(checkDeletable(5).reason, 'not-a-folder');
  const root = tmp();
  assert.equal(checkDeletable(path.join(root, 'nope')).reason, 'missing');
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'x');
  assert.equal(checkDeletable(file).reason, 'not-a-folder');
});

test('a folder that is, or contains, a protected folder is refused', () => {
  const root = tmp();
  const home = path.join(root, 'home');
  const dir = server(root, 'srv');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'server.properties'), 'x'); // the parent looks like a server too
  assert.equal(checkDeletable(root, { keep: [home] }).reason, 'protected'); // holds home
  assert.equal(checkDeletable(dir, { keep: [dir] }).reason, 'protected');   // is home
  assert.equal(checkDeletable(dir, { keep: [home] }).ok, true);
});

test('a folder shared with, holding, or inside another saved server is refused', () => {
  const root = tmp();
  const a = server(root, 'a');
  const inner = server(a, 'inner');
  assert.equal(checkDeletable(a, { otherServerDirs: [a] }).reason, 'shared');
  assert.equal(checkDeletable(a, { otherServerDirs: [inner] }).reason, 'shared');
  assert.equal(checkDeletable(inner, { otherServerDirs: [a] }).reason, 'shared');
  assert.equal(checkDeletable(a, { otherServerDirs: [path.join(root, 'elsewhere')] }).ok, true);
});

test('a name that only starts the same is not "inside"', () => {
  const root = tmp();
  const a = server(root, 'srv');
  const b = server(root, 'srv-two');
  assert.equal(checkDeletable(a, { otherServerDirs: [b] }).ok, true);
});

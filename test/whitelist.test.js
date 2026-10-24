'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isValidUsername, parseNames, readWhitelist, addFriends, removeFriend, setEnabled, status, isWhitelistOn } = require('../src/main/whitelist');

function server({ cracked = false, props = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-wl-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), `online-mode=${cracked ? 'false' : 'true'}\n${props}`);
  return dir;
}
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'whitelist.json'), 'utf8'));
const propVal = (dir, key) => { const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')); return m && m[1]; };

// ─── pure name parsing ──────────────────────────────────────────────────────

test('isValidUsername: 3–16 of letters, digits, underscore', () => {
  assert.ok(isValidUsername('Steve'));
  assert.ok(isValidUsername('a_b_123'));
  assert.ok(!isValidUsername('ab'));           // too short
  assert.ok(!isValidUsername('x'.repeat(17))); // too long
  assert.ok(!isValidUsername('has space'));
  assert.ok(!isValidUsername('bad-dash'));
  assert.ok(!isValidUsername('emoji😀name'));
});

test('parseNames splits on spaces/commas/newlines, drops duplicates, separates invalid', () => {
  const { valid, invalid } = parseNames('Steve, Alex\nSteve  bad-name  Notch');
  assert.deepEqual(valid, ['Steve', 'Alex', 'Notch']);
  assert.deepEqual(invalid, ['bad-name']);
});

test('parseNames treats names as case-insensitive for duplicates', () => {
  assert.deepEqual(parseNames('Steve steve STEVE').valid, ['Steve']);
});

// ─── whitelist file + properties ────────────────────────────────────────────

test('addFriends writes whitelist.json, turns on white-list and enforce-whitelist', () => {
  const dir = server();
  const r = addFriends({ serverDir: dir, text: 'Steve Alex', running: false });
  assert.deepEqual(r.added, ['Steve', 'Alex']);
  assert.deepEqual(read(dir).map((e) => e.name), ['Steve', 'Alex']);
  assert.equal(propVal(dir, 'white-list'), 'true');
  assert.equal(propVal(dir, 'enforce-whitelist'), 'true');
  assert.equal(r.restartNeeded, true); // added while stopped
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('addFriends reports already-present and invalid names, and does not duplicate', () => {
  const dir = server();
  addFriends({ serverDir: dir, text: 'Steve', running: false });
  const r = addFriends({ serverDir: dir, text: 'Steve Alex ab name!', running: false });
  assert.deepEqual(r.added, ['Alex']);
  assert.deepEqual(r.already, ['Steve']);
  assert.deepEqual(r.invalid.sort(), ['ab', 'name!']);
  assert.deepEqual(read(dir).map((e) => e.name), ['Steve', 'Alex']);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('addFriends on a running server sends whitelist commands and needs no restart', () => {
  const dir = server();
  const sent = [];
  const r = addFriends({ serverDir: dir, text: 'Steve', running: true, send: (c) => sent.push(c) });
  assert.ok(sent.includes('whitelist add Steve'));
  assert.ok(sent.includes('whitelist on'));
  assert.equal(r.restartNeeded, false);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('addFriends flags a cracked server so the UI can warn', () => {
  const plain = server({ cracked: false });
  const cracked = server({ cracked: true });
  assert.equal(addFriends({ serverDir: plain, text: 'Steve', running: false }).cracked, false);
  assert.equal(addFriends({ serverDir: cracked, text: 'Steve', running: false }).cracked, true);
  fs.rmSync(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(cracked, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('removeFriend takes a name off the list and commands a running server', () => {
  const dir = server();
  addFriends({ serverDir: dir, text: 'Steve Alex', running: false });
  const sent = [];
  removeFriend({ serverDir: dir, name: 'Steve', running: true, send: (c) => sent.push(c) });
  assert.deepEqual(read(dir).map((e) => e.name), ['Alex']);
  assert.ok(sent.includes('whitelist remove Steve'));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('setEnabled turns the whitelist off but keeps the names', () => {
  const dir = server();
  addFriends({ serverDir: dir, text: 'Steve', running: false });
  setEnabled({ serverDir: dir, on: false, running: false });
  assert.equal(propVal(dir, 'white-list'), 'false');
  assert.deepEqual(read(dir).map((e) => e.name), ['Steve']); // names kept for turning back on
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('status reports enabled state, the friends and cracked', () => {
  const dir = server({ cracked: true });
  addFriends({ serverDir: dir, text: 'Steve', running: false });
  const s = status(dir);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.friends, ['Steve']);
  assert.equal(s.cracked, true);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('readWhitelist ignores malformed entries and duplicates', () => {
  const dir = server();
  fs.writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify([
    { name: 'Steve', uuid: 'u1' }, { name: 'steve' }, { name: 'bad name' }, { nope: true }, 'x',
  ]));
  assert.deepEqual(readWhitelist(dir).map((e) => e.name), ['Steve']);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('isWhitelistOn reads the property', () => {
  const on = server({ props: 'white-list=true\n' });
  const off = server({ props: 'white-list=false\n' });
  assert.equal(isWhitelistOn(on), true);
  assert.equal(isWhitelistOn(off), false);
  fs.rmSync(on, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(off, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

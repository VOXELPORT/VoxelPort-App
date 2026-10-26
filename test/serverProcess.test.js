'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { ServerProcess, stripLogPrefix } = require('../src/main/serverProcess');

/** A stand-in for the spawned Java process: output the test writes, and a stdin it can break. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  return child;
}

const START = { serverDir: path.resolve(os.tmpdir()), minRamMb: 1024, maxRamMb: 1024, javaPath: 'java' };

function started(opts = {}) {
  const child = fakeChild();
  const proc = new ServerProcess({ spawnImpl: () => child });
  const events = [];
  for (const name of ['status', 'log', 'players', 'exit']) proc.on(name, (v) => events.push([name, v]));
  proc.start({ ...START, ...opts });
  return { proc, child, events };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ─── K1: a line cut across chunks is still one line ─────────────────────────

test('K1: "Done (3.2s)!" split across two chunks still brings the server online', async () => {
  const { proc, child } = started();
  child.stdout.write('[12:00:00 INFO]: Done (3.2');
  await tick();
  assert.equal(proc.status, 'starting', 'half a line is not a line');
  child.stdout.write('s)! For help, type "help"\n');
  await tick();
  assert.equal(proc.status, 'online');
});

test('K1: a character split between two chunks comes through whole', async () => {
  const { child, events } = started();
  const line = '[12:00:01 INFO]: naïve — ✓ 日本語\n';
  const bytes = Buffer.from(line, 'utf8');
  // Cut inside the two-byte "ï", inside the three-byte "—", and inside a three-byte Japanese character.
  const cuts = [bytes.indexOf(0xC3) + 1, bytes.indexOf(0xE2) + 1, bytes.indexOf(0xE6) + 1, bytes.indexOf(0xE6) + 2];
  let from = 0;
  for (const cut of cuts) { child.stdout.write(bytes.subarray(from, cut)); from = cut; await tick(); }
  child.stdout.write(bytes.subarray(from));
  await tick();
  const logs = events.filter(([n]) => n === 'log').map(([, l]) => l);
  assert.deepEqual(logs, ['[12:00:01 INFO]: naïve — ✓ 日本語']);
});

test('K1: several lines in one chunk, and Windows line endings, are read as separate lines', async () => {
  const { child, events } = started();
  child.stdout.write('[12:00:00 INFO]: one\r\n[12:00:00 INFO]: two\r\n[12:00:00 INFO]: Steve joined the game\r\n');
  await tick();
  assert.deepEqual(events.filter(([n]) => n === 'log').map(([, l]) => l), ['[12:00:00 INFO]: one', '[12:00:00 INFO]: two', '[12:00:00 INFO]: Steve joined the game']);
  assert.deepEqual(events.filter(([n]) => n === 'players').map(([, c]) => c), [1]);
});

test('K1: what the server writes to its error output is read the same way', async () => {
  const { proc, child } = started();
  child.stderr.write('[12:00:00 INFO]: Done (1.0');
  await tick();
  child.stderr.write('s)!\n');
  await tick();
  assert.equal(proc.status, 'online');
});

// ─── K2: a Java that cannot start, and a server that has gone away ──────────

test('K2: a Java that does not exist ends the server once, as a crash', async () => {
  const proc = new ServerProcess();
  const exits = [];
  proc.on('exit', (code) => exits.push(code));
  const noSuchJava = path.join(os.tmpdir(), `vp-no-such-folder-${process.pid}`, process.platform === 'win32' ? 'java.exe' : 'java');
  proc.start({ ...START, javaPath: noSuchJava });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(exits, [-1]);
  assert.equal(proc.status, 'crashed');
  assert.equal(proc.child, null, 'so the app can let go of this server');
});

test('K2: an error from a process that did start is logged, and its exit still comes once', async () => {
  const { proc, child, events } = started();
  child.emit('error', new Error('kill EPERM'));
  assert.equal(events.filter(([n]) => n === 'exit').length, 0, 'it is still running');
  assert.ok(proc.child);
  child.emit('exit', 0);
  child.emit('exit', 0);
  assert.deepEqual(events.filter(([n]) => n === 'exit'), [['exit', 0]]);
});

test('K2: writing to a server that has gone away (a broken pipe) does not crash the app', () => {
  const { proc, child, events } = started();
  assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  assert.ok(events.some(([n, v]) => n === 'log' && /write EPIPE/.test(v)));
  assert.ok(proc);
});

// ─── K3: what the server says, and what a player can type ───────────────────

test('K3: the log prefix of Vanilla and of Paper is removed, and nothing else', () => {
  assert.equal(stripLogPrefix('[12:00:00] [Server thread/INFO]: Done (3.2s)! For help, type "help"'), 'Done (3.2s)! For help, type "help"');
  assert.equal(stripLogPrefix('[12:00:00 INFO]: Steve joined the game'), 'Steve joined the game');
  assert.equal(stripLogPrefix('[Server thread/INFO]: Saved the game'), 'Saved the game');
  assert.equal(stripLogPrefix('no prefix at all'), 'no prefix at all');
});

test('K3: the server saying a player joined or left (either format) is counted', async () => {
  const { child, events } = started();
  child.stdout.write('[12:00:00] [Server thread/INFO]: Steve joined the game\n');
  child.stdout.write('[12:00:01 INFO]: .Bedrock_Alex joined the game\n');
  child.stdout.write('[12:00:02 INFO]: Steve left the game\n');
  await tick();
  assert.deepEqual(events.filter(([n]) => n === 'players').map(([, c]) => c), [1, 2, 1]);
});

test('K3: chat and other text that only contains those words is not the server saying them', async () => {
  const { proc, child, events } = started();
  const spoofs = [
    '[12:00:00 INFO]: <Steve> Bob joined the game',
    '[12:00:00 INFO]: <Steve> x: Bob joined the game',
    '[12:00:00 INFO]: [Not Secure] <Steve> Bob left the game',
    '[12:00:00 INFO]: <Steve> Done (1s)!',
    '[12:00:00 INFO]: Steve joined the game for the first time',
    '[12:00:00 INFO]: Steve: Bob joined the game',
    '[12:00:00 INFO]: Mr Steve joined the game',
    '[12:00:00 INFO]: ' + 'A'.repeat(33) + ' joined the game',
  ];
  for (const line of spoofs) child.stdout.write(line + '\n');
  await tick();
  assert.equal(proc.status, 'starting', 'a player typing "Done (1s)!" does not start the server');
  assert.deepEqual(events.filter(([n]) => n === 'players'), []);
  assert.equal(proc.online.size, 0);
});

// ─── player names and the console's player buttons ──────────────────────────

test('the names of who is online follow joins and leaves, and clear when the server ends', async () => {
  const child = fakeChild();
  const proc = new ServerProcess({ spawnImpl: () => child });
  const lists = [];
  proc.on('names', (v) => lists.push(v));
  proc.start(START);
  child.stdout.write('[12:00:00 INFO]: Steve joined the game\n');
  child.stdout.write('[12:00:01 INFO]: Alex joined the game\n');
  child.stdout.write('[12:00:02 INFO]: Steve left the game\n');
  await tick();
  child.emit('exit', 0);
  assert.deepEqual(lists, [['Steve'], ['Steve', 'Alex'], ['Alex'], []]);
});

test('playerAction sends only known actions for names that look like a player name', () => {
  const child = fakeChild();
  const proc = new ServerProcess({ spawnImpl: () => child });
  proc.start(START);
  const written = [];
  child.stdin.on('data', (d) => written.push(String(d)));
  assert.equal(proc.playerAction('kick', 'Steve'), true);
  assert.equal(proc.playerAction('ban', '.Bedrock_Alex'), true);
  assert.equal(proc.playerAction('stop', 'Steve'), false);          // not a player action
  assert.equal(proc.playerAction('kick', 'Steve\nstop'), false);    // a second command
  assert.equal(proc.playerAction('kick', 'a b'), false);
  assert.equal(proc.playerAction('kick', ''), false);
  assert.equal(proc.playerAction('kick', 5), false);
  assert.deepEqual(written, ['kick Steve\n', 'ban .Bedrock_Alex\n']);
});

test('playerAction does nothing when no server is running', () => {
  assert.equal(new ServerProcess().playerAction('kick', 'Steve'), false);
});

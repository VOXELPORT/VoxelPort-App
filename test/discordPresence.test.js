'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { DiscordPresence, encode, createDecoder, pipePath, buildActivity } = require('../src/main/discordPresence');

const ID = '123456789012345678';

/** A stand-in for Discord's pipe: remembers what was written, and lets the test answer. */
function fakeSocket() {
  const sock = new EventEmitter();
  sock.written = [];
  sock.destroyed = false;
  sock.write = (b) => { sock.written.push(b); };
  sock.destroy = () => { sock.destroyed = true; };
  sock.frames = () => {
    const out = [];
    const dec = createDecoder((op, data) => out.push([op, data]));
    for (const b of sock.written) dec(b);
    return out;
  };
  return sock;
}

const ready = (sock) => sock.emit('data', encode(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }));

test('frames are cut correctly, even when they arrive in pieces', () => {
  const got = [];
  const dec = createDecoder((op, data) => got.push([op, data]));
  const bytes = Buffer.concat([encode(1, { a: 1 }), encode(3, { b: 2 })]);
  dec(bytes.subarray(0, 5));
  dec(bytes.subarray(5, 13));
  dec(bytes.subarray(13));
  assert.deepEqual(got, [[1, { a: 1 }], [3, { b: 2 }]]);
});

test('an absurd frame size closes the connection instead of buffering it', () => {
  const got = [];
  const dec = createDecoder((op) => got.push(op));
  const head = Buffer.alloc(8);
  head.writeInt32LE(1, 0);
  head.writeInt32LE(0x7fffffff, 4);
  dec(head);
  assert.deepEqual(got, [2]);
});

test('pipe paths follow the platform', () => {
  assert.equal(pipePath(0, { platform: 'win32' }), '\\\\?\\pipe\\discord-ipc-0');
  assert.match(pipePath(3, { platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' } }).replace(/\\/g, '/'), /\/run\/user\/1000\/discord-ipc-3$/);
});

test('the activity says what is hosted and how many are online, and nothing about the server itself', () => {
  const a = buildActivity({ type: 'paper', version: '1.21.4', players: 1, name: 'Secret SMP', address: 'x.voxelport.in' }, 5000);
  assert.deepEqual(a, { details: 'Hosting a Paper 1.21.4 server', state: '1 player online', timestamps: { start: 5 }, instance: false });
  assert.equal(buildActivity({ type: 'odd', players: 0 }, 0).details, 'Hosting a Minecraft server');
  assert.equal(buildActivity({ type: 'fabric', players: 3 }, 0).state, '3 players online');
  assert.ok(!/Secret|voxelport/.test(JSON.stringify(a)));
  // a version is cleaned, so odd text cannot smuggle anything in
  assert.equal(buildActivity({ type: 'paper', version: '1.21<script>', players: 0 }, 0).details, 'Hosting a Paper 1.21script server');
});

test('without a valid application id it is unavailable and never connects', () => {
  let connects = 0;
  for (const clientId of ['', 'abc', 123, undefined]) {
    const p = new DiscordPresence({ clientId, connect: () => { connects++; return fakeSocket(); } });
    assert.equal(p.available, false);
    p.setEnabled(true);
    p.update({ type: 'paper', version: '1.21', players: 1 });
  }
  assert.equal(connects, 0);
});

test('turned off, it never connects', () => {
  let connects = 0;
  const p = new DiscordPresence({ clientId: ID, connect: () => { connects++; return fakeSocket(); } });
  p.update({ type: 'paper', version: '1.21', players: 1 });
  assert.equal(connects, 0);
});

test('it greets Discord, then sends the activity once Discord says READY, and keeps it current', () => {
  const sock = fakeSocket();
  const p = new DiscordPresence({ clientId: ID, connect: () => sock, pid: 77, now: () => 10000 });
  p.setEnabled(true);
  p.update({ type: 'paper', version: '1.21', players: 0 });
  sock.emit('connect');
  assert.deepEqual(sock.frames(), [[0, { v: 1, client_id: ID }]]);
  ready(sock);
  p.update({ type: 'paper', version: '1.21', players: 2 });
  const frames = sock.frames();
  assert.equal(frames.length, 3);
  assert.equal(frames[1][1].cmd, 'SET_ACTIVITY');
  assert.equal(frames[1][1].args.pid, 77);
  assert.equal(frames[1][1].args.activity.state, '0 players online');
  assert.equal(frames[2][1].args.activity.state, '2 players online');
  assert.equal(frames[2][1].args.activity.timestamps.start, 10);
});

test('when the server stops the activity is cleared, and turning it off clears it too', () => {
  const sock = fakeSocket();
  const p = new DiscordPresence({ clientId: ID, connect: () => sock });
  p.setEnabled(true);
  sock.emit('connect');
  ready(sock);
  p.update({ type: 'vanilla', version: '1.21', players: 0 });
  p.update(null);
  const frames = sock.frames();
  assert.equal(frames[frames.length - 1][1].args.activity, null);
  p.update({ type: 'vanilla', version: '1.21', players: 0 });
  p.setEnabled(false);
  const after = sock.frames();
  assert.equal(after[after.length - 1][1].args.activity, null);
  assert.equal(sock.destroyed, true);
});

test('it answers Discord pings', () => {
  const sock = fakeSocket();
  const p = new DiscordPresence({ clientId: ID, connect: () => sock });
  p.setEnabled(true);
  sock.emit('connect');
  sock.emit('data', encode(3, { nonce: 'n' }));
  assert.deepEqual(sock.frames().pop(), [4, { nonce: 'n' }]);
});

test('it tries the next pipe when one is missing, and gives up quietly when Discord is not running', () => {
  const tried = [];
  const p = new DiscordPresence({
    clientId: ID,
    connect: (name) => { tried.push(name); const s = fakeSocket(); setImmediate(() => s.emit('error', new Error('ENOENT'))); return s; },
  });
  p.setEnabled(true);
  return new Promise((resolve) => setImmediate(() => setImmediate(() => {
    assert.ok(tried.length >= 2, 'moved on to the next pipe');
    p.dispose();
    resolve();
  })));
});

test('a thrown error while connecting does not escape', () => {
  const p = new DiscordPresence({ clientId: ID, connect: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => p.setEnabled(true));
  p.dispose();
});

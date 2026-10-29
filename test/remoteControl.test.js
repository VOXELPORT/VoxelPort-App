'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanLines, parseCommand, backoffMs, createRemoteControl } = require('../src/main/remoteControl');

test('console lines lose IP addresses, tokens and secrets but keep times and UUIDs', () => {
  const out = cleanLines([
    'Steve[/1.2.3.4:5555] logged in with entity id 12 at (1.0, 64.0, 1.0)',
    'Player connected from 203.0.113.9',
    'Alex[/[2001:db8::1]:5555] logged in',
    'peer 2001:0db8:0000:0000:0000:ff00:0042:8329 joined',
    'mapped ::ffff:198.51.100.7 seen',
    'token vp_abcdefghijklmnop was used',
    'key 0123456789abcdef0123456789abcdef0123 found',
    '[12:07:00] [Server thread/INFO]: Done (3.2s)!',
    'UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5',
  ]);
  assert.equal(out[0], 'Steve[[ip]] logged in with entity id 12 at (1.0, 64.0, 1.0)');
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(out[1]) && out[1].includes('[ip]'));
  assert.ok(!out[2].includes('2001') && !out[2].includes('db8'));
  assert.ok(!out[3].includes('ff00') && !out[3].includes('8329'));
  assert.ok(!out[4].includes('198.51') && !out[4].includes('ffff'));
  assert.ok(!out[5].includes('abcdefghijklmnop'));
  assert.ok(!out[6].includes('0123456789abcdef0123'));
  assert.equal(out[7], '[12:07:00] [Server thread/INFO]: Done (3.2s)!');
  assert.ok(out[8].includes('069a79f4-44e9-4726-a5be-fca90e38aaf5'));
});

test('at most 100 lines of 200 characters leave the PC, colour codes and control characters are dropped', () => {
  const lines = Array.from({ length: 150 }, (_, i) => `${i}:` + 'x'.repeat(500));
  const out = cleanLines(lines);
  assert.equal(out.length, 100);
  assert.ok(out.every((l) => l.length <= 200));
  assert.ok(out[99].startsWith('149:'), 'the newest lines are kept');
  assert.equal(cleanLines(['\u001b[31mred\u001b[0m\u0007 text']).join(), 'red text');
  assert.deepEqual(cleanLines('not an array'), []);
});

test('only the four allowed actions pass, and a kick needs a plain player name', () => {
  assert.deepEqual(parseCommand({ id: 5, action: 'start' }), { id: 5, action: 'start', arg: null });
  assert.deepEqual(parseCommand({ id: 6, action: 'kick', arg: 'Steve_1' }), { id: 6, action: 'kick', arg: 'Steve_1' });
  for (const bad of [
    { id: 1, action: 'kick', arg: 'a b' }, { id: 1, action: 'kick', arg: 'x\ny' }, { id: 1, action: 'kick', arg: 'a;stop' }, { id: 1, action: 'kick', arg: 'a'.repeat(17) },
    { id: 1, action: 'kick' }, { id: 1, action: 'op', arg: 'Steve' }, { id: 1, action: 'say hi' }, { action: 'start' }, { id: 'x', action: 'start' }, { id: -1, action: 'start' }, null, 'start',
  ]) assert.equal(parseCommand(bad), null, JSON.stringify(bad));
});

test('error backoff doubles from 2 seconds up to a minute', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

function rig({ commands = [], allowed = true } = {}) {
  const calls = [], ran = [];
  let queue = commands;
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/api/app/control/poll')) { const c = queue; queue = []; return { ok: true, status: 200, json: { commands: c, watching: false } }; }
    return { ok: true, status: 200, json: { ok: true, watching: true } };
  };
  const actions = {
    start: async () => { ran.push('start'); return { ok: true, message: 'Starting' }; },
    stop: async () => { ran.push('stop'); return { ok: true }; },
    restart: async () => { ran.push('restart'); return { ok: false, error: 'Not running' }; },
    kick: async (n) => { ran.push(`kick ${n}`); return { ok: true }; },
    status: () => ({ status: 'online', players: ['Steve'], lines: ['Steve[/9.9.9.9:1] joined'] }),
  };
  const events = [];
  const rc = createRemoteControl({ request, getVpId: () => 'vp_test', actions, isAllowed: () => allowed, onEvent: (e) => events.push(e), wait: async () => {} });
  return { rc, calls, ran, events, setAllowed: (v) => { allowed = v; } };
}

test('a command is run once and its result is sent, even if the server hands it out twice', async () => {
  const r = rig({ commands: [{ id: 7, action: 'start', arg: null }, { id: 8, action: 'kick', arg: 'Steve' }] });
  assert.equal(await r.rc.pollOnce(), 'ok');
  assert.deepEqual(r.ran, ['start', 'kick Steve']);
  const results = r.calls.filter((c) => c.path === '/api/app/control/result').map((c) => [c.body.id, c.body.ok]);
  assert.deepEqual(results, [[7, true], [8, true]]);
  r.calls.length = 0;
  const again = rig({ commands: [{ id: 7, action: 'start' }] });
  await again.rc.pollOnce();
  await again.rc.pollOnce();
  assert.deepEqual(again.ran, ['start']);
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.events[0], { action: 'start', arg: null, ok: true });
});

test('an unknown or malformed action is refused with a failed result and never runs', async () => {
  const r = rig({ commands: [{ id: 9, action: 'op', arg: 'Steve' }, { id: 10, action: 'kick', arg: 'a b' }] });
  await r.rc.pollOnce();
  assert.deepEqual(r.ran, []);
  assert.deepEqual(r.calls.filter((c) => c.path === '/api/app/control/result').map((c) => [c.body.id, c.body.ok]), [[9, false], [10, false]]);
});

test('a failing action reports the failure instead of crashing the loop', async () => {
  const r = rig({ commands: [{ id: 11, action: 'restart' }] });
  assert.equal(await r.rc.pollOnce(), 'ok');
  const sent = r.calls.find((c) => c.path === '/api/app/control/result').body;
  assert.deepEqual([sent.ok, sent.message], [false, 'Not running']);
});

test('the report is cleaned and tells the loop whether anyone is watching', async () => {
  const r = rig();
  assert.equal(await r.rc.reportOnce(), 'ok');
  const body = r.calls.find((c) => c.path === '/api/app/control/report').body;
  assert.deepEqual([body.vp, body.status, body.players, body.lines], ['vp_test', 'online', ['Steve'], ['Steve[[ip]] joined']]);
  assert.equal(r.rc.snapshot().watching, true);
});

test('when the account is no longer allowed nothing is sent or obeyed', async () => {
  const r = rig({ commands: [{ id: 1, action: 'start' }], allowed: false });
  assert.equal(await r.rc.pollOnce(), 'blocked');
  assert.equal(await r.rc.reportOnce(), 'blocked');
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.ran, []);
});

test('start() keeps polling until stop(), stops by itself when blocked, and backs off on errors', async () => {
  const waits = [];
  let polls = 0, stopAfter = 4;
  const holder = {};
  const request = async (method, path) => {
    if (path.startsWith('/api/app/control/poll')) { polls++; if (polls >= stopAfter) holder.rc.stop(); return { ok: false, status: 500, json: {} }; }
    return { ok: true, status: 200, json: { ok: true } };
  };
  holder.rc = createRemoteControl({ request, getVpId: () => 'vp_test', actions: { status: () => ({ status: 'stopped', players: [], lines: [] }) }, isAllowed: () => true, wait: async (ms, kind) => { if (kind === 'error') waits.push(ms); } });
  await holder.rc.start();
  assert.equal(polls, 4);
  assert.deepEqual(waits.slice(0, 3), [2000, 4000, 8000]);

  let allowed = true, count = 0;
  const rc = createRemoteControl({ request: async () => { count++; allowed = false; return { ok: true, status: 200, json: { commands: [] } }; }, getVpId: () => 'vp_test', actions: { status: () => ({}) }, isAllowed: () => allowed, wait: async () => {} });
  await rc.start();
  assert.ok(count <= 2, 'it stops asking once it is no longer allowed');
});

test('the owner’s computer user name in file paths never reaches friends', () => {
  const out = cleanLines([
    String.raw`Loading from C:\Users\Trazverse\AppData\Roaming\VoxelPort\servers\smp`,
    'at /home/alice/servers/smp/plugins/x.jar',
    'at /Users/bob/Library/Application Support/VoxelPort',
  ]);
  assert.ok(!out.join('\n').match(/Trazverse|alice|bob/));
  assert.ok(out[0].includes(String.raw`C:\Users\[user]\AppData`), out[0]);
});

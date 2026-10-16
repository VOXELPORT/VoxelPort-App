'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { DirectMode, directAction } = require('../src/main/directMode');
const { UpnpError } = require('../src/main/upnp');

/** A tunnel that records what it was asked and lets the test play the relay's answers. */
class FakeTunnel extends EventEmitter {
  constructor() { super(); this.asked = []; }
  setDirect(port) { this.asked.push(port); }
}

/** A router: open() answers as scripted; close() is counted. */
class FakeMapper {
  constructor({ externalPort = 25565, error = null, delay = 0 } = {}) {
    this.externalPort = externalPort;
    this.error = error;
    this.delay = delay;
    this.opened = 0;
    this.closed = 0;
    this.isOpen = false; // whether the router is holding the port right now
    this.onLost = null;
  }
  async open() {
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    this.opened++;
    if (this.error) throw this.error;
    this.isOpen = true;
    return { externalIp: '83.45.12.9', externalPort: this.externalPort, localAddress: '192.168.1.5' };
  }
  async close() { this.closed++; this.isOpen = false; }
}

const tick = () => new Promise((r) => setImmediate(r));

function rig({ mapper = new FakeMapper(), replyTimeoutMs = 2000 } = {}) {
  const tunnel = new FakeTunnel();
  const direct = new DirectMode({ createMapper: () => mapper, replyTimeoutMs });
  const seen = [];
  direct.on('status', (s) => seen.push(`${s.state}:${s.code}`));
  return { tunnel, direct, mapper, seen };
}

test('it opens the router port, asks the relay about that port, and is on when the relay confirms', async () => {
  const { tunnel, direct, mapper, seen } = rig({ mapper: new FakeMapper({ externalPort: 25601 }) });
  const result = direct.start(tunnel, { localPort: 25565 });
  await tick(); await tick();
  assert.deepEqual(tunnel.asked, [25601], 'the relay is asked about the port the router really opened, not the local one');
  tunnel.emit('direct', { ip: '83.45.12.9', port: 25601, address: 'steve.voxelport.in' });
  const status = await result;
  assert.deepEqual(status, { state: 'on', code: 'ok', detail: '', ip: '83.45.12.9', port: 25601, address: 'steve.voxelport.in' });
  assert.deepEqual(seen, ['working:opening', 'working:checking', 'on:ok']);
  assert.equal(mapper.closed, 0, 'the port stays open while Direct mode is on');
});

test('a router that does not answer UPnP is reported, and the relay is never asked', async () => {
  const { tunnel, direct, mapper } = rig({ mapper: new FakeMapper({ error: new UpnpError('no-gateway', 'No router answered.') }) });
  const status = await direct.start(tunnel, { localPort: 25565 });
  assert.equal(status.state, 'failed');
  assert.equal(status.code, 'no-router');
  assert.deepEqual(tunnel.asked, []);
  assert.equal(mapper.closed, 1);
});

test('a provider-shared address (CGNAT) is "unsupported", not a failure to retry', async () => {
  const { tunnel, direct } = rig({ mapper: new FakeMapper({ error: new UpnpError('cgnat', 'shared') }) });
  const status = await direct.start(tunnel, { localPort: 25565 });
  assert.equal(status.state, 'unsupported');
  assert.equal(status.code, 'cgnat');
  assert.deepEqual(tunnel.asked, []);
});

test('router errors get their own wording', async () => {
  for (const [error, code] of [
    [new UpnpError('conflict', 'taken'), 'port-busy'],
    [new UpnpError('refused', 'no', 501), 'refused'],
    [new UpnpError('bad-reply', 'weird'), 'no-router'],
    [new Error('something else'), 'no-router'],
  ]) {
    const { tunnel, direct } = rig({ mapper: new FakeMapper({ error }) });
    assert.equal((await direct.start(tunnel, { localPort: 25565 })).code, code);
  }
});

test('when the relay cannot reach the server, the router port is closed again and the relay is told to stop', async () => {
  const { tunnel, direct, mapper } = rig();
  const result = direct.start(tunnel, { localPort: 25565 });
  await tick(); await tick();
  tunnel.emit('directError', "Couldn't reach your server from the internet on port 25565 (nothing answered).");
  const status = await result;
  assert.equal(status.state, 'failed');
  assert.equal(status.code, 'relay');
  assert.match(status.detail, /nothing answered/);
  assert.equal(mapper.closed, 1, 'no port is left open on the router after a failed check');
  assert.deepEqual(tunnel.asked, [25565, null]);
  assert.equal(tunnel.listenerCount('direct'), 0, 'and it stops listening');
});

test('a relay that never answers ends in "timeout"', async () => {
  const { tunnel, direct, mapper } = rig({ replyTimeoutMs: 40 });
  const status = await direct.start(tunnel, { localPort: 25565 });
  assert.equal(status.state, 'failed');
  assert.equal(status.code, 'timeout');
  assert.equal(mapper.closed, 1);
});

test('when the relay sends players back it shows "fallback", keeps the port, and goes on again by itself', async () => {
  const { tunnel, direct, mapper } = rig();
  const result = direct.start(tunnel, { localPort: 25565 });
  await tick(); await tick();
  tunnel.emit('direct', { ip: '83.45.12.9', port: 25565, address: '' });
  await result;

  tunnel.emit('directError', 'Direct mode stopped working, so players are using the relay again.');
  tunnel.emit('direct', { ip: '', port: 0, address: '' });
  assert.equal(direct.status.state, 'fallback');
  assert.equal(direct.status.code, 'fallback');
  assert.match(direct.status.detail, /relay again/);
  assert.equal(mapper.closed, 0, 'the relay switches back by itself, so the router port stays');

  tunnel.emit('direct', { ip: '83.45.12.9', port: 25565, address: 'steve.voxelport.in' });
  assert.equal(direct.status.state, 'on');
  assert.equal(direct.status.address, 'steve.voxelport.in');
});

test('a router that stops renewing is reported and the relay is told to stop', async () => {
  const { tunnel, direct, mapper } = rig();
  const result = direct.start(tunnel, { localPort: 25565 });
  await tick(); await tick();
  tunnel.emit('direct', { ip: '83.45.12.9', port: 25565, address: '' });
  await result;
  mapper.onLost(new Error('router went away'));
  assert.equal(direct.status.state, 'failed');
  assert.equal(direct.status.code, 'lost');
  assert.equal(tunnel.asked.at(-1), null);
});

test('turning it off closes the router port, tells the relay, and ignores what the relay says afterwards', async () => {
  const { tunnel, direct, mapper } = rig();
  const result = direct.start(tunnel, { localPort: 25565 });
  await tick(); await tick();
  tunnel.emit('direct', { ip: '83.45.12.9', port: 25565, address: '' });
  await result;

  await direct.stop();
  assert.equal(direct.status.state, 'off');
  assert.equal(mapper.closed, 1);
  assert.equal(tunnel.asked.at(-1), null);
  tunnel.emit('direct', { ip: '83.45.12.9', port: 25565, address: '' });
  assert.equal(direct.status.state, 'off', 'a late relay message must not switch it back on');
  assert.equal(tunnel.listenerCount('direct') + tunnel.listenerCount('directError'), 0, 'it stops listening to the tunnel');
  await direct.stop(); // harmless twice
  assert.equal(mapper.closed, 1);
});

test('when the tunnel itself is gone, stopping does not talk to it but still closes the router port', async () => {
  const { tunnel, direct, mapper } = rig();
  const result = direct.start(tunnel, { localPort: 25565 });
  await tick(); await tick();
  tunnel.emit('direct', { ip: '83.45.12.9', port: 25565, address: '' });
  await result;
  const askedBefore = tunnel.asked.length;
  await direct.stop({ tunnelAlive: false });
  assert.equal(tunnel.asked.length, askedBefore);
  assert.equal(mapper.closed, 1);
});

test('stopping while the router is still being asked closes the port that was opened late', async () => {
  const { tunnel, direct, mapper } = rig({ mapper: new FakeMapper({ delay: 60 }) });
  const result = direct.start(tunnel, { localPort: 25565 });
  await new Promise((r) => setTimeout(r, 20));
  await direct.stop(); // the user turned it off, or the server stopped
  await result;
  assert.equal(direct.status.state, 'off');
  assert.equal(mapper.isOpen, false, 'the port that opened after the stop must not be left open on the router');
  assert.equal(tunnel.asked.some((p) => p !== null), false, 'the relay is never asked to verify a port that was cancelled');
});

test('asking twice while it works is one attempt', async () => {
  let made = 0;
  const tunnel = new FakeTunnel();
  const direct = new DirectMode({ createMapper: () => { made++; return new FakeMapper(); }, replyTimeoutMs: 2000 });
  const a = direct.start(tunnel, { localPort: 25565 });
  const b = direct.start(tunnel, { localPort: 25565 });
  assert.equal(a, b);
  await tick(); await tick();
  tunnel.emit('direct', { ip: '83.45.12.9', port: 25565, address: '' });
  await a;
  assert.equal(made, 1);
});

test('after a failure it can be tried again', async () => {
  const mappers = [new FakeMapper({ error: new UpnpError('no-gateway', 'x') }), new FakeMapper()];
  const tunnel = new FakeTunnel();
  const direct = new DirectMode({ createMapper: () => mappers.shift(), replyTimeoutMs: 2000 });
  assert.equal((await direct.start(tunnel, { localPort: 25565 })).state, 'failed');
  const second = direct.start(tunnel, { localPort: 25565 });
  await tick(); await tick();
  tunnel.emit('direct', { ip: '83.45.12.9', port: 25565, address: '' });
  assert.equal((await second).state, 'on');
});

test('directAction: starts only for a public server on the official relay once online and turned on', () => {
  const on = { enabled: true, online: true, official: true };
  assert.equal(directAction({ ...on, state: 'off' }), 'start');
  assert.equal(directAction({ ...on, enabled: false, state: 'off' }), 'keep', 'nothing to stop when it was never on');
  assert.equal(directAction({ ...on, online: false, state: 'off' }), 'keep');
  assert.equal(directAction({ ...on, official: false, state: 'off' }), 'keep', 'a self-hosted relay is never asked');
});

test('directAction: an attempt that is active is kept across tunnel reconnects, and stopped when it no longer applies', () => {
  const on = { enabled: true, online: true, official: true };
  for (const state of ['working', 'on', 'fallback']) {
    assert.equal(directAction({ ...on, state }), 'keep', state);
    assert.equal(directAction({ ...on, enabled: false, state }), 'stop', state + ' turned off');
    assert.equal(directAction({ ...on, online: false, state }), 'stop', state + ' tunnel gone');
    assert.equal(directAction({ ...on, official: false, state }), 'stop', state + ' other relay');
  }
});

test('directAction: a failed or unsupported attempt is not retried on its own, and is cleared when turned off', () => {
  const on = { enabled: true, online: true, official: true };
  for (const state of ['failed', 'unsupported']) {
    assert.equal(directAction({ ...on, state }), 'keep', state);
    assert.equal(directAction({ ...on, enabled: false, state }), 'stop', state + ' turned off');
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');
const { P2PHost, MAX_PEERS, MAX_CHANNELS_PER_PEER } = require('../src/main/p2pHost');
const { P2PJoin } = require('../src/main/p2pJoin');
const { FakeRtcNetwork, FakeRelay } = require('./helpers/fakeRtc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(10); }
  throw new Error(`timed out waiting for: ${what}`);
}

/** A server that echoes everything, greeting each connection with its name first (like a very simple game server). */
function startEcho(prefix = '') {
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    let first = true;
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    s.on('data', (b) => { s.write(first ? Buffer.concat([Buffer.from(prefix), b]) : b); first = false; });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, sockets, connections: () => sockets.size,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}

/** Connects like Minecraft would, sends one chunk, and returns what came back. */
function roundTrip(port, data, expectLen) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1');
    const chunks = [];
    let got = 0;
    c.on('connect', () => c.write(data));
    c.on('data', (b) => { chunks.push(b); got += b.length; if (got >= expectLen) { c.destroy(); resolve(Buffer.concat(chunks)); } });
    c.on('error', reject);
    setTimeout(() => { c.destroy(); reject(new Error('round trip timed out')); }, 4000);
  });
}

async function rig({ mode = 'ok', p2pTimeoutMs = 4000, relayPrefix = 'RELAY:' } = {}) {
  const mc = await startEcho('MC:');
  const relayPort = await startEcho(relayPrefix); // stands in for the host's ordinary relay port
  const network = new FakeRtcNetwork();
  network.mode = mode;
  const relay = new FakeRelay({ fallback: { address: '127.0.0.1', port: relayPort.port } });
  const hostWorker = network.worker('host');
  const joinWorker = network.worker('join');
  const connects = [];
  const host = new P2PHost({ worker: hostWorker, getLocalPort: () => mc.port, connect: (o) => { connects.push(o); return net.connect(o); }, connectTimeoutMs: 600 });
  host.attach(relay.tunnel);
  const join = new P2PJoin({ worker: joinWorker, signaling: relay.signaling(), p2pTimeoutMs, channelOpenTimeoutMs: 400, preferredPort: 0 });
  const statuses = [];
  join.on('status', (s) => statuses.push(s.state));
  const cleanup = () => { join.stop(); host.detach(); mc.close(); relayPort.close(); };
  return { mc, relayPort, network, relay, hostWorker, joinWorker, host, join, statuses, connects, cleanup };
}

test('a player with the code connects directly, and the game works through it', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'k7m2q9xh4t', client: 'desktop/1.9.0' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    assert.deepEqual(r.statuses.slice(0, 3), ['signaling', 'connecting', 'p2p']);
    assert.equal(r.join.status.path, 'direct');
    assert.ok(r.join.status.port > 0, 'it should be listening for Minecraft');
    assert.equal(r.host.connectedPeers, 1);

    const back = await roundTrip(r.join.status.port, Buffer.from('hello server'), 'MC:hello server'.length);
    assert.equal(back.toString(), 'MC:hello server', 'the host\'s own server answered, through the direct connection');
    assert.deepEqual(r.connects, [{ host: '127.0.0.1', port: r.mc.port }], 'the host only ever connects to its own server');
    assert.equal(r.relayPort.connections(), 0, 'nothing went through the relay port');
  } finally { r.cleanup(); }
});

test('the relay is told who is coming, and leaves once the two are connected', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T', client: 'desktop/1.9.0' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    assert.equal(r.relay.players.size, 0, 'the player leaves the relay once connected');
  } finally { r.cleanup(); }
});

test('several connections at once, and a large payload, arrive intact', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    const big = crypto.randomBytes(3 * 1024 * 1024);
    const results = await Promise.all([
      roundTrip(r.join.status.port, big, big.length + 3),
      roundTrip(r.join.status.port, Buffer.from('a'), 4),
      roundTrip(r.join.status.port, Buffer.from('b'), 4),
    ]);
    assert.equal(Buffer.compare(results[0], Buffer.concat([Buffer.from('MC:'), big])), 0, 'a big payload is not corrupted');
    assert.equal(results[1].toString(), 'MC:a');
    assert.equal(results[2].toString(), 'MC:b');
  } finally { r.cleanup(); }
});

test('when no direct route can be made, the player is sent through the relay', async () => {
  const r = await rig({ mode: 'fail' });
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'relay', 'the fallback');
    assert.equal(r.join.status.path, 'relay');
    assert.equal(r.join.status.reason, 'failed');
    const back = await roundTrip(r.join.status.port, Buffer.from('hi'), 'RELAY:hi'.length);
    assert.equal(back.toString(), 'RELAY:hi', 'it went to the host\'s relay address');
    assert.equal(r.mc.connections(), 0, 'and not through a direct connection');
  } finally { r.cleanup(); }
});

test('a direct connection that never opens times out into the relay', async () => {
  const r = await rig({ mode: 'silent', p2pTimeoutMs: 150 });
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'relay', 'the timeout');
    assert.equal(r.join.status.reason, 'timeout');
    assert.equal((await roundTrip(r.join.status.port, Buffer.from('x'), 7)).toString(), 'RELAY:x');
  } finally { r.cleanup(); }
});

test('if the direct connection is lost later, new connections use the relay', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    const port = r.join.status.port;
    assert.equal((await roundTrip(port, Buffer.from('a'), 4)).toString(), 'MC:a');
    r.joinWorker.dropLinks();
    await waitFor(() => r.join.status.state === 'relay', 'the switch to the relay');
    assert.equal(r.join.status.reason, 'lost');
    assert.equal(r.join.status.port, port, 'the same local port keeps working: Minecraft need not change anything');
    assert.equal((await roundTrip(port, Buffer.from('b'), 7)).toString(), 'RELAY:b');
  } finally { r.cleanup(); }
});

test('a wrong code fails with the relay\'s words and opens no port', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'WRONG-CODE0' });
    await waitFor(() => r.join.status.state === 'failed', 'the failure');
    assert.match(r.join.status.message, /isn't active/);
    assert.equal(r.join.server, null);
    assert.equal(r.join.status.port, 0);
  } finally { r.cleanup(); }
});

test('if the usual Minecraft port is taken, another local port is used', async () => {
  const blocker = net.createServer();
  await new Promise((res) => blocker.listen(0, '127.0.0.1', res));
  const taken = blocker.address().port;
  const r = await rig();
  r.join.preferredPort = taken;
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p' && r.join.status.port > 0, 'listening');
    assert.notEqual(r.join.status.port, taken);
  } finally { r.cleanup(); blocker.close(); }
});

test('the local port only accepts connections from this PC', async () => {
  const seen = [];
  const r = await rig();
  const real = r.join.createServer;
  r.join.createServer = (cb) => { const s = real(cb); const listen = s.listen.bind(s); s.listen = (...a) => { seen.push(a[1]); return listen(...a); }; return s; };
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'listening');
    assert.deepEqual(seen, ['127.0.0.1']);
  } finally { r.cleanup(); }
});

test('stopping closes the local port, the connection and the open games', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    const port = r.join.status.port;
    const open = net.connect(port, '127.0.0.1');
    open.resume(); // a socket nobody reads from never reports that it closed
    await new Promise((res) => open.on('connect', res));
    open.write('x');
    await waitFor(() => r.mc.connections() === 1, 'the game to be open');
    const closed = new Promise((res) => open.on('close', res));
    r.join.stop();
    await closed;
    assert.equal(r.join.status.state, 'stopped');
    await waitFor(() => r.mc.connections() === 0, "the host's side to close too");
    await assert.rejects(roundTrip(port, Buffer.from('x'), 1), 'the port must be closed');
    assert.ok(r.joinWorker.sent.some((c) => c.op === 'peer-close'));
  } finally { r.cleanup(); }
});

test('data sent before the channel is open is not lost', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    const c = net.connect(r.join.status.port, '127.0.0.1');
    c.write('first'); c.write('second'); // straight away, before the channel could be open
    const got = await new Promise((res) => { let b = ''; c.on('data', (d) => { b += d; if (b.length >= 'MC:firstMC:second'.length || b.includes('second')) res(b); }); setTimeout(() => res(b), 2000); });
    c.destroy();
    assert.match(got, /first/);
    assert.match(got, /second/);
  } finally { r.cleanup(); }
});

// ─── The host's side ────────────────────────────────────────────────────────────

test('attaching the same tunnel again keeps the players already connected', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    assert.equal(r.host.connectedPeers, 1);
    r.host.attach(r.relay.tunnel); // as happens on every tunnel reconnect
    assert.equal(r.host.connectedPeers, 1);
    assert.equal((await roundTrip(r.join.status.port, Buffer.from('k'), 4)).toString(), 'MC:k');
  } finally { r.cleanup(); }
});

test('the host drops a player that never connects, and tells the relay', async () => {
  const r = await rig({ mode: 'silent' });
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.host.peers.size === 1, 'the peer');
    await waitFor(() => r.host.peers.size === 0, 'the drop', 2000);
    assert.equal(r.relay.tunnel.closed.length, 1);
    assert.ok(r.hostWorker.sent.some((c) => c.op === 'peer-close'));
  } finally { r.cleanup(); }
});

test('a relay "gone" message drops a player that never connected, but not one that did', async () => {
  const r = await rig();
  try {
    r.host._onPeer({ peer: 'aa01', client: 'x' });
    r.relay.tunnel.emit('peerGone', 'aa01');
    assert.equal(r.host.peers.size, 0, 'an unconnected player goes');

    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    const peer = [...r.host.peers.keys()][0];
    r.relay.tunnel.emit('peerGone', peer); // the introduction ended; the connection lives on
    assert.equal(r.host.peers.has(peer), true);
    assert.equal((await roundTrip(r.join.status.port, Buffer.from('z'), 4)).toString(), 'MC:z');
  } finally { r.cleanup(); }
});

test('the host takes at most MAX_PEERS players at a time', async () => {
  const r = await rig({ mode: 'silent' });
  try {
    for (let i = 0; i < MAX_PEERS + 3; i++) r.host._onPeer({ peer: (i + 1).toString(16).padStart(4, '0'), client: '' });
    assert.equal(r.host.peers.size, MAX_PEERS);
    assert.equal(r.relay.tunnel.closed.length, 3, 'the extra ones are refused at the relay');
  } finally { r.cleanup(); }
});

test('the host refuses channels from a player that has not connected, with a bad name, or beyond the limit', async () => {
  const r = await rig();
  try {
    r.host._onPeer({ peer: 'bb01', client: '' });
    r.hostWorker.emit('event', { evt: 'open', peer: 'bb01', conn: '1' }); // not connected yet
    assert.equal(r.connects.length, 0);
    assert.ok(r.hostWorker.sent.some((c) => c.op === 'end' && c.conn === '1'));

    r.hostWorker.emit('event', { evt: 'state', peer: 'bb01', state: 'connected', path: 'direct' });
    r.hostWorker.emit('event', { evt: 'open', peer: 'bb01', conn: '../../x' }); // a channel name that is not a number
    assert.equal(r.connects.length, 0);
    r.hostWorker.emit('event', { evt: 'open', peer: 'nobody', conn: '1' }); // not a player we know
    assert.equal(r.connects.length, 0);

    for (let i = 1; i <= MAX_CHANNELS_PER_PEER + 5; i++) r.hostWorker.emit('event', { evt: 'open', peer: 'bb01', conn: String(i) });
    assert.equal(r.connects.length, MAX_CHANNELS_PER_PEER, 'a player can only hold so many games open');
  } finally { r.cleanup(); }
});

test('detaching drops every player, closes their games and stops listening', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    const open = net.connect(r.join.status.port, '127.0.0.1');
    open.resume();
    await new Promise((res) => open.on('connect', res));
    open.write('x');
    await waitFor(() => r.host.players === 1, 'a game');
    r.host.detach();
    assert.equal(r.host.players, 0);
    assert.equal(r.host.peers.size, 0);
    assert.equal(r.relay.tunnel.listenerCount('peer'), 0, 'no longer listening to the tunnel');
    open.destroy();
  } finally { r.cleanup(); }
});

test('the host reports how many players are playing and connected', async () => {
  const r = await rig();
  const changes = [];
  r.host.on('changed', (c) => changes.push(c));
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    const c = net.connect(r.join.status.port, '127.0.0.1');
    c.resume();
    await new Promise((res) => c.on('connect', res));
    c.write('x');
    await waitFor(() => r.host.players === 1, 'a game');
    assert.ok(changes.some((x) => x.peers === 1 && x.players === 1));
    c.destroy();
    await waitFor(() => r.host.players === 0, 'the game to end');
  } finally { r.cleanup(); }
});

// ─── Direct only (no relay), for players far from the relay ───────────────────────

test('direct only: with no direct route the join fails, opens no port and never touches the relay', async () => {
  const r = await rig({ mode: 'fail' });
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T', allowRelay: false });
    await waitFor(() => r.join.status.state === 'failed', 'the failure');
    assert.equal(r.join.status.reason, 'failed');
    assert.equal(r.join.status.port, 0);
    assert.equal(r.join.server, null, 'nothing is listening for Minecraft');
    assert.equal(r.relayPort.connections(), 0);
  } finally { r.cleanup(); }
});

test('direct only: a direct connection that never opens fails after the timeout', async () => {
  const r = await rig({ mode: 'silent', p2pTimeoutMs: 150 });
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T', allowRelay: false });
    await waitFor(() => r.join.status.state === 'failed', 'the timeout');
    assert.equal(r.join.status.reason, 'timeout');
    assert.equal(r.join.server, null);
  } finally { r.cleanup(); }
});

test('direct only: a direct connection that works is used exactly as before', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T', allowRelay: false });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    assert.equal((await roundTrip(r.join.status.port, Buffer.from('a'), 4)).toString(), 'MC:a');
  } finally { r.cleanup(); }
});

test('direct only: if the direct connection is lost later the join ends (it does not slip onto the relay)', async () => {
  const r = await rig();
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T', allowRelay: false });
    await waitFor(() => r.join.status.state === 'p2p', 'a direct connection');
    const port = r.join.status.port;
    r.joinWorker.dropLinks();
    await waitFor(() => r.join.status.state === 'failed', 'the end');
    assert.equal(r.join.status.reason, 'lost');
    await assert.rejects(roundTrip(port, Buffer.from('b'), 1), 'the local port is closed');
    assert.equal(r.relayPort.connections(), 0);
  } finally { r.cleanup(); }
});

test('with the relay allowed (the default) a failed direct route still falls back, as before', async () => {
  const r = await rig({ mode: 'fail' });
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T', allowRelay: true });
    await waitFor(() => r.join.status.state === 'relay', 'the fallback');
  } finally { r.cleanup(); }
});

test('the choice of the last join does not stick to the next one', async () => {
  const r = await rig({ mode: 'fail' });
  try {
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T', allowRelay: false });
    await waitFor(() => r.join.status.state === 'failed', 'the failure');
    r.join.signaling = r.relay.signaling();
    r.join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T' }); // allowRelay defaults to true again
    await waitFor(() => r.join.status.state === 'relay', 'the fallback this time');
  } finally { r.cleanup(); }
});

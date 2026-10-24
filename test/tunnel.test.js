'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { Tunnel, isValidRelayMessage, MAX_LOCAL_PLAYERS } = require('../src/main/tunnel');

// Always resolves with just the first emitted argument — for ws's 'message'
// event (data, isBinary) we only ever care about the data; for our own
// Tunnel EventEmitter events there's only ever one argument anyway.
function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (arg) => resolve(arg)));
}

/** A minimal fake relay: accepts one host WS, hands out a fixed port, and lets the test script frames directly. */
function startFakeRelay() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const port = wss.address().port;
      resolve({ wss, url: `ws://127.0.0.1:${port}` });
    });
  });
}

function startLocalEchoServer() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on('data', (buf) => sock.write(buf)); // echoes back whatever it receives
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/**
 * Starts a Tunnel and returns once the fake relay has actually accepted its
 * connection. The connection listener MUST be armed before tunnel.start()
 * is called, or the 'connection' event can fire before anyone is listening
 * for it.
 */
function startTunnelAndConnect(wss, tunnel, opts) {
  const connected = new Promise((resolve) => wss.once('connection', resolve));
  tunnel.start(opts);
  return connected;
}

// ─── Pure validation function ───────────────────────────────────────────────

test('isValidRelayMessage accepts well-formed frames of every known type', () => {
  assert.equal(isValidRelayMessage({ type: 'port', port: 25500 }), true);
  assert.equal(isValidRelayMessage({ type: 'connect', conn: 'abc123', ip: '1.2.3.4' }), true);
  assert.equal(isValidRelayMessage({ type: 'data', conn: 'abc123', data: 'aGVsbG8=' }), true);
  assert.equal(isValidRelayMessage({ type: 'close', conn: 'abc123' }), true);
  assert.equal(isValidRelayMessage({ type: 'pong' }), true);
  assert.equal(isValidRelayMessage({ type: 'error', message: 'bad token' }), true);
});

test('isValidRelayMessage rejects malformed/out-of-range fields', () => {
  assert.equal(isValidRelayMessage(null), false);
  assert.equal(isValidRelayMessage('not an object'), false);
  assert.equal(isValidRelayMessage({ type: 'port', port: 99999 }), false);
  assert.equal(isValidRelayMessage({ type: 'port', port: 'not a number' }), false);
  assert.equal(isValidRelayMessage({ type: 'connect', conn: '' }), false);
  assert.equal(isValidRelayMessage({ type: 'connect', conn: 'x'.repeat(200) }), false);
  assert.equal(isValidRelayMessage({ type: 'data', conn: 'abc', data: 123 }), false);
  assert.equal(isValidRelayMessage({ type: 'data', conn: 'abc', data: 'x'.repeat(10 * 1024 * 1024) }), false);
  assert.equal(isValidRelayMessage({ type: 'close', conn: null }), false);
});

test('unknown message types are ignored safely, not rejected', () => {
  assert.equal(isValidRelayMessage({ type: 'some-future-type', anything: 'goes' }), true);
});

// ─── Full protocol round trip against a fake relay + real local server ─────

test('register -> port -> connect -> data -> close -> ping/pong end-to-end, with a large payload verified by SHA-256', async () => {
  const { wss, url } = await startFakeRelay();
  const localSrv = await startLocalEchoServer();
  const localPort = localSrv.address().port;

  const tunnel = new Tunnel();
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort });
  const registerMsg = JSON.parse(await once(hostSocket, 'message'));
  assert.equal(registerMsg.type, 'register');
  assert.equal(registerMsg.token, 'vp_testtoken1234567890');

  const assignedPortPromise = once(tunnel, 'assigned');
  hostSocket.send(JSON.stringify({ type: 'port', port: 30001 }));
  assert.equal(await assignedPortPromise, 30001);

  // Simulate a player connecting: relay tells the host to connect, host
  // opens 127.0.0.1:localPort, then a large pseudorandom payload flows
  // player -> tunnel -> local server -> (echoed) -> tunnel -> relay.
  const connId = 'conn-' + crypto.randomBytes(8).toString('hex');
  const dataFromHostPromise = new Promise((resolve) => {
    let received = Buffer.alloc(0);
    hostSocket.on('message', function handler(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'data' || msg.conn !== connId) return;
      received = Buffer.concat([received, Buffer.from(msg.data, 'base64')]);
      if (received.length >= payload.length) {
        hostSocket.removeListener('message', handler);
        resolve(received);
      }
    });
  });

  hostSocket.send(JSON.stringify({ type: 'connect', conn: connId, ip: '203.0.113.5' }));
  await once(tunnel, 'players'); // player socket opened

  const payload = crypto.randomBytes(3 * 1024 * 1024); // several MB, pseudorandom
  // Send from "relay" to host, which forwards to the local echo server.
  const chunkSize = 64 * 1024;
  for (let i = 0; i < payload.length; i += chunkSize) {
    hostSocket.send(JSON.stringify({
      type: 'data', conn: connId, data: payload.subarray(i, i + chunkSize).toString('base64'),
    }));
  }

  const echoed = await dataFromHostPromise;
  assert.equal(
    crypto.createHash('sha256').update(echoed.subarray(0, payload.length)).digest('hex'),
    crypto.createHash('sha256').update(payload).digest('hex'),
    'bytes must survive the full round trip unmodified and in order'
  );

  // ping/pong
  const pingPromise = once(tunnel, 'ping');
  const pingMsg = await new Promise((resolve) => {
    hostSocket.once('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') resolve(msg);
    });
    // Exercise the same send path _startPing()'s interval would eventually
    // trigger, without waiting out its real 15s period.
    tunnel.lastPingSent = Date.now();
    tunnel._send({ type: 'ping' });
  });
  assert.equal(pingMsg.type, 'ping');
  hostSocket.send(JSON.stringify({ type: 'pong' }));
  assert.equal(typeof (await pingPromise), 'number');

  // close from relay side
  const playersAfterClose = once(tunnel, 'players');
  hostSocket.send(JSON.stringify({ type: 'close', conn: connId }));
  assert.equal(await playersAfterClose, 0);

  tunnel.stop();
  localSrv.close();
  wss.close();
});

test('reconnect: manual stop cleanly ends without retry; unexpected close triggers reconnect status', async () => {
  const { wss, url } = await startFakeRelay();
  const localSrv = await startLocalEchoServer();
  const localPort = localSrv.address().port;

  const tunnel = new Tunnel();
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort });
  await once(hostSocket, 'message'); // register received

  const reconnectingPromise = once(tunnel, 'status');
  hostSocket.close(); // unexpected drop from the relay side
  const status1 = await reconnectingPromise;
  assert.ok(status1 === 'reconnecting' || status1 === 'connecting');

  const stoppedPromise = once(tunnel, 'stopped');
  tunnel.stop();
  await stoppedPromise;

  localSrv.close();
  wss.close();
});

// ─── Item 19: local connection cap ─────────────────────────────────────────

test('rejects new player connections past the local connection cap, cleanly', async () => {
  const { wss, url } = await startFakeRelay();
  const localSrv = await startLocalEchoServer();
  const localPort = localSrv.address().port;

  const tunnel = new Tunnel();
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort });
  await once(hostSocket, 'message');

  // Directly fill the internal map to avoid actually opening MAX_LOCAL_PLAYERS
  // real sockets in a unit test — we only need to exercise the cap-check path.
  for (let i = 0; i < MAX_LOCAL_PLAYERS; i++) {
    tunnel.players.set('filler-' + i, { sock: { destroy() {} }, pendingBytes: 0, closed: false });
  }

  const closeSentPromise = new Promise((resolve) => {
    hostSocket.once('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      resolve(msg);
    });
  });
  hostSocket.send(JSON.stringify({ type: 'connect', conn: 'one-too-many', ip: '1.2.3.4' }));

  const closeMsg = await closeSentPromise;
  assert.equal(closeMsg.type, 'close');
  assert.equal(closeMsg.conn, 'one-too-many');
  assert.equal(tunnel.players.has('one-too-many'), false);

  tunnel.stop();
  localSrv.close();
  wss.close();
});

// ─── Item 18: duplicate / unknown connection IDs ───────────────────────────

test('a duplicate connect for an already-open connection id does not replace the existing socket', async () => {
  const { wss, url } = await startFakeRelay();
  const localSrv = await startLocalEchoServer();
  const localPort = localSrv.address().port;

  const tunnel = new Tunnel();
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort });
  await once(hostSocket, 'message');

  hostSocket.send(JSON.stringify({ type: 'connect', conn: 'dup-conn', ip: '1.2.3.4' }));
  await once(tunnel, 'players');
  const originalPc = tunnel.players.get('dup-conn');

  hostSocket.send(JSON.stringify({ type: 'connect', conn: 'dup-conn', ip: '5.6.7.8' }));
  await new Promise((r) => setTimeout(r, 50)); // let the (ignored) duplicate be processed

  assert.equal(tunnel.players.get('dup-conn'), originalPc, 'the original socket must not be replaced');
  assert.equal(tunnel.players.size, 1);

  tunnel.stop();
  localSrv.close();
  wss.close();
});

test('data/close for an unknown connection id is a safe no-op and creates no state', async () => {
  const { wss, url } = await startFakeRelay();
  const localSrv = await startLocalEchoServer();
  const localPort = localSrv.address().port;

  const tunnel = new Tunnel();
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort });
  await once(hostSocket, 'message');

  hostSocket.send(JSON.stringify({ type: 'data', conn: 'never-existed', data: 'aGVsbG8=' }));
  hostSocket.send(JSON.stringify({ type: 'close', conn: 'never-existed' }));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(tunnel.players.size, 0);

  tunnel.stop();
  localSrv.close();
  wss.close();
});

test('malformed base64 in a data frame is handled without crashing the tunnel', async () => {
  const { wss, url } = await startFakeRelay();
  const localSrv = await startLocalEchoServer();
  const localPort = localSrv.address().port;

  const tunnel = new Tunnel();
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort });
  await once(hostSocket, 'message');

  hostSocket.send(JSON.stringify({ type: 'connect', conn: 'c1', ip: '1.2.3.4' }));
  await once(tunnel, 'players');

  assert.doesNotThrow(() => {
    hostSocket.send(JSON.stringify({ type: 'data', conn: 'c1', data: '***not valid base64***' }));
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(tunnel.players.has('c1'), true, 'the connection itself should survive one malformed frame');

  tunnel.stop();
  localSrv.close();
  wss.close();
});

// ─── Item 21: local connect timeout ────────────────────────────────────────

test('a player connecting when no local server is listening gets cleaned up (close sent, no leak)', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  // Nothing is listening on this port.
  const deadPort = 1; // reserved/unlikely-to-be-listening low port, connection should be refused quickly
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort: deadPort });
  await once(hostSocket, 'message');

  const closeSentPromise = new Promise((resolve) => {
    hostSocket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'close') resolve(msg);
    });
  });
  hostSocket.send(JSON.stringify({ type: 'connect', conn: 'no-local-server', ip: '1.2.3.4' }));

  const closeMsg = await closeSentPromise;
  assert.equal(closeMsg.conn, 'no-local-server');
  assert.equal(tunnel.players.has('no-local-server'), false);

  tunnel.stop();
  wss.close();
});

// ─── Relay candidate fallback (direct endpoint -> Cloudflare) ───────────────

test('falls back to the next relay candidate when the preferred one is unreachable', async () => {
  const { wss, url } = await startFakeRelay();
  // Grab a free port, then close it so connecting there is refused.
  const deadPort = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const tunnel = new Tunnel();
  const logs = [];
  tunnel.on('log', (l) => logs.push(l));

  const connected = new Promise((resolve) => wss.once('connection', resolve));
  tunnel.start({ relayUrls: [`ws://127.0.0.1:${deadPort}`, url], token: 'vp_testtoken1234567890', localPort: 1 });
  const hostSocket = await connected;
  await once(hostSocket, 'message'); // register received

  try {
    assert.equal(tunnel.relayUrl, url);
    assert.ok(logs.some((l) => l.startsWith(`Could not reach ws://127.0.0.1:${deadPort}`)), 'logs the fallback');

    // Once established, a later drop retries the preferred candidate first.
    const reconnecting = once(tunnel, 'status');
    hostSocket.close();
    assert.equal(await reconnecting, 'reconnecting');
    assert.equal(tunnel.urlIndex, 0);
  } finally {
    const stopped = once(tunnel, 'stopped');
    tunnel.stop();
    await stopped;
    wss.close();
  }
});

test('single relayUrl form still works (no fallback list)', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort: 1 });
  assert.deepEqual(tunnel.relayUrls, [url]);
  tunnel.stop();
  wss.close();
});

// ─── Bedrock (UDP), custom addresses, public listing ───────────────────────

const dgram = require('dgram');

test('isValidRelayMessage checks the udp/name frames', () => {
  assert.equal(isValidRelayMessage({ type: 'udp', conn: 'c1', data: 'aGk=', ip: '1.2.3.4' }), true);
  assert.equal(isValidRelayMessage({ type: 'udp', conn: 'c1', data: 'x'.repeat(5000) }), false);
  assert.equal(isValidRelayMessage({ type: 'udp_close', conn: '' }), false);
  assert.equal(isValidRelayMessage({ type: 'name', name: 'steve', address: 'steve.voxelport.in' }), true);
  assert.equal(isValidRelayMessage({ type: 'name' }), true);
  assert.equal(isValidRelayMessage({ type: 'name', name: '<script>' }), false);
  assert.equal(isValidRelayMessage({ type: 'name_error', message: 42 }), false);
});

test('registers with udp:true and bridges Bedrock datagrams to the local UDP port', async () => {
  const { wss, url } = await startFakeRelay();
  const geyser = dgram.createSocket('udp4');
  await new Promise((r) => geyser.bind(0, '127.0.0.1', r));
  // Geyser stand-in: answers every datagram with "pong:<payload>".
  geyser.on('message', (buf, rinfo) => geyser.send(Buffer.concat([Buffer.from('pong:'), buf]), rinfo.port, rinfo.address));

  const tunnel = new Tunnel();
  const ws = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_test', localPort: 1, udpPort: geyser.address().port });
  const reg = JSON.parse(await once(ws, 'message'));
  assert.equal(reg.udp, true);
  ws.send(JSON.stringify({ type: 'port', port: 26137 }));

  ws.send(JSON.stringify({ type: 'udp', conn: 'sess1', ip: '9.9.9.9', data: Buffer.from('ping').toString('base64') }));
  const reply = JSON.parse(await once(ws, 'message'));
  assert.equal(reply.type, 'udp');
  assert.equal(reply.conn, 'sess1');
  assert.equal(Buffer.from(reply.data, 'base64').toString(), 'pong:ping');

  tunnel.stop();
  geyser.close();
  wss.close();
});

test('without udpPort, register omits udp and udp frames are ignored', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  const ws = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_test', localPort: 1 });
  const reg = JSON.parse(await once(ws, 'message'));
  assert.equal(reg.udp, undefined);
  ws.send(JSON.stringify({ type: 'udp', conn: 'sess1', data: 'aGk=' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tunnel.udpSessions.size, 0);
  tunnel.stop();
  wss.close();
});

test('claimName sends claim_name and surfaces name / name_error frames', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  const ws = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_test', localPort: 1 });
  await once(ws, 'message'); // register
  ws.send(JSON.stringify({ type: 'port', port: 26137 }));
  await once(tunnel, 'assigned');

  tunnel.claimName('  Steve ');
  const claim = JSON.parse(await once(ws, 'message'));
  assert.deepEqual(claim, { type: 'claim_name', name: 'steve' });

  ws.send(JSON.stringify({ type: 'name', name: 'steve', address: 'steve.voxelport.in' }));
  assert.deepEqual(await once(tunnel, 'name'), { name: 'steve', address: 'steve.voxelport.in' });
  ws.send(JSON.stringify({ type: 'name_error', message: 'That name is taken — try another.' }));
  assert.match(await once(tunnel, 'nameError'), /taken/);
  tunnel.stop();
  wss.close();
});

test('a listing set before going live is sent after registration, and withdrawn with null', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  tunnel.setListing({ title: 'Survival SMP', max_players: 20, players: 0 });
  const ws = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_test', localPort: 1 });
  await once(ws, 'message'); // register
  ws.send(JSON.stringify({ type: 'port', port: 26137 }));
  const listing = JSON.parse(await once(ws, 'message'));
  assert.equal(listing.type, 'listing');
  assert.equal(listing.listing.title, 'Survival SMP');

  tunnel.setListing(null);
  assert.deepEqual(JSON.parse(await once(ws, 'message')), { type: 'listing' });
  tunnel.stop();
  wss.close();
});

// ─── Who is connecting, and announcements from the relay ───────────────────

test('register tells the relay which app and version this is, when it was given one', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  const ws = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_test', localPort: 1, client: 'desktop/1.8.0' });
  const reg = JSON.parse(await once(ws, 'message'));
  tunnel.stop();
  wss.close();
  assert.equal(reg.type, 'register');
  assert.equal(reg.client, 'desktop/1.8.0');
});

test('register leaves the client out when none was given (older callers keep working)', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  const ws = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_test', localPort: 1 });
  const reg = JSON.parse(await once(ws, 'message'));
  tunnel.stop();
  wss.close();
  assert.equal('client' in reg, false);
});

test('a notice frame reaches the app as an event, and an empty one withdraws it', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  const ws = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_test', localPort: 1 });
  await once(ws, 'message'); // register
  ws.send(JSON.stringify({ type: 'port', port: 26137 }));
  await once(tunnel, 'assigned');

  const got = once(tunnel, 'notice');
  ws.send(JSON.stringify({ type: 'notice', message: 'The VoxelPort relay will restart.', seconds: 600 }));
  assert.deepEqual(await got, { message: 'The VoxelPort relay will restart.', seconds: 600 });

  const cleared = once(tunnel, 'notice');
  ws.send(JSON.stringify({ type: 'notice' }));
  assert.deepEqual(await cleared, { message: '', seconds: 0 });
  tunnel.stop();
  wss.close();
});

test('isValidRelayMessage checks notice frames', () => {
  assert.equal(isValidRelayMessage({ type: 'notice', message: 'ok', seconds: 60 }), true);
  assert.equal(isValidRelayMessage({ type: 'notice' }), true);
  assert.equal(isValidRelayMessage({ type: 'notice', message: 5 }), false);
  assert.equal(isValidRelayMessage({ type: 'notice', message: 'x'.repeat(301) }), false);
  assert.equal(isValidRelayMessage({ type: 'notice', message: 'ok', seconds: -1 }), false);
  assert.equal(isValidRelayMessage({ type: 'notice', message: 'ok', seconds: 1.5 }), false);
  assert.equal(isValidRelayMessage({ type: 'notice', message: 'ok', seconds: 999999999 }), false);
});

// ─── Lifecycle: a tunnel is live until it says it stopped ──────────────────

/** A relay address nothing listens on, so every connection attempt fails at once. */
function deadRelayUrl() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(`ws://127.0.0.1:${port}`)); });
  });
}

test('C1: a tunnel is live while it is still connecting or reconnecting, and not before start or after stop', async () => {
  const url = await deadRelayUrl();
  const tunnel = new Tunnel();
  assert.equal(tunnel.isLive(), false, 'before start');
  const statuses = [];
  tunnel.on('status', (s) => statuses.push(s));
  tunnel.start({ relayUrl: url, token: 'vp_testtoken1234567890', localPort: 25565 });
  assert.equal(tunnel.isLive(), true, 'connecting');
  assert.equal(tunnel.running, false, 'running still means registered and online');
  await new Promise((resolve) => { const t = setInterval(() => { if (statuses.includes('reconnecting')) { clearInterval(t); resolve(); } }, 10); });
  assert.equal(tunnel.isLive(), true, 'waiting to reconnect is still live');
  assert.equal(tunnel.running, false);
  const stopped = once(tunnel, 'stopped');
  tunnel.stop();
  await stopped;
  assert.equal(tunnel.isLive(), false, 'after stop');
});

test('C1: stopping while it waits to reconnect says "stopped" once and never reconnects', async () => {
  const url = await deadRelayUrl();
  const tunnel = new Tunnel();
  const events = [];
  tunnel.on('stopped', () => events.push('stopped'));
  tunnel.on('status', (s) => events.push('status:' + s));
  tunnel.start({ relayUrl: url, token: 'vp_testtoken1234567890', localPort: 25565 });
  await new Promise((resolve) => { const t = setInterval(() => { if (events.includes('status:reconnecting')) { clearInterval(t); resolve(); } }, 10); });
  tunnel.stop();
  tunnel.stop(); // a second stop changes nothing
  await new Promise((resolve) => setTimeout(resolve, 1500)); // longer than the first backoff (1 s)
  assert.equal(events.filter((e) => e === 'stopped').length, 1);
  assert.equal(events.filter((e) => e === 'status:connecting').length, 1, 'only the first attempt: no reconnect after stop');
  assert.equal(tunnel.isLive(), false);
});

test('C1: a tunnel that was stopped can be told to stop again without a second "stopped"', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort: 25565 });
  await once(hostSocket, 'message');
  let stoppedCount = 0;
  tunnel.on('stopped', () => stoppedCount++);
  tunnel.stop();
  tunnel.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  tunnel.stop();
  assert.equal(stoppedCount, 1);
  wss.close();
});

test('C1: a bad relay address ends the tunnel instead of leaving it live with no socket', () => {
  const tunnel = new Tunnel();
  tunnel.on('error', () => {});
  let stopped = 0;
  tunnel.on('stopped', () => stopped++);
  tunnel.start({ relayUrl: 'not a url', token: 'vp_testtoken1234567890', localPort: 25565 });
  assert.equal(tunnel.isLive(), false);
  assert.equal(stopped, 1);
});

test('K7: stop() reports zero players and "stopped" exactly once each', async () => {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  const hostSocket = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_testtoken1234567890', localPort: 25565 });
  await once(hostSocket, 'message');
  hostSocket.send(JSON.stringify({ type: 'port', port: 26000 }));
  await once(tunnel, 'assigned');
  const seen = [];
  tunnel.on('players', (n) => seen.push('players:' + n));
  tunnel.on('stopped', () => seen.push('stopped'));
  tunnel.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(seen, ['players:0', 'stopped']);
  wss.close();
});

// ─── K5: a frame that is too big for a player's stream ──────────────────────

test('K5: an oversized data frame disconnects that player instead of silently leaving a hole in the stream', () => {
  const tunnel = new Tunnel();
  const sent = [];
  const logs = [];
  tunnel.on('log', (l) => logs.push(l));
  tunnel.ws = { readyState: WebSocket.OPEN, send: (s) => sent.push(JSON.parse(s)) };
  let destroyed = false;
  tunnel.players.set('c1', { sock: { destroy: () => { destroyed = true; }, write() {} }, pendingBytes: 0, closed: false });
  tunnel.players.set('c2', { sock: { destroy() {}, write() {} }, pendingBytes: 0, closed: false });
  // Valid as a frame (under the base64 length limit), but it decodes to just over the 4 MiB cap.
  const data = 'A'.repeat(5_592_500);
  tunnel._onMessage(JSON.stringify({ type: 'data', conn: 'c1', data }));
  assert.equal(destroyed, true);
  assert.equal(tunnel.players.has('c1'), false);
  assert.equal(tunnel.players.has('c2'), true, 'other players are not affected');
  assert.deepEqual(sent, [{ type: 'close', conn: 'c1' }], 'the relay is told the player is gone');
  assert.ok(logs.some((l) => /larger than allowed/.test(l)));
});

// ─── Protocol v2: binary data frames ────────────────────────────────────────

const dgramV2 = require('dgram');
const { parseBinaryFrame, buildBinaryFrame, FRAME_TCP, FRAME_UDP, FRAME_HEADER_LEN } = require('../src/main/tunnel');

const newConnId = () => crypto.randomBytes(16).toString('hex');
const binaryFrame = (kind, connHex, payload) => Buffer.concat([Buffer.from([kind]), Buffer.from(connHex, 'hex'), Buffer.from(payload)]);

/**
 * A fake relay for one tunnel, in either mode. It answers the register frame with a port frame: with "bin": 1 only when
 * `v2` is set and the client asked for it, exactly as the real relay does. `frames` records everything the tunnel sends.
 */
async function startProtocolRelay({ v2, udpPort = null, voicePort = null, onLog } = {}) {
  const { wss, url } = await startFakeRelay();
  const tunnel = new Tunnel();
  if (onLog) tunnel.on('log', onLog);
  const ws = await startTunnelAndConnect(wss, tunnel, { relayUrl: url, token: 'vp_protocol_v2_test', localPort: 1, udpPort, voicePort });
  const frames = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const frame = { binary: isBinary, data: Buffer.from(data) };
    frames.push(frame);
    for (const w of [...waiters]) if (w.match(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(frame); }
  });
  const registered = await new Promise((resolve) => {
    const find = () => frames.find((f) => !f.binary && JSON.parse(f.data.toString()).type === 'register');
    if (find()) return resolve(JSON.parse(find().data.toString()));
    waiters.push({ match: (f) => !f.binary && JSON.parse(f.data.toString()).type === 'register', resolve: (f) => resolve(JSON.parse(f.data.toString())) });
  });
  frames.splice(0); // the register frame has been read; what is recorded from here on is what the tunnel sends next
  const assigned = once(tunnel, 'assigned');
  ws.send(JSON.stringify({ type: 'port', port: 26137, ...(voicePort ? {voice_port:26138} : {}), ...(v2 && registered.bin === 1 ? { bin: 1 } : {}) }));
  await assigned;
  const next = (match) => new Promise((resolve) => {
    const have = frames.find((f) => match(f));
    if (have) { frames.splice(frames.indexOf(have), 1); return resolve(have); }
    waiters.push({ match, resolve: (f) => { const i = frames.indexOf(f); if (i >= 0) frames.splice(i, 1); resolve(f); } });
  });
  return {
    tunnel, ws, frames, registered, next,
    json: (type) => next((f) => !f.binary && JSON.parse(f.data.toString()).type === type).then((f) => JSON.parse(f.data.toString())),
    binary: () => next((f) => f.binary),
    close() { tunnel.stop(); wss.close(); },
  };
}

/** A local Minecraft server stand-in that echoes, and remembers what it was sent. */
async function startRecordingEcho() {
  const received = [];
  const srv = net.createServer((sock) => sock.on('data', (buf) => { received.push(Buffer.from(buf)); sock.write(buf); }));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { srv, port: srv.address().port, received, bytes: () => Buffer.concat(received) };
}

async function startedRelay(opts) {
  const echo = await startRecordingEcho();
  const relay = await startProtocolRelay(opts);
  relay.tunnel.localPort = echo.port;
  return { ...relay, echo, close() { relay.close(); echo.srv.close(); } };
}

test('C1: the tunnel always asks for protocol v2 when it registers', async () => {
  for (const v2 of [false, true]) {
    const r = await startProtocolRelay({ v2 });
    assert.equal(r.registered.bin, 1);
    assert.equal(r.tunnel.bin, v2, v2 ? 'the relay confirmed it' : 'an older relay never does');
    r.close();
  }
});

test('C2: against a relay that does not confirm v2 everything stays JSON, and the bytes arrive unchanged', async () => {
  const r = await startedRelay({ v2: false });
  const conn = newConnId();
  r.ws.send(JSON.stringify({ type: 'connect', conn, ip: '203.0.113.5' }));
  await once(r.tunnel, 'players');
  const payload = crypto.randomBytes(300 * 1024);
  for (let i = 0; i < payload.length; i += 32768) {
    r.ws.send(JSON.stringify({ type: 'data', conn, data: payload.subarray(i, i + 32768).toString('base64') }));
  }
  let echoed = Buffer.alloc(0);
  while (echoed.length < payload.length) {
    const f = await r.next(() => true);
    assert.equal(f.binary, false, 'a legacy relay must never be sent a binary frame');
    const msg = JSON.parse(f.data.toString());
    if (msg.type === 'data' && msg.conn === conn) echoed = Buffer.concat([echoed, Buffer.from(msg.data, 'base64')]);
  }
  assert.equal(crypto.createHash('sha256').update(r.echo.bytes()).digest('hex'), crypto.createHash('sha256').update(payload).digest('hex'));
  assert.equal(crypto.createHash('sha256').update(echoed).digest('hex'), crypto.createHash('sha256').update(payload).digest('hex'));
  r.close();
});

test('C2: against a v2 relay payloads travel as binary frames in both directions, and the bytes arrive unchanged', async () => {
  const r = await startedRelay({ v2: true });
  const conn = newConnId();
  r.ws.send(JSON.stringify({ type: 'connect', conn, ip: '203.0.113.5' }));
  await once(r.tunnel, 'players');

  const payload = crypto.randomBytes(300 * 1024);
  for (let i = 0; i < payload.length; i += 32768) r.ws.send(binaryFrame(FRAME_TCP, conn, payload.subarray(i, i + 32768)));

  let echoed = Buffer.alloc(0);
  while (echoed.length < payload.length) {
    const f = await r.next(() => true);
    assert.equal(f.binary, true, 'payload to a v2 relay is binary');
    assert.equal(f.data[0], FRAME_TCP);
    assert.equal(f.data.subarray(1, FRAME_HEADER_LEN).toString('hex'), conn, 'the header names the connection');
    echoed = Buffer.concat([echoed, f.data.subarray(FRAME_HEADER_LEN)]);
  }
  assert.equal(crypto.createHash('sha256').update(r.echo.bytes()).digest('hex'), crypto.createHash('sha256').update(payload).digest('hex'), 'relay -> local server unchanged');
  assert.equal(crypto.createHash('sha256').update(echoed).digest('hex'), crypto.createHash('sha256').update(payload).digest('hex'), 'local server -> relay unchanged');

  // Control frames stay JSON: the tunnel's ping, and the close it sends when the player goes away.
  r.tunnel.lastPingSent = Date.now();
  r.tunnel._send({ type: 'ping' });
  assert.equal((await r.json('ping')).type, 'ping');
  const closed = r.json('close');
  r.tunnel.players.get(conn).sock.destroy();
  assert.equal((await closed).conn, conn);
  r.close();
});

test('C2: a v2 relay may still send JSON data frames', async () => {
  const r = await startedRelay({ v2: true });
  const conn = newConnId();
  r.ws.send(JSON.stringify({ type: 'connect', conn }));
  await once(r.tunnel, 'players');
  r.ws.send(JSON.stringify({ type: 'data', conn, data: Buffer.from('json is fine').toString('base64') }));
  const back = await r.binary();
  assert.equal(back.data.subarray(FRAME_HEADER_LEN).toString(), 'json is fine', 'and the reply goes back the v2 way');
  r.close();
});

test('C2: malformed binary frames are ignored, logged once, and the tunnel carries on', async () => {
  const logs = [];
  const r = await startedRelay({ v2: true, onLog: (l) => logs.push(l) });
  const conn = newConnId();
  r.ws.send(JSON.stringify({ type: 'connect', conn }));
  await once(r.tunnel, 'players');
  const unknown = newConnId();
  const bad = [
    Buffer.alloc(0),
    Buffer.from([FRAME_TCP]),
    Buffer.concat([Buffer.from([FRAME_TCP]), crypto.randomBytes(5)]),
    binaryFrame(0x7f, conn, 'unknown kind'),
    binaryFrame(0x00, conn, 'unknown kind'),
    binaryFrame(FRAME_TCP, unknown, 'no such connection'),
    binaryFrame(FRAME_UDP, conn, 'this tunnel has no UDP port'),
  ];
  for (const f of bad) r.ws.send(f);
  r.ws.send(binaryFrame(FRAME_TCP, conn, 'still works'));
  const back = await r.binary();
  assert.equal(back.data.subarray(FRAME_HEADER_LEN).toString(), 'still works', 'the next good frame is delivered');
  assert.equal(r.echo.bytes().toString(), 'still works', 'and nothing else reached the local server');
  assert.equal(logs.filter((l) => /Ignored a binary frame/.test(l)).length, 1, 'a flood of bad frames is logged once');
  assert.equal(r.tunnel.players.size, 1);
  assert.equal(r.tunnel.isLive(), true);
  r.close();
});

test('C2: a binary frame from a relay that did not agree to v2 is ignored', async () => {
  const r = await startedRelay({ v2: false });
  const conn = newConnId();
  r.ws.send(JSON.stringify({ type: 'connect', conn }));
  await once(r.tunnel, 'players');
  r.ws.send(binaryFrame(FRAME_TCP, conn, 'not agreed'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(r.echo.bytes().length, 0);
  r.ws.send(JSON.stringify({ type: 'data', conn, data: Buffer.from('json').toString('base64') }));
  const f = await r.next((x) => !x.binary && JSON.parse(x.data.toString()).type === 'data');
  assert.equal(Buffer.from(JSON.parse(f.data.toString()).data, 'base64').toString(), 'json');
  r.close();
});

test('C2: an oversized TCP payload disconnects that player; an oversized UDP datagram is dropped', async () => {
  const tunnel = new Tunnel();
  const sent = [];
  tunnel.ws = { readyState: WebSocket.OPEN, send: (d) => sent.push(d), bufferedAmount: 0 };
  tunnel.bin = true;
  let destroyed = false;
  const conn = newConnId();
  tunnel.players.set(conn, { sock: { destroy: () => { destroyed = true; }, write() {} }, pendingBytes: 0, closed: false, raw: Buffer.from(conn, 'hex') });
  tunnel._onBinary(Buffer.concat([Buffer.from([FRAME_TCP]), Buffer.from(conn, 'hex'), Buffer.alloc(4 * 1024 * 1024 + 1)]));
  assert.equal(destroyed, true);
  assert.equal(tunnel.players.size, 0);
  assert.deepEqual(sent.map((s) => JSON.parse(s)), [{ type: 'close', conn }], 'the relay is told');

  tunnel.udpPort = 1;
  tunnel._onBinary(binaryFrame(FRAME_UDP, newConnId(), Buffer.alloc(2049)));
  assert.equal(tunnel.udpSessions.size, 0, 'nothing was forwarded');
});

test('C2: UDP works in both modes', async () => {
  for (const v2 of [false, true]) {
    const geyser = dgramV2.createSocket('udp4');
    await new Promise((r) => geyser.bind(0, '127.0.0.1', r));
    geyser.on('message', (buf, rinfo) => geyser.send(Buffer.concat([Buffer.from('pong:'), buf]), rinfo.port, rinfo.address));
    const r = await startProtocolRelay({ v2, udpPort: geyser.address().port });
    const session = newConnId();
    if (v2) {
      r.ws.send(binaryFrame(FRAME_UDP, session, 'ping'));
      const f = await r.binary();
      assert.equal(f.data[0], FRAME_UDP);
      assert.equal(f.data.subarray(1, FRAME_HEADER_LEN).toString('hex'), session);
      assert.equal(f.data.subarray(FRAME_HEADER_LEN).toString(), 'pong:ping');
    } else {
      r.ws.send(JSON.stringify({ type: 'udp', conn: session, ip: '9.9.9.9', data: Buffer.from('ping').toString('base64') }));
      const reply = await r.json('udp');
      assert.equal(reply.conn, session);
      assert.equal(Buffer.from(reply.data, 'base64').toString(), 'pong:ping');
    }
    r.close();
    geyser.close();
  }
});

test('C2: a JSON udp frame from a v2 relay still works', async () => {
  const geyser = dgramV2.createSocket('udp4');
  await new Promise((r) => geyser.bind(0, '127.0.0.1', r));
  geyser.on('message', (buf, rinfo) => geyser.send(buf, rinfo.port, rinfo.address));
  const r = await startProtocolRelay({ v2: true, udpPort: geyser.address().port });
  const session = newConnId();
  r.ws.send(JSON.stringify({ type: 'udp', conn: session, data: Buffer.from('echo me').toString('base64') }));
  const f = await r.binary();
  assert.equal(f.data.subarray(FRAME_HEADER_LEN).toString(), 'echo me');
  r.close();
  geyser.close();
});

test('C2: a connection id that is not 32 hex characters stays on JSON even when v2 is on', async () => {
  const r = await startedRelay({ v2: true });
  r.ws.send(JSON.stringify({ type: 'connect', conn: 'conn-not-hex' }));
  await once(r.tunnel, 'players');
  r.ws.send(JSON.stringify({ type: 'data', conn: 'conn-not-hex', data: Buffer.from('hi').toString('base64') }));
  const f = await r.next(() => true);
  assert.equal(f.binary, false);
  assert.equal(JSON.parse(f.data.toString()).type, 'data');
  r.close();
});

test('C2: binary frame helpers: layout, and what is refused', () => {
  const conn = newConnId();
  const frame = buildBinaryFrame(FRAME_UDP, Buffer.from(conn, 'hex'), Buffer.from('abc'));
  assert.equal(frame.length, 20);
  assert.equal(frame[0], 0x02);
  assert.equal(frame.subarray(1, 17).toString('hex'), conn);
  assert.deepEqual(parseBinaryFrame(frame), { kind: FRAME_UDP, conn, payload: Buffer.from('abc') });
  assert.equal(parseBinaryFrame(Buffer.alloc(16)), null, 'shorter than the header');
  assert.equal(parseBinaryFrame(Buffer.alloc(17)), null, 'kind 0 is not a kind');
  assert.equal(parseBinaryFrame(Buffer.concat([Buffer.from([0x7f]), Buffer.alloc(20)])), null);
  assert.equal(parseBinaryFrame('not a buffer'), null);
  assert.deepEqual(parseBinaryFrame(Buffer.concat([Buffer.from([FRAME_TCP]), Buffer.from(conn, 'hex')])).payload, Buffer.alloc(0), 'an empty payload parses (and is ignored later)');
  assert.equal(FRAME_TCP, 0x01);
  assert.equal(FRAME_HEADER_LEN, 17);
});

test('C2: the port frame check accepts a bin field and refuses a mistyped one', () => {
  assert.equal(isValidRelayMessage({ type: 'port', port: 26000 }), true);
  assert.equal(isValidRelayMessage({ type: 'port', port: 26000, bin: 1 }), true);
  assert.equal(isValidRelayMessage({ type: 'port', port: 26000, bin: 'yes' }), false);
});

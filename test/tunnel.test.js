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

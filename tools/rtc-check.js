'use strict';

// Real WebRTC check for join codes. Run it with Electron (not `npm test`, which needs no window):
//   npm run test:rtc   (needs a desktop session; not part of npm test)
// Two hidden windows (a host's and a player's) open a real WebRTC connection to each other, the real host and player
// controllers bridge real TCP sockets over it, and a stand-in Minecraft server answers. Only the relay is faked.
// Exit code 0 = everything held.

const { app } = require('electron');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

const root = path.join(__dirname, '..');
const { ElectronRtcWorker } = require(path.join(root, 'src', 'main', 'p2pWorker'));
const { P2PHost } = require(path.join(root, 'src', 'main', 'p2pHost'));
const { P2PJoin } = require(path.join(root, 'src', 'main', 'p2pJoin'));
const { FakeRelay } = require(path.join(root, 'test', 'helpers', 'fakeRtc'));

app.disableHardwareAcceleration();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(25); }
  throw new Error(`timed out waiting for: ${what}`);
}

/** Connects like Minecraft: sends data, waits for `expect` bytes back. */
function roundTrip(port, data, expect) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1');
    const chunks = []; let got = 0;
    c.on('connect', () => c.write(data));
    c.on('data', (b) => { chunks.push(b); got += b.length; if (got >= expect) { c.destroy(); resolve(Buffer.concat(chunks)); } });
    c.on('error', reject);
    setTimeout(() => { c.destroy(); reject(new Error(`round trip timed out (${got}/${expect} bytes)`)); }, 30000);
  });
}

app.whenReady().then(async () => {
  let code = 0;
  const mc = net.createServer((s) => { let first = true; s.on('error', () => {}); s.on('data', (b) => { s.write(first ? Buffer.concat([Buffer.from('MC:'), b]) : b); first = false; }); });
  await new Promise((r) => mc.listen(0, '127.0.0.1', r));
  const relay = new FakeRelay({ fallback: { address: '127.0.0.1', port: 9 } });
  const hostWorker = new ElectronRtcWorker();
  const joinWorker = new ElectronRtcWorker();
  const host = new P2PHost({ worker: hostWorker, getLocalPort: () => mc.address().port });
  host.attach(relay.tunnel);
  const join = new P2PJoin({ worker: joinWorker, signaling: relay.signaling(), preferredPort: 0, p2pTimeoutMs: 20000 });
  try {
    const t0 = Date.now();
    join.start({ relayUrl: 'wss://relay.example', code: 'K7M2Q-9XH4T', client: 'rtc-test' });
    await waitFor(() => join.status.state === 'p2p' || join.status.state === 'relay' || join.status.state === 'failed', 'the connection');
    check('a real WebRTC connection opens between two windows', join.status.state === 'p2p', `state=${join.status.state} path=${join.status.path} in ${Date.now() - t0} ms ${join.status.message || ''}`);
    check('the host sees the player connected', host.connectedPeers === 1);
    if (join.status.state !== 'p2p') throw new Error('no direct connection, cannot go on');

    const port = join.status.port;
    const hello = await roundTrip(port, Buffer.from('hello'), 8);
    check('a small message goes to the host\'s server and back', hello.toString() === 'MC:hello', JSON.stringify(hello.toString()));

    const big = crypto.randomBytes(12 * 1024 * 1024);
    const t1 = Date.now();
    const echoed = await roundTrip(port, big, big.length + 3);
    const ms = Date.now() - t1;
    check('12 MB goes through intact (flow control works)', Buffer.compare(echoed, Buffer.concat([Buffer.from('MC:'), big])) === 0, `${(big.length * 2 / 1048576 / (ms / 1000)).toFixed(1)} MB/s round trip`);

    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => roundTrip(port, Buffer.from(`conn${i}`), 3 + `conn${i}`.length)));
    check('8 games at once, each its own channel', many.every((b, i) => b.toString() === `MC:conn${i}`));

    // A game that closes on the host's side closes for the player, and the other way round.
    const c = net.connect(port, '127.0.0.1'); c.resume();
    await new Promise((r) => c.on('connect', r)); c.write('x');
    await waitFor(() => host.players === 1, 'the game to open');
    c.destroy();
    await waitFor(() => host.players === 0, 'the host to see the game end');
    check('closing a game on the player\'s side closes it on the host\'s', true);

    join.stop();
    await waitFor(() => host.connectedPeers === 0, 'the host to see the player leave', 8000);
    check('stopping the player closes the host\'s side', true);
  } catch (err) {
    check('no unexpected error', false, err.message);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  code = failed ? 1 : 0;
  try { join.stop(); host.detach(); hostWorker.close(); joinWorker.close(); mc.close(); } catch { /* shutting down */ }
  setTimeout(() => app.exit(code), 900);
});

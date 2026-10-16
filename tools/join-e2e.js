'use strict';

// Full-stack check of join codes against a REAL relay (the Go one from the relay repo's join-codes branch), run with Electron:
//   RELAY=ws://127.0.0.1:28990 electron tools/join-e2e.js
// The relay must run with -public-host 127.0.0.1 and a -data-dir, and its tunnel ports must be reachable at 127.0.0.1
// (for example through ssh -L). A real host (Tunnel + P2PHost) and a real player (JoinSignaling + P2PJoin) open a real WebRTC
// connection and play against a stand-in Minecraft server. Also checks the relay fallback and wrong / replaced codes.

const { app } = require('electron');
const net = require('net');
const path = require('path');

const root = path.join(__dirname, '..');
const { Tunnel } = require(path.join(root, 'src', 'main', 'tunnel'));
const { ElectronRtcWorker } = require(path.join(root, 'src', 'main', 'p2pWorker'));
const { P2PHost } = require(path.join(root, 'src', 'main', 'p2pHost'));
const { P2PJoin } = require(path.join(root, 'src', 'main', 'p2pJoin'));

const RELAY = process.env.RELAY || 'ws://127.0.0.1:28990';
app.disableHardwareAcceleration();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(25); }
  throw new Error(`timed out waiting for: ${what}`);
}
const once = (em, ev) => new Promise((r) => em.once(ev, r));

function roundTrip(port, data, expect, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, host);
    const chunks = []; let got = 0;
    c.on('connect', () => c.write(data));
    c.on('data', (b) => { chunks.push(b); got += b.length; if (got >= expect) { c.destroy(); resolve(Buffer.concat(chunks)); } });
    c.on('error', reject);
    setTimeout(() => { c.destroy(); reject(new Error(`round trip timed out (${got}/${expect})`)); }, 15000);
  });
}

function newPlayer(extra = {}) {
  const worker = new ElectronRtcWorker();
  const join = new P2PJoin({ worker, preferredPort: 0, ...extra });
  return { worker, join, stop: () => { join.stop(); worker.close(); } };
}

app.whenReady().then(async () => {
  const mc = net.createServer((s) => { let first = true; s.on('error', () => {}); s.on('data', (b) => { s.write(first ? Buffer.concat([Buffer.from('MC:'), b]) : b); first = false; }); });
  await new Promise((r) => mc.listen(0, '127.0.0.1', r));
  const hostWorker = new ElectronRtcWorker();
  const host = new P2PHost({ worker: hostWorker, getLocalPort: () => mc.address().port });
  const tunnel = new Tunnel();
  let code = 0;
  const players = [];
  try {
    tunnel.on('error', (m) => console.log('tunnel error:', m));
    tunnel.start({ relayUrl: RELAY, token: 'vp_e2ejoincode0000000001', localPort: mc.address().port, client: 'e2e/1' });
    const relayPort = await once(tunnel, 'assigned');
    host.attach(tunnel);
    tunnel.setP2P(true);
    const code1 = await once(tunnel, 'joinCode');
    check('the host gets a join code from the real relay', /^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(code1), code1);

    // 1. A direct connection.
    const p1 = newPlayer(); players.push(p1);
    p1.join.start({ relayUrl: RELAY, code: code1.toLowerCase().replace('-', ' '), client: 'e2e/1' });
    await waitFor(() => ['p2p', 'relay', 'failed'].includes(p1.join.status.state), 'the join');
    check('a player with the code connects directly (typed in lower case with a space)', p1.join.status.state === 'p2p', `state=${p1.join.status.state} path=${p1.join.status.path} ${p1.join.status.message}`);
    if (p1.join.status.state === 'p2p') {
      const back = await roundTrip(p1.join.status.port, Buffer.from('hello'), 8);
      check('the game works through the direct connection', back.toString() === 'MC:hello');
      check('the host counts the connected friend', host.connectedPeers === 1, `peers=${host.connectedPeers}`);
    }
    p1.stop();
    await waitFor(() => host.connectedPeers === 0, 'the host to see the player go', 8000);

    // 2. The relay fallback: the host does not answer the introduction, so the player ends up on the relay path.
    host.detach();
    const p2 = newPlayer({ p2pTimeoutMs: 2500 }); players.push(p2);
    p2.join.start({ relayUrl: RELAY, code: code1, client: 'e2e/1' });
    await waitFor(() => ['p2p', 'relay', 'failed'].includes(p2.join.status.state), 'the fallback', 15000);
    check('with no answer from the host the player falls back to the relay', p2.join.status.state === 'relay' && p2.join.status.reason === 'timeout', `state=${p2.join.status.state} reason=${p2.join.status.reason}`);
    if (p2.join.status.state === 'relay') {
      const back = await roundTrip(p2.join.status.port, Buffer.from('via relay'), 12);
      check('the game works through the relay port (the real tunnel)', back.toString() === 'MC:via relay', `relay port ${relayPort}`);
    }
    p2.stop();
    host.attach(tunnel);

    // 3. A wrong code.
    const p3 = newPlayer(); players.push(p3);
    p3.join.start({ relayUrl: RELAY, code: '99999-99999' });
    await waitFor(() => p3.join.status.state === 'failed', 'the refusal', 8000);
    check('a wrong code is refused with the relay\'s explanation', /isn't active/.test(p3.join.status.message), p3.join.status.message);

    // 4. A new code revokes the old one.
    tunnel.rotateJoinCode();
    const code2 = await once(tunnel, 'joinCode');
    check('rotating gives a different code', code2 !== code1 && /^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(code2), code2);
    const p4 = newPlayer(); players.push(p4);
    p4.join.start({ relayUrl: RELAY, code: code1 });
    await waitFor(() => p4.join.status.state === 'failed', 'the old code to be refused', 8000);
    check('the old code stops working', /isn't active/.test(p4.join.status.message));
    const p5 = newPlayer(); players.push(p5);
    p5.join.start({ relayUrl: RELAY, code: code2 });
    await waitFor(() => ['p2p', 'relay', 'failed'].includes(p5.join.status.state), 'the new code', 15000);
    check('the new code works', p5.join.status.state === 'p2p', p5.join.status.state);

    // 5. Turning join codes off.
    p5.stop();
    tunnel.setP2P(false);
    const off = await once(tunnel, 'joinCode');
    check('turning join codes off clears the code', off === '', JSON.stringify(off));
    const p6 = newPlayer(); players.push(p6);
    p6.join.start({ relayUrl: RELAY, code: code2 });
    await waitFor(() => p6.join.status.state === 'failed', 'the refusal', 8000);
    check('and the code no longer works', /isn't active/.test(p6.join.status.message));
  } catch (err) {
    check('no unexpected error', false, err.message);
  }
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  code = failed ? 1 : 0;
  try { for (const p of players) p.stop(); host.detach(); tunnel.stop(); hostWorker.close(); mc.close(); } catch { /* shutting down */ }
  setTimeout(() => app.exit(code), 900);
});

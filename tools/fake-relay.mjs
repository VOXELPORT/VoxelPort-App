// A stand-in for the VoxelPort relay, for testing the tunnel end to end without the internet.
//   import { startFakeRelay } from './fake-relay.mjs'
// It speaks the host protocol the way the real relay does: it answers `register` with a `port` frame (with "bin": 1 when the client asked,
// and a Bedrock port when it asked), answers ping, claim_name and release_name, and remembers everything the tunnel sends. Tests drive
// "players" through it and can drop the connection or push a notice.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(path.join(import.meta.dirname, '..', 'reference', 'electron-v1.17.1', 'node_modules', 'ws'));

export async function startFakeRelay(port = 0) {
  const state = { registers: [], listings: [], frames: [], connections: 0, takenNames: new Set(['taken']), bedrockPort: 26138, rank: 'free', bedrockOn: true, voicePort: null };
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  let host = null; // the current tunnel connection
  const players = new Map(); // conn -> { chunks: Buffer[], waiters: [] }

  wss.on('connection', (ws) => {
    state.connections++;
    host = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const conn = data.subarray(1, 17).toString('hex');
        const p = players.get(conn);
        if (p) { p.chunks.push(Buffer.from(data.subarray(17))); p.waiters.splice(0).forEach((w) => w()); }
        return;
      }
      const m = JSON.parse(data.toString());
      state.frames.push(m);
      if (m.type === 'register') {
        state.registers.push(m);
        const port = { type: 'port', port: 26137, rank: state.rank };
        if (m.bin === 1) port.bin = 1;
        if (m.bedrock && state.bedrockOn) port.bedrock_port = state.bedrockPort;
        if ((m.voice_auto || m.voice) && state.voicePort) port.voice_port = state.voicePort; // a public voice port, when the test gives one
        ws.send(JSON.stringify(port));
      } else if (m.type === 'listing') state.listings.push(m.listing ?? null);
      else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      else if (m.type === 'claim_name') {
        if (state.takenNames.has(m.name)) ws.send(JSON.stringify({ type: 'name_error', message: 'That name is taken — try another.' }));
        else ws.send(JSON.stringify({ type: 'name', name: m.name, address: `${m.name}.voxelport.in` }));
      } else if (m.type === 'release_name') ws.send(JSON.stringify({ type: 'name' }));
      else if (m.type === 'data') {
        const p = players.get(m.conn);
        if (p) { p.chunks.push(Buffer.from(m.data, 'base64')); p.waiters.splice(0).forEach((w) => w()); }
      } else if (m.type === 'close') players.delete(m.conn);
    });
    ws.on('close', () => { if (host === ws) host = null; });
  });

  return {
    state,
    url: `ws://127.0.0.1:${wss.address().port}`,
    /** A player joins: the relay tells the tunnel to connect, then sends `data` and returns what comes back (the local server's echo). */
    async player(data, { bedrock = false } = {}) {
      const conn = crypto.randomBytes(16).toString('hex');
      players.set(conn, { chunks: [], waiters: [] });
      host.send(JSON.stringify({ type: 'connect', conn, ip: '203.0.113.7', ...(bedrock ? { bedrock: true } : {}) }));
      host.send(JSON.stringify({ type: 'data', conn, data: Buffer.from(data).toString('base64') }));
      const p = players.get(conn);
      const deadline = Date.now() + 5000;
      while (Buffer.concat(p.chunks).length < Buffer.byteLength(data) && Date.now() < deadline) await new Promise((r) => { p.waiters.push(r); setTimeout(r, 100); });
      const got = Buffer.concat(p.chunks);
      return { conn, got, close: () => host?.send(JSON.stringify({ type: 'close', conn })) };
    },
    notice(message, seconds) { host?.send(JSON.stringify(message ? { type: 'notice', message, seconds } : { type: 'notice' })); },
    drop() { host?.close(); },
    connected: () => host !== null,
    close() { for (const c of wss.clients) c.terminate(); wss.close(); },
  };
}

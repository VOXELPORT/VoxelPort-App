'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const dgram = require('dgram');
const { once } = require('events');
const { WebSocketServer } = require('ws');
const { Tunnel, isValidRelayMessage, buildBinaryFrame, parseBinaryFrame, FRAME_TCP } = require('../src/main/tunnel');

test('Bedrock endpoint and connection capability are validated', () => {
  assert.equal(isValidRelayMessage({ type: 'port', port: 26000, bedrock_port: -1 }), false);
  assert.equal(isValidRelayMessage({ type: 'port', port: 26000, bedrock_port: 26000 }), false);
  assert.equal(isValidRelayMessage({ type: 'port', port: 26000, bedrock_port: 26001, voice_port: 26001 }), false);
  assert.equal(isValidRelayMessage({ type: 'port', port: 26000, bedrock_port: 26001 }), true);
  assert.equal(isValidRelayMessage({ type: 'connect', conn: 'abc', bedrock: 'true' }), false);
});

for (const binary of [false, true]) test(`Java and Bedrock TCP/UDP are routed independently (${binary ? 'binary' : 'JSON'})`, { timeout: 8000 }, async (t) => {
  const java = net.createServer((s) => s.on('data', (b) => s.write(Buffer.concat([Buffer.from('java:'), b]))));
  const bedrock = net.createServer((s) => s.on('data', (b) => s.write(Buffer.concat([Buffer.from('bedrock:'), b]))));
  java.listen(0, '127.0.0.1'); await once(java, 'listening');
  bedrock.listen(0, '127.0.0.1'); await once(bedrock, 'listening');
  const udp = dgram.createSocket('udp4');
  udp.on('message', (b, r) => udp.send(b, r.port, r.address));
  udp.bind(bedrock.address().port, '127.0.0.1'); await once(udp, 'listening');
  const wss = new WebSocketServer({ port: 0 }); await once(wss, 'listening');
  const tunnel = new Tunnel();
  t.after(() => { tunnel.stop(); for (const s of wss.clients) s.terminate(); wss.close(); java.close(); bedrock.close(); udp.close(); });
  const connection = once(wss, 'connection');
  tunnel.start({ relayUrl: `ws://127.0.0.1:${wss.address().port}`, token: 'vp_bedrocktest12345',
    localPort: java.address().port, udpPort: bedrock.address().port, bedrockPort: bedrock.address().port });
  const [host] = await connection;
  const [registration] = await once(host, 'message');
  assert.equal(JSON.parse(registration).bedrock, true);
  const assigned = once(tunnel, 'assigned');
  host.send(JSON.stringify({ type: 'port', port: 26001, bedrock_port: 26002, ...(binary ? { bin: 1 } : {}) }));
  await assigned;
  assert.equal(tunnel.bedrockPublicPort, 26002);
  for (const [id, extra, prefix] of [['1'.repeat(32), {}, 'java:'], ['2'.repeat(32), { bedrock: true }, 'bedrock:']]) {
    host.send(JSON.stringify({ type: 'connect', conn: id, ...extra }));
    const reply = once(host, 'message');
    if (binary) host.send(buildBinaryFrame(FRAME_TCP, Buffer.from(id, 'hex'), Buffer.from('hello')));
    else host.send(JSON.stringify({ type: 'data', conn: id, data: Buffer.from('hello').toString('base64') }));
    const [raw, isBinary] = await reply;
    const payload = isBinary ? parseBinaryFrame(raw).payload : Buffer.from(JSON.parse(raw).data, 'base64');
    assert.equal(payload.toString(), prefix + 'hello');
    host.send(JSON.stringify({ type: 'close', conn: id }));
  }
  const udpReply = once(host, 'message');
  host.send(JSON.stringify({ type: 'udp', conn: '3'.repeat(32), data: Buffer.from('datagram').toString('base64') }));
  const [raw, isBinary] = await udpReply;
  assert.equal((isBinary ? parseBinaryFrame(raw).payload : Buffer.from(JSON.parse(raw).data, 'base64')).toString(), 'datagram');
});

test('an old relay cannot silently enable the legacy Bedrock port for a new client', () => {
  const tunnel = new Tunnel();
  tunnel.bedrockPort = 19132;
  tunnel.on('log', () => {});
  tunnel._startPing = () => {};
  tunnel._onMessage(Buffer.from(JSON.stringify({ type: 'port', port: 26000 })));
  assert.equal(tunnel.bedrockPublicPort, null);
  let opened = false;
  tunnel._openPlayer = () => { opened = true; };
  tunnel._onMessage(Buffer.from(JSON.stringify({ type: 'connect', conn: 'bedrock-test', bedrock: true })));
  assert.equal(opened, false, 'unnegotiated signaling must never reach Java');
});

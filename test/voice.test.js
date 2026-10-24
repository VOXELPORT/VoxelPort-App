'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { Tunnel, isValidRelayMessage, buildBinaryFrame } = require('../src/main/tunnel');

for (const binary of [false, true]) {
  test(`voice and Bedrock reach different local services (${binary ? 'binary' : 'JSON'})`, { timeout: 5000 }, async (t) => {
    const geyser = dgram.createSocket('udp4');
    const voice = dgram.createSocket('udp4');
    geyser.bind(0, '127.0.0.1'); await once(geyser, 'listening');
    voice.bind(0, '127.0.0.1'); await once(voice, 'listening');
    geyser.on('message', (data, from) => geyser.send(Buffer.from('bedrock:' + data), from.port, from.address));
    voice.on('message', (data, from) => voice.send(Buffer.from('voice:' + data), from.port, from.address));
    const wss = new WebSocketServer({ port: 0 }); await once(wss, 'listening');
    const tunnel = new Tunnel();
    let socket;
    t.after(() => { tunnel.stop(); if (socket) socket.terminate(); wss.close(); geyser.close(); voice.close(); });
    const accepted = new Promise((resolve) => wss.once('connection', (ws) => {
      ws.once('message', (data) => resolve({ ws, registration: JSON.parse(data.toString()) }));
    }));
    tunnel.start({relayUrl:`ws://127.0.0.1:${wss.address().port}`, token:'vp_voice_app_test_12345', localPort:25565, udpPort:geyser.address().port, voicePort:voice.address().port});
    const { ws, registration } = await accepted; socket = ws;
    assert.equal(registration.udp, true);
    assert.equal(registration.voice, true);
    const assigned = once(tunnel, 'voiceAssigned');
    ws.send(JSON.stringify({type:'port', port:26000, voice_port:26001, ...(binary ? {bin:1} : {})}));
    assert.equal((await assigned)[0], 26001);
    // Deliberately reuse the same session ID across channels to catch map crossover.
    const conn = 'a'.repeat(32);
    for (const [kind, type, expected] of [[2,'udp','bedrock:hello'], [3,'voice_udp','voice:hello']]) {
      const reply = once(ws, 'message');
      if (binary) ws.send(buildBinaryFrame(kind, Buffer.from(conn,'hex'), Buffer.from('hello')));
      else ws.send(JSON.stringify({type, conn, data:Buffer.from('hello').toString('base64')}));
      const [data, isBinary] = await reply;
      assert.equal(isBinary, binary);
      if (binary) { assert.equal(data[0],kind); assert.equal(data.subarray(17).toString(),expected); }
      else { const result=JSON.parse(data.toString());assert.equal(result.type,type);assert.equal(Buffer.from(result.data,'base64').toString(),expected); }
    }
    assert.equal(tunnel.udpSessions.size,1);
    assert.equal(tunnel.voiceSessions.size,1);
    tunnel.stop();
    assert.equal(tunnel.udpSessions.size,0);
    assert.equal(tunnel.voiceSessions.size,0);
  });
}

test('voice frames require valid session IDs and bounded payloads', () => {
  assert.equal(isValidRelayMessage({type:'port',port:26000,voice_port:0}),false);
  assert.equal(isValidRelayMessage({type:'port',port:26000,voice_port:'26001'}),false);
  assert.equal(isValidRelayMessage({type:'voice_udp',conn:'',data:'aGk='}),false);
  assert.equal(isValidRelayMessage({type:'voice_udp',conn:'a'.repeat(32),data:'x'.repeat(5000)}),false);
  const tunnel=new Tunnel();tunnel.voicePort=24454;
  tunnel._receiveUdp('a'.repeat(32),Buffer.from('hello'),true);
  assert.equal(tunnel.voiceSessions.size,0,'voice data without an assigned voice port is ignored');
});

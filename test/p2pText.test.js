'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeJoin, describeHost } = require('../src/renderer/p2pText');

const t = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

test('before and after joining it says nothing and shows Join, not Stop', () => {
  for (const s of [null, { state: 'idle' }, { state: 'stopped' }]) {
    assert.deepEqual(describeJoin(s, t), { text: '', tone: '', pill: '', address: '', running: false });
  }
});

test('while looking and connecting it says so, and offers Stop', () => {
  const a = describeJoin({ state: 'signaling' }, t);
  const b = describeJoin({ state: 'connecting' }, t);
  assert.match(a.text, /Looking for/);
  assert.match(b.text, /Connecting straight/);
  assert.equal(a.running && b.running, true);
  assert.equal(a.address + b.address, '');
});

test('a direct connection shows the local address to use in Minecraft', () => {
  const d = describeJoin({ state: 'p2p', path: 'direct', port: 25565 }, t);
  assert.equal(d.address, 'localhost:25565');
  assert.equal(d.pill, 'Direct');
  assert.equal(d.tone, 'ok');
  assert.match(d.text, /Lowest ping/);
  assert.match(describeJoin({ state: 'p2p', path: 'lan', port: 50001 }, t).text, /same network/);
  assert.equal(describeJoin({ state: 'p2p', path: 'direct', port: 50001 }, t).address, 'localhost:50001', 'another port when 25565 was taken');
});

test('through the relay it says why, still shows the address, and is a warning not an error', () => {
  const seen = new Set();
  for (const reason of ['timeout', 'failed', 'lost', 'stalled', '', undefined]) {
    const d = describeJoin({ state: 'relay', path: 'relay', port: 25565, reason }, t);
    assert.equal(d.address, 'localhost:25565');
    assert.equal(d.pill, 'Relay');
    assert.equal(d.tone, 'warn');
    assert.match(d.text, /relay/);
    seen.add(d.text);
  }
  assert.ok(seen.size >= 4, 'the reasons read differently');
});

test('a failure shows the relay\'s own words, offers Join again, and shows no address', () => {
  const d = describeJoin({ state: 'failed', message: "That code isn't active." }, t);
  assert.equal(d.text, "That code isn't active.");
  assert.equal(d.tone, 'err');
  assert.equal(d.running, false);
  assert.equal(d.address, '');
  assert.equal(describeJoin({ state: 'failed' }, t).text, 'Could not join.');
});

test('the host row only shows for a public server with join codes on', () => {
  assert.equal(describeHost(null, t).showRow, false);
  assert.equal(describeHost({ enabled: false, public: true, supported: true }, t).showRow, false);
  assert.equal(describeHost({ enabled: true, public: false, supported: true }, t).showRow, false);
  assert.equal(describeHost({ enabled: true, public: true, supported: false }, t).showRow, false);
  assert.equal(describeHost({ enabled: true, public: true, supported: true }, t).showRow, true);
});

test('the host sees the code, or that it is on its way, and who has connected', () => {
  const base = { enabled: true, public: true, supported: true };
  assert.deepEqual(describeHost({ ...base, code: '' }, t), { showRow: true, showOffer: false, code: '', line: 'Getting your code…' });
  assert.equal(describeHost({ ...base, code: 'K7M2Q-9XH4T', peers: 0 }, t).line, 'Nobody has joined with the code yet.');
  assert.equal(describeHost({ ...base, code: 'K7M2Q-9XH4T', peers: 1 }, t).line, '1 friend connected directly.');
  assert.equal(describeHost({ ...base, code: 'K7M2Q-9XH4T', peers: 3 }, t).line, '3 friends connected directly.');
  assert.equal(describeHost({ ...base, code: 'K7M2Q-9XH4T' }, t).code, 'K7M2Q-9XH4T');
});

test('a public server with join codes off is offered a button to turn them on', () => {
  assert.equal(describeHost({ enabled: false, public: true, supported: true }, t).showOffer, true);
  assert.equal(describeHost({ enabled: true, public: true, supported: true, code: 'K7M2Q-9XH4T' }, t).showOffer, false, 'already on');
  assert.equal(describeHost({ enabled: false, public: false, supported: true }, t).showOffer, false, 'not public yet');
  assert.equal(describeHost({ enabled: false, public: true, supported: false }, t).showOffer, false, 'a relay that does not support it');
  assert.equal(describeHost(null, t).showOffer, false);
});

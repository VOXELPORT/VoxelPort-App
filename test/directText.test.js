'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeDirect } = require('../src/renderer/directText');

// A stand-in for the screen's t(): fills {name} values in, like the real one.
const t = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

test('off and unknown states say nothing', () => {
  for (const s of [null, undefined, { state: 'off' }, { state: 'whatever' }]) {
    assert.deepEqual(describeDirect(s, t), { text: '', tone: '', retry: false });
  }
});

test('while working it says which step, and offers no retry', () => {
  assert.equal(describeDirect({ state: 'working', code: 'opening' }, t).text, 'Opening a port on your router…');
  assert.equal(describeDirect({ state: 'working', code: 'checking' }, t).text, 'Checking from the internet…');
  assert.equal(describeDirect({ state: 'working', code: 'opening' }, t).retry, false);
});

test('when on with a custom address it names that address', () => {
  const d = describeDirect({ state: 'on', code: 'ok', ip: '83.45.12.9', port: 25565, address: 'steve.voxelport.in' }, t);
  assert.equal(d.text, 'Direct is on: players who join steve.voxelport.in connect straight to your PC.');
  assert.equal(d.tone, 'ok');
});

test('when on without an address it shows the direct address to share', () => {
  const d = describeDirect({ state: 'on', code: 'ok', ip: '83.45.12.9', port: 25601, address: '' }, t);
  assert.equal(d.text, 'Direct is on. Players can also join straight at 83.45.12.9:25601.');
});

test('a pause says players are on the relay and that it comes back by itself', () => {
  const d = describeDirect({ state: 'fallback', code: 'fallback', detail: 'x' }, t);
  assert.match(d.text, /relay again/);
  assert.match(d.text, /by itself/);
  assert.equal(d.tone, 'warn');
});

test('CGNAT is explained and not offered as a retry, because trying again cannot help', () => {
  const d = describeDirect({ state: 'unsupported', code: 'cgnat' }, t);
  assert.match(d.text, /CGNAT/);
  assert.equal(d.retry, false);
  assert.equal(d.tone, 'info');
});

test('every failure has its own words, offers a retry, and always says players keep using the relay', () => {
  const seen = new Set();
  for (const code of ['no-router', 'refused', 'port-busy', 'timeout', 'lost', 'relay', 'something-new', '']) {
    const d = describeDirect({ state: 'failed', code }, t);
    assert.ok(d.text.length > 20, code);
    assert.match(d.text, /relay/i, code);
    assert.equal(d.retry, true, code);
    assert.equal(d.tone, 'err', code);
    assert.equal(/undefined|\{|\}/.test(d.text), false, `${code}: ${d.text}`);
    seen.add(d.text);
  }
  assert.ok(seen.size >= 7, 'the failures should not all read the same');
});

test('a failure from the relay shows the relay\'s own explanation', () => {
  const d = describeDirect({ state: 'failed', code: 'relay', detail: "Couldn't reach your server from the internet on port 25565 (nothing answered)." }, t);
  assert.match(d.text, /port 25565 \(nothing answered\)/);
  assert.match(d.text, /Players keep using the relay\.$/);
});

test('a router that needs UPnP switched on is told so', () => {
  assert.match(describeDirect({ state: 'failed', code: 'no-router' }, t).text, /UPnP/);
});

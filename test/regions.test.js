'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REGIONS, normalizePreference, measureRegion, pickRegion } = require('../src/main/regions');

const fixed = (ms) => async (region) => ms[region.id];

test('every region has relay URLs, a status URL and a public host', () => {
  for (const r of Object.values(REGIONS)) {
    assert.ok(r.relayUrls.length > 0 && r.relayUrls.every((u) => u.startsWith('wss://')));
    assert.ok(r.statusUrls.length > 0 && r.statusUrls.every((u) => u.startsWith('https://')));
    assert.match(r.publicHost, /\.voxelport\.in$/);
  }
});

test('unknown preferences fall back to auto', () => {
  assert.equal(normalizePreference('na'), 'na');
  assert.equal(normalizePreference('mars'), 'auto');
  assert.equal(normalizePreference(undefined), 'auto');
});

test('an explicit region wins, without measuring', async () => {
  const res = await pickRegion({ preference: 'na', nameRegion: 'in', measure: () => { throw new Error('measured'); } });
  assert.equal(res.region.id, 'na');
  assert.equal(res.reason, 'chosen');
});

test('auto stays on the region that owns the custom address', async () => {
  const res = await pickRegion({ preference: 'auto', nameRegion: 'in', measure: fixed({ in: 300, na: 20 }) });
  assert.equal(res.region.id, 'in');
  assert.equal(res.reason, 'address');
});

test('auto picks the lowest latency', async () => {
  const res = await pickRegion({ preference: 'auto', nameRegion: '', measure: fixed({ in: 280, na: 35 }) });
  assert.equal(res.region.id, 'na');
  assert.equal(res.reason, 'fastest');
  assert.deepEqual(res.latency, { in: 280, na: 35 });
});

test('auto skips an unreachable region', async () => {
  const res = await pickRegion({ preference: 'auto', measure: fixed({ in: Infinity, na: 240 }) });
  assert.equal(res.region.id, 'na');
  assert.deepEqual(res.latency, { na: 240 });
});

test('auto falls back to India when nothing can be measured', async () => {
  const res = await pickRegion({ preference: 'auto', measure: async () => { throw new Error('offline'); } });
  assert.equal(res.region.id, 'in');
  assert.equal(res.reason, 'fallback');
});

test('measureRegion uses the fallback status URL only when the first fails', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('direct')) throw new Error('blocked');
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const ms = await measureRegion(REGIONS.in, { fetchImpl, tries: 2 });
  assert.ok(Number.isFinite(ms));
  assert.equal(calls.filter((u) => u.includes('direct')).length, 1);
  assert.equal(calls.filter((u) => u.includes('relay.voxelport.in')).length, 2);
});

test('measureRegion is Infinity when the region is unreachable', async () => {
  const ms = await measureRegion(REGIONS.na, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(ms, Infinity);
});

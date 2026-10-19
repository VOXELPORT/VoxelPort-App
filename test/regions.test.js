'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REGIONS, DEFAULT_REGION, normalizePreference, measureRegion, pickRegion } = require('../src/main/regions');

// A two-region set, to exercise the multi-region selection logic even though
// the app currently ships a single region.
const TWO = {
  in: { id: 'in', label: 'India', relayUrls: ['wss://relay.voxelport.in'], statusUrls: ['https://relay.voxelport.in/api/status'], publicHost: 'play.voxelport.in' },
  na: { id: 'na', label: 'North America', relayUrls: ['wss://na.voxelport.in'], statusUrls: ['https://na.voxelport.in/api/status'], publicHost: 'play-na.voxelport.in' },
};
const fixed = (ms) => async (region) => ms[region.id];

test('every shipped region has relay URLs, a status URL and a public host', () => {
  assert.ok(Object.keys(REGIONS).length >= 1);
  for (const r of Object.values(REGIONS)) {
    assert.ok(r.relayUrls.length > 0 && r.relayUrls.every((u) => u.startsWith('wss://')));
    assert.ok(r.statusUrls.length > 0 && r.statusUrls.every((u) => u.startsWith('https://')));
    assert.match(r.publicHost, /\.voxelport\.in$/);
  }
  assert.ok(REGIONS[DEFAULT_REGION], 'the default region is shipped');
});

test('India and Europe ship (North America is not offered)', () => {
  assert.deepEqual(Object.keys(REGIONS), ['in', 'eu']);
  assert.equal(REGIONS.eu.label, 'Europe');
  assert.deepEqual(REGIONS.eu.relayUrls, ['wss://eu.voxelport.in']);
  assert.deepEqual(REGIONS.eu.statusUrls, ['https://eu.voxelport.in/api/status']);
  assert.equal(REGIONS.eu.publicHost, 'play-eu.voxelport.in');
});

test('preferences are auto plus the shipped regions; others fall back to auto', () => {
  assert.equal(normalizePreference('in'), 'in');
  assert.equal(normalizePreference('eu'), 'eu');
  assert.equal(normalizePreference('auto'), 'auto');
  assert.equal(normalizePreference('na'), 'auto'); // not shipped
  assert.equal(normalizePreference('mars'), 'auto');
  assert.equal(normalizePreference(undefined), 'auto');
});

test('a single region is used without measuring', async () => {
  const res = await pickRegion({ preference: 'auto', regions: { in: REGIONS.in }, measure: () => { throw new Error('measured'); } });
  assert.equal(res.region.id, 'in');
  assert.equal(res.reason, 'only');
});

test('shipped regions: a player near India stays on India, one near Europe gets Europe', async () => {
  const india = await pickRegion({ preference: 'auto', measure: fixed({ in: 18, eu: 160 }) });
  assert.equal(india.region.id, 'in');
  const europe = await pickRegion({ preference: 'auto', measure: fixed({ in: 150, eu: 22 }) });
  assert.equal(europe.region.id, 'eu');
  assert.equal(europe.reason, 'fastest');
});

test('shipped regions: a custom address (India only) keeps the tunnel on India, even from Europe', async () => {
  const res = await pickRegion({ preference: 'auto', nameRegion: 'in', measure: fixed({ in: 150, eu: 22 }) });
  assert.equal(res.region.id, 'in');
  assert.equal(res.reason, 'address');
});

test('shipped regions: Europe being down falls back to India', async () => {
  const res = await pickRegion({ preference: 'auto', measure: fixed({ in: 30, eu: Infinity }) });
  assert.equal(res.region.id, 'in');
});

test('choosing Europe explicitly uses it even when India is faster', async () => {
  const res = await pickRegion({ preference: 'eu', measure: () => { throw new Error('measured'); } });
  assert.equal(res.region.id, 'eu');
  assert.equal(res.reason, 'chosen');
});

test('an explicit region wins, without measuring', async () => {
  const res = await pickRegion({ preference: 'na', nameRegion: 'in', regions: TWO, measure: () => { throw new Error('measured'); } });
  assert.equal(res.region.id, 'na');
  assert.equal(res.reason, 'chosen');
});

test('auto stays on the region that owns the custom address', async () => {
  const res = await pickRegion({ preference: 'auto', nameRegion: 'in', regions: TWO, measure: fixed({ in: 300, na: 20 }) });
  assert.equal(res.region.id, 'in');
  assert.equal(res.reason, 'address');
});

test('auto picks the lowest latency', async () => {
  const res = await pickRegion({ preference: 'auto', nameRegion: '', regions: TWO, measure: fixed({ in: 280, na: 35 }) });
  assert.equal(res.region.id, 'na');
  assert.equal(res.reason, 'fastest');
  assert.deepEqual(res.latency, { in: 280, na: 35 });
});

test('auto skips an unreachable region', async () => {
  const res = await pickRegion({ preference: 'auto', regions: TWO, measure: fixed({ in: Infinity, na: 240 }) });
  assert.equal(res.region.id, 'na');
  assert.deepEqual(res.latency, { na: 240 });
});

test('auto falls back to India when nothing can be measured', async () => {
  const res = await pickRegion({ preference: 'auto', regions: TWO, measure: async () => { throw new Error('offline'); } });
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
  const ms = await measureRegion(REGIONS.in, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(ms, Infinity);
});

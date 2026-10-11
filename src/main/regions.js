'use strict';

// VoxelPort relay regions. Each region is its own relay: a public port (and a
// custom address) belongs to the region it was handed out by.
//
// relayUrls are tried in order (see Tunnel.start). India is reached directly
// first, then through Cloudflare if the direct port is blocked.
const REGIONS = {
  in: {
    id: 'in',
    label: 'India',
    relayUrls: ['wss://direct.voxelport.in:26499', 'wss://relay.voxelport.in'],
    statusUrls: ['https://direct.voxelport.in:26499/api/status', 'https://relay.voxelport.in/api/status'],
    publicHost: 'play.voxelport.in',
  },
  na: {
    id: 'na',
    label: 'North America',
    relayUrls: ['wss://na.voxelport.in'],
    statusUrls: ['https://na.voxelport.in/api/status'],
    publicHost: 'play-na.voxelport.in',
  },
};
const DEFAULT_REGION = 'in';
const PREFERENCES = ['auto', ...Object.keys(REGIONS)];

function isRegion(id) {
  return Object.prototype.hasOwnProperty.call(REGIONS, id);
}

function normalizePreference(p) {
  return PREFERENCES.includes(p) ? p : 'auto';
}

/**
 * Round-trip time to one region in ms: the best of a few small requests to
 * its status endpoint (the first pays for DNS + TLS, later ones reuse the
 * connection and show the real latency). Infinity if it can't be reached.
 */
async function measureRegion(region, { fetchImpl = fetch, tries = 3, timeoutMs = 4000 } = {}) {
  let best = Infinity;
  for (const url of region.statusUrls) {
    for (let i = 0; i < tries; i++) {
      const t0 = Date.now();
      try {
        const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
        await res.arrayBuffer();
        if (res.ok) best = Math.min(best, Date.now() - t0);
      } catch {
        break; // unreachable this way: don't wait on more timeouts
      }
    }
    if (best < Infinity) break; // the preferred route works; skip the fallback
  }
  return best;
}

/**
 * Which region a tunnel should use.
 *  - an explicit preference wins;
 *  - on "auto", a custom address pins the tunnel to the region that owns it
 *    (it only exists there);
 *  - otherwise the region with the lowest measured latency, India if none
 *    can be measured.
 * Returns { region, reason, latency }.
 */
async function pickRegion({ preference, nameRegion, measure = measureRegion }) {
  const pref = normalizePreference(preference);
  if (pref !== 'auto') return { region: REGIONS[pref], reason: 'chosen', latency: {} };
  if (isRegion(nameRegion)) return { region: REGIONS[nameRegion], reason: 'address', latency: {} };

  const ids = Object.keys(REGIONS);
  const times = await Promise.all(ids.map((id) => measure(REGIONS[id]).catch(() => Infinity)));
  const latency = {};
  let bestId = DEFAULT_REGION;
  let bestMs = Infinity;
  ids.forEach((id, i) => {
    if (Number.isFinite(times[i])) latency[id] = times[i];
    if (times[i] < bestMs) { bestMs = times[i]; bestId = id; }
  });
  return { region: REGIONS[bestId], reason: Number.isFinite(bestMs) ? 'fastest' : 'fallback', latency };
}

module.exports = { REGIONS, DEFAULT_REGION, PREFERENCES, isRegion, normalizePreference, measureRegion, pickRegion };

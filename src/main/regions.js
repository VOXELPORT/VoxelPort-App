'use strict';

// VoxelPort relay regions. Each region is its own relay: a public port (and a
// custom address) belongs to the region it was handed out by.
//
// relayUrls are tried in order (see Tunnel.start). India is reached directly
// first, then through Cloudflare if the direct port is blocked.
//
// The app ships India and Europe. Adding another region is one entry below
// (nothing else needs to change). The Europe relay serves wss straight on
// :443 with a Let's Encrypt certificate (no Cloudflare in front), so it has a
// single relay URL.
//
// Custom addresses (supporters) are created through Cloudflare DNS, which only
// the India relay is set up for; the Europe relay answers a claim with an
// error, and the app keeps an address on the region that owns it.
const REGIONS = {
  in: {
    id: 'in',
    label: 'India',
    relayUrls: ['wss://direct.voxelport.in:26499', 'wss://relay.voxelport.in'],
    statusUrls: ['https://direct.voxelport.in:26499/api/status', 'https://relay.voxelport.in/api/status'],
    publicHost: 'play.voxelport.in',
  },
  eu: {
    id: 'eu',
    label: 'Europe',
    relayUrls: ['wss://eu.voxelport.in'],
    statusUrls: ['https://eu.voxelport.in/api/status'],
    publicHost: 'play-eu.voxelport.in',
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
// `regions` defaults to the shipped set; tests pass their own to exercise the
// multi-region path even when the app ships a single region.
async function pickRegion({ preference, nameRegion, measure = measureRegion, regions = REGIONS }) {
  const pref = preference === 'auto' || regions[preference] ? preference : 'auto';
  if (pref !== 'auto') return { region: regions[pref], reason: 'chosen', latency: {} };
  if (regions[nameRegion]) return { region: regions[nameRegion], reason: 'address', latency: {} };

  const ids = Object.keys(regions);
  // One region: no point measuring — just use it.
  if (ids.length === 1) return { region: regions[ids[0]], reason: 'only', latency: {} };
  const times = await Promise.all(ids.map((id) => measure(regions[id]).catch(() => Infinity)));
  const latency = {};
  let bestId = regions[DEFAULT_REGION] ? DEFAULT_REGION : ids[0];
  let bestMs = Infinity;
  ids.forEach((id, i) => {
    if (Number.isFinite(times[i])) latency[id] = times[i];
    if (times[i] < bestMs) { bestMs = times[i]; bestId = id; }
  });
  return { region: regions[bestId], reason: Number.isFinite(bestMs) ? 'fastest' : 'fallback', latency };
}

module.exports = { REGIONS, DEFAULT_REGION, PREFERENCES, isRegion, normalizePreference, measureRegion, pickRegion };

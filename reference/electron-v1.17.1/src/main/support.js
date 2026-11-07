'use strict';

// The "Support VoxelPort" screen: tipping, supporter perks, and paid-hosting suggestions.
//
// The donation target (UPI ID, GitHub Sponsors) is fixed in this file, so a changed website can
// never redirect anyone's tip. The wording, supporter perks and hosting links come from
// https://voxelport.in/support.json (so they can change without an app update); everything read
// from it is validated here, and hosting links are only ever opened by id from the validated list,
// never from a URL the renderer supplies.

const fs = require('node:fs');
const path = require('node:path');

const SUPPORT_URL = 'https://voxelport.in/support.json';
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_HOSTS = 6;
const MAX_TIERS = 4;
const MAX_PERKS = 8;

const DONATE = Object.freeze({
  upiId: 'trazhub@upi',
  upiLink: 'upi://pay?pa=trazhub@upi&pn=VoxelPort&cu=INR&tn=Support%20VoxelPort',
  sponsorsUrl: 'https://github.com/sponsors/trazhub',
  pageUrl: 'https://voxelport.in/#support',
  perksUrl: 'https://voxelport.in/#supporters',
});

const CONTACT_DEFAULT = 'traz@voxelport.in';

// What shows when voxelport.in can't be reached and nothing is cached.
const DEFAULT_SUPPORTER = Object.freeze({
  intro: 'VoxelPort stays free for everyone. If you want to chip in, supporters get a few extras as a thank-you.',
  tiers: [
    { name: 'Supporter', inr: 99, perks: ['★ Supporter badge on the server list, and your server pinned to the top', 'Your custom address never expires from disuse'] },
    { name: 'Supporter+', inr: 299, perks: ['Everything in Supporter', 'A short address of 1–2 characters, like vp.voxelport.in'] },
  ],
  how: `Tip by UPI, then email ${CONTACT_DEFAULT} with your UPI reference number and your server's address. It's switched on by hand, usually within a day or two.`,
  fine: 'Perks are a thank-you for a donation, not a purchase, and last as long as VoxelPort runs.',
});

const DEFAULT_DISCLOSURE = 'Some of these are affiliate links: VoxelPort may earn a commission if you sign up, at no extra cost to you. VoxelPort itself stays free either way.';

/** Plain text: control characters and angle brackets removed, whitespace collapsed, cut to max. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/** A hosting link is https to a real domain: no credentials, no port, no IP address, no localhost. */
function isSafeHostUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return false; // IPv4 / IPv6 literal
  return true;
}

/** The hosting suggestions for one app ('desktop' or 'android'). Empty items means "show nothing". */
function sanitizeHosts(raw, device) {
  const empty = { intro: '', disclosure: '', items: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const items = [];
  const seen = new Set();
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    if (items.length >= MAX_HOSTS || !it || typeof it !== 'object') continue;
    const id = typeof it.id === 'string' ? it.id : '';
    if (!/^[a-z0-9-]{1,32}$/.test(id) || seen.has(id)) continue;
    const name = cleanText(it.name, 40);
    if (!name || !isSafeHostUrl(it.url)) continue;
    if (Array.isArray(it.for) && !it.for.includes(device)) continue;
    seen.add(id);
    items.push({ id, name, blurb: cleanText(it.blurb, 140), url: it.url, affiliate: it.affiliate === true });
  }
  if (!items.length) return empty;
  const intro = raw.intro && typeof raw.intro === 'object' ? cleanText(raw.intro[device], 220) : cleanText(raw.intro, 220);
  const disclosure = cleanText(raw.disclosure, 300) || DEFAULT_DISCLOSURE;
  return { intro, disclosure, items };
}

function sanitizeSupporter(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_SUPPORTER;
  const tiers = [];
  for (const t of Array.isArray(raw.tiers) ? raw.tiers.slice(0, MAX_TIERS) : []) {
    if (!t || typeof t !== 'object') continue;
    const name = cleanText(t.name, 30);
    const inr = Number.isFinite(t.inr) && t.inr > 0 && t.inr < 1e6 ? Math.round(t.inr) : 0;
    const perks = (Array.isArray(t.perks) ? t.perks : []).slice(0, MAX_PERKS).map((p) => cleanText(p, 200)).filter(Boolean);
    if (name && inr && perks.length) tiers.push({ name, inr, perks });
  }
  if (!tiers.length) return DEFAULT_SUPPORTER;
  return {
    intro: cleanText(raw.intro, 300) || DEFAULT_SUPPORTER.intro,
    tiers,
    how: cleanText(raw.how, 400) || DEFAULT_SUPPORTER.how,
    fine: cleanText(raw.fine, 300) || DEFAULT_SUPPORTER.fine,
  };
}

/** Everything the Support screen shows, from whatever support.json said (or nothing). */
function buildSupport(remote, device) {
  const r = remote && typeof remote === 'object' ? remote : {};
  return {
    donate: { ...DONATE },
    contact: CONTACT_DEFAULT,
    supporter: sanitizeSupporter(r.supporter),
    hosts: sanitizeHosts(r.hosts, device),
  };
}

function readCache(file) {
  try {
    const stat = fs.statSync(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { data, at: stat.mtimeMs };
  } catch { return null; }
}

/**
 * support.json from voxelport.in, cached in [dir] for 12 hours; falls back to the last good copy,
 * then to the built-in defaults. Never throws.
 */
async function loadRemote({ dir, fetchImpl = fetch, now = Date.now(), force = false }) {
  const file = path.join(dir, 'support-cache.json');
  const cached = readCache(file);
  if (cached && !force && now - cached.at < CACHE_MAX_AGE_MS) return cached.data;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let text;
    try {
      const res = await fetchImpl(SUPPORT_URL, { signal: ctl.signal, headers: { accept: 'application/json' }, redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } finally { clearTimeout(timer); }
    if (text.length > MAX_JSON_BYTES) throw new Error('too large');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || data.version !== 1) throw new Error('unexpected format');
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, text); } catch { /* cache is optional */ }
    return data;
  } catch {
    return cached ? cached.data : null;
  }
}

async function getSupport({ dir, device = 'desktop', fetchImpl, now, force }) {
  return buildSupport(await loadRemote({ dir, fetchImpl, now, force }), device);
}

module.exports = {
  SUPPORT_URL, DONATE, DEFAULT_SUPPORTER, DEFAULT_DISCLOSURE,
  cleanText, isSafeHostUrl, sanitizeHosts, sanitizeSupporter, buildSupport, loadRemote, getSupport,
};

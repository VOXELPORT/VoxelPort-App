'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const support = require('../src/main/support');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vp-support-'));
const host = (over = {}) => ({ id: 'good-host', name: 'Good Host', blurb: 'For small groups.', url: 'https://example.com/?ref=vp', affiliate: true, ...over });

test('only https links to real domains are accepted for hosting suggestions', () => {
  for (const ok of ['https://example.com/', 'https://www.host.co.in/minecraft?ref=abc', 'https://a.b.example.org/x#y']) {
    assert.equal(support.isSafeHostUrl(ok), true, ok);
  }
  for (const bad of [
    'http://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.com/',
    'https://user:pw@example.com/', 'https://example.com:8443/', 'https://localhost/', 'https://127.0.0.1/', 'https://10.0.0.5/',
    'https://[::1]/', 'https://printer.local/', 'https://intranet/', 'not a url', '', null, undefined, 42,
    'https://example.com/' + 'a'.repeat(600),
  ]) assert.equal(support.isSafeHostUrl(bad), false, String(bad));
});

test('hosting suggestions are filtered per device, cleaned and capped', () => {
  const raw = {
    intro: { desktop: 'PC intro', android: 'Phone intro' },
    disclosure: 'Affiliate links.',
    items: [
      host(),
      host({ id: 'pc-only', name: 'PC <b>Only</b>', for: ['desktop'] }),
      host({ id: 'phone-only', name: 'Phone Only', for: ['android'] }),
      host({ id: 'good-host', name: 'Duplicate id' }),        // repeated id: dropped
      host({ id: 'Bad Id!', name: 'Bad id' }),                // invalid id: dropped
      host({ id: 'no-name', name: '   ' }),                   // nothing to show: dropped
      host({ id: 'http-link', url: 'http://example.com/' }),  // not https: dropped
      host({ id: 'evil', url: 'javascript:alert(1)' }),       // dropped
    ],
  };
  const desktop = support.sanitizeHosts(raw, 'desktop');
  assert.deepEqual(desktop.items.map((h) => h.id), ['good-host', 'pc-only']);
  assert.doesNotMatch(desktop.items[1].name, /[<>]/, 'markup characters are stripped from names');
  assert.equal(desktop.intro, 'PC intro');
  assert.equal(desktop.disclosure, 'Affiliate links.');
  const phone = support.sanitizeHosts(raw, 'android');
  assert.deepEqual(phone.items.map((h) => h.id), ['good-host', 'phone-only']);
  assert.equal(phone.intro, 'Phone intro');

  const many = { items: Array.from({ length: 20 }, (_, i) => host({ id: `h${i}`, name: `Host ${i}` })) };
  assert.equal(support.sanitizeHosts(many, 'desktop').items.length, 6);
});

test('with nothing valid the hosting section is empty, and affiliate links always come with a disclosure', () => {
  for (const raw of [null, undefined, {}, { items: [] }, { items: [{ id: 'x', name: 'x', url: 'http://x.com' }] }, 'junk', []]) {
    assert.deepEqual(support.sanitizeHosts(raw, 'desktop'), { intro: '', disclosure: '', items: [] });
  }
  const h = support.sanitizeHosts({ items: [host()] }, 'desktop'); // no disclosure supplied
  assert.equal(h.disclosure, support.DEFAULT_DISCLOSURE);
  assert.match(h.disclosure, /affiliate/i);
});

test('supporter tiers are validated and fall back to the built-in text', () => {
  assert.equal(support.sanitizeSupporter(null), support.DEFAULT_SUPPORTER);
  assert.equal(support.sanitizeSupporter({ tiers: [{ name: 'Free', inr: 0, perks: ['x'] }] }), support.DEFAULT_SUPPORTER);
  const s = support.sanitizeSupporter({
    intro: 'Hi', how: 'Email us.',
    tiers: [{ name: 'Supporter', inr: 99.4, perks: ['One', '', 'Two'] }, { name: 'Bad', inr: -5, perks: ['x'] }, null],
  });
  assert.equal(s.tiers.length, 1);
  assert.deepEqual(s.tiers[0], { name: 'Supporter', inr: 99, perks: ['One', 'Two'] });
  assert.equal(s.how, 'Email us.');
});

test('the donation target is fixed in the app, whatever the website says', () => {
  const built = support.buildSupport({ donate: { upiId: 'attacker@upi', upiLink: 'upi://pay?pa=attacker@upi' }, hosts: { items: [host()] } }, 'desktop');
  assert.equal(built.donate.upiId, 'trazhub@upi');
  assert.match(built.donate.upiLink, /^upi:\/\/pay\?pa=trazhub@upi&/);
  assert.equal(built.donate.sponsorsUrl, 'https://github.com/sponsors/trazhub');
  assert.equal(built.hosts.items.length, 1);
});

test('support.json is fetched once, cached for 12 hours, and a stale copy is used when offline', async () => {
  const dir = tmp();
  const payload = { version: 1, supporter: { tiers: [{ name: 'Supporter', inr: 99, perks: ['Badge'] }] }, hosts: { items: [host()] } };
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify(payload) }; };
  const down = async () => { calls++; throw new Error('offline'); };

  let s = await support.getSupport({ dir, fetchImpl: ok, now: Date.now() });
  assert.equal(calls, 1);
  assert.equal(s.hosts.items[0].id, 'good-host');
  s = await support.getSupport({ dir, fetchImpl: down, now: Date.now() + 60_000 });
  assert.equal(calls, 1, 'fresh cache: no new request');
  s = await support.getSupport({ dir, fetchImpl: down, now: Date.now() + 13 * 3600 * 1000 });
  assert.equal(calls, 2, 'stale cache: tried again');
  assert.equal(s.hosts.items[0].id, 'good-host', 'but kept the last good copy when the request failed');

  const fresh = await support.getSupport({ dir: tmp(), fetchImpl: down });
  assert.equal(fresh.hosts.items.length, 0);
  assert.equal(fresh.supporter, support.DEFAULT_SUPPORTER);
  assert.equal(fresh.donate.upiId, 'trazhub@upi');
});

test('a bad or oversized support.json is ignored', async () => {
  for (const body of ['not json', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, pad: 'x'.repeat(70_000) }), '[]']) {
    const dir = tmp();
    const s = await support.getSupport({ dir, fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }) });
    assert.equal(s.hosts.items.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'support-cache.json')), false, 'nothing bad is cached');
  }
  const notOk = await support.getSupport({ dir: tmp(), fetchImpl: async () => ({ ok: false, status: 503, text: async () => '{}' }) });
  assert.equal(notOk.hosts.items.length, 0);
});

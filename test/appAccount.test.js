'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { createAppAccount } = require('../src/main/appAccount');

const DEVICE = 'vp_appaccounttest_1234567890';
// Stand-in for Electron's safeStorage: reversible, and visibly not plaintext.
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`), decryptString: (b) => [...b.toString().slice(4)].reverse().join('') };

function get(url) { return new Promise((resolve) => http.get(url, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve(0)).setTimeout(2000, function () { this.destroy(); })); }
const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });

async function fakeAccounts(over = {}) {
  const log = { exchange: [], signouts: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/app/exchange') { const b = JSON.parse(body); log.exchange.push(b); return send(over.exchangeStatus || 200, over.exchange || { session: 'session-token-abcdefghijklmnopqrstuvwxyz0123456789', member: true, reason: null, discordName: 'Player', plan: { id: 'free', name: 'Free' }, rank: 'free', graceUntil: null, serverNow: 5000, inviteUrl: 'https://discord.gg/x' }); }
      if (req.url === '/api/app/status') return req.headers.authorization === 'Bearer session-token-abcdefghijklmnopqrstuvwxyz0123456789' && !over.reject ? send(200, { member: true, reason: null, discordName: 'Player', plan: { id: 'plus', name: 'Plus' }, rank: 'supporter_plus', graceUntil: null, serverNow: 9000 }) : send(401, { error: 'Sign in again.' });
      if (req.url === '/api/app/config') return send(200, { graceUntil: 123456, serverNow: 7000, inviteUrl: 'https://discord.gg/x' });
      if (req.url === '/api/app/signout') { log.signouts++; return send(200, { ok: true }); }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { log, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

// The browser: opens the sign-in URL, then follows the redirect back to the app's loopback port.
const browser = (steps) => async (url) => {
  const u = new URL(url);
  assert.equal(u.pathname, '/api/auth/discord/start');
  assert.equal(u.searchParams.get('app'), '1');
  assert.match(u.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/);
  const port = u.searchParams.get('port');
  setImmediate(async () => { for (const step of steps) await get(`http://127.0.0.1:${port}${step}`); });
};

function make(accounts, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-appaccount-'));
  const opened = [];
  const account = createAppAccount({ baseUrl: accounts.baseUrl, userDataDir: dir, safeStorage, deviceToken: DEVICE, now: () => 1000, signInTimeoutMs: 5000,
    openExternal: async (url) => { opened.push(url); return (over.browser || browser(['/?code=' + 'c'.repeat(43)]))(url); }, ...over.account });
  return { account, dir, opened, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('sign-in completes, saves an encrypted session, and never writes either secret in plain text', async () => {
  const accounts = await fakeAccounts();
  const { account, dir, done } = make(accounts);
  try {
    const result = await account.signIn();
    assert.deepEqual([result.ok, result.member, result.discordName], [true, true, 'Player']);
    assert.equal(accounts.log.exchange[0].deviceToken, DEVICE);
    assert.equal(accounts.log.exchange[0].code, 'c'.repeat(43));
    assert.match(accounts.log.exchange[0].verifier, /^[A-Za-z0-9_-]{43}$/);
    const saved = fs.readFileSync(path.join(dir, 'app-session.json'), 'utf8');
    assert.ok(!saved.includes('session-token') && !saved.includes(DEVICE));
    const snap = account.snapshot();
    assert.deepEqual([snap.session, snap.status.member, snap.lastGood.member], [true, true, true]);
  } finally { done(); await accounts.close(); }
});

test('a second sign-in click while one is open reuses it: one listener, one browser tab', async () => {
  const accounts = await fakeAccounts();
  const { account, opened, done } = make(accounts);
  try {
    const [a, b] = await Promise.all([account.signIn(), account.signIn()]);
    assert.equal(opened.length, 1);
    assert.deepEqual([a.ok, b.ok], [true, true]);
  } finally { done(); await accounts.close(); }
});

test('no callback times out, cancel stops it, and the loopback port is closed afterwards', async () => {
  const accounts = await fakeAccounts();
  let port;
  const watching = async (url) => { port = Number(new URL(url).searchParams.get('port')); };
  const { account, done } = make(accounts, { browser: watching, account: { signInTimeoutMs: 300 } });
  try {
    assert.deepEqual(await account.signIn(), { ok: false, error: 'timeout' });
    assert.equal(await portOpen(port), false);
    const pending = account.signIn();
    await new Promise((r) => setTimeout(r, 30));
    account.cancelSignIn();
    assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
    assert.equal(await portOpen(port), false);
  } finally { done(); await accounts.close(); }
});

test('stray requests to the loopback port are ignored until the real code arrives', async () => {
  const accounts = await fakeAccounts();
  const { account, done } = make(accounts, { browser: browser(['/favicon.ico', '/?code=', '/?code=short', '/other?code=' + 'c'.repeat(43), '/?code=' + 'd'.repeat(43)]) });
  try {
    const result = await account.signIn();
    assert.equal(result.ok, true);
    assert.equal(accounts.log.exchange.length, 1);
    assert.equal(accounts.log.exchange[0].code, 'd'.repeat(43));
  } finally { done(); await accounts.close(); }
});

test('a non-member and a link problem are passed through without failing the sign-in', async () => {
  const accounts = await fakeAccounts({ exchange: { session: 'session-token-abcdefghijklmnopqrstuvwxyz0123456789', member: false, reason: 'not_in_server', discordName: 'Player', linkError: 'That VoxelPort ID is already linked to an account.', graceUntil: null, serverNow: 5000, inviteUrl: 'https://discord.gg/x' } });
  const { account, done } = make(accounts);
  try {
    const r = await account.signIn();
    assert.deepEqual([r.ok, r.member, r.reason, r.linkError], [true, false, 'not_in_server', 'That VoxelPort ID is already linked to an account.']);
    assert.deepEqual([account.snapshot().status.member, account.snapshot().lastGood.member], [false, false]);
  } finally { done(); await accounts.close(); }
});

test('a refused exchange reports the problem and saves no session', async () => {
  const accounts = await fakeAccounts({ exchangeStatus: 400, exchange: { error: 'Sign-in expired. Please try again.' } });
  const { account, dir, done } = make(accounts);
  try {
    const r = await account.signIn();
    assert.deepEqual([r.ok, r.error], [false, 'Sign-in expired. Please try again.']);
    assert.equal(fs.existsSync(path.join(dir, 'app-session.json')), false);
  } finally { done(); await accounts.close(); }
});

test('status refresh keeps the last good answer, and maps a rejected session and an outage', async () => {
  const accounts = await fakeAccounts();
  const { account, dir, done } = make(accounts);
  try {
    await account.signIn();
    const ok = await account.refreshStatus();
    assert.deepEqual([ok.statusError, account.snapshot().status.member], [null, true]);
    // A new run of the app loads the saved session from disk.
    const again = createAppAccount({ baseUrl: accounts.baseUrl, userDataDir: dir, safeStorage, deviceToken: DEVICE, now: () => 2000, openExternal: async () => {} });
    assert.equal(again.snapshot().session, true);
    assert.equal(again.snapshot().lastGood.member, true);
    await accounts.close();
    assert.equal((await again.refreshStatus()).statusError, 'unreachable');
    assert.equal(again.snapshot().lastGood.member, true);
  } finally { done(); }
});

test('a rejected session is reported as unauthorized and keeps the saved file for a clean re-sign-in', async () => {
  const accounts = await fakeAccounts({ reject: true });
  const { account, done } = make(accounts);
  try {
    await account.signIn();
    assert.equal((await account.refreshStatus()).statusError, 'unauthorized');
    assert.equal(account.snapshot().statusError, 'unauthorized');
  } finally { done(); await accounts.close(); }
});

test('config is readable without a session, and sign-out clears the session', async () => {
  const accounts = await fakeAccounts();
  const { account, dir, done } = make(accounts);
  try {
    assert.deepEqual(await account.refreshConfig(), { graceUntil: 123456, serverNow: 7000, at: 1000, inviteUrl: 'https://discord.gg/x' });
    assert.equal(account.snapshot().session, false);
    await account.signIn();
    await account.signOut();
    assert.equal(accounts.log.signouts, 1);
    assert.equal(fs.existsSync(path.join(dir, 'app-session.json')), false);
    assert.equal(account.snapshot().session, false);
  } finally { done(); await accounts.close(); }
});

test('the browser returning with an error ends the sign-in at once and closes the port', async () => {
  const accounts = await fakeAccounts();
  let port;
  const failing = async (url) => { port = Number(new URL(url).searchParams.get('port')); setImmediate(() => get(`http://127.0.0.1:${port}/?error=signin_failed`)); };
  const { account, done } = make(accounts, { browser: failing, account: { signInTimeoutMs: 5000 } });
  try {
    const started = Date.now();
    assert.deepEqual(await account.signIn(), { ok: false, error: 'signin_failed' });
    assert.ok(Date.now() - started < 2000, 'did not wait for the timeout');
    assert.equal(accounts.log.exchange.length, 0);
    assert.equal(await portOpen(port), false);
  } finally { done(); await accounts.close(); }
});

test('a first-time Discord user gets ten minutes to finish signing in', () => {
  assert.equal(require('../src/main/appAccount').DEFAULT_SIGN_IN_TIMEOUT_MS, 10 * 60 * 1000);
});

test('the plan and rank from the server are kept, refreshed and remembered across runs', async () => {
  const accounts = await fakeAccounts();
  const { account, dir, done } = make(accounts);
  try {
    assert.equal(account.snapshot().standing, null);
    await account.signIn();
    assert.deepEqual(account.snapshot().standing, { plan: { id: 'free', name: 'Free' }, rank: 'free' });
    await account.refreshStatus();
    assert.deepEqual(account.snapshot().standing, { plan: { id: 'plus', name: 'Plus' }, rank: 'supporter_plus' });
    const again = createAppAccount({ baseUrl: accounts.baseUrl, userDataDir: dir, safeStorage, deviceToken: DEVICE, now: () => 2000, openExternal: async () => {} });
    assert.deepEqual(again.snapshot().standing, { plan: { id: 'plus', name: 'Plus' }, rank: 'supporter_plus' });
    await again.signOut();
    assert.equal(again.snapshot().standing, null);
  } finally { done(); await accounts.close(); }
});

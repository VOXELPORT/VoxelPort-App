'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppAccount } = require('../src/main/appAccount');
const backup = require('../src/main/identityBackup');

const DEVICE = 'vp_appaccountbackup_1234567890';
const OTHER = 'vp_someotherdevicetoken_0987654321';
const PASS = 'correct horse battery staple';
const SESSION = 'session-token-abcdefghijklmnopqrstuvwxyz0123456789';

// An account module that is already signed in, talking to a scripted accounts service.
function make(handler, { signedIn = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-backup-'));
  if (signedIn) fs.writeFileSync(path.join(dir, 'app-session.json'), JSON.stringify({ session: SESSION, lastGood: { member: true, at: 1 }, discordName: 'Player' }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const call = { method: init.method, path: u.pathname, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const out = await handler(call);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.json || {} };
  };
  const account = createAppAccount({ baseUrl: 'https://accounts.test', userDataDir: dir, safeStorage: null, openExternal: async () => {}, deviceToken: DEVICE, fetchImpl, now: () => 1000 });
  return { account, calls, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A tiny fake of the service's /api/app/identity: it keeps one blob.
function store() {
  const s = { row: null };
  s.handler = (call) => {
    if (call.path !== '/api/app/identity') return { status: 404 };
    if (call.auth !== `Bearer ${SESSION}`) return { status: 401, json: { error: 'Sign in again.' } };
    if (call.method === 'PUT') { s.row = { vpId: call.body.vpId, blob: call.body.blob, updatedAt: 5000 }; return { status: 200, json: { ok: true, vpId: call.body.vpId, updatedAt: 5000 } }; }
    if (call.method === 'GET') return s.row ? { status: 200, json: s.row } : { status: 404, json: { error: 'There is no address backup for this account.' } };
    if (call.method === 'DELETE') { s.row = null; return { status: 200, json: { ok: true } }; }
    return { status: 405 };
  };
  return s;
}

test('save sends only the encrypted blob, filed under this address, and the snapshot then shows it', async () => {
  const svc = store();
  const { account, calls, done } = make(svc.handler);
  try {
    assert.deepEqual(await account.saveBackup(PASS), { ok: true });
    const put = calls.find((c) => c.method === 'PUT');
    assert.equal(put.body.vpId, backup.shortId(DEVICE));
    assert.equal(put.auth, `Bearer ${SESSION}`);
    assert.ok(!JSON.stringify(put.body).includes(DEVICE) && !JSON.stringify(put.body).includes(PASS));
    assert.equal(backup.decrypt(put.body.blob, PASS, put.body.vpId), DEVICE);
    assert.deepEqual(account.snapshot().identityBackup, { vpId: backup.shortId(DEVICE), updatedAt: 5000 });
  } finally { done(); }
});

test('a weak passphrase is refused before anything is sent', async () => {
  const { account, calls, done } = make(store().handler);
  try {
    assert.deepEqual(await account.saveBackup('short'), { ok: false, error: 'too_short' });
    assert.deepEqual(await account.saveBackup('aaaaaaaaaaaaaaaa'), { ok: false, error: 'too_simple' });
    assert.equal(calls.length, 0);
  } finally { done(); }
});

test('restore returns the token that was backed up, e.g. from another device', async () => {
  const svc = store();
  svc.row = { vpId: backup.shortId(OTHER), blob: backup.encrypt(OTHER, PASS, { iterations: 200000 }), updatedAt: 7000 };
  const { account, done } = make(svc.handler);
  try {
    assert.deepEqual(await account.restoreBackup(PASS), { ok: true, token: OTHER });
    assert.deepEqual(account.snapshot().identityBackup, { vpId: backup.shortId(OTHER), updatedAt: 7000 });
  } finally { done(); }
});

test('a wrong passphrase is its own answer and returns no token', async () => {
  const svc = store();
  svc.row = { vpId: backup.shortId(OTHER), blob: backup.encrypt(OTHER, PASS, { iterations: 200000 }), updatedAt: 7000 };
  const { account, done } = make(svc.handler);
  try {
    assert.deepEqual(await account.restoreBackup('not the passphrase'), { ok: false, error: 'wrong_passphrase' });
  } finally { done(); }
});

test('a backup filed under another address than its contents does not restore', async () => {
  const svc = store();
  svc.row = { vpId: '000000000000', blob: backup.encrypt(OTHER, PASS, { iterations: 200000 }), updatedAt: 7000 };
  const { account, done } = make(svc.handler);
  try {
    assert.deepEqual(await account.restoreBackup(PASS), { ok: false, error: 'wrong_passphrase' });
  } finally { done(); }
});

test('no backup on the account answers not_found and clears what was shown', async () => {
  const { account, done } = make(store().handler);
  try {
    assert.deepEqual(await account.restoreBackup(PASS), { ok: false, error: 'not_found' });
    assert.equal(account.snapshot().identityBackup, null);
  } finally { done(); }
});

test('delete removes it', async () => {
  const svc = store();
  const { account, done } = make(svc.handler);
  try {
    await account.saveBackup(PASS);
    assert.deepEqual(await account.deleteBackup(), { ok: true });
    assert.equal(svc.row, null);
    assert.equal(account.snapshot().identityBackup, null);
  } finally { done(); }
});

test('a rejected session (401) forgets the account, for every backup call', async () => {
  for (const act of [(a) => a.saveBackup(PASS), (a) => a.restoreBackup(PASS), (a) => a.deleteBackup()]) {
    const { account, dir, done } = make(() => ({ status: 401, json: { error: 'Sign in again.' } }));
    try {
      assert.deepEqual(await act(account), { ok: false, error: 'unauthorized' });
      const snap = account.snapshot();
      assert.deepEqual([snap.session, snap.discordName, snap.identityBackup], [false, null, null]);
      assert.ok(!fs.existsSync(path.join(dir, 'app-session.json')));
    } finally { done(); }
  }
});

test('signed out, or the service unreachable or refusing, is reported without a throw', async () => {
  const out = make(() => ({ status: 500 }), { signedIn: false });
  try {
    assert.deepEqual(await out.account.saveBackup(PASS), { ok: false, error: 'signed_out' });
    assert.equal(out.calls.length, 0);
  } finally { out.done(); }
  for (const handler of [() => ({ status: 500 }), () => ({ status: 429 }), () => ({ status: 400 }), () => { throw new Error('offline'); }]) {
    const { account, done } = make(handler);
    try {
      assert.deepEqual(await account.saveBackup(PASS), { ok: false, error: 'failed' });
      assert.deepEqual(await account.restoreBackup(PASS), { ok: false, error: 'failed' });
      assert.deepEqual(await account.deleteBackup(), { ok: false, error: 'failed' });
      assert.equal(account.snapshot().session, true, 'a failure other than 401 keeps the account');
    } finally { done(); }
  }
});

test('the status answer carries the backup into the snapshot; an answer without the field leaves it', async () => {
  let answer = { member: true, reason: null, discordName: 'Player', serverNow: 1, identityBackup: { vpId: 'abcdef012345', updatedAt: 42 } };
  const { account, done } = make(() => ({ status: 200, json: answer }));
  try {
    assert.equal(account.snapshot().identityBackup, null);
    await account.refreshStatus();
    assert.deepEqual(account.snapshot().identityBackup, { vpId: 'abcdef012345', updatedAt: 42 });
    answer = { ...answer }; delete answer.identityBackup;
    await account.refreshStatus();
    assert.deepEqual(account.snapshot().identityBackup, { vpId: 'abcdef012345', updatedAt: 42 });
    answer = { ...answer, identityBackup: null };
    await account.refreshStatus();
    assert.equal(account.snapshot().identityBackup, null);
  } finally { done(); }
});

test('after setDeviceToken the backup is made from the new token', async () => {
  const svc = store();
  const { account, calls, done } = make(svc.handler);
  try {
    account.setDeviceToken(OTHER);
    assert.deepEqual(await account.saveBackup(PASS), { ok: true });
    assert.equal(calls.find((c) => c.method === 'PUT').body.vpId, backup.shortId(OTHER));
  } finally { done(); }
});

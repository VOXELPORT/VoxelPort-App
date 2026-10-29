'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { atomicWriteFileSync } = require('./atomicWrite');

/**
 * The app's side of "Continue with Discord". The browser does the Discord sign-in on the accounts
 * service and is sent back to a loopback port on this machine with a one-time code. The code is
 * only useful together with the PKCE verifier, which never leaves this process, and is traded for
 * a revocable app session. The session is stored with OS-backed encryption when that exists, the
 * same way the device token is, and is never handed to the renderer.
 */

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const ERROR_RE = /^[a-z_]{1,40}$/;
// A first-time Discord user may have to make an account and verify an email, so this matches the 10 minutes the server allows.
const DEFAULT_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const RETURN_PAGE = '<!doctype html><meta charset="utf-8"><title>VoxelPort</title><body style="font-family:system-ui;text-align:center;margin-top:20vh"><h2>You can return to VoxelPort now.</h2><p>You may close this tab.</p>';

function createAppAccount({ baseUrl, userDataDir, safeStorage, openExternal, deviceToken, fetchImpl = fetch, now = Date.now, signInTimeoutMs = DEFAULT_SIGN_IN_TIMEOUT_MS }) {
  const file = path.join(userDataDir, 'app-session.json');
  const canEncrypt = () => !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
  const state = { session: null, config: null, status: null, statusError: null, lastGood: null, discordName: null, standing: null };
  const readStanding = (j) => { if (j && j.plan && typeof j.plan.id === 'string' && typeof j.rank === 'string') state.standing = { plan: { id: j.plan.id, name: String(j.plan.name || '') }, rank: j.rank }; };
  let flow = null;

  function load() {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.enc && canEncrypt()) state.session = safeStorage.decryptString(Buffer.from(record.enc, 'base64'));
      else if (typeof record.session === 'string') state.session = record.session;
      if (record.lastGood && typeof record.lastGood.member === 'boolean') state.lastGood = { member: record.lastGood.member, at: Number(record.lastGood.at) || 0 };
      if (typeof record.discordName === 'string') state.discordName = record.discordName;
      readStanding(record.standing);
    } catch { /* no saved session, or it cannot be read right now: the person simply signs in again */ }
  }
  function save() {
    fs.mkdirSync(userDataDir, { recursive: true });
    const secret = canEncrypt() ? { enc: safeStorage.encryptString(state.session).toString('base64') } : { session: state.session };
    atomicWriteFileSync(file, JSON.stringify({ ...secret, lastGood: state.lastGood, discordName: state.discordName, standing: state.standing }), { mode: 0o600 });
  }
  // Forgets the signed-in account on this machine: nothing it showed (name, rank) may be left on screen.
  function forgetAccount() {
    state.session = null; state.status = null; state.statusError = null; state.lastGood = null; state.discordName = null; state.standing = null;
    try { fs.rmSync(file, { force: true }); } catch { /* nothing to remove */ }
  }
  const url = (p) => `${baseUrl}${p}`;
  async function call(method, p, { body, session } = {}) {
    const res = await fetchImpl(url(p), { method, headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    let json = {};
    try { json = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, json };
  }
  const readConfig = (j) => { state.config = { graceUntil: j.graceUntil ?? null, serverNow: j.serverNow, at: now(), inviteUrl: typeof j.inviteUrl === 'string' ? j.inviteUrl : null }; };

  async function runFlow(cancelled) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let server, timer;
    const codePromise = new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const code = u.searchParams.get('code') || '';
        const failure = u.searchParams.get('error') || '';
        if (u.pathname === '/' && CODE_RE.test(code)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(RETURN_PAGE); resolve({ code }); }
        else if (u.pathname === '/' && ERROR_RE.test(failure)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(RETURN_PAGE); resolve({ error: failure }); }
        else { res.writeHead(404); res.end(); }
      });
    });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const port = server.address().port;
      try { await openExternal(`${baseUrl}/api/auth/discord/start?app=1&challenge=${challenge}&port=${port}`); } catch { return { ok: false, error: 'browser' }; }
      const outcome = await Promise.race([
        codePromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'timeout' }), signInTimeoutMs); }),
        cancelled.then(() => ({ error: 'cancelled' })),
      ]);
      if (outcome.error) return { ok: false, error: outcome.error };
      let result;
      try { result = await call('POST', '/api/app/exchange', { body: { code: outcome.code, verifier, deviceToken } }); } catch { return { ok: false, error: 'unreachable' }; }
      if (!result.ok) return { ok: false, error: result.json.error || `Sign-in failed (${result.status}).` };
      const j = result.json;
      state.session = j.session; state.discordName = j.discordName || null;
      state.status = { member: !!j.member, reason: j.reason || null }; state.statusError = null;
      state.lastGood = { member: !!j.member, at: now() };
      readStanding(j);
      readConfig(j);
      try { save(); } catch { /* signed in for this run even if it cannot be remembered */ }
      return { ok: true, member: !!j.member, reason: j.reason || null, linkError: j.linkError, discordName: state.discordName };
    } catch { return { ok: false, error: 'browser' }; }
    finally {
      clearTimeout(timer);
      if (server.listening) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    }
  }

  function signIn() {
    if (flow) return flow.promise; // a second click joins the sign-in already open
    let cancel;
    const cancelled = new Promise((resolve) => { cancel = resolve; });
    const promise = runFlow(cancelled).finally(() => { flow = null; });
    flow = { promise, cancel };
    return promise;
  }

  async function refreshStatus() {
    if (!state.session) return { statusError: null, status: null };
    try {
      const r = await call('GET', '/api/app/status', { session: state.session });
      if (r.status === 401) { forgetAccount(); state.statusError = 'unauthorized'; } // the server no longer knows this session (signed out elsewhere, or the account was removed)
      else if (!r.ok) state.statusError = 'unreachable';
      else {
        state.status = { member: !!r.json.member, reason: r.json.reason || null }; state.statusError = null;
        state.lastGood = { member: !!r.json.member, at: now() }; state.discordName = r.json.discordName || state.discordName;
        readStanding(r.json);
        readConfig(r.json);
        try { save(); } catch { /* best effort */ }
      }
    } catch { state.statusError = 'unreachable'; }
    return { statusError: state.statusError, status: state.status };
  }

  async function refreshConfig() {
    try {
      const r = await call('GET', '/api/app/config');
      if (r.ok) readConfig(r.json);
    } catch { /* keep the last known config */ }
    return state.config;
  }

  async function signOut() {
    const session = state.session;
    forgetAccount();
    if (session) { try { await call('POST', '/api/app/signout', { body: {}, session }); } catch { /* the server forgets it on its own schedule */ } }
  }

  load();
  return { signIn, cancelSignIn: () => flow && flow.cancel(), refreshStatus, refreshConfig, signOut, snapshot: () => ({ session: !!state.session, config: state.config, status: state.status, statusError: state.statusError, lastGood: state.lastGood, discordName: state.discordName, standing: state.standing }) };
}

module.exports = { createAppAccount, DEFAULT_SIGN_IN_TIMEOUT_MS };

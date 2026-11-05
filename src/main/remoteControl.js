'use strict';

/**
 * Web control, the app's side. The accounts service holds the buttons friends press; this asks it
 * for them (a long poll, because this PC cannot be reached from the internet), runs only the four
 * allowed actions through the same code as the app's own buttons, and sends back a cleaned picture
 * of the server so the web page can show it. Nothing here imports Electron: the app hands in what
 * it needs, which keeps the rules testable.
 */

const ACTIONS = ['start', 'stop', 'restart', 'kick'];
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const MAX_LINES = 100;
const MAX_LINE = 200;
const MAX_PLAYERS = 100;
const REPORT_WATCHED_MS = 5000;
const REPORT_IDLE_MS = 30000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IPV4 = /\/?\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const IPV6_FULL = /\[?\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b\]?(?::\d{1,5})?/g;
// Only addresses written with "::" are matched, so times such as 12:07:00 are left alone.
const IPV6_SHORT = /\[?(?:[A-Fa-f0-9]{1,4}:){0,6}:(?::?[A-Fa-f0-9]{1,4}){0,6}(?=[\s\]\/,;)]|$)\]?(?::\d{1,5})?/g;
// The computer's user name shows up in file paths; friends have no need to see it.
const WIN_USER = /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s]+/gi;
const UNIX_USER = /(\/(?:home|Users)\/)[^/\s]+/g;
const TOKEN = /\bvp_[A-Za-z0-9_-]{6,}/g;
const HEX_RUN = /\b[A-Fa-f0-9]{24,}\b/g;
const LONG_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** What may leave this PC: no addresses, no secrets, at most 100 short lines. */
function cleanLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.filter((l) => typeof l === 'string').slice(-MAX_LINES).map((line) => {
    let s = line.replace(ANSI, '').replace(CONTROL, '').replace(WIN_USER, '$1[user]').replace(UNIX_USER, '$1[user]');
    s = s.replace(IPV4, '[ip]').replace(/::ffff:\[ip\]/gi, '[ip]').replace(IPV6_FULL, '[ip]').replace(IPV6_SHORT, (m) => (m.includes('::') ? '[ip]' : m));
    s = s.replace(TOKEN, '[secret]').replace(HEX_RUN, '[secret]').replace(LONG_RUN, (m) => (UUID.test(m) ? m : '[secret]'));
    return s.slice(0, MAX_LINE);
  });
}

/** A command from the server, or null if it is anything other than one of the four allowed actions. */
function parseCommand(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id;
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!ACTIONS.includes(raw.action)) return null;
  if (raw.action !== 'kick') return { id, action: raw.action, arg: null };
  if (typeof raw.arg !== 'string' || !PLAYER_NAME.test(raw.arg)) return null;
  return { id, action: 'kick', arg: raw.arg };
}

const backoffMs = (errors) => Math.min(60000, 2000 * 2 ** Math.max(0, errors - 1));

/**
 * request(method, path, body) -> { ok, status, json }; actions = { start, stop, restart, kick(name), status() };
 * isAllowed() is false when nobody is signed in or the account is not in the Discord server.
 */
function createRemoteControl({ request, getVpId, actions, isAllowed, onEvent = () => {}, now = Date.now, wait }) {
  let stopped = false;
  let watching = false;
  let lastOk = null;
  let perk = null; // false once the accounts service says the owner is not Supporter+ (web control is a Supporter+ perk)
  const executed = new Set();
  const sleepers = new Set();
  const sleep = wait || ((ms) => new Promise((resolve) => {
    const entry = { resolve };
    entry.timer = setTimeout(() => { sleepers.delete(entry); resolve(); }, ms);
    sleepers.add(entry);
  }));
  const vp = () => getVpId();
  const gate = () => stopped || !isAllowed() || !vp();

  async function send(method, path, body) {
    try { return await request(method, path, body); } catch { return { ok: false, status: 0, json: {} }; }
  }

  async function runCommand(cmd) {
    if (executed.has(cmd.id)) return;
    executed.add(cmd.id);
    if (executed.size > 500) executed.delete(executed.values().next().value);
    let outcome;
    try { outcome = await actions[cmd.action](cmd.arg); } catch (e) { outcome = { ok: false, error: String((e && e.message) || e) }; }
    const ok = !!(outcome && outcome.ok);
    const message = String((outcome && (outcome.error || outcome.message)) || (ok ? 'Done' : 'Failed')).slice(0, 200);
    await send('POST', '/api/app/control/result', { vp: vp(), id: cmd.id, ok, message });
    try { onEvent({ action: cmd.action, arg: cmd.arg, ok }); } catch { /* a notification problem never stops control */ }
  }

  /** One long poll. 'ok', 'error' (try again later) or 'blocked' (do nothing more). */
  async function pollOnce() {
    if (gate()) return 'blocked';
    const res = await send('GET', `/api/app/control/poll?vp=${encodeURIComponent(vp())}`);
    if (res.status === 401) return 'blocked';
    if (!res.ok) return 'error';
    lastOk = now();
    if (res.json && typeof res.json.watching === 'boolean') watching = res.json.watching;
    if (res.json && typeof res.json.perk === 'boolean') perk = res.json.perk;
    for (const raw of Array.isArray(res.json && res.json.commands) ? res.json.commands : []) {
      if (gate()) return 'blocked';
      const cmd = parseCommand(raw);
      if (!cmd) {
        if (raw && Number.isInteger(raw.id) && raw.id > 0) await send('POST', '/api/app/control/result', { vp: vp(), id: raw.id, ok: false, message: 'Not allowed' });
        continue;
      }
      await runCommand(cmd);
    }
    return 'ok';
  }

  async function reportOnce() {
    if (gate()) return 'blocked';
    let s;
    try { s = actions.status() || {}; } catch { s = {}; }
    const players = (Array.isArray(s.players) ? s.players : []).filter((p) => typeof p === 'string' && PLAYER_NAME.test(p)).slice(0, MAX_PLAYERS);
    const res = await send('POST', '/api/app/control/report', { vp: vp(), status: s.status, players, lines: cleanLines(s.lines) });
    if (res.status === 401) return 'blocked';
    if (!res.ok) return 'error';
    lastOk = now();
    if (res.json && typeof res.json.watching === 'boolean') watching = res.json.watching;
    return 'ok';
  }

  async function pollLoop() {
    let errors = 0;
    while (!stopped) {
      const began = now();
      const r = await pollOnce();
      if (r === 'blocked') { stop(); return; }
      if (r === 'ok') { errors = 0; if (perk === false) await sleep(30000, 'perk'); else if (now() - began < 1000) await sleep(1000, 'gap'); continue; }
      errors++;
      await sleep(backoffMs(errors), 'error');
    }
  }
  async function reportLoop() {
    let errors = 0;
    while (!stopped) {
      const r = await reportOnce();
      if (r === 'blocked') { stop(); return; }
      if (r === 'ok') { errors = 0; await sleep(watching ? REPORT_WATCHED_MS : REPORT_IDLE_MS, 'report'); continue; }
      errors++;
      await sleep(backoffMs(errors), 'error');
    }
  }

  function stop() {
    stopped = true;
    for (const s of sleepers) { clearTimeout(s.timer); s.resolve(); }
    sleepers.clear();
  }

  return {
    start: () => { stopped = false; return Promise.all([pollLoop(), reportLoop()]).then(() => undefined); },
    stop,
    pollOnce,
    reportOnce,
    snapshot: () => ({ running: !stopped, watching, lastOk, perk }),
  };
}

module.exports = { cleanLines, parseCommand, backoffMs, createRemoteControl, ACTIONS, PLAYER_NAME };

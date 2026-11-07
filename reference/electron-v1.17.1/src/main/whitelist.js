'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');
const { isCracked } = require('./accounts');

/**
 * Friends-only hosting: a small whitelist a host can edit from one screen.
 *
 * When the whitelist is on, only the names on it can join. VoxelPort keeps the list in the server's own
 * whitelist.json (and turns white-list=true in server.properties). If the server is running, it also sends
 * the matching `whitelist add/remove` and `whitelist on/off` commands so the change takes effect at once;
 * if it is stopped, editing the file is enough and it applies next start.
 *
 * Names are validated as Minecraft usernames (3–16 of letters, digits, underscore). On a normal (premium)
 * server the server resolves each name to a real account when it is added. On a cracked/offline server the
 * match is by the exact typed name, so the caller is told to warn the host — that is why addFriends returns
 * `cracked`.
 */

const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const MAX_NAMES = 200;
const WHITELIST_FILE = 'whitelist.json';
const PROPS_FILE = 'server.properties';

/** True when a string is a valid Minecraft Java username. */
function isValidUsername(name) {
  return typeof name === 'string' && USERNAME.test(name);
}

/**
 * Splits free text (what the host typed, maybe comma/space/newline separated) into valid and invalid names,
 * with no duplicates (case-insensitive, since usernames are case-insensitive to join). Pure.
 * @returns {{ valid: string[], invalid: string[] }}
 */
function parseNames(text) {
  const parts = String(text == null ? '' : text).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isValidUsername(p)) { if (valid.length < MAX_NAMES) valid.push(p); } else { invalid.push(p.slice(0, 20)); }
  }
  return { valid, invalid };
}

function checkServerDir(serverDir) {
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) throw new Error('Invalid server folder.');
}
function whitelistPath(serverDir) { return path.join(serverDir, WHITELIST_FILE); }

/** The names currently in whitelist.json (just the names, lower-cased for comparison hidden; display name kept). */
function readWhitelist(serverDir) {
  checkServerDir(serverDir);
  let list;
  try { list = JSON.parse(fs.readFileSync(whitelistPath(serverDir), 'utf8')); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const e of list) {
    const name = e && typeof e.name === 'string' ? e.name : '';
    if (!isValidUsername(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, uuid: typeof e.uuid === 'string' ? e.uuid : '' });
  }
  return out;
}

/** Writes whitelist.json from a list of {name, uuid}. Vanilla keeps the uuid; an empty one is fine (it fills on join). */
function writeWhitelist(serverDir, entries) {
  const list = entries.map((e) => ({ uuid: e.uuid || '', name: e.name }));
  atomicWriteFileSync(whitelistPath(serverDir), JSON.stringify(list, null, 2));
}

/** Sets white-list=true/false (and enforce-whitelist to match) in server.properties, adding the keys if missing. */
function setWhitelistProperty(serverDir, on) {
  const file = path.join(serverDir, PROPS_FILE);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* a fresh server may not have it yet */ }
  const value = on ? 'true' : 'false';
  const lines = text.split(/\r?\n/);
  const set = (key) => {
    const re = new RegExp(`^${key}\\s*=`);
    const i = lines.findIndex((l) => re.test(l.trim()));
    if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  };
  set('white-list');
  set('enforce-whitelist');
  atomicWriteFileSync(file, lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n');
}

/**
 * Adds friends to the whitelist and turns it on. `send` runs a server command when the server is live (null when
 * stopped). Returns which names were added, which were already there, which were invalid, whether the server is
 * cracked (so the UI warns), and whether a restart is needed (only when the file was edited while stopped — a
 * live server applies it at once).
 */
function addFriends({ serverDir, text, running = false, send = null }) {
  checkServerDir(serverDir);
  const { valid, invalid } = parseNames(text);
  const current = readWhitelist(serverDir);
  const have = new Set(current.map((e) => e.name.toLowerCase()));
  const added = [];
  const already = [];
  for (const name of valid) {
    if (have.has(name.toLowerCase())) { already.push(name); continue; }
    added.push(name);
    current.push({ name, uuid: '' });
    have.add(name.toLowerCase());
  }
  if (added.length) writeWhitelist(serverDir, current);
  setWhitelistProperty(serverDir, true);
  if (running && typeof send === 'function') {
    for (const name of added) send(`whitelist add ${name}`);
    send('whitelist on');
    send('whitelist reload');
  }
  return {
    added, already, invalid,
    cracked: safeCracked(serverDir),
    total: current.length,
    restartNeeded: !running && (added.length > 0),
  };
}

/** Removes one friend from the whitelist. */
function removeFriend({ serverDir, name, running = false, send = null }) {
  checkServerDir(serverDir);
  if (!isValidUsername(name)) throw new Error('That is not a valid username.');
  const current = readWhitelist(serverDir);
  const next = current.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
  if (next.length !== current.length) writeWhitelist(serverDir, next);
  if (running && typeof send === 'function') { send(`whitelist remove ${name}`); send('whitelist reload'); }
  return { total: next.length, restartNeeded: !running && next.length !== current.length };
}

/** Turns the whitelist off (anyone may join). Keeps the names so it can be turned back on. */
function setEnabled({ serverDir, on, running = false, send = null }) {
  checkServerDir(serverDir);
  setWhitelistProperty(serverDir, Boolean(on));
  if (running && typeof send === 'function') { send(on ? 'whitelist on' : 'whitelist off'); send('whitelist reload'); }
  return { on: Boolean(on), restartNeeded: false };
}

/** The current friends-only state: whether it is on, and the names. */
function status(serverDir) {
  checkServerDir(serverDir);
  return { enabled: isWhitelistOn(serverDir), friends: readWhitelist(serverDir).map((e) => e.name), cracked: safeCracked(serverDir) };
}

function isWhitelistOn(serverDir) {
  try {
    const text = fs.readFileSync(path.join(serverDir, PROPS_FILE), 'utf8');
    const m = /^white-list\s*=\s*(.*)$/m.exec(text);
    return Boolean(m) && m[1].trim() === 'true';
  } catch { return false; }
}

function safeCracked(serverDir) {
  try { return isCracked(serverDir); } catch { return false; }
}

module.exports = {
  isValidUsername, parseNames,
  readWhitelist, addFriends, removeFriend, setEnabled, status,
  isWhitelistOn,
};

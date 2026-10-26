'use strict';

const fs = require('fs');
const path = require('path');

// "Delete server" moves the server's whole folder to the Recycle Bin. A server can be imported from anywhere, so before any
// folder is touched it has to be clearly a server folder and clearly not somewhere the user keeps other things.

const WORLD_OR_JAR = /\.jar$/i;

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  const rel = path.relative(process.platform === 'win32' ? p.toLowerCase() : p, process.platform === 'win32' ? c.toLowerCase() : c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Whether `dir` may be moved to the Recycle Bin. Returns { ok: true } or { ok: false, reason }.
 * `keep` lists folders that must never be deleted, nor any folder that holds one of them (home, Desktop, the app's own data...).
 * `otherServerDirs` are the folders of the other saved servers: one inside this folder, or this one inside another, stops it.
 */
function checkDeletable(dir, { keep = [], otherServerDirs = [] } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, reason: 'not-a-folder' };
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved || resolved.split(path.sep).filter(Boolean).length < 2) return { ok: false, reason: 'too-broad' };
  for (const k of keep) {
    if (!k) continue;
    if (samePath(resolved, k) || isInside(k, resolved)) return { ok: false, reason: 'protected' };
  }
  for (const other of otherServerDirs) {
    if (!other) continue;
    if (samePath(resolved, other) || isInside(other, resolved) || isInside(resolved, other)) return { ok: false, reason: 'shared' };
  }
  let st;
  try { st = fs.statSync(resolved); } catch { return { ok: false, reason: 'missing' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'not-a-folder' };
  // It must look like a Minecraft server: a server.properties, or a jar next to a world or logs.
  let names;
  try { names = fs.readdirSync(resolved); } catch { return { ok: false, reason: 'not-a-folder' }; }
  const looksLikeServer = names.includes('server.properties') || (names.some((n) => WORLD_OR_JAR.test(n)) && names.some((n) => ['world', 'logs', 'eula.txt'].includes(n)));
  if (!looksLikeServer) return { ok: false, reason: 'not-a-server' };
  return { ok: true };
}

module.exports = { checkDeletable };

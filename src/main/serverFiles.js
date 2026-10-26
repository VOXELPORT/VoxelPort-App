'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

// A small file browser for one server folder: list, read and edit plain-text settings files (ops.json, plugin configs,
// bukkit.yml...). The renderer only ever sends a path RELATIVE to the server folder; it is checked here, never trusted.

const MAX_ENTRIES = 1000;
const MAX_TEXT_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set(['.properties', '.json', '.json5', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini', '.txt', '.xml', '.mcmeta', '.md', '.log']);
// Read-only: the server writes these itself and an edit would be thrown away or fight the running server.
const READ_ONLY_EXTENSIONS = new Set(['.log']);

function fail(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

function extOf(name) {
  return path.extname(String(name)).toLowerCase();
}

/**
 * The absolute path for `rel` inside `root`, or an Error. Rejects absolute paths, "..", NUL bytes and anything that leaves the
 * folder through a symbolic link or junction (checked on the real path of the deepest part that exists).
 */
function resolveInside(root, rel = '') {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail('Server folder not found.');
  if (typeof rel !== 'string' || rel.includes('\0')) throw fail('That path is not allowed.');
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((part) => part === '..')) throw fail('That path is not allowed.');
  if (/^[A-Za-z]:/.test(rel)) throw fail('That path is not allowed.');

  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { throw fail('Server folder not found.'); }
  const target = path.resolve(realRoot, clean);

  // Walk up to the part that exists and check where it really points.
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realProbe;
  try { realProbe = fs.realpathSync(probe); } catch { throw fail('That path is not allowed.'); }
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(realProbe) || !inside(target)) throw fail('That path is not allowed.');
  return target;
}

/** Folders first, then files, each A to Z. Hidden dot-files are listed too (a server has few and they matter). */
function listDir(root, rel = '') {
  const dir = resolveInside(root, rel);
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { throw fail('Could not read that folder.'); }
  const entries = [];
  for (const d of names) {
    if (entries.length >= MAX_ENTRIES) break;
    let isDir = d.isDirectory();
    let size = 0;
    try {
      const st = fs.statSync(path.join(dir, d.name));
      isDir = st.isDirectory();
      size = isDir ? 0 : st.size;
    } catch { continue; } // a dead link: skip it
    entries.push({ name: d.name, dir: isDir, size, editable: !isDir && isEditable(d.name, size) });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
  return { path: path.relative(fs.realpathSync(root), dir).split(path.sep).join('/'), entries };
}

function isEditable(name, size) {
  const ext = extOf(name);
  return TEXT_EXTENSIONS.has(ext) && !READ_ONLY_EXTENSIONS.has(ext) && size <= MAX_TEXT_BYTES;
}

function readTextFile(root, rel) {
  const file = resolveInside(root, rel);
  if (!TEXT_EXTENSIONS.has(extOf(file))) throw fail('That kind of file cannot be opened here.');
  let st;
  try { st = fs.statSync(file); } catch { throw fail('That file does not exist.'); }
  if (!st.isFile()) throw fail('That is not a file.');
  if (st.size > MAX_TEXT_BYTES) throw fail('That file is too large to edit here (limit 512 KB).');
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) throw fail('That file is not plain text.');
  return { text: buf.toString('utf8'), readOnly: READ_ONLY_EXTENSIONS.has(extOf(file)) };
}

/** Replaces an EXISTING text file. New files and other kinds of file are never created or changed from here. */
function writeTextFile(root, rel, text) {
  const file = resolveInside(root, rel);
  const ext = extOf(file);
  if (!TEXT_EXTENSIONS.has(ext) || READ_ONLY_EXTENSIONS.has(ext)) throw fail('That file cannot be edited here.');
  if (typeof text !== 'string') throw fail('Nothing to save.');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw fail('That file is too large to save here (limit 512 KB).');
  let st;
  try { st = fs.statSync(file); } catch { throw fail('That file does not exist.'); }
  if (!st.isFile()) throw fail('That is not a file.');
  if (ext === '.json') {
    try { JSON.parse(text); } catch (e) { throw fail(`That is not valid JSON, so it was not saved (${e.message}).`); }
  }
  atomicWriteFileSync(file, text, 'utf8');
  return { ok: true };
}

module.exports = { resolveInside, listDir, readTextFile, writeTextFile, isEditable, MAX_TEXT_BYTES };

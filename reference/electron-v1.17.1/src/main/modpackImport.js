'use strict';

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { downloadServerJar, isAllowedDownloadUrl } = require('./serverInstall');

/**
 * Import a Modrinth modpack (.mrpack) and install the parts that run on a server.
 *
 * A .mrpack is a ZIP whose modrinth.index.json lists each file with a download URL, a SHA-512, and an `env`
 * saying whether it belongs on the client, the server, or both. VoxelPort downloads only the files marked for
 * the server (or required on both), each verified against its SHA-512 and only from Modrinth's own CDN, into
 * the Fabric server's mods/ folder. Client-only mods (shaders, minimaps, key-binds) are skipped and reported
 * so the person understands why their pack looks smaller on the server.
 *
 * Everything inside the pack is untrusted: the manifest is size-limited and strictly validated, file paths are
 * kept inside mods/ or config/, and nothing is downloaded from a host that isn't on the app's allowlist.
 *
 * Forge and NeoForge packs are refused with a clear message, because the app has no Forge/NeoForge server
 * installer. Quilt packs install on Fabric (Quilt loads Fabric mods), which is how most of them are meant to run.
 */

const MAX_INDEX_BYTES = 2 * 1024 * 1024;   // modrinth.index.json: a few hundred KB even for a huge pack
const MAX_FILES = 1000;                    // a pack with more than this is not something we want to install blindly
const MAX_OVERRIDE_BYTES = 64 * 1024 * 1024; // total bytes of config/ files copied out of the pack
const MAX_OVERRIDE_FILES = 2000;
const SAFE_REL = /^(?!.*\.\.)[\w .+()[\]-]+(\/[\w .+()[\]-]+)*$/; // a relative path with no ".." and only tame characters
const MODRINTH_HOSTS = ['cdn.modrinth.com', 'modrinth.com'];

/** A tidy error the UI can show as-is, with a machine-readable `code`. */
class ModpackError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'ModpackError'; }
}

// ─── Pure manifest logic (no files, no network: tested in modpackImport.test.js) ───

/** The Minecraft version and Fabric loader version a parsed manifest asks for, or an error if it isn't a Fabric pack we can run. */
function readDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new ModpackError('bad-pack', 'This modpack has no version information.');
  const mc = deps.minecraft;
  if (typeof mc !== 'string' || !/^[\w.+-]{1,40}$/.test(mc)) throw new ModpackError('bad-pack', 'This modpack does not say which Minecraft version it needs.');
  if (deps['forge'] || deps['neoforge']) {
    throw new ModpackError('forge', 'This is a Forge or NeoForge modpack. VoxelPort can host Fabric modpacks; Forge isn’t supported yet.');
  }
  const loader = deps['fabric-loader'] || deps['quilt-loader'];
  if (typeof loader !== 'string' || !/^[\w.+-]{1,40}$/.test(loader)) {
    throw new ModpackError('not-fabric', 'VoxelPort can host Fabric (and Quilt) modpacks. This one needs a loader it doesn’t support.');
  }
  return { minecraft: mc, quilt: Boolean(deps['quilt-loader']) };
}

/** True when a file's env marks it as wanted on the server (present-on-server, or required with no env given). */
function wantedOnServer(env) {
  if (!env || typeof env !== 'object') return true; // no env block: Modrinth's default is "both sides"
  const server = env.server;
  if (server === 'unsupported') return false;
  // "required" and "optional" both go on the server; only "unsupported" is left off. Optional-on-server mods are
  // part of the pack's server build, so we install them (the person can remove any later from the add-ons screen).
  return true;
}

/** Why a file was left off the server, for the report ("" means it was kept). */
function skipReason(env) {
  if (!env || typeof env !== 'object') return '';
  if (env.server === 'unsupported') {
    return env.client === 'required' ? 'client-only' : 'not for servers';
  }
  return '';
}

/**
 * Turns the raw files array from modrinth.index.json into a plan: what to download to the server, and what was
 * skipped and why. Throws ModpackError on anything malformed. Pure — the caller does the downloading.
 * @returns {{ downloads: Array<{path, url, sha512, bytes}>, skipped: Array<{name, reason}> }}
 */
function planFiles(files) {
  if (!Array.isArray(files)) throw new ModpackError('bad-pack', 'This modpack’s file list is missing or damaged.');
  if (files.length > MAX_FILES) throw new ModpackError('too-big', 'This modpack lists an unusual number of files, so it was not imported.');
  const downloads = [];
  const skipped = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') throw new ModpackError('bad-pack', 'This modpack has a damaged entry in its file list.');
    const rel = typeof f.path === 'string' ? f.path : '';
    // Only mods and config go on the server. Anything else in the manifest (resourcepacks/, shaderpacks/) is client art.
    const inMods = rel.startsWith('mods/');
    const inConfig = rel.startsWith('config/');
    const name = rel.split('/').pop() || rel;
    // A backslash, a drive letter or anything but a plain forward-slash path is refused outright, not tidied up.
    if (!SAFE_REL.test(rel) || rel.includes('\\')) throw new ModpackError('unsafe', 'This modpack names a file in an unexpected place, so it was not imported.');

    if (!inMods && !inConfig) { skipped.push({ name, reason: 'client-only' }); continue; }
    if (!wantedOnServer(f.env)) { skipped.push({ name, reason: skipReason(f.env) || 'not for servers' }); continue; }

    const urls = Array.isArray(f.downloads) ? f.downloads : [];
    const url = urls.find((u) => typeof u === 'string' && isModrinthUrl(u));
    const sha512 = f.hashes && typeof f.hashes.sha512 === 'string' && /^[a-f0-9]{128}$/i.test(f.hashes.sha512) ? f.hashes.sha512 : '';
    if (!url || !sha512) {
      // A server mod we can't fetch safely: tell the person rather than installing something unverified.
      skipped.push({ name, reason: url ? 'no checksum' : 'not on Modrinth' });
      continue;
    }
    const bytes = Number.isFinite(f.fileSize) && f.fileSize > 0 ? f.fileSize : 0;
    downloads.push({ path: rel, url, sha512, bytes });
  }
  return { downloads, skipped };
}

function isModrinthUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const h = parsed.hostname.toLowerCase();
  return MODRINTH_HOSTS.some((d) => h === d || h.endsWith('.' + d)) && isAllowedDownloadUrl(parsed);
}

/** Validates the parsed modrinth.index.json and returns name, versions and the install plan. Pure. */
function planFromManifest(index) {
  if (!index || typeof index !== 'object') throw new ModpackError('bad-pack', 'This file is not a readable Modrinth modpack.');
  if (index.game !== undefined && index.game !== 'minecraft') throw new ModpackError('bad-pack', 'This modpack is not for Minecraft.');
  if (index.formatVersion !== undefined && index.formatVersion !== 1) throw new ModpackError('bad-pack', 'This modpack is in a newer format VoxelPort can’t read yet.');
  const name = typeof index.name === 'string' ? index.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) : '';
  const { minecraft, quilt } = readDependencies(index.dependencies);
  const { downloads, skipped } = planFiles(index.files);
  return { name, minecraft, quilt, downloads, skipped };
}

// ─── File side: read the .mrpack, run the plan, copy config overrides ───

function checkMrpackPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new ModpackError('bad-pack', 'Invalid modpack file.');
  if (!/\.mrpack$/i.test(file)) throw new ModpackError('bad-pack', 'Choose a Modrinth modpack (.mrpack) file.');
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => (err ? reject(new ModpackError('bad-pack', `That modpack file can’t be read (${err.message}).`)) : resolve(zip)));
  });
}

/** Reads modrinth.index.json out of the pack (never extracting anything) and returns the install plan. */
async function readPlan(file) {
  checkMrpackPath(file);
  const zip = await openZip(file);
  return new Promise((resolve, reject) => {
    let found = false;
    const fail = (err) => { zip.close(); reject(err instanceof ModpackError ? err : new ModpackError('bad-pack', `That modpack is damaged (${err.message}).`)); };
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      if (entry.fileName !== 'modrinth.index.json') { zip.readEntry(); return; }
      found = true;
      if (entry.uncompressedSize > MAX_INDEX_BYTES) { fail(new ModpackError('too-big', 'This modpack’s index is unexpectedly large, so it was not imported.')); return; }
      zip.openReadStream(entry, (err, stream) => {
        if (err) { fail(err); return; }
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => { size += c.length; if (size > MAX_INDEX_BYTES) stream.destroy(new Error('index too large')); else chunks.push(c); });
        stream.on('error', fail);
        stream.on('end', () => {
          zip.close();
          let index;
          try { index = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { reject(new ModpackError('bad-pack', `This modpack’s index is damaged (${e.message}).`)); return; }
          try { resolve(planFromManifest(index)); } catch (e) { reject(e); }
        });
      });
    });
    zip.on('end', () => { if (!found) fail(new ModpackError('not-mrpack', 'That file is not a Modrinth modpack (no modrinth.index.json inside).')); });
    zip.readEntry();
  });
}

/**
 * Copies the pack's own config files (the `overrides/` and `server-overrides/` folders) into the server, so a
 * pack that ships tuned config works out of the box. Only files under config/ or mods/ are taken; a world,
 * a client option file or anything with a strange path is ignored. Returns how many files were copied.
 */
function copyOverrides(file, serverDir) {
  return openZip(file).then((zip) => new Promise((resolve, reject) => {
    const root = path.resolve(serverDir) + path.sep;
    let copied = 0;
    let bytes = 0;
    const fail = (err) => { zip.close(); reject(err instanceof ModpackError ? err : new ModpackError('bad-pack', `The modpack’s config could not be read (${err.message}).`)); };
    zip.on('error', fail);
    zip.on('end', () => { zip.close(); resolve(copied); });
    zip.on('entry', (entry) => {
      const fn = entry.fileName;
      // server-overrides wins over overrides for the same file: it is applied in zip order, and a later copy replaces an earlier one.
      const m = /^(server-overrides|overrides)\/(.+)$/.exec(fn);
      if (!m || /\/$/.test(fn)) { zip.readEntry(); return; }
      const rel = m[2];
      if (!(rel.startsWith('config/') || rel.startsWith('mods/')) || !SAFE_REL.test(rel) || rel.includes('\\')) { zip.readEntry(); return; }
      if (++copied > MAX_OVERRIDE_FILES) { fail(new ModpackError('too-big', 'This modpack ships too many config files, so it was not imported.')); return; }
      const target = path.resolve(serverDir, ...rel.split('/'));
      if (!target.startsWith(root)) { fail(new ModpackError('unsafe', 'This modpack tried to write outside its folder, so it was not imported.')); return; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      zip.openReadStream(entry, (err, rs) => {
        if (err) { fail(err); return; }
        const ws = fs.createWriteStream(target);
        rs.on('data', (c) => { bytes += c.length; if (bytes > MAX_OVERRIDE_BYTES) rs.destroy(new Error('overrides too large')); });
        rs.on('error', fail);
        ws.on('error', fail);
        ws.on('close', () => zip.readEntry());
        rs.pipe(ws);
      });
    });
    zip.readEntry();
  }));
}

/**
 * Downloads every planned server mod into `serverDir`, verified by SHA-512, then copies the pack's config
 * overrides. The Fabric server.jar itself is installed by the caller (it knows the version from the plan).
 * @param onProgress { stage: 'download'|'config'|'done', name, index, total }
 * @returns the number of mods installed.
 */
async function installMods({ file, serverDir, plan, onProgress = () => {}, download = downloadServerJar }) {
  checkMrpackPath(file);
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) throw new ModpackError('bad-pack', 'Invalid server folder.');
  const total = plan.downloads.length;
  let i = 0;
  for (const d of plan.downloads) {
    i += 1;
    const name = d.path.split('/').pop();
    onProgress({ stage: 'download', name, index: i, total });
    const target = path.resolve(serverDir, ...d.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await download(d.url, target, null, { algorithm: 'sha512', expected: d.sha512 });
  }
  onProgress({ stage: 'config' });
  await copyOverrides(file, serverDir);
  onProgress({ stage: 'done' });
  return total;
}

module.exports = {
  ModpackError,
  planFromManifest, planFiles, readDependencies, wantedOnServer, skipReason, isModrinthUrl,
  readPlan, installMods, copyOverrides,
};

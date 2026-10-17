'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { downloadServerJar } = require('./serverInstall');

/**
 * Plugins (Paper) and mods (Fabric) from Modrinth: search, install with the libraries they need, and remove.
 *
 * Everything that comes from Modrinth is treated as untrusted text: it is only ever shown as text, file names must be
 * plain .jar names, and every download is checked against Modrinth's SHA-512 before it is put in the folder. What was
 * installed is written to voxelport-addons.json in the server folder, so Remove only ever deletes files VoxelPort put
 * there (never the ones the person added by hand, or Geyser and Floodgate, which Bedrock support manages).
 */

const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'VoxelPort-App (+https://voxelport.in)';
const REGISTRY = 'voxelport-addons.json';
const SAFE_JAR_NAME = /^[\w.+-]{1,120}\.jar$/;
const PROJECT_ID = /^[A-Za-z0-9]{8}$/;
const MC_VERSION = /^[\w.+-]{1,40}$/;
const PAGE = 20;
const MAX_DEPENDENCY_DEPTH = 2;
const MAX_JARS_TO_IDENTIFY = 100;

/** Vanilla can't load either; Paper takes plugins, Fabric takes mods. */
function supported(type) { return type === 'paper' || type === 'fabric'; }
function loadersFor(type) { return type === 'fabric' ? ['fabric'] : ['paper', 'spigot', 'bukkit']; }
function folderFor(type) { return type === 'fabric' ? 'mods' : 'plugins'; }

function checkServerDir(serverDir) {
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) throw new Error('Invalid server folder.');
}
function checkType(type) {
  if (!supported(type)) throw new Error('Plugins and mods need a Paper or Fabric server.');
}
function checkProject(id) {
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) throw new Error('Invalid project.');
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} → HTTP ${res.status}`);
  return res.json();
}

/**
 * One page of search results. @param anyVersion also list ones not marked for this Minecraft version.
 * @returns {Promise<{ hits: Array<{id, slug, title, desc, downloads, author}>, more: boolean }>}
 */
async function searchAddons({ type, version, query = '', anyVersion = false, offset = 0, fetchImpl = fetch }) {
  checkType(type);
  const q = String(query).trim().slice(0, 100);
  const off = Number.isInteger(offset) && offset >= 0 && offset <= 1000 ? offset : 0;
  const facets = [
    type === 'fabric' ? ['project_type:mod'] : ['project_type:mod', 'project_type:plugin'],
    loadersFor(type).map((l) => `categories:${l}`),
  ];
  if (!anyVersion && typeof version === 'string' && MC_VERSION.test(version)) facets.push([`versions:${version}`]);
  const url = `${MODRINTH_API}/search?query=${encodeURIComponent(q)}&facets=${encodeURIComponent(JSON.stringify(facets))}`
    + `&limit=${PAGE}&offset=${off}&index=${q ? 'relevance' : 'downloads'}`;
  const body = await getJson(url, fetchImpl);
  const raw = Array.isArray(body && body.hits) ? body.hits : [];
  const hits = raw
    .filter((h) => h && PROJECT_ID.test(String(h.project_id)))
    .map((h) => ({
      id: String(h.project_id),
      slug: String(h.slug || ''),
      title: String(h.title || h.slug || ''),
      desc: String(h.description || ''),
      downloads: Number(h.downloads) || 0,
      author: String(h.author || ''),
    }));
  return { hits, more: raw.length >= PAGE };
}

/** The newest version that fits: a release if there is one, otherwise the newest beta or alpha. */
async function bestVersion(projectId, type, version, fetchImpl) {
  let url = `${MODRINTH_API}/project/${projectId}/version?loaders=${encodeURIComponent(JSON.stringify(loadersFor(type)))}`;
  if (typeof version === 'string' && MC_VERSION.test(version)) url += `&game_versions=${encodeURIComponent(JSON.stringify([version]))}`;
  const list = await getJson(url, fetchImpl);
  const versions = Array.isArray(list) ? list : [];
  return versions.find((v) => v && v.version_type === 'release') || versions[0] || null;
}

// ─── What VoxelPort installed ─────────────────────────────────────────────

function registryPath(serverDir) { return path.join(serverDir, REGISTRY); }

/** The add-ons VoxelPort installed that are still in the folder. */
function installedAddons(serverDir) {
  checkServerDir(serverDir);
  let list;
  try { list = JSON.parse(fs.readFileSync(registryPath(serverDir), 'utf8')); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || !PROJECT_ID.test(String(a.id)) || !SAFE_JAR_NAME.test(String(a.file)) || !['plugins', 'mods'].includes(a.dir)) continue;
    if (!fs.existsSync(path.join(serverDir, a.dir, a.file))) continue;
    out.push({ id: a.id, title: String(a.title || a.id), file: a.file, dir: a.dir });
  }
  return out;
}

function saveRegistry(serverDir, list) {
  fs.writeFileSync(registryPath(serverDir), JSON.stringify(list, null, 2));
}

/** Deletes the files VoxelPort installed for a project. A running server has them open, so it has to be stopped first. */
function removeAddon({ serverDir, projectId, running = false }) {
  checkServerDir(serverDir);
  checkProject(projectId);
  const all = installedAddons(serverDir);
  const mine = all.filter((a) => a.id === projectId);
  if (!mine.length) throw new Error('That one was not installed by VoxelPort.');
  if (running) throw new Error('Stop the server first. A running server has its plugins and mods open.');
  for (const a of mine) fs.rmSync(path.join(serverDir, a.dir, a.file), { force: true });
  saveRegistry(serverDir, all.filter((a) => a.id !== projectId));
}

/**
 * Which projects are already in the folder, by file fingerprint (so a mod added by hand, or Fabric API that Bedrock
 * support installed, is recognised and not downloaded twice). A failed lookup just means "none recognised".
 */
async function projectsInFolder(dir, fetchImpl) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f)).slice(0, MAX_JARS_TO_IDENTIFY); } catch { return new Set(); }
  if (!names.length) return new Set();
  const hashes = [];
  for (const f of names) {
    try { hashes.push(crypto.createHash('sha512').update(fs.readFileSync(path.join(dir, f))).digest('hex')); } catch { /* unreadable */ }
  }
  try {
    const res = await fetchImpl(`${MODRINTH_API}/version_files`, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes, algorithm: 'sha512' }),
    });
    if (!res.ok) return new Set();
    const found = await res.json();
    return new Set(Object.values(found || {}).map((v) => v && v.project_id).filter(Boolean));
  } catch { return new Set(); }
}

/**
 * Installs a project and the libraries it requires. Returns the titles that were installed (libraries first).
 * @param running the server is running: new files can be added, but one that is already there can't be replaced.
 */
async function installAddon({
  serverDir, type, version, projectId, title = '', running = false,
  onProgress = () => {}, fetchImpl = fetch, download = downloadServerJar,
}) {
  checkServerDir(serverDir);
  checkType(type);
  checkProject(projectId);
  const dir = path.join(serverDir, folderFor(type));
  const done = [];
  const seen = new Set();
  let inFolder = null; // looked up once, and only if something needs a library

  async function one(id, name, depth) {
    if (seen.has(id)) return;
    seen.add(id);
    onProgress({ stage: 'resolve', title: name });
    const v = await bestVersion(id, type, version, fetchImpl);
    if (!v) throw new Error(`${name || 'It'} has no ${type === 'fabric' ? 'Fabric' : 'Paper'} version for Minecraft ${version}.`);

    for (const d of Array.isArray(v.dependencies) ? v.dependencies : []) {
      if (!d || d.dependency_type !== 'required' || !PROJECT_ID.test(String(d.project_id)) || depth >= MAX_DEPENDENCY_DEPTH) continue;
      if (installedAddons(serverDir).some((a) => a.id === d.project_id)) continue;
      if (inFolder === null) inFolder = await projectsInFolder(dir, fetchImpl);
      if (inFolder.has(d.project_id)) continue;
      let depTitle = '';
      try { depTitle = String((await getJson(`${MODRINTH_API}/project/${d.project_id}`, fetchImpl)).title || ''); } catch { /* the id is enough */ }
      await one(d.project_id, depTitle, depth + 1);
    }

    const files = Array.isArray(v.files) ? v.files : [];
    const file = files.find((f) => f && f.primary) || files[0];
    const fileName = file && typeof file.filename === 'string' ? file.filename : ''; // a plain name or nothing: never "tidied up" into one
    if (!file || !SAFE_JAR_NAME.test(fileName)) throw new Error(`${name || 'It'} is not shipped as a .jar, so it can't be installed here.`);
    const sha512 = file.hashes && file.hashes.sha512;
    if (!sha512) throw new Error(`${name || 'It'} has no checksum to verify, so it was not installed.`);

    const registry = installedAddons(serverDir);
    const older = registry.filter((a) => a.id === id);
    const dest = path.join(dir, fileName);
    // A file with this name that VoxelPort did not put there is the owner's own (added by hand, or by another tool): never overwrite it.
    if (fs.existsSync(dest) && !older.some((a) => a.file === fileName)) {
      throw Object.assign(new Error(`A file named ${fileName} is already in ${folderFor(type)}. Remove it first, or keep using it.`), { code: 'exists', file: fileName });
    }
    if (running && (older.length || fs.existsSync(dest))) {
      throw new Error('Stop the server first to update one that is already installed.');
    }
    fs.mkdirSync(dir, { recursive: true });
    onProgress({ stage: 'download', title: name || fileName, file: fileName });
    await download(file.url, dest, null, { algorithm: 'sha512', expected: sha512 });
    for (const a of older) if (a.file !== fileName) fs.rmSync(path.join(serverDir, a.dir, a.file), { force: true });
    saveRegistry(serverDir, [...registry.filter((a) => a.id !== id), { id, title: name || fileName, file: fileName, dir: folderFor(type) }]);
    done.push(name || fileName);
  }

  await one(projectId, String(title).slice(0, 100), 0);
  onProgress({ stage: 'done' });
  return done;
}

module.exports = {
  supported, loadersFor, folderFor, searchAddons, installAddon, removeAddon, installedAddons, projectsInFolder,
};

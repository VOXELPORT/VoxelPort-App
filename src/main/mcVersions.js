'use strict';

/**
 * Resolves server jar downloads for the three supported server types.
 * Each one is ultimately just "fetch a small JSON API, then hand back a
 * direct jar URL" — none of them need an interactive installer subprocess.
 */

const VANILLA_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
// PaperMC retired the old api.papermc.io/v2 API (now HTTP 410) in favor of
// their "Fill" service. It requires a non-generic User-Agent header.
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const USER_AGENT = 'VoxelPort-App (+https://voxelport.in)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function listVanillaVersions() {
  const manifest = await getJson(VANILLA_MANIFEST);
  return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id);
}

async function resolveVanilla(version) {
  const manifest = await getJson(VANILLA_MANIFEST);
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Unknown vanilla version: ${version}`);
  const detail = await getJson(entry.url);
  const server = detail.downloads && detail.downloads.server;
  if (!server) throw new Error(`${version} has no server download (too old?)`);
  return { url: server.url, fileName: 'server.jar', checksum: server.sha1 ? { algorithm: 'sha1', expected: server.sha1 } : null };
}

async function listPaperVersions() {
  // versions is grouped by minor release ("1.21": ["1.21.4", "1.21.3", ...]),
  // newest group first and newest patch first within each group.
  const project = await getJson(PAPER_API);
  return Object.values(project.versions).flat();
}

async function resolvePaper(version) {
  const known = await listPaperVersions();
  if (!known.includes(version)) throw new Error(`Unknown Paper version: ${version}`);
  const builds = await getJson(`${PAPER_API}/versions/${version}/builds`);
  const stable = builds.filter((b) => b.channel === 'STABLE');
  const build = (stable.length ? stable : builds).reduce((a, b) => (b.id > a.id ? b : a));
  const download = build.downloads['server:default'];
  if (!download) throw new Error(`Paper ${version} build ${build.id} has no server download`);
  const sha256 = download.checksums && download.checksums.sha256;
  return { url: download.url, fileName: 'server.jar', checksum: sha256 ? { algorithm: 'sha256', expected: sha256 } : null };
}

async function listFabricVersions() {
  const games = await getJson(`${FABRIC_META}/versions/game`);
  return games.filter((g) => g.stable).map((g) => g.version);
}

async function resolveFabric(version) {
  const known = await listFabricVersions();
  if (!known.includes(version)) throw new Error(`Unknown Fabric version: ${version}`);
  const [loaders, installers] = await Promise.all([
    getJson(`${FABRIC_META}/versions/loader/${version}`),
    getJson(`${FABRIC_META}/versions/installer`),
  ]);
  const loader = (loaders.find((l) => l.loader.stable) || loaders[0]);
  const installer = (installers.find((i) => i.stable) || installers[0]);
  if (!loader || !installer) throw new Error(`No Fabric loader/installer available for ${version}`);
  const loaderVersion = loader.loader.version;
  const installerVersion = installer.version;
  return {
    url: `${FABRIC_META}/versions/loader/${version}/${loaderVersion}/${installerVersion}/server/jar`,
    fileName: 'server.jar',
    // Fabric's server/jar endpoint assembles the jar on request — no published
    // hash to verify against, unlike Vanilla (sha1) and Paper (sha256).
    checksum: null,
  };
}

const TYPES = {
  vanilla: { label: 'Vanilla', listVersions: listVanillaVersions, resolve: resolveVanilla },
  paper: { label: 'Paper', listVersions: listPaperVersions, resolve: resolvePaper },
  fabric: { label: 'Fabric', listVersions: listFabricVersions, resolve: resolveFabric },
};

function getTypes() {
  return Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label }));
}

async function listVersions(type) {
  const t = TYPES[type];
  if (!t) throw new Error(`Unknown server type: ${type}`);
  return t.listVersions();
}

async function resolveDownload(type, version) {
  const t = TYPES[type];
  if (!t) throw new Error(`Unknown server type: ${type}`);
  return t.resolve(version);
}

module.exports = { getTypes, listVersions, resolveDownload };

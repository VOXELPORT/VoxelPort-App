'use strict';

const fs = require('fs');
const path = require('path');
const { downloadServerJar } = require('./serverInstall');

/**
 * One-click Bedrock support: Geyser (translates Bedrock ↔ Java) plus
 * Floodgate (lets Bedrock players in without a Java account).
 *
 * Paper  → Geyser-Spigot + floodgate-spigot from GeyserMC's download API (sha256).
 * Fabric → Geyser-Fabric + Floodgate-Fabric + Fabric API from Modrinth (sha512),
 *          matched to the server's Minecraft version.
 * Vanilla can't load plugins or mods, so it isn't supported.
 *
 * Geyser's default config listens for Bedrock on UDP 19132 and switches to
 * Floodgate authentication by itself when Floodgate is installed, so no
 * config editing is needed.
 */

const GEYSER_API = 'https://download.geysermc.org/v2/projects';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'VoxelPort-App (+https://voxelport.in)';
const DEFAULT_BEDROCK_PORT = 19132;

// Only jars this module itself manages — anything else in plugins/ or mods/
// is never touched.
const MANAGED_JAR = /^(?:geyser|floodgate)[\w.+-]*\.jar$/i;
const SAFE_JAR_NAME = /^[\w.+-]{1,120}\.jar$/;

async function getJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} → HTTP ${res.status}`);
  return res.json();
}

function bedrockSupported(type) {
  return type === 'paper' || type === 'fabric';
}

/** Resolves the jars to download for a server: [{ url, fileName, checksum, dir }]. */
async function resolveBedrockJars(type, mcVersion, fetchImpl = fetch) {
  if (type === 'paper') {
    const out = [];
    for (const project of ['geyser', 'floodgate']) {
      const build = await getJson(`${GEYSER_API}/${project}/versions/latest/builds/latest`, fetchImpl);
      const dl = build.downloads && build.downloads.spigot;
      if (!dl || !dl.sha256 || !SAFE_JAR_NAME.test(dl.name)) throw new Error(`No Paper download for ${project}.`);
      out.push({
        url: `${GEYSER_API}/${project}/versions/${encodeURIComponent(build.version)}/builds/${Number(build.build)}/downloads/spigot`,
        fileName: dl.name,
        checksum: { algorithm: 'sha256', expected: dl.sha256 },
        dir: 'plugins',
      });
    }
    return out;
  }
  if (type === 'fabric') {
    const out = [];
    for (const project of ['fabric-api', 'geyser', 'floodgate']) {
      const q = `loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
      const versions = await getJson(`${MODRINTH_API}/project/${project}/version?${q}`, fetchImpl);
      const pick = (Array.isArray(versions) ? versions : []).find((v) => v.version_type === 'release') || (versions || [])[0];
      if (!pick) throw new Error(`${project} isn't available for Minecraft ${mcVersion} yet.`);
      const file = (pick.files || []).find((f) => f.primary) || (pick.files || [])[0];
      if (!file || !file.hashes || !file.hashes.sha512 || !SAFE_JAR_NAME.test(file.filename)) {
        throw new Error(`No usable download for ${project}.`);
      }
      out.push({ url: file.url, fileName: file.filename, checksum: { algorithm: 'sha512', expected: file.hashes.sha512 }, dir: 'mods', project });
    }
    return out;
  }
  throw new Error('Bedrock players need a Paper or Fabric server — Vanilla can\'t run Geyser.');
}

/**
 * Installs Geyser + Floodgate into serverDir. Existing Geyser/Floodgate jars
 * are replaced; an existing Fabric API is kept.
 */
async function installBedrockSupport({ serverDir, type, version, onProgress = () => {}, fetchImpl = fetch, download = downloadServerJar }) {
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) throw new Error('Invalid server folder.');
  onProgress({ stage: 'resolve' });
  const jars = await resolveBedrockJars(type, version, fetchImpl);

  for (const jar of jars) {
    const dir = path.join(serverDir, jar.dir);
    fs.mkdirSync(dir, { recursive: true });
    if (jar.project === 'fabric-api' && fs.readdirSync(dir).some((f) => /^fabric-api[\w.+-]*\.jar$/i.test(f))) continue;
    onProgress({ stage: 'download', file: jar.fileName });
    const dest = path.join(dir, path.basename(jar.fileName));
    await download(jar.url, dest, null, jar.checksum);
    // Drop older copies so the server doesn't load two Geysers.
    if (MANAGED_JAR.test(jar.fileName)) {
      const family = /^geyser/i.test(jar.fileName) ? /^geyser/i : /^floodgate/i;
      for (const f of fs.readdirSync(dir)) {
        if (f !== path.basename(jar.fileName) && MANAGED_JAR.test(f) && family.test(f)) fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  }
  onProgress({ stage: 'done' });
  return { port: bedrockPort(serverDir) };
}

/** Removes the Geyser/Floodgate jars (Fabric API stays — other mods may need it). */
function removeBedrockSupport(serverDir) {
  for (const sub of ['plugins', 'mods']) {
    const dir = path.join(serverDir, sub);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) if (MANAGED_JAR.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

/** The UDP port Geyser listens on (from its config once it has run), default 19132. */
function bedrockPort(serverDir) {
  for (const rel of [['plugins', 'Geyser-Spigot', 'config.yml'], ['config', 'Geyser-Fabric', 'config.yml']]) {
    try {
      const text = fs.readFileSync(path.join(serverDir, ...rel), 'utf8');
      const block = /^bedrock:\s*\n((?:[ \t]+.*\n|[ \t]*\n|#.*\n)*)/m.exec(text);
      const m = block && /^[ \t]+port:[ \t]*(\d{1,5})\b/m.exec(block[1]);
      if (m) {
        const port = Number(m[1]);
        if (port >= 1 && port <= 65535) return port;
      }
    } catch { /* not generated yet */ }
  }
  return DEFAULT_BEDROCK_PORT;
}

module.exports = { bedrockSupported, resolveBedrockJars, installBedrockSupport, removeBedrockSupport, bedrockPort, DEFAULT_BEDROCK_PORT };

'use strict';

const fs = require('fs');
const path = require('path');
const { isIP } = require('net');
const { downloadServerJar } = require('./serverInstall');
const { atomicWriteFileSync } = require('./atomicWrite');
const { parseProperties } = require('./serverSettings');

/**
 * One-click Bedrock support: Geyser (translates Bedrock ↔ Java) plus
 * Floodgate (lets Bedrock players in without a Java account).
 *
 * Paper  → Geyser-Spigot + floodgate-spigot from GeyserMC's download API (sha256).
 * Fabric → Geyser-Fabric + Floodgate-Fabric + Fabric API from Modrinth (sha512),
 *          matched to the server's Minecraft version.
 * Vanilla can't load plugins or mods, so it isn't supported.
 *
 * Startup uses Geyser's hosting-provider JVM properties to enable NetherNet
 * with a separate TCP signaling / UDP WebRTC endpoint. Existing Geyser and
 * Floodgate configuration files are never rewritten for startup.
 */

const GEYSER_API = 'https://download.geysermc.org/v2/projects';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'VoxelPort-App (+https://voxelport.in)';
const DEFAULT_BEDROCK_PORT = 19132;

// Only jars this module itself installed are ever replaced or removed: their exact names are written to
// voxelport-bedrock.json. A server set up by an older VoxelPort has no such list; for those the jars are recognised by
// the exact names Geyser and Floodgate use, which does not match look-alikes such as GeyserSkinManager-Spigot.jar.
const LEGACY_JAR = /^(?:geyser|floodgate)[-_](?:spigot|fabric)(?:[-_.][\w.+-]*)?\.jar$/i;
const SAFE_JAR_NAME = /^[\w.+-]{1,120}\.jar$/;
const REGISTRY = 'voxelport-bedrock.json';
const FOLDERS = ['plugins', 'mods'];

async function getJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} → HTTP ${res.status}`);
  return res.json();
}

function bedrockSupported(type) {
  return type === 'paper' || type === 'fabric';
}

/**
 * Picks the Geyser build that actually supports a given Minecraft version, from
 * Modrinth's per-release `game_versions` (the GeyserMC download API does not say
 * which Minecraft versions a build supports, which is why installing "latest"
 * could hand a 26.2 server a Geyser that only speaks 26.3). Returns a download
 * descriptor, or throws if no Geyser release lists that Minecraft version.
 */
async function resolveGeyserForVersion(loaders, mcVersion, fetchImpl = fetch) {
  const q = `loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
  const versions = await getJson(`${MODRINTH_API}/project/geyser/version?${q}`, fetchImpl);
  const pick = (Array.isArray(versions) ? versions : []).find((v) => v.version_type === 'release') || (versions || [])[0];
  if (!pick) throw new Error(`No Geyser build supports Minecraft ${mcVersion} yet.`);
  const file = (pick.files || []).find((f) => f.primary) || (pick.files || [])[0];
  if (!file || !file.hashes || !file.hashes.sha512 || !SAFE_JAR_NAME.test(file.filename)) {
    throw new Error(`No usable Geyser download for Minecraft ${mcVersion}.`);
  }
  return { url: file.url, fileName: file.filename, checksum: { algorithm: 'sha512', expected: file.hashes.sha512 } };
}

/** Resolves the jars to download for a server: [{ url, fileName, checksum, dir }]. */
async function resolveBedrockJars(type, mcVersion, fetchImpl = fetch) {
  if (type === 'paper') {
    const out = [];
    // Geyser must match the server's Minecraft version (see resolveGeyserForVersion).
    const geyser = await resolveGeyserForVersion(['paper', 'spigot'], mcVersion, fetchImpl);
    out.push({ ...geyser, dir: 'plugins', family: 'geyser' });
    // Floodgate is Minecraft-version-agnostic (it only adds the auth path), so the
    // latest build from GeyserMC's own API is correct for every server version.
    const fg = await getJson(`${GEYSER_API}/floodgate/versions/latest/builds/latest`, fetchImpl);
    const dl = fg.downloads && fg.downloads.spigot;
    if (!dl || !dl.sha256 || !SAFE_JAR_NAME.test(dl.name)) throw new Error('No Paper download for floodgate.');
    out.push({
      url: `${GEYSER_API}/floodgate/versions/${encodeURIComponent(fg.version)}/builds/${Number(fg.build)}/downloads/spigot`,
      fileName: dl.name,
      checksum: { algorithm: 'sha256', expected: dl.sha256 },
      dir: 'plugins',
      family: 'floodgate',
    });
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

/** The jars an earlier install put there, as [{ dir, name }], or null when there is no (usable) list. */
function readRegistry(serverDir) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(serverDir, REGISTRY), 'utf8')); } catch { return null; }
  if (!data || !Array.isArray(data.files)) return null;
  return data.files
    .filter((f) => f && FOLDERS.includes(f.dir) && typeof f.name === 'string' && SAFE_JAR_NAME.test(f.name))
    .map((f) => ({ dir: f.dir, name: f.name }));
}

function writeRegistry(serverDir, files) {
  atomicWriteFileSync(path.join(serverDir, REGISTRY), JSON.stringify({ files }, null, 2));
}

/** The jars to replace or remove: the ones on the list, or (no list) the ones with Geyser's and Floodgate's own names. */
function ownedJars(serverDir) {
  const listed = readRegistry(serverDir);
  if (listed) return listed.filter((f) => fs.existsSync(path.join(serverDir, f.dir, f.name)));
  const out = [];
  for (const dir of FOLDERS) {
    let names = [];
    try { names = fs.readdirSync(path.join(serverDir, dir)); } catch { continue; }
    for (const name of names) if (LEGACY_JAR.test(name)) out.push({ dir, name });
  }
  return out;
}

/**
 * Installs Geyser + Floodgate into serverDir. Existing Geyser/Floodgate jars
 * are replaced; an existing Fabric API is kept.
 */
async function installBedrockSupport({ serverDir, type, version, onProgress = () => {}, fetchImpl = fetch, download = downloadServerJar }) {
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) throw new Error('Invalid server folder.');
  onProgress({ stage: 'resolve' });
  const jars = await resolveBedrockJars(type, version, fetchImpl);
  let owned = ownedJars(serverDir); // what is VoxelPort's to replace, worked out before anything is written
  const installed = [];

  for (const jar of jars) {
    const dir = path.join(serverDir, jar.dir);
    fs.mkdirSync(dir, { recursive: true });
    if (jar.project === 'fabric-api' && fs.readdirSync(dir).some((f) => /^fabric-api[\w.+-]*\.jar$/i.test(f))) continue;
    onProgress({ stage: 'download', file: jar.fileName });
    const dest = path.join(dir, path.basename(jar.fileName));
    await download(jar.url, dest, null, jar.checksum);
    if (jar.project !== 'fabric-api') {
      // Drop older copies of the same one, so the server doesn't load two Geysers.
      const isGeyser = jar.family === 'geyser' || (!jar.family && /^geyser/i.test(jar.fileName));
      const family = isGeyser ? /^geyser/i : /^floodgate/i;
      const name = path.basename(jar.fileName);
      for (const old of owned) {
        if (old.dir === jar.dir && old.name !== name && family.test(old.name)) fs.rmSync(path.join(serverDir, old.dir, old.name), { force: true });
      }
      owned = owned.filter((o) => !(o.dir === jar.dir && family.test(o.name)));
      installed.push({ dir: jar.dir, name });
    }
  }
  writeRegistry(serverDir, [...owned, ...installed]);
  onProgress({ stage: 'done' });
  return { port: bedrockPort(serverDir) };
}

/** Removes the Geyser/Floodgate jars VoxelPort installed (Fabric API stays — other mods may need it). */
function removeBedrockSupport(serverDir) {
  for (const f of ownedJars(serverDir)) fs.rmSync(path.join(serverDir, f.dir, f.name), { force: true });
  fs.rmSync(path.join(serverDir, REGISTRY), { force: true });
}

/**
 * Pre-flight for decision 5: does a Geyser build exist that supports this
 * server's Minecraft version? Reads Modrinth's per-release game_versions (not a
 * hardcoded table). Returns { ok: true } when one exists, { ok: false, reason }
 * when none does (so the server would let Bedrock players in only to have Geyser
 * disconnect them), or { ok: true, unknown: true } if the check itself failed
 * (network) — we never block a start on our own inability to check.
 */
async function checkGeyserCompatible(type, mcVersion, fetchImpl = fetch) {
  const loaders = type === 'fabric' ? ['fabric'] : ['paper', 'spigot'];
  try {
    const q = `loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
    const versions = await getJson(`${MODRINTH_API}/project/geyser/version?${q}`, fetchImpl);
    if (Array.isArray(versions) && versions.length > 0) return { ok: true };
    return { ok: false, reason: `No Geyser build supports Minecraft ${mcVersion}, so Bedrock players would be disconnected.` };
  } catch {
    return { ok: true, unknown: true };
  }
}

/** A configured Bedrock port, before applying VoxelPort's startup overrides. */
function configuredBedrockPort(serverDir) {
  for (const rel of [['plugins', 'Geyser-Spigot', 'config.yml'], ['config', 'Geyser-Fabric', 'config.yml']]) {
    try {
      const text = fs.readFileSync(path.join(serverDir, ...rel), 'utf8').replace(/\r\n?/g, '\n') + '\n';
      const block = /^bedrock:\s*\n((?:[ \t]+.*\n|[ \t]*\n|#.*\n)*)/m.exec(text);
      const m = block && /^[ \t]+port:[ \t]*(?:(\d{1,5})|'(\d{1,5})'|"(\d{1,5})")[ \t]*(?:#.*)?$/m.exec(block[1]);
      if (m) {
        const port = Number(m[1] || m[2] || m[3]);
        if (port >= 1 && port <= 65535) return port;
      }
    } catch { /* not generated yet */ }
  }
  return DEFAULT_BEDROCK_PORT;
}

function validateBedrockPort(port, name) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid Bedrock ${name} port (expected 1-65535).`);
}

/**
 * Without options, preserves the legacy config/default lookup. With options,
 * chooses one local TCP+UDP port, preferring the configured port, then 19132
 * upward, excluding Java, enabled query and voice ports. No files are changed
 * and no sockets are reserved; pass the same result to the process and tunnel.
 */
function bedrockPort(serverDir, options) {
  if (options === undefined) return configuredBedrockPort(serverDir);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid Bedrock port options.');
  const used = new Set();
  for (const key of ['javaPort', 'queryPort', 'voicePort']) {
    if (options[key] !== undefined) {
      validateBedrockPort(options[key], key);
      used.add(options[key]);
    }
  }
  let properties = new Map();
  try { properties = parseProperties(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8')); } catch { /* not generated yet */ }
  const propertyPort = (key) => {
    const raw = (properties.get(key) || '').trim();
    const port = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
    return port >= 1 && port <= 65535 ? port : 25565;
  };
  if (options.javaPort === undefined) used.add(propertyPort('server-port'));
  if (options.queryPort === undefined && (properties.get('enable-query') || '').trim().toLowerCase() === 'true') {
    used.add(propertyPort('query.port'));
  }
  const configured = configuredBedrockPort(serverDir);
  if (!used.has(configured)) return configured;
  let port = DEFAULT_BEDROCK_PORT;
  while (used.has(port)) port++;
  return port;
}

/** A single DNS/IP host, never a URL, address list, or host with an embedded port. */
function advertiseHost(host) {
  if (typeof host !== 'string' || !host || host.length > 253 || /[\s%]/.test(host)) throw new Error('Invalid Bedrock public host.');
  const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(address) === 6) return `[${address}]`;
  if (isIP(host) === 4) return host;
  if (/^\d+(?:\.\d+){3}$/.test(host) || !host.replace(/\.$/, '').split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error('Invalid Bedrock public host.');
  }
  return host;
}

/**
 * Fixed JVM argv for { localPort, publicHost?, publicPort? }. The parent owns
 * the per-profile public assignment cache; both public fields are omitted
 * until assigned and take effect on the next Java start, not make-public.
 * Official properties: https://geysermc.org/wiki/geyser/geyser-command-line-arguments-and-system-properties/
 */
function bedrockJvmArgs(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid Bedrock startup options.');
  const { localPort, publicHost, publicPort } = options;
  validateBedrockPort(localPort, 'local');
  const args = [
    '-DgeyserTransport=nethernet',
    '-DgeyserUdpAddress=0.0.0.0',
    `-DgeyserUdpPort=${localPort}`,
    `-DgeyserSignalingPort=${localPort}`,
    `-DgeyserWebrtcPort=${localPort}`,
    '-DgeyserSignalingMode=builtin',
  ];
  if (publicHost !== undefined || publicPort !== undefined) {
    validateBedrockPort(publicPort, 'public');
    args.push(`-DgeyserAdvertiseAddresses=${advertiseHost(publicHost)}:${publicPort}`);
  }
  return args;
}

module.exports = { bedrockSupported, resolveBedrockJars, resolveGeyserForVersion, checkGeyserCompatible, installBedrockSupport, removeBedrockSupport, bedrockPort, bedrockJvmArgs, DEFAULT_BEDROCK_PORT };

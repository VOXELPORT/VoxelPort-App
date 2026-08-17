'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { isPrivateOrLocalHost } = require('./relayUrlSafety');

function getServerDir(userDataDir) {
  return path.join(userDataDir, 'server');
}

// Official first-party hosts (and their subdomains) that a Vanilla/Paper/
// Fabric server jar download is allowed to come from — confirmed by
// actually resolving a real download for each type and checking the
// resulting hostname (piston-data.mojang.com, fill-data.papermc.io,
// meta.fabricmc.net), plus each project's other known first-party domains
// so a CDN subdomain change doesn't need a code update. Anything else
// (including an HTTPS→HTTP downgrade) is rejected rather than followed.
const ALLOWED_DOWNLOAD_DOMAINS = ['mojang.com', 'minecraft.net', 'papermc.io', 'fabricmc.net'];

const MAX_REDIRECTS = 5;
const MAX_SERVER_JAR_BYTES = 500 * 1024 * 1024; // generous — real server jars are low tens of MB
const CONNECT_TIMEOUT_MS = 15000;
const INACTIVITY_TIMEOUT_MS = 30000;

function isOfficialDownloadHost(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_DOWNLOAD_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

/**
 * A download URL is allowed when it's HTTPS to an official host, or — the
 * same private/local carve-out relayUrlSafety.js uses for the relay URL —
 * HTTP or HTTPS to loopback/a private address, which only matters for local
 * development/testing against a mock download server and can never be
 * reached by following a redirect from a real Mojang/Paper/Fabric response
 * (those only ever redirect to their own CDN hosts). A public HTTPS URL
 * redirecting to a public HTTP URL is rejected either way (item 23).
 */
function isAllowedDownloadUrl(parsed) {
  if (isPrivateOrLocalHost(parsed.hostname)) return true;
  return parsed.protocol === 'https:' && isOfficialDownloadHost(parsed.hostname);
}

/**
 * Streams a jar to a temp file next to destPath, verifies its checksum (when
 * given) and size while streaming, then atomically renames it over destPath
 * only once the download has fully and successfully completed (item 22) —
 * an existing server.jar is never touched until its replacement is known
 * good, and survives untouched on any failure. Follows redirects, but only
 * to other official Mojang/Paper/Fabric hosts and never HTTPS → HTTP
 * (item 23), and enforces connect/inactivity timeouts and a maximum size
 * (item 24).
 */
function downloadServerJar(url, destPath, onProgress, checksum = null) {
  const dir = path.dirname(destPath);
  const tmpPath = path.join(dir, '.' + path.basename(destPath) + '.download-' + crypto.randomBytes(6).toString('hex'));

  return attempt(url, MAX_REDIRECTS)
    .then(() => new Promise((resolve, reject) => {
      fs.rename(tmpPath, destPath, (err) => (err ? reject(err) : resolve()));
    }))
    .catch((err) => {
      fs.unlink(tmpPath, () => {});
      throw err;
    });

  function attempt(currentUrl, redirectsLeft) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch {
        reject(new Error('Invalid download URL.'));
        return;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        reject(new Error(`Refusing unsupported download URL scheme: ${currentUrl}`));
        return;
      }
      if (!isAllowedDownloadUrl(parsed)) {
        reject(new Error(`Refusing download from untrusted host/scheme: ${parsed.protocol}//${parsed.hostname}`));
        return;
      }

      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(currentUrl, { timeout: CONNECT_TIMEOUT_MS }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects while downloading server jar'));
            return;
          }
          const next = new URL(res.headers.location, currentUrl).toString();
          attempt(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        const declaredTotal = parseInt(res.headers['content-length'] || '0', 10);
        if (declaredTotal > MAX_SERVER_JAR_BYTES) {
          res.destroy();
          reject(new Error(`Server jar too large (${declaredTotal} bytes, max ${MAX_SERVER_JAR_BYTES}).`));
          return;
        }

        let received = 0;
        const file = fs.createWriteStream(tmpPath);
        const hash = checksum ? crypto.createHash(checksum.algorithm) : null;
        let inactivityTimer = null;
        const armInactivityTimer = () => {
          clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(() => {
            res.destroy(new Error('Download stalled (no data received in time).'));
          }, INACTIVITY_TIMEOUT_MS);
        };
        armInactivityTimer();

        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_SERVER_JAR_BYTES) {
            clearTimeout(inactivityTimer);
            res.destroy(new Error(`Server jar exceeded the maximum allowed size (${MAX_SERVER_JAR_BYTES} bytes).`));
            return;
          }
          armInactivityTimer();
          if (hash) hash.update(chunk);
          if (onProgress) onProgress({ received, total: declaredTotal });
        });

        res.pipe(file);
        file.on('finish', () => file.close(() => {
          clearTimeout(inactivityTimer);
          if (hash) {
            const actual = hash.digest('hex');
            if (actual.toLowerCase() !== checksum.expected.toLowerCase()) {
              reject(new Error(
                `Downloaded server jar failed ${checksum.algorithm} verification ` +
                `(expected ${checksum.expected}, got ${actual}).`
              ));
              return;
            }
          }
          resolve();
        }));
        file.on('error', (err) => { clearTimeout(inactivityTimer); reject(err); });
        res.on('error', (err) => { clearTimeout(inactivityTimer); reject(err); });
      });
      req.on('timeout', () => req.destroy(new Error('Connection to download host timed out.')));
      req.on('error', reject);
    });
  }
}

function writeEula(serverDir) {
  fs.writeFileSync(
    path.join(serverDir, 'eula.txt'),
    '# By setting eula=true you agree to the Minecraft EULA (https://www.minecraft.net/eula)\neula=true\n'
  );
}

function writeServerProperties(serverDir, { port = 25565, maxPlayers = 20, difficulty = 'easy', gamemode = 'survival', motd = 'A VoxelPort server' } = {}) {
  // port is written into a config file as a bare value — coerce to a plain
  // integer (not just interpolate the caller's value) so it can't smuggle in
  // extra server.properties lines (e.g. a newline followed by enable-rcon=true).
  const safePort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 25565;
  const lines = [
    `server-port=${safePort}`,
    `max-players=${maxPlayers}`,
    `difficulty=${difficulty}`,
    `gamemode=${gamemode}`,
    `motd=${motd}`,
    'online-mode=true',
    'enable-command-block=false',
  ];
  fs.writeFileSync(path.join(serverDir, 'server.properties'), lines.join('\n') + '\n');
}

/**
 * Updates only the caller-specified keys in an existing server.properties,
 * preserving every other line byte-for-byte (item 26) — used when a server
 * was imported rather than freshly installed, so a host's custom settings
 * (view-distance, whitelist, plugin-specific keys, etc.) are never silently
 * dropped. Never touches keys that could weaken the server (enable-rcon,
 * enable-command-block, online-mode) even if not asked to.
 */
function updateServerPropertiesSafely(serverDir, changes) {
  const DANGEROUS_KEYS = new Set(['enable-rcon', 'enable-command-block', 'online-mode']);
  const file = path.join(serverDir, 'server.properties');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }

  const wanted = new Map(
    Object.entries(changes || {}).filter(([k]) => !DANGEROUS_KEYS.has(k))
  );

  const seen = new Set();
  const updated = lines.map((line) => {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (!m) return line;
    const key = m[1];
    if (wanted.has(key)) {
      seen.add(key);
      return `${key}=${wanted.get(key)}`;
    }
    return line;
  });

  for (const [key, value] of wanted) {
    if (!seen.has(key)) updated.push(`${key}=${value}`);
  }

  fs.writeFileSync(file, updated.join('\n'));
}

/**
 * Detects an already-installed server in a folder the user points VoxelPort
 * at (item 5) — never used to decide whether to overwrite anything, only to
 * populate the "Import Existing Server" UI and to make a best-effort type
 * guess (mods/ → fabric-flavored, plugins/ → paper/spigot-flavored).
 */
function detectExistingServer(dir) {
  const has = (name) => {
    try {
      return fs.existsSync(path.join(dir, name));
    } catch {
      return false;
    }
  };
  const hasServerJar = has('server.jar');
  const hasProperties = has('server.properties');
  const hasEula = has('eula.txt');
  const hasWorld = has('world');
  const hasMods = has('mods');
  const hasPlugins = has('plugins');

  let guessedType = null;
  if (hasMods) guessedType = 'fabric';
  else if (hasPlugins) guessedType = 'paper';
  else if (hasServerJar || hasProperties) guessedType = 'vanilla';

  let guessedPort = null;
  if (hasProperties) {
    try {
      const text = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
      const m = /^server-port=(\d+)/m.exec(text);
      if (m) guessedPort = parseInt(m[1], 10);
    } catch {
      // leave guessedPort null
    }
  }

  return {
    hasServerJar, hasProperties, hasEula, hasWorld, hasMods, hasPlugins,
    looksLikeServer: hasServerJar || hasProperties || hasWorld,
    guessedType, guessedPort,
  };
}

module.exports = {
  getServerDir,
  downloadServerJar,
  writeEula,
  writeServerProperties,
  updateServerPropertiesSafely,
  detectExistingServer,
  isOfficialDownloadHost,
  isAllowedDownloadUrl,
};

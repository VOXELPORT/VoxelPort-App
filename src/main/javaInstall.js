'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

/**
 * Downloads and unpacks an Eclipse Temurin JRE into the app's own data
 * folder, so "Install Java" works in one click without admin rights or a
 * system-wide installer. The build is chosen through the official Adoptium
 * API, which also supplies the SHA-256 we verify the download against.
 *
 * Layout: <userData>/java/temurin-<major>/  (the extracted JRE root)
 */

const API_BASE = 'https://api.adoptium.net/v3/assets/latest';

// Every host a Temurin download is allowed to touch: the API itself, the
// GitHub release page it links to, and GitHub's release-asset CDN that page
// redirects to. Anything else — including an HTTPS→HTTP downgrade — is refused.
const ALLOWED_HOSTS = new Set([
  'api.adoptium.net',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

const MAX_REDIRECTS = 5;
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024; // real JRE archives are ~45-60 MB
const MAX_API_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15000;
const INACTIVITY_TIMEOUT_MS = 30000;

function javaRoot(userDataDir) {
  return path.join(userDataDir, 'java');
}

function installDir(userDataDir, major) {
  return path.join(javaRoot(userDataDir), `temurin-${major}`);
}

function javaBinaryName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

/** The java executable inside an extracted JRE folder, or null if absent. */
function javaExecutableIn(dir) {
  const candidates = [
    path.join(dir, 'bin', javaBinaryName()),
    path.join(dir, 'Contents', 'Home', 'bin', javaBinaryName()), // macOS bundle layout
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * The best app-managed Java for `requiredMajor`: an exact match first, then
 * the lowest installed major above it (Minecraft runs on newer Java, but the
 * closest version is the safest choice). Returns { major, javaPath } or null.
 */
function findManagedJava(userDataDir, requiredMajor) {
  let entries;
  try {
    entries = fs.readdirSync(javaRoot(userDataDir));
  } catch {
    return null;
  }
  const installed = entries
    .map((name) => /^temurin-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => ({ major: parseInt(m[1], 10), dir: path.join(javaRoot(userDataDir), m[0]) }))
    .filter((j) => j.major >= requiredMajor)
    .sort((a, b) => a.major - b.major);
  for (const j of installed) {
    const javaPath = javaExecutableIn(j.dir);
    if (javaPath) return { major: j.major, javaPath };
  }
  return null;
}

function adoptiumPlatform() {
  const os = { win32: 'windows', linux: 'linux', darwin: 'mac' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
  if (!os || !arch) throw new Error(`Automatic Java install isn't available for ${process.platform}/${process.arch}.`);
  return { os, arch };
}

function checkHost(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error('Invalid Java download URL.'); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error(`Refusing Java download from untrusted host: ${u.protocol}//${u.hostname}`);
  }
  return u;
}

/** GET following allowed redirects; resolves with the final 200 response. */
function get(urlStr, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    try { checkHost(urlStr); } catch (err) { reject(err); return; }
    const req = https.get(urlStr, { timeout: CONNECT_TIMEOUT_MS, headers: { 'User-Agent': 'VoxelPort-App' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('Too many redirects while downloading Java.')); return; }
        get(new URL(res.headers.location, urlStr).toString(), redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Java download failed: HTTP ${res.statusCode}`));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Connection to the Java download server timed out.')));
    req.on('error', reject);
  });
}

async function fetchJson(urlStr) {
  const res = await get(urlStr);
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      body += c;
      if (body.length > MAX_API_BYTES) res.destroy(new Error('Adoptium API response too large.'));
    });
    res.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Could not read the Adoptium API response.')); }
    });
    res.on('error', reject);
  });
}

/** Picks the archive for this platform: a JRE if one is published, else a JDK. */
async function resolvePackage(major) {
  const { os, arch } = adoptiumPlatform();
  const ext = os === 'windows' ? '.zip' : '.tar.gz';
  for (const imageType of ['jre', 'jdk']) {
    const url = `${API_BASE}/${major}/hotspot?architecture=${arch}&image_type=${imageType}&os=${os}&vendor=eclipse`;
    const assets = await fetchJson(url);
    const pkg = Array.isArray(assets)
      ? assets.map((a) => a && a.binary && a.binary.package).find((p) => p && typeof p.link === 'string' && p.name && p.name.endsWith(ext))
      : null;
    if (pkg) {
      if (!/^[a-f0-9]{64}$/i.test(pkg.checksum || '')) throw new Error('Adoptium did not provide a valid checksum for this Java build.');
      return { link: pkg.link, name: pkg.name, size: pkg.size, sha256: pkg.checksum.toLowerCase(), imageType };
    }
  }
  throw new Error(`No Java ${major} build is published for ${os}/${arch}.`);
}

function download(pkg, destPath, onProgress) {
  return get(pkg.link).then((res) => new Promise((resolve, reject) => {
    const declared = parseInt(res.headers['content-length'] || '0', 10);
    if (declared > MAX_ARCHIVE_BYTES) { res.destroy(); reject(new Error('Java archive is unexpectedly large.')); return; }
    const total = declared || pkg.size || 0;
    const hash = crypto.createHash('sha256');
    const file = fs.createWriteStream(destPath);
    let received = 0;
    let stall = null;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => res.destroy(new Error('Java download stalled (no data received in time).')), INACTIVITY_TIMEOUT_MS);
    };
    arm();
    res.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES) { clearTimeout(stall); res.destroy(new Error('Java archive exceeded the maximum allowed size.')); return; }
      arm();
      hash.update(chunk);
      if (onProgress) onProgress({ stage: 'download', received, total });
    });
    res.pipe(file);
    file.on('finish', () => file.close(() => {
      clearTimeout(stall);
      const actual = hash.digest('hex');
      if (actual !== pkg.sha256) {
        reject(new Error(`Downloaded Java failed SHA-256 verification (expected ${pkg.sha256}, got ${actual}).`));
        return;
      }
      resolve();
    }));
    file.on('error', (err) => { clearTimeout(stall); reject(err); });
    res.on('error', (err) => { clearTimeout(stall); reject(err); });
  }));
}

/**
 * Unpacks with the OS's own tar (bsdtar on Windows 10+, which reads .zip;
 * GNU/BSD tar elsewhere). execFile with a fixed argv — never a shell.
 */
function extract(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const tar = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    execFile(tar, ['-xf', archivePath, '-C', destDir], { windowsHide: true, timeout: 5 * 60 * 1000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`Could not unpack Java: ${(stderr || err.message).toString().trim()}`));
      else resolve();
    });
  });
}

/**
 * Installs Temurin `major` (if not already present) and resolves with
 * { major, javaPath, version }. onProgress receives
 * { stage: 'resolve' | 'download' | 'extract' | 'done', received?, total? }.
 */
async function installJava({ userDataDir, major, onProgress }) {
  if (!Number.isInteger(major) || major < 8 || major > 99) throw new Error('Invalid Java version requested.');
  const existing = findManagedJava(userDataDir, major);
  if (existing && existing.major === major) {
    if (onProgress) onProgress({ stage: 'done' });
    return existing;
  }

  if (onProgress) onProgress({ stage: 'resolve' });
  const pkg = await resolvePackage(major);

  fs.mkdirSync(javaRoot(userDataDir), { recursive: true });
  const work = fs.mkdtempSync(path.join(javaRoot(userDataDir), '.install-'));
  try {
    const archive = path.join(work, pkg.name.replace(/[^\w.+-]/g, '_'));
    await download(pkg, archive, onProgress);

    if (onProgress) onProgress({ stage: 'extract' });
    const unpackDir = path.join(work, 'unpacked');
    fs.mkdirSync(unpackDir);
    await extract(archive, unpackDir);

    // Archives hold a single top-level folder (e.g. jdk-21.0.4+7-jre).
    const top = fs.readdirSync(unpackDir).filter((n) => !n.startsWith('.'));
    const root = top.length === 1 ? path.join(unpackDir, top[0]) : unpackDir;
    if (!javaExecutableIn(root)) throw new Error('The downloaded Java archive did not contain a java executable.');

    const target = installDir(userDataDir, major);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(root, target);

    const javaPath = javaExecutableIn(target);
    if (onProgress) onProgress({ stage: 'done' });
    return { major, javaPath, imageType: pkg.imageType };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { installJava, findManagedJava, javaExecutableIn, ALLOWED_HOSTS };

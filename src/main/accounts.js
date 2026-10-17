'use strict';

const fs = require('fs');
const path = require('path');
const { downloadServerJar } = require('./serverInstall');
const { atomicWriteFileSync } = require('./atomicWrite');

/**
 * "Cracked" (offline-mode) servers: let people without a paid Minecraft account join.
 *
 * It is a normal server.properties setting, but it removes Minecraft's account check, so
 * anyone can join under any name (an admin's too). That is why `online-mode` is NOT one of
 * the ordinary Settings keys (see serverSettings.js, serverInstall.js): the only way to
 * change it is the dedicated, confirmed action here, which touches only online-mode and
 * enforce-secure-profile and leaves every other line byte-for-byte as it was.
 *
 * For the matching safety net there is a one-click login plugin (AuthMe) from Modrinth.
 */

const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'VoxelPort-App (+https://voxelport.in)';
const LOGIN_PROJECT = '3IEZ9vol'; // AuthMe ReReloaded, the maintained fork
const AUTHME_JAR = /^authme[\w.+-]*\.jar$/i;
const SAFE_JAR_NAME = /^[\w.+-]{1,120}\.jar$/;
const KEYS = ['online-mode', 'enforce-secure-profile'];

function propsFile(serverDir) {
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) throw new Error('Invalid server folder.');
  return path.join(serverDir, 'server.properties');
}

/** True when the server lets in players without an account check (online-mode=false). */
function isCracked(serverDir) {
  let text = '';
  try { text = fs.readFileSync(propsFile(serverDir), 'utf8'); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const m = /^online-mode\s*=\s*(.*)$/.exec(raw.trim());
    if (m) return m[1].trim().toLowerCase() === 'false';
  }
  return false; // Minecraft's default is on
}

/**
 * Turns cracked mode on or off. Rewrites only the two keys (adding them if missing); the
 * rest of the file, including comments and line endings, is preserved.
 */
function setCracked(serverDir, cracked) {
  if (typeof cracked !== 'boolean') throw new Error('Invalid setting.');
  const file = propsFile(serverDir);
  const value = cracked ? 'false' : 'true';
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(online-mode|enforce-secure-profile)\s*=/.exec(lines[i]);
    if (m) { lines[i] = `${m[1]}=${value}`; seen.add(m[1]); }
  }
  for (const key of KEYS) if (!seen.has(key)) lines.push(`${key}=${value}`);
  atomicWriteFileSync(file, lines.join(nl) + nl);
}

/** Checks a change coming from the renderer: enabling cracked mode needs an explicit confirmation. */
function validateAccountsChange(change) {
  if (!change || typeof change.cracked !== 'boolean') throw new Error('Invalid setting.');
  if (change.cracked && change.confirmed !== true) {
    throw new Error('Confirm that you understand anyone can join under any name before turning this on.');
  }
  return change.cracked;
}

function hasLoginPlugin(serverDir) {
  try { return fs.readdirSync(path.join(serverDir, 'plugins')).some((f) => AUTHME_JAR.test(f)); } catch { return false; }
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} → HTTP ${res.status}`);
  return res.json();
}

/** The AuthMe download for this Minecraft version: { url, fileName, checksum }. */
async function resolveLoginPlugin(mcVersion, fetchImpl = fetch) {
  const q = `loaders=${encodeURIComponent('["paper","spigot","bukkit"]')}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
  const versions = await getJson(`${MODRINTH_API}/project/${LOGIN_PROJECT}/version?${q}`, fetchImpl);
  const list = Array.isArray(versions) ? versions : [];
  const pick = list.find((v) => v.version_type === 'release') || list[0];
  if (!pick) throw new Error(`AuthMe isn't available for Minecraft ${mcVersion} yet.`);
  const file = (pick.files || []).find((f) => f.primary) || (pick.files || [])[0];
  if (!file || !file.hashes || !file.hashes.sha512 || !SAFE_JAR_NAME.test(file.filename)) throw new Error('No usable AuthMe download.');
  return { url: file.url, fileName: file.filename, checksum: { algorithm: 'sha512', expected: file.hashes.sha512 } };
}

/** Installs AuthMe into plugins/ (Paper only), replacing an older copy. */
async function installLoginPlugin({ serverDir, type, version, onProgress = () => {}, fetchImpl = fetch, download = downloadServerJar }) {
  if (type !== 'paper') throw new Error('The login plugin needs a Paper server.');
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) throw new Error('Invalid server folder.');
  onProgress({ stage: 'resolve' });
  const jar = await resolveLoginPlugin(version, fetchImpl);
  const dir = path.join(serverDir, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  onProgress({ stage: 'download', file: jar.fileName });
  const dest = path.join(dir, path.basename(jar.fileName));
  await download(jar.url, dest, null, jar.checksum);
  for (const f of fs.readdirSync(dir)) {
    if (f !== path.basename(jar.fileName) && AUTHME_JAR.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  onProgress({ stage: 'done' });
  return { file: path.basename(jar.fileName) };
}

module.exports = { isCracked, setCracked, validateAccountsChange, hasLoginPlugin, resolveLoginPlugin, installLoginPlugin };

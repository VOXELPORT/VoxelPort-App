'use strict';

const fs = require('fs');
const path = require('path');
const { downloadServerJar } = require('./serverInstall');
const { registerAddon, isIconUrl } = require('./addons');
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
const SKINS_PROJECT = 'TsLS8Py5'; // SkinsRestorer: shows each cracked player's own skin
const SKINS_JAR = /^skinsrestorer[\w.+-]*\.jar$/i;
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

/** The Paper-compatible download of a Modrinth plugin for this Minecraft version: { url, fileName, checksum }. */
async function resolveModrinthPlugin(projectId, name, mcVersion, fetchImpl) {
  const q = `loaders=${encodeURIComponent('["paper","spigot","bukkit"]')}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
  const versions = await getJson(`${MODRINTH_API}/project/${projectId}/version?${q}`, fetchImpl);
  const list = Array.isArray(versions) ? versions : [];
  const pick = list.find((v) => v.version_type === 'release') || list[0];
  if (!pick) throw new Error(`${name} isn't available for Minecraft ${mcVersion} yet.`);
  const file = (pick.files || []).find((f) => f.primary) || (pick.files || [])[0];
  if (!file || !file.hashes || !file.hashes.sha512 || !SAFE_JAR_NAME.test(file.filename)) throw new Error(`No usable ${name} download.`);
  return { url: file.url, fileName: file.filename, checksum: { algorithm: 'sha512', expected: file.hashes.sha512 } };
}

/** Downloads a resolved plugin into plugins/ and removes older copies of the same plugin (matched by `family`). */
async function installPluginJar({ serverDir, type, resolved, family, projectId, title, onProgress, download, fetchImpl }) {
  if (type !== 'paper') throw new Error('This plugin needs a Paper server.');
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) throw new Error('Invalid server folder.');
  const dir = path.join(serverDir, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  onProgress({ stage: 'download', file: resolved.fileName });
  const keep = path.basename(resolved.fileName);
  await download(resolved.url, path.join(dir, keep), null, resolved.checksum);
  for (const f of fs.readdirSync(dir)) {
    if (f !== keep && family.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  // Record it where "Installed" looks, so it shows in the Plugins screen and Remove knows it is VoxelPort's.
  // The icon address is a nicety: if Modrinth does not answer, the plugin is still listed.
  let icon = '';
  try {
    const meta = await getJson(`${MODRINTH_API}/project/${projectId}`, fetchImpl);
    if (meta && isIconUrl(meta.icon_url)) icon = meta.icon_url;
  } catch { /* listed without an icon */ }
  try { registerAddon({ serverDir, projectId, title, file: keep, dir: 'plugins', icon }); } catch { /* the file is installed either way */ }
  return { file: keep };
}

/** The AuthMe download for this Minecraft version: { url, fileName, checksum }. */
function resolveLoginPlugin(mcVersion, fetchImpl = fetch) {
  return resolveModrinthPlugin(LOGIN_PROJECT, 'AuthMe', mcVersion, fetchImpl);
}

/** Installs AuthMe into plugins/ (Paper only), replacing an older copy. */
async function installLoginPlugin({ serverDir, type, version, onProgress = () => {}, fetchImpl = fetch, download = downloadServerJar }) {
  if (type !== 'paper') throw new Error('The login plugin needs a Paper server.');
  onProgress({ stage: 'resolve' });
  const resolved = await resolveLoginPlugin(version, fetchImpl);
  const { file } = await installPluginJar({ serverDir, type, resolved, family: AUTHME_JAR, projectId: LOGIN_PROJECT, title: 'AuthMe', onProgress, download, fetchImpl });
  onProgress({ stage: 'done' });
  return { file };
}

function hasSkinsPlugin(serverDir) {
  try { return fs.readdirSync(path.join(serverDir, 'plugins')).some((f) => SKINS_JAR.test(f)); } catch { return false; }
}

/** The SkinsRestorer download for this Minecraft version: { url, fileName, checksum }. */
function resolveSkinsPlugin(mcVersion, fetchImpl = fetch) {
  return resolveModrinthPlugin(SKINS_PROJECT, 'SkinsRestorer', mcVersion, fetchImpl);
}

/**
 * Installs SkinsRestorer into plugins/ (Paper only), so cracked players show their own skin
 * instead of all being Steve or Alex.
 */
async function installSkinsPlugin({ serverDir, type, version, onProgress = () => {}, fetchImpl = fetch, download = downloadServerJar }) {
  if (type !== 'paper') throw new Error('The skins plugin needs a Paper server.');
  onProgress({ stage: 'resolve' });
  const resolved = await resolveSkinsPlugin(version, fetchImpl);
  const { file } = await installPluginJar({ serverDir, type, resolved, family: SKINS_JAR, projectId: SKINS_PROJECT, title: 'SkinsRestorer', onProgress, download, fetchImpl });
  onProgress({ stage: 'done' });
  return { file };
}

/**
 * Sets a new Paper server up for cracked players: a login plugin first, then offline mode, then skins.
 * The order is the safety rule: offline mode with no login plugin lets anyone join as the owner and
 * /op themselves, so online-mode is switched off ONLY once AuthMe is really on disk. If AuthMe cannot
 * be installed the server stays in normal (account-checked) mode. Skins are a nicety and never block.
 * Returns { cracked, skins, warnings } and never throws for a download problem.
 */
async function setUpCrackedServer({ serverDir, type, version, onProgress = () => {}, fetchImpl = fetch, download = downloadServerJar }) {
  const warnings = [];
  let cracked = false;
  let skins = false;
  try {
    await installLoginPlugin({ serverDir, type, version, onProgress, fetchImpl, download });
    if (!hasLoginPlugin(serverDir)) throw new Error('the login plugin did not end up in plugins/');
    setCracked(serverDir, true);
    cracked = true;
  } catch (err) {
    warnings.push(`Cracked mode was NOT turned on, because the login plugin couldn't be installed (${err.message}). Your server still needs a paid Minecraft account to join. You can try again in Settings.`);
    return { cracked, skins, warnings };
  }
  try {
    await installSkinsPlugin({ serverDir, type, version, onProgress, fetchImpl, download });
    skins = true;
  } catch (err) {
    warnings.push(`Skins couldn't be added (${err.message}). Cracked players will all look like Steve or Alex.`);
  }
  return { cracked, skins, warnings };
}

module.exports = {
  isCracked, setCracked, validateAccountsChange, hasLoginPlugin, resolveLoginPlugin, installLoginPlugin, LOGIN_PROJECT,
  hasSkinsPlugin, resolveSkinsPlugin, installSkinsPlugin, setUpCrackedServer,
};

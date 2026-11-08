'use strict';

/**
 * "VoxelPort has moved": the final job of this (Electron) app. It downloads the new VoxelPort, checks it is really ours, installs it, has it bring this
 * app's data over (servers, backups, VoxelPort ID and address, settings), and then removes this app. One button, nothing else to do.
 *
 * What it will and will not do, all of it deliberate:
 *  - The download is checked before anything is written to disk or run: https from github.com's release path for this project only, the size is capped, and
 *    the installer must carry a valid signature made with VoxelPort's own update key (the same key the new app trusts for its own updates). A signature that
 *    is for another file, or for another version than the manifest announces, is refused. Nothing is ever run that was not verified.
 *  - This app is only removed after the new app has said, in a file it writes (legacy-handoff.json), that the data really came over. If anything fails before
 *    that, this app and all its data are exactly as they were, and the person is told what happened and given the download page.
 *  - Removing this app never touches its data folder (servers, worlds and backups are kept; the new app lists the servers where they are).
 *  - The Microsoft Store copy cannot do this (the Store does not allow an app to install another one): it only points to the download page.
 *  - A portable copy is not installed anywhere, so there is nothing to uninstall: it brings the data over and tells the person to delete the file.
 *
 * Everything that touches the world (network, files, processes) is passed in, so the whole flow is tested without a real install.
 */

const crypto = require('crypto');
const fsDefault = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Where the new app's update manifest lives: the same address the new app itself reads (see its updatesetup.rs). It is only reachable once the new
// VoxelPort is published, so until then this whole feature stays hidden (nothing is promised that cannot be delivered).
const MANIFEST_URL = 'https://github.com/VOXELPORT/VoxelPort-App/releases/latest/download/latest.json';
// The public half of VoxelPort's update-signing key (the same value as UPDATE_PUBLIC_KEY in the new app). Not a secret.
const PUBLIC_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc3ODMwQzAwNzE0MDhENzUKUldSMWpVQnhBQXlEZDN4bmpCVW1nKzJmMHU3bzgzNmdYZFRabk9vQzRsL0pQWVFtMzdvZitpdjEK';
const DOWNLOAD_PAGE = 'https://voxelport.in/download';
const FLAG = '--migrate-from-electron';
const HANDOFF_FILE = 'legacy-handoff.json';
const NEW_APP_EXE = 'voxelport-tauri.exe';
const NEW_APP_DATA_FOLDER = 'in.voxelport.app';
const MAX_INSTALLER_BYTES = 60 * 1024 * 1024; // the real one is about 3 MB
const MANIFEST_TTL_MS = 30 * 60 * 1000;
const MANIFEST_RETRY_MS = 5 * 60 * 1000;

/** A failure with a step name the screen can word ('manifest', 'download', 'signature', 'install', 'launch', 'import', 'timeout'). */
class MigrationError extends Error {
  constructor(step, message, extra = {}) {
    super(message);
    this.name = 'MigrationError';
    this.step = step;
    Object.assign(this, extra);
  }
}

// ─── BLAKE2b-512 ────────────────────────────────────────────────────────────────────────────────────────────
// The update signature is minisign's "prehashed" kind: Ed25519 over the BLAKE2b-512 hash of the file. Node's own `blake2b512` is not in every build
// (Electron uses BoringSSL, which has no 512-bit BLAKE2b), so it is written out here (RFC 7693) with 32-bit halves, and tested against Node's.
const IV = [
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function blake2b512(data) {
  const h = new Uint32Array(IV);
  h[0] ^= 0x01010040; // digest length 64, no key, fan-out 1, depth 1
  const v = new Uint32Array(32);
  const m = new Uint32Array(32);

  // 64-bit helpers on (lo, hi) pairs stored at v[2i], v[2i+1]
  const add = (a, b) => {
    const lo = v[a] + v[b];
    v[a + 1] = (v[a + 1] + v[b + 1] + (lo > 0xffffffff ? 1 : 0)) >>> 0;
    v[a] = lo >>> 0;
  };
  const addMsg = (a, x) => {
    const lo = v[a] + m[x];
    v[a + 1] = (v[a + 1] + m[x + 1] + (lo > 0xffffffff ? 1 : 0)) >>> 0;
    v[a] = lo >>> 0;
  };
  const xorRotr32 = (d, a) => { // v[d] = rotr64(v[d] ^ v[a], 32)
    const lo = v[d] ^ v[a];
    const hi = v[d + 1] ^ v[a + 1];
    v[d] = hi; v[d + 1] = lo;
  };
  const xorRotr = (d, a, n) => { // rotate right by n (< 32)
    const lo = v[d] ^ v[a];
    const hi = v[d + 1] ^ v[a + 1];
    v[d] = ((lo >>> n) | (hi << (32 - n))) >>> 0;
    v[d + 1] = ((hi >>> n) | (lo << (32 - n))) >>> 0;
  };
  const xorRotr63 = (d, a) => { // rotate right by 63 = left by 1
    const lo = v[d] ^ v[a];
    const hi = v[d + 1] ^ v[a + 1];
    v[d] = ((lo << 1) | (hi >>> 31)) >>> 0;
    v[d + 1] = ((hi << 1) | (lo >>> 31)) >>> 0;
  };
  const G = (a, b, c, d, x, y) => {
    addMsg(a, x); add(a, b); xorRotr32(d, a);
    add(c, d); xorRotr(b, c, 24);
    addMsg(a, y); add(a, b); xorRotr(d, a, 16);
    add(c, d); xorRotr63(b, c);
  };

  const compress = (block, offset, counter, last) => {
    for (let i = 0; i < 32; i++) m[i] = block.readUInt32LE(offset + i * 4);
    for (let i = 0; i < 16; i++) { v[i] = h[i]; v[i + 16] = IV[i]; }
    v[24] ^= counter >>> 0;
    v[25] ^= Math.floor(counter / 0x100000000) >>> 0; // the counter's high word (inputs here are far below 2^53 bytes)
    if (last) { v[28] = ~v[28] >>> 0; v[29] = ~v[29] >>> 0; }
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      G(0, 8, 16, 24, s[0] * 2, s[1] * 2);
      G(2, 10, 18, 26, s[2] * 2, s[3] * 2);
      G(4, 12, 20, 28, s[4] * 2, s[5] * 2);
      G(6, 14, 22, 30, s[6] * 2, s[7] * 2);
      G(0, 10, 20, 30, s[8] * 2, s[9] * 2);
      G(2, 12, 22, 24, s[10] * 2, s[11] * 2);
      G(4, 14, 16, 26, s[12] * 2, s[13] * 2);
      G(6, 8, 18, 28, s[14] * 2, s[15] * 2);
    }
    for (let i = 0; i < 16; i++) h[i] = (h[i] ^ v[i] ^ v[i + 16]) >>> 0;
  };

  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const full = bytes.length === 0 ? 0 : Math.ceil(bytes.length / 128) - 1; // every block but the last
  for (let i = 0; i < full; i++) compress(bytes, i * 128, (i + 1) * 128, false);
  const tail = Buffer.alloc(128);
  bytes.copy(tail, 0, full * 128);
  compress(tail, 0, bytes.length, true);

  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE(h[i], i * 4);
  return out;
}

// ─── Signature check (minisign / Tauri's updater format) ────────────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const verifyEd25519 = (message, signature, rawKey) => crypto.verify(null, message, crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]), format: 'der', type: 'spki' }), signature);

function decodeText(base64) {
  return Buffer.from(String(base64), 'base64').toString('utf8');
}

/** The key as the new app stores it: base64 of a minisign public-key file (a comment line, then base64 of "Ed" + key id + the 32-byte key). */
function parsePublicKey(base64) {
  const lines = decodeText(base64).split(/\r?\n/).filter(Boolean);
  const raw = Buffer.from(lines[1] || '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') throw new MigrationError('signature', 'The update key is not a valid key.');
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

/** A signature as the updater's manifest carries it: base64 of a minisign signature file (comment, signature, trusted comment, global signature). */
function parseSignature(base64) {
  const lines = decodeText(base64).split(/\r?\n/);
  const sig = Buffer.from(lines[1] || '', 'base64');
  const trusted = (lines[2] || '').startsWith('trusted comment: ') ? lines[2].slice('trusted comment: '.length) : null;
  const globalSig = Buffer.from(lines[3] || '', 'base64');
  const algorithm = sig.subarray(0, 2).toString();
  if (sig.length !== 74 || !['ED', 'Ed'].includes(algorithm) || trusted === null || globalSig.length !== 64) throw new MigrationError('signature', 'The installer\'s signature is malformed.');
  return { algorithm, keyId: sig.subarray(2, 10), signature: sig.subarray(10), trusted, globalSignature: globalSig };
}

/**
 * Throws a MigrationError('signature') unless `data` carries a valid signature from `publicKey`, made for exactly this file name and version (the signature's
 * trusted comment is signed too, so an old installer cannot be passed off as a new one). Returns true.
 */
function verifySignature({ data, signature, publicKey, file, version }) {
  const key = parsePublicKey(publicKey);
  const sig = parseSignature(signature);
  if (!sig.keyId.equals(key.keyId)) throw new MigrationError('signature', 'The installer is signed with a key VoxelPort does not use.');
  const message = sig.algorithm === 'ED' ? blake2b512(data) : data;
  if (!verifyEd25519(message, sig.signature, key.key)) throw new MigrationError('signature', 'The installer\'s signature does not match the file.');
  if (!verifyEd25519(Buffer.concat([sig.signature, Buffer.from(sig.trusted, 'utf8')]), sig.globalSignature, key.key)) throw new MigrationError('signature', 'The installer\'s signature has been altered.');
  const fields = Object.fromEntries(sig.trusted.split('\t').map((part) => { const i = part.indexOf(':'); return i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)]; }));
  if (fields.file !== file) throw new MigrationError('signature', 'The signature is for a different file.');
  if (fields.version !== version) throw new MigrationError('signature', 'The signature is for a different version.');
  return true;
}

// ─── The manifest ─────────────────────────────────────────────────────────────────────────────────────────────

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const INSTALLER_NAME = /^VoxelPort_[0-9A-Za-z.\-]+_x64-setup\.exe$/;

/** Only an installer attached to a release of this project, named the way the build names it, for the version the manifest announces. */
function isAllowedInstallerUrl(urlText, version) {
  let url;
  try { url = new URL(urlText); } catch { return false; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.search || url.hash) return false;
  const parts = url.pathname.split('/');
  // ['', 'VOXELPORT', 'VoxelPort-App', 'releases', 'download', 'v<version>', '<file>']
  return parts.length === 7 && parts[1] === 'VOXELPORT' && parts[2] === 'VoxelPort-App' && parts[3] === 'releases' && parts[4] === 'download'
    && parts[5] === `v${version}` && INSTALLER_NAME.test(parts[6]) && parts[6] === `VoxelPort_${version}_x64-setup.exe`;
}

/** The Windows entry of the new app's update manifest, or a MigrationError('manifest'). `allowAnyUrl` is for the tests' stand-in server only. */
function parseManifest(json, { allowAnyUrl = false } = {}) {
  const entry = json && json.platforms && json.platforms['windows-x86_64'];
  if (!json || typeof json.version !== 'string' || !VERSION.test(json.version) || !entry || typeof entry.url !== 'string' || typeof entry.signature !== 'string') {
    throw new MigrationError('manifest', 'The update manifest is not in the expected form.');
  }
  if (!allowAnyUrl && !isAllowedInstallerUrl(entry.url, json.version)) throw new MigrationError('manifest', 'The installer address in the manifest is not one VoxelPort uses.');
  return { version: json.version, url: entry.url, signature: entry.signature, file: decodeURIComponent(entry.url.split('/').pop() || '') };
}

// ─── Which kind of copy is this? ──────────────────────────────────────────────────────────────────────────────

/**
 * 'installed' (an NSIS install: can do all of it), 'portable' (brings the data over, cannot remove itself), 'store' (the Store does not allow it: points to
 * the download page), or 'none' (not Windows, or a development run: the new app is Windows-only, and a development run must never remove anything).
 */
function detectMode({ platform, isPackaged, windowsStore, env, execPath, fs = fsDefault }) {
  if (platform !== 'win32') return 'none';
  if (windowsStore) return 'store';
  if (!isPackaged) return 'none';
  if (env && env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  return fs.existsSync(uninstallerPath(execPath)) ? 'installed' : 'portable';
}

const uninstallerPath = (execPath) => path.join(path.dirname(execPath), 'Uninstall VoxelPort.exe');

// ─── Removing this app, after it has quit ─────────────────────────────────────────────────────────────────────

// Run by PowerShell once this app has exited: waits for it, runs the old uninstaller silently, waits until the old program is gone, then puts back any
// shortcut the uninstaller removed (the old and the new app use the same shortcut names, and the old uninstaller deletes by name) pointing at the new app.
// Every value arrives as its own argument, never pasted into the script.
const REMOVAL_SCRIPT = `# Every value arrives in an environment variable (VP_*), so no path is ever pasted into a command line or into this text.
$OldPid = 0
[void][int]::TryParse($env:VP_OLD_PID, [ref]$OldPid)
$Uninstaller = $env:VP_UNINSTALLER
$OldExe = $env:VP_OLD_EXE
$NewExe = $env:VP_NEW_EXE
$Desktop = $env:VP_DESKTOP
$StartMenu = $env:VP_START_MENU
$Log = $env:VP_LOG
$ErrorActionPreference = 'Continue'
function Say([string]$text) { if ($Log) { Add-Content -LiteralPath $Log -Value ("{0:o} {1}" -f (Get-Date), $text) } }
Say "waiting for the old app (pid $OldPid) to exit"
if ($OldPid -gt 0) { try { Wait-Process -Id $OldPid -Timeout 90 -ErrorAction SilentlyContinue } catch { } }
$had = @{}
foreach ($shortcut in @($Desktop, $StartMenu)) { if ($shortcut) { $had[$shortcut] = Test-Path -LiteralPath $shortcut } }
Say "running the uninstaller"
try { Start-Process -FilePath $Uninstaller -ArgumentList '/S' -WindowStyle Hidden } catch { Say "could not start the uninstaller: $_"; exit 1 }
$end = (Get-Date).AddSeconds(90)
while ((Test-Path -LiteralPath $OldExe) -and ((Get-Date) -lt $end)) { Start-Sleep -Milliseconds 500 }
Start-Sleep -Seconds 1
if (Test-Path -LiteralPath $OldExe) { Say "the old program is still there"; exit 2 }
Say "the old program is gone"
if (Test-Path -LiteralPath $NewExe) {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in $had.Keys) {
    if ($had[$shortcut] -and -not (Test-Path -LiteralPath $shortcut)) {
      try {
        $link = $shell.CreateShortcut($shortcut)
        $link.TargetPath = $NewExe
        $link.WorkingDirectory = Split-Path -Parent $NewExe
        $link.Save()
        Say "put back $shortcut"
      } catch { Say "could not put back \${shortcut}: $_" }
    }
  }
}
Say "done"
`;

// How the removal is started. Two things found by running it for real on Windows:
//  - Node ties every child it starts (unless detached) to a job that ends when this app exits, so a plain child would be killed with the app, just as it
//    starts waiting for it. A process started BY that child is outside the job. So this starts a short-lived PowerShell whose only job is to start the real
//    script as a new process and return.
//  - `detached` is no way out: it starts PowerShell without a console, and it then exits without running anything.
// The values go in environment variables (inherited by the script), so no path is ever pasted into a command line or a command.
const LAUNCHER = "Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('\"' + $env:VP_SCRIPT + '\"'))";

function removalInvocation({ script, oldPid, uninstaller, oldExe, newExe, desktop, startMenu, log }, baseEnv) {
  return {
    file: path.join(baseEnv.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(LAUNCHER, 'utf16le').toString('base64')],
    env: { ...baseEnv, VP_SCRIPT: script, VP_OLD_PID: String(oldPid), VP_UNINSTALLER: uninstaller, VP_OLD_EXE: oldExe, VP_NEW_EXE: newExe, VP_DESKTOP: desktop || '', VP_START_MENU: startMenu || '', VP_LOG: log || '' },
  };
}

// ─── The flow ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 *   fetch, spawn, fs, env, platform, isPackaged, windowsStore, execPath, pid
 *   manifestUrl, publicKey            (the real ones unless a development run says otherwise)
 *   installDir                        where the new app is installed (default %LOCALAPPDATA%\VoxelPort)
 *   newAppDataDir                     the new app's data folder (default %APPDATA%\in.voxelport.app)
 *   shortcuts { desktop, startMenu }  the old app's shortcuts, to be put back pointing at the new app
 *   tmpDir                            where the verified installer and the removal script are written
 *   beforeInstall()                   async: stop the server and public address (called after the download is verified; may throw to cancel)
 *   quit()                            ends this app (called a moment after the removal has been handed over)
 *   timeouts { install, handoff, quitDelay, poll }  milliseconds
 * Emits 'progress' ({ phase, percent?, version? }) with phase one of: checking, downloading, verifying, stopping, installing, importing, removing, done.
 */
function createMigration(o) {
  const fs = o.fs || fsDefault;
  const env = o.env || process.env;
  const timeouts = { install: 180000, handoff: 120000, quitDelay: 3000, poll: 400, ...(o.timeouts || {}) };
  const manifestUrl = o.manifestUrl || MANIFEST_URL;
  const publicKey = o.publicKey || PUBLIC_KEY;
  const events = new EventEmitter();
  const emit = (event) => events.emit('progress', event);
  const mode = () => detectMode({ platform: o.platform, isPackaged: o.isPackaged, windowsStore: o.windowsStore, env, execPath: o.execPath, fs });
  const installDir = () => o.installDir || path.join(env.LOCALAPPDATA || '', 'VoxelPort');
  const newAppDataDir = () => o.newAppDataDir || path.join(env.APPDATA || '', NEW_APP_DATA_FOLDER);
  const manifestOptions = { allowAnyUrl: Boolean(o.allowAnyUrl) };

  let cache = null; // { at, manifest | null }
  let running = false;

  async function loadManifest({ force = false } = {}) {
    const age = cache ? Date.now() - cache.at : Infinity;
    if (!force && cache && age < (cache.manifest ? MANIFEST_TTL_MS : MANIFEST_RETRY_MS)) {
      if (cache.manifest) return cache.manifest;
      throw cache.error;
    }
    try {
      const response = await o.fetch(manifestUrl, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'VoxelPort-App' } });
      if (!response.ok) throw new MigrationError('manifest', `The update manifest answered ${response.status}.`);
      const manifest = parseManifest(await response.json(), manifestOptions);
      cache = { at: Date.now(), manifest };
      return manifest;
    } catch (err) {
      const error = err instanceof MigrationError ? err : new MigrationError('manifest', 'Could not read the update manifest.');
      cache = { at: Date.now(), manifest: null, error };
      throw error;
    }
  }

  /** What the screen needs: is there anything to offer (only when the new app is really published), and what this copy can do about it. */
  async function info() {
    const kind = mode();
    if (kind === 'none') return { available: false, mode: kind };
    try {
      const manifest = await loadManifest();
      return { available: true, mode: kind, version: manifest.version, canInstall: kind === 'installed' || kind === 'portable', downloadPage: DOWNLOAD_PAGE };
    } catch {
      return { available: false, mode: kind };
    }
  }

  async function download(manifest) {
    emit({ phase: 'downloading', percent: 0, version: manifest.version });
    let response;
    try {
      response = await o.fetch(manifest.url, { redirect: 'follow', signal: AbortSignal.timeout(300000), headers: { 'user-agent': 'VoxelPort-App' } });
    } catch { throw new MigrationError('download', 'Could not reach the download.'); }
    if (!response.ok) throw new MigrationError('download', `The download answered ${response.status}.`);
    // A redirect may only lead to GitHub's own file hosts.
    if (!o.allowAnyUrl) {
      let final;
      try { final = new URL(response.url || manifest.url); } catch { throw new MigrationError('download', 'The download address was odd.'); }
      const host = final.hostname.toLowerCase();
      if (final.protocol !== 'https:' || !(host === 'github.com' || host.endsWith('.githubusercontent.com'))) throw new MigrationError('download', 'The download was sent somewhere VoxelPort does not use.');
    }
    const total = Number(response.headers.get('content-length')) || 0;
    if (total > MAX_INSTALLER_BYTES) throw new MigrationError('download', 'The download is larger than expected.');
    const chunks = [];
    let got = 0;
    let lastPercent = -1;
    try {
      for await (const chunk of response.body) {
        got += chunk.length;
        if (got > MAX_INSTALLER_BYTES) throw new MigrationError('download', 'The download is larger than expected.');
        chunks.push(Buffer.from(chunk));
        const percent = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
        if (percent !== lastPercent) { lastPercent = percent; emit({ phase: 'downloading', percent, version: manifest.version }); }
      }
    } catch (err) {
      throw err instanceof MigrationError ? err : new MigrationError('download', 'The download was interrupted.');
    }
    return Buffer.concat(chunks);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function runInstaller(file) {
    return new Promise((resolve, reject) => {
      const args = ['/S', ...(o.installerArgs || [])]; // installerArgs: only a development run's stand-in setup (such as /NS) ever sets it
      if (o.installDir) args.push(`/D=${o.installDir}`); // must be last, unquoted (NSIS)
      let child;
      try { child = o.spawn(file, args, { env, windowsHide: true, stdio: 'ignore' }); } catch (err) { reject(new MigrationError('install', 'Windows would not start the installer.', { blocked: true })); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new MigrationError('install', 'The installer took too long.')); }, timeouts.install);
      child.once('error', () => { clearTimeout(timer); reject(new MigrationError('install', 'Windows would not start the installer.', { blocked: true })); });
      child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new MigrationError('install', `The installer stopped with code ${code}.`)); });
    });
  }

  async function waitForHandoff(file) {
    const end = Date.now() + timeouts.handoff;
    while (Date.now() < end) {
      let body = null;
      try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not written yet */ }
      if (body && typeof body.ok === 'boolean') return body;
      await sleep(timeouts.poll);
    }
    throw new MigrationError('timeout', 'The new VoxelPort did not answer in time.');
  }

  function scheduleRemoval(newExe) {
    const script = path.join(o.tmpDir, 'voxelport-remove-old.ps1');
    fs.writeFileSync(script, REMOVAL_SCRIPT, 'utf8');
    const invocation = removalInvocation({
      script, oldPid: o.pid, uninstaller: o.uninstaller || uninstallerPath(o.execPath), oldExe: o.execPath, newExe,
      desktop: o.shortcuts && o.shortcuts.desktop, startMenu: o.shortcuts && o.shortcuts.startMenu, log: path.join(o.tmpDir, 'voxelport-remove-old.log'),
    }, env);
    // Whatever PowerShell says, and any failure to start it, goes to a file next to the script: this runs after the app is gone, so nobody could see it otherwise.
    const out = path.join(o.tmpDir, 'voxelport-remove-old.out');
    let fd = null;
    try { fd = fs.openSync(out, 'a'); } catch { /* no log: still do the work */ }
    const child = o.spawn(invocation.file, invocation.args, { windowsHide: true, stdio: fd === null ? 'ignore' : ['ignore', fd, fd], env: invocation.env });
    child.on('error', (err) => { try { fs.appendFileSync(out, `could not start PowerShell: ${err.message}
`); } catch { /* nothing more to do */ } });
    child.unref();
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }

  /** Does everything. Resolves (never rejects) with { ok: true, mode, version } or { ok: false, step, error, installed }. */
  async function start() {
    if (running) return { ok: false, step: 'busy', error: 'Already working on it.' };
    const kind = mode();
    if (kind !== 'installed' && kind !== 'portable') return { ok: false, step: 'unsupported', error: 'This copy cannot install the new VoxelPort by itself.' };
    running = true;
    let installed = false;
    try {
      emit({ phase: 'checking' });
      const manifest = await loadManifest({ force: true });
      const data = await download(manifest);
      emit({ phase: 'verifying', version: manifest.version });
      verifySignature({ data, signature: manifest.signature, publicKey, file: manifest.file, version: manifest.version });

      emit({ phase: 'stopping', version: manifest.version });
      if (o.beforeInstall) await o.beforeInstall();

      // Only now does anything touch the disk: the verified installer, written where nothing else is.
      fs.mkdirSync(o.tmpDir, { recursive: true });
      const installer = path.join(o.tmpDir, manifest.file);
      fs.writeFileSync(installer, data);
      const handoff = path.join(newAppDataDir(), HANDOFF_FILE);
      try { fs.rmSync(handoff, { force: true }); } catch { /* none */ }

      emit({ phase: 'installing', version: manifest.version });
      await runInstaller(installer);
      installed = true;
      const newExe = path.join(installDir(), NEW_APP_EXE);
      if (!fs.existsSync(newExe)) throw new MigrationError('install', 'The new VoxelPort was not found after installing.', { installed: true });

      emit({ phase: 'importing', version: manifest.version });
      try {
        const child = o.spawn(newExe, [FLAG], { detached: true, windowsHide: false, stdio: 'ignore', env });
        child.once('error', () => { /* reported through the missing answer below */ });
        child.unref();
      } catch { throw new MigrationError('launch', 'The new VoxelPort would not start.', { installed: true }); }
      const answer = await waitForHandoff(handoff);
      if (!answer.ok) throw new MigrationError('import', typeof answer.error === 'string' ? answer.error : 'Your data could not be brought over.', { installed: true });

      const result = { ok: true, mode: kind, version: manifest.version, identity: answer.identity || null };
      if (kind === 'installed') {
        emit({ phase: 'removing', version: manifest.version });
        scheduleRemoval(newExe);
        emit({ phase: 'done', mode: kind, version: manifest.version });
        if (o.quit) setTimeout(() => o.quit(), timeouts.quitDelay).unref?.();
      } else {
        emit({ phase: 'done', mode: kind, version: manifest.version });
      }
      return result;
    } catch (err) {
      const e = err instanceof MigrationError ? err : new MigrationError('install', String((err && err.message) || err));
      return { ok: false, step: e.step, error: e.message, installed: Boolean(e.installed || installed), blocked: Boolean(e.blocked) };
    } finally {
      running = false;
    }
  }

  return { info, start, mode, on: (event, fn) => events.on(event, fn) };
}

module.exports = {
  createMigration, detectMode, parseManifest, isAllowedInstallerUrl, verifySignature, blake2b512, parsePublicKey, parseSignature,
  MigrationError, REMOVAL_SCRIPT, LAUNCHER, removalInvocation, MANIFEST_URL, PUBLIC_KEY, DOWNLOAD_PAGE, FLAG, HANDOFF_FILE, NEW_APP_EXE, uninstallerPath,
};

'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Tunnel } = require('./tunnel');
const { loadOrCreateToken, maskToken } = require('./token');
const mcVersions = require('./mcVersions');
const { checkJava, requiredJavaMajor, requiredJavaFromLog } = require('./javaCheck');
const { installJava, findManagedJava } = require('./javaInstall');
const {
  getServerDir, downloadServerJar, writeEula, writeServerProperties,
  detectExistingServer, updateServerPropertiesSafely,
} = require('./serverInstall');
const { ServerProcess } = require('./serverProcess');
const { Updater } = require('./updater');
const serverProfiles = require('./serverProfiles');
const { isSafeRelayUrl } = require('./relayUrlSafety');
const { isApprovedExternalUrl } = require('./externalLinkSafety');
const { guarded } = require('./ipcSenders');
const serverSettings = require('./serverSettings');
const { explainCrash } = require('./crashExplain');
const {
  PerfMonitor, supportsTickQuery, isTickQueryLine, parseMspt, tpsFromMspt, LAG_RE,
} = require('./perfMonitor');
const { bedrockSupported, installBedrockSupport, removeBedrockSupport, bedrockPort } = require('./bedrock');

const DEFAULT_RELAY_URL = 'wss://relay.voxelport.in';
// Tried first when no custom relay is set: same relay, reached directly
// instead of through Cloudflare (which routes some Indian ISPs via
// Singapore, adding ~130 ms). Falls back to DEFAULT_RELAY_URL if blocked.
const DIRECT_RELAY_URL = 'wss://direct.voxelport.in:26499';
const PUBLIC_HOST = 'play.voxelport.in';
const STOP_WAIT_TIMEOUT_MS = 25000; // a little past ServerProcess's own 20s force-kill grace

let mainWindow = null;
let tunnel = null;
let deviceToken = '';
let tokenEncryptedAtRest = false;
const serverProc = new ServerProcess();
const updater = new Updater();

// ─── Explicit, always-accurate app state (item 8) ──────────────────────────
// activeServerProfileId: which managed profile's child process is running (or null).
// publicServerProfileId: which managed profile the tunnel is currently pointed at (or null).
// manualTunnelActive: true when the running tunnel belongs to the manual-tunnel flow, not a profile.
let activeServerProfileId = null;
let publicServerProfileId = null;
let manualTunnelActive = false;

// The custom address (steve.voxelport.in) belongs to this install's device
// token, not to one server: whichever server is public uses it. The relay
// re-announces it on every connection; this copy just lets the UI show it
// while nothing is public.
let customAddress = { name: '', address: '' };
function customAddressPath() {
  return path.join(userDataDir(), 'custom-address.json');
}
function loadCustomAddress() {
  try {
    const v = JSON.parse(fs.readFileSync(customAddressPath(), 'utf8'));
    if (v && typeof v.name === 'string' && typeof v.address === 'string') customAddress = { name: v.name, address: v.address };
  } catch { /* none yet */ }
}
function saveCustomAddress() {
  try { fs.writeFileSync(customAddressPath(), JSON.stringify(customAddress)); } catch { /* best-effort */ }
}
function userDataDir() {
  return app.getPath('userData');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 800,
    minWidth: 540,
    minHeight: 640,
    backgroundColor: '#F3EBDC',
    title: 'VoxelPort',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Item 15/16: the renderer must never navigate away from packaged local
  // content, and window.open()/target=_blank must never spawn a new
  // VoxelPort-preload-capable window. External links only ever reach
  // shell.openExternal, and only after the same domain allowlist used
  // everywhere else in this file.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = (() => { try { return new URL(url); } catch { return null; } })();
    const current = mainWindow.webContents.getURL();
    if (target && target.protocol === 'file:' && url === current) return; // internal reloads
    event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isApprovedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// True while server:start is fetching Java before launching the process —
// shown to the UI as "starting" so the server doesn't look idle meanwhile.
let preparingJava = false;
function currentServerStatus() {
  return preparingJava ? 'starting' : serverProc.status;
}

function broadcastState() {
  send('app:state', {
    activeServerProfileId,
    publicServerProfileId,
    manualTunnelActive,
    serverStatus: currentServerStatus(),
  });
}

function wireTunnel(t) {
  t.on('status', (s) => send('tunnel:status', s));
  t.on('assigned', (port) => send('tunnel:assigned', { port, host: PUBLIC_HOST }));
  t.on('players', (n) => send('tunnel:players', n));
  t.on('ping', (ms) => send('tunnel:ping', ms));
  t.on('log', (line) => send('tunnel:log', line));
  t.on('error', (message) => send('tunnel:error', message));
  t.on('name', (n) => {
    customAddress = { name: n.name, address: n.address };
    saveCustomAddress();
    send('tunnel:name', customAddress);
  });
  t.on('nameError', (message) => send('tunnel:nameError', message));
  t.on('listingError', (message) => send('server:log', `[VoxelPort] Server list: ${message}`));
  t.on('udpError', (message) => send('server:log', `[VoxelPort] ${message}`));
  t.on('stopped', () => {
    send('tunnel:status', 'stopped');
    publicServerProfileId = null;
    manualTunnelActive = false;
    broadcastState();
  });
}

// Watches the running server's output for "needs Java N" errors, so a
// version our requirement table doesn't know yet still gets fixed: on a
// failed exit, the right Java is installed, remembered on the profile, and
// the server restarted once.
let javaWatch = null; // { profileId, usedMajor, neededMajor, retried }

// Recent console lines, for crash explanations.
const RECENT_LINES = 400;
let recentLines = [];
// True once the user (or a switch) asked the server to stop — such exits
// aren't crashes and get no explanation.
let stopRequested = false;

// Performance panel: CPU/RAM from the OS, TPS from a hidden `tick query`.
const perf = new PerfMonitor();
let perfState = { cpuPercent: null, memMb: null, tps: null, mspt: null, lagWarnings: 0 };
let tickTimer = null;
let tickQueryAt = 0;
let tickMisses = 0;
const TICK_QUERY_EVERY_MS = 10000;
const TICK_QUERY_WINDOW_MS = 3000;

function sendPerf() {
  const profile = activeServerProfileId ? serverProfiles.getProfile(userDataDir(), activeServerProfileId) : null;
  send('perf:sample', { ...perfState, maxRamMb: profile ? profile.maxRamMb : null });
}
perf.on('sample', (s) => {
  perfState.cpuPercent = s.cpuPercent;
  perfState.memMb = s.memMb;
  sendPerf();
});

function startTickPolling(profile) {
  stopTickPolling();
  if (!supportsTickQuery(profile.version)) return;
  tickMisses = 0;
  tickTimer = setInterval(() => {
    if (serverProc.status !== 'online') return;
    if (tickQueryAt && perfState.mspt === null) tickMisses++;
    if (tickMisses >= 3) { stopTickPolling(); return; } // this server has no /tick
    tickQueryAt = Date.now();
    serverProc.sendCommand('tick query');
  }, TICK_QUERY_EVERY_MS);
}
function stopTickPolling() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  tickQueryAt = 0;
}

function wireServerProcess(p) {
  p.on('status', (s) => {
    send('server:status', s);
    broadcastState();
    if (s === 'online') {
      const profile = activeServerProfileId ? serverProfiles.getProfile(userDataDir(), activeServerProfileId) : null;
      if (profile) startTickPolling(profile);
    }
  });
  p.on('log', (line) => {
    recentLines.push(line);
    if (recentLines.length > RECENT_LINES) recentLines = recentLines.slice(-RECENT_LINES);
    if (tickQueryAt && Date.now() - tickQueryAt < TICK_QUERY_WINDOW_MS && isTickQueryLine(line)) {
      const mspt = parseMspt(line);
      if (mspt !== null) {
        perfState.mspt = mspt;
        perfState.tps = tpsFromMspt(mspt);
        tickMisses = 0;
        sendPerf();
      }
      return; // our own query — keep it out of the console
    }
    if (LAG_RE.test(line)) { perfState.lagWarnings++; sendPerf(); }
    send('server:log', line);
    if (javaWatch) {
      const need = requiredJavaFromLog(line);
      if (need && need > (javaWatch.usedMajor || 0)) javaWatch.neededMajor = Math.max(javaWatch.neededMajor || 0, need);
    }
  });
  p.on('players', (n) => {
    send('server:players', n);
    scheduleListingUpdate();
  });
  p.on('exit', (code) => {
    perf.stop();
    stopTickPolling();
    const exitedProfileId = activeServerProfileId;
    send('server:exit', code);
    if (activeServerProfileId && publicServerProfileId === activeServerProfileId) {
      // The managed server backing the public tunnel died — the tunnel
      // still technically runs but has nothing to bridge to; stop it too
      // rather than leaving a misleading "public" state.
      if (tunnel) tunnel.stop();
    }
    activeServerProfileId = null;
    broadcastState();

    const watch = javaWatch;
    javaWatch = null;
    const javaFix = code !== 0 && watch && watch.neededMajor && !watch.retried;
    if (!stopRequested && !javaFix && exitedProfileId) {
      const profile = serverProfiles.getProfile(userDataDir(), exitedProfileId);
      const items = explainCrash(recentLines.slice(-200), { port: profile && profile.port, crashed: code !== 0 });
      if (items.length) send('server:diagnosis', { profileId: exitedProfileId, items });
    }
    if (code !== 0 && watch && watch.neededMajor) {
      if (watch.retried) {
        send('server:log', `[VoxelPort] The server still reports it needs Java ${watch.neededMajor}. Please check the server files.`);
        return;
      }
      send('server:log', `[VoxelPort] This server needs Java ${watch.neededMajor} — fixing that and restarting…`);
      try {
        serverProfiles.updateProfile(userDataDir(), watch.profileId, { javaMajor: watch.neededMajor });
      } catch { /* profile was removed meanwhile */ }
      startServerProfile(watch.profileId, { retried: true }).then((res) => {
        if (res && !res.ok && res.error) send('server:log', `[VoxelPort] ${res.error}`);
      });
    }
  });
}
wireServerProcess(serverProc);

function wireUpdater(u) {
  u.on('available', (version) => send('update:available', version));
  u.on('downloaded', (version) => send('update:downloaded', version));
  u.on('error', (message) => send('update:error', message));
}
wireUpdater(updater);

/** ~2GB reserved for the OS, then a tiered slice of what's left. */
function recommendedRamMb(totalMemMb) {
  if (totalMemMb <= 4096) return 1024;
  if (totalMemMb <= 8192) return 3072;
  if (totalMemMb <= 16384) return 6144;
  return 8192;
}

function waitForServerStopped(timeoutMs) {
  if (!serverProc.child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { serverProc.off('exit', onExit); resolve(); }, timeoutMs);
    function onExit() { clearTimeout(timer); resolve(); }
    serverProc.once('exit', onExit);
  });
}

function waitForTunnelStopped(timeoutMs) {
  if (!tunnel || !tunnel.running) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { tunnel && tunnel.off('stopped', onStopped); resolve(); }, timeoutMs);
    function onStopped() { clearTimeout(timer); resolve(); }
    tunnel.once('stopped', onStopped);
  });
}

// One VoxelPort instance per machine. A second copy would share the same device
// token and fight the first for the single tunnel that token is allowed — an
// endless reconnect war. Instead, focus the window that's already running.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const loaded = loadOrCreateToken(userDataDir(), safeStorage);
    deviceToken = loaded.token;
    tokenEncryptedAtRest = loaded.encryptedAtRest;
    loadCustomAddress();
    createWindow();
    updater.start({ isPackaged: app.isPackaged, platform: process.platform, windowsStore: Boolean(process.windowsStore) });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  updater.stop();
  perf.stop();
  stopTickPolling();
  if (tunnel) tunnel.stop();
  stopRequested = true;
  if (serverProc.child) serverProc.stop();
  if (process.platform !== 'darwin') app.quit();
});

const g = () => mainWindow;

// ─── App info / token (item 12/13) ─────────────────────────────────────────

ipcMain.handle('app:info', guarded(g, () => ({
  publicHost: PUBLIC_HOST,
  defaultRelayUrl: DEFAULT_RELAY_URL,
  maskedToken: maskToken(deviceToken),
  tokenEncryptedAtRest,
  version: app.getVersion(),
})));

// The raw token never crosses into the renderer at all — copying goes
// straight from the main process to the OS clipboard.
ipcMain.handle('token:copy', guarded(g, () => {
  clipboard.writeText(deviceToken);
  return { ok: true };
}));

// ─── Auto-update ────────────────────────────────────────────────────────────

ipcMain.handle('update:state', guarded(g, () => ({ readyToInstall: updater.readyToInstall })));

// Applying a downloaded update quits and relaunches the app — never do that
// silently while a managed server is running or the tunnel is public
// without asking first, same as any other switch/stop in this app.
ipcMain.handle('update:install', guarded(g, async () => {
  if (!updater.readyToInstall) return { ok: false };

  if (serverProc.child || (tunnel && tunnel.running)) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'Restart & Update'],
      defaultId: 1,
      cancelId: 0,
      message: serverProc.child
        ? 'A managed server is currently running.'
        : 'The VoxelPort tunnel is currently public.',
      detail: 'Restarting to install the update will stop it. Continue?',
    });
    if (response !== 1) return { ok: false, cancelled: true };
  }

  updater.install();
  return { ok: true };
}));

// ─── Tunnel (single global instance, item 7) ───────────────────────────────

/** The public server-list entry for a profile, or null if it isn't opted in. */
function buildListing(profile) {
  if (!profile || !profile.listing || !profile.listing.enabled) return null;
  const values = serverSettings.readSettings(profile.serverDir);
  return {
    title: profile.name,
    description: profile.listing.description || values.motd || '',
    version: profile.version,
    mode: serverSettings.listingMode(values, profile.type),
    players: activeServerProfileId === profile.id ? serverProc.online.size : 0,
    max_players: values['max-players'],
    bedrock: Boolean(profile.bedrock),
  };
}

let listingTimer = null;
function scheduleListingUpdate() {
  if (listingTimer || !tunnel || !publicServerProfileId) return;
  listingTimer = setTimeout(() => {
    listingTimer = null;
    if (!tunnel || !publicServerProfileId) return;
    tunnel.setListing(buildListing(serverProfiles.getProfile(userDataDir(), publicServerProfileId)));
  }, 5000);
}

async function startTunnelInternal({ localPort, relayUrl, profileId, udpPort = null }) {
  const port = Number(localPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    send('tunnel:error', 'Enter a valid local port (1–65535).');
    return { ok: false };
  }
  const resolvedRelayUrl = (relayUrl && relayUrl.trim()) || DEFAULT_RELAY_URL;
  if (!isSafeRelayUrl(resolvedRelayUrl)) {
    send('tunnel:error', 'Relay URL must be wss:// (plain ws:// is only allowed for localhost/private addresses).');
    return { ok: false };
  }

  if (tunnel && tunnel.running) {
    const currentlyManual = manualTunnelActive;
    const currentProfile = publicServerProfileId ? serverProfiles.getProfile(userDataDir(), publicServerProfileId) : null;
    const targetProfile = profileId ? serverProfiles.getProfile(userDataDir(), profileId) : null;
    const sameTarget = (profileId && publicServerProfileId === profileId) || (!profileId && currentlyManual && !targetProfile);
    if (!sameTarget) {
      const currentLabel = currentProfile ? currentProfile.name : (currentlyManual ? 'The manual tunnel' : 'The current tunnel');
      const targetLabel = targetProfile ? targetProfile.name : 'the server you already run manually';
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Cancel', 'Switch'],
        defaultId: 1,
        cancelId: 0,
        message: `${currentLabel} is currently public.`,
        detail: `Switch the VoxelPort tunnel to ${targetLabel}?`,
      });
      if (response !== 1) return { ok: false, cancelled: true };
      tunnel.stop();
      await waitForTunnelStopped(10000);
    } else {
      return { ok: true, alreadyRunning: true };
    }
  }

  tunnel = new Tunnel();
  wireTunnel(tunnel);
  const usingDefault = resolvedRelayUrl.replace(/\/+$/, '') === DEFAULT_RELAY_URL;
  const relayUrls = usingDefault ? [DIRECT_RELAY_URL, DEFAULT_RELAY_URL] : [resolvedRelayUrl];
  if (profileId) tunnel.setListing(buildListing(serverProfiles.getProfile(userDataDir(), profileId)));
  tunnel.start({ relayUrls, token: deviceToken, localPort: port, udpPort });
  publicServerProfileId = profileId || null;
  manualTunnelActive = !profileId;
  broadcastState();
  return { ok: true };
}

ipcMain.handle('tunnel:start', guarded(g, (_evt, { localPort, relayUrl }) =>
  startTunnelInternal({ localPort, relayUrl, profileId: null })
));

ipcMain.handle('server:makePublic', guarded(g, (_evt, { id }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  if (activeServerProfileId !== id) {
    return { ok: false, error: 'Start this server before making it public.' };
  }
  const udpPort = profile.bedrock ? bedrockPort(profile.serverDir) : null;
  return startTunnelInternal({ localPort: profile.port, relayUrl: DEFAULT_RELAY_URL, profileId: id, udpPort });
}));

ipcMain.handle('tunnel:stop', guarded(g, () => {
  if (tunnel) {
    tunnel.stop();
    tunnel = null;
  }
  publicServerProfileId = null;
  manualTunnelActive = false;
  broadcastState();
  return { ok: true };
}));

// ─── Server profiles (Part A) ───────────────────────────────────────────────

ipcMain.handle('server:profiles:list', guarded(g, () => serverProfiles.listProfiles(userDataDir())));
ipcMain.handle('server:profiles:get', guarded(g, (_evt, { id }) => serverProfiles.getProfile(userDataDir(), id)));

ipcMain.handle('server:profiles:update', guarded(g, (_evt, { id, changes }) => {
  const safeChanges = {};
  if (typeof changes.name === 'string') safeChanges.name = changes.name;
  if (changes.port !== undefined) safeChanges.port = changes.port;
  if (changes.minRamMb !== undefined) safeChanges.minRamMb = changes.minRamMb;
  if (changes.maxRamMb !== undefined) safeChanges.maxRamMb = changes.maxRamMb;
  const updated = serverProfiles.updateProfile(userDataDir(), id, safeChanges);

  // Keep an on-disk server.properties in sync with a changed port without
  // rewriting the whole file (item 26) — best-effort, since an imported
  // server folder may not even have one yet at this point.
  if (safeChanges.port !== undefined) {
    try {
      updateServerPropertiesSafely(updated.serverDir, { 'server-port': updated.port });
    } catch {
      // best-effort
    }
  }
  return updated;
}));

ipcMain.handle('server:profiles:delete', guarded(g, (_evt, { id }) => {
  // "Remove from VoxelPort" only — never touches serverDir.
  if (id === activeServerProfileId || id === publicServerProfileId) {
    return { ok: false, error: 'Stop and un-publish this server before removing it.' };
  }
  const removed = serverProfiles.deleteProfile(userDataDir(), id);
  return { ok: removed };
}));

ipcMain.handle('server:detectExisting', guarded(g, (_evt, { dir }) => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Invalid folder.');
  return detectExistingServer(dir);
}));

ipcMain.handle('server:import', guarded(g, (_evt, { name, type, version, port, minRamMb, maxRamMb, serverDir }) => {
  if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir) || !fs.existsSync(serverDir)) {
    throw new Error('Choose a valid existing server folder.');
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) throw new Error('Enter a valid server port (1–65535).');
  const minRam = Number(minRamMb) || 1024;
  const maxRam = Number(maxRamMb) || minRam;
  if (!serverProfiles.KNOWN_TYPES.has(type)) throw new Error('Unknown server type.');

  // Adoption never installs/downloads/overwrites anything (item 5) — it only
  // records a profile pointing at the folder as-is.
  const profile = serverProfiles.createProfile(userDataDir(), {
    name, type, version: version || 'unknown', serverDir, port: portNum, minRamMb: minRam, maxRamMb: maxRam,
  });
  return { ok: true, profile };
}));

// ─── System / Java ───────────────────────────────────────────────────────

ipcMain.handle('system:specs', guarded(g, () => {
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  return { totalMemMb, recommendedRamMb: recommendedRamMb(totalMemMb) };
}));

/**
 * The Java to use for a Minecraft version: Java that VoxelPort installed
 * itself (if one is new enough), else java on the PATH. Resolves with the
 * checkJava() result plus { required, satisfied, javaPath, managed }.
 */
async function resolveJava(mcVersion, minMajor = 0) {
  const required = Math.max(requiredJavaMajor(mcVersion || '1.20.5'), minMajor);
  const managed = findManagedJava(userDataDir(), required);
  if (managed) {
    const result = await checkJava(managed.javaPath);
    if (result.found && result.major !== null && result.major >= required) {
      return { ...result, required, satisfied: true, javaPath: managed.javaPath, managed: true };
    }
  }
  const result = await checkJava();
  return { ...result, required, satisfied: result.found && result.major !== null && result.major >= required, javaPath: 'java', managed: false };
}

ipcMain.handle('java:check', guarded(g, async (_evt, { version }) => {
  const { javaPath, ...result } = await resolveJava(version); // the path stays in main
  return result;
}));

// One Java install at a time; a second request for the same major joins it.
let javaInstallInFlight = null;
function installJavaOnce(major, onProgress) {
  if (javaInstallInFlight && javaInstallInFlight.major === major) return javaInstallInFlight.promise;
  const promise = installJava({ userDataDir: userDataDir(), major, onProgress })
    .finally(() => { if (javaInstallInFlight && javaInstallInFlight.promise === promise) javaInstallInFlight = null; });
  javaInstallInFlight = { major, promise };
  return promise;
}

ipcMain.handle('java:install', guarded(g, async (_evt, { version }) => {
  const major = requiredJavaMajor(version || '1.20.5');
  try {
    const res = await installJavaOnce(major, (p) => send('java:progress', p));
    return { ok: true, major: res.major };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}));

/** Progress callback that narrates a Java install into the server console. */
function javaProgressToConsole(major) {
  let lastPct = -1;
  return (p) => {
    if (p.stage === 'resolve') send('server:log', `[VoxelPort] Downloading Java ${major} (Eclipse Temurin)…`);
    else if (p.stage === 'download' && p.total) {
      const pct = Math.floor((p.received / p.total) * 100);
      if (pct >= lastPct + 20 || pct === 100) { lastPct = pct; send('server:log', `[VoxelPort] Java download ${pct}%`); }
    } else if (p.stage === 'extract') send('server:log', '[VoxelPort] Unpacking Java…');
    else if (p.stage === 'done') send('server:log', `[VoxelPort] Java ${major} ready.`);
  };
}

ipcMain.handle('java:openDownloadPage', guarded(g, () => {
  const url = 'https://adoptium.net/temurin/releases/';
  if (isApprovedExternalUrl(url)) shell.openExternal(url);
  return { ok: true };
}));

ipcMain.handle('server:types', guarded(g, () => mcVersions.getTypes()));
ipcMain.handle('server:versions', guarded(g, (_evt, { type }) => mcVersions.listVersions(type)));
// A fresh suggested folder per install (not the old fixed single-server
// path) so multiple installed servers never collide unless the user
// explicitly chooses the same folder themselves.
ipcMain.handle('server:defaultDir', guarded(g, () => {
  const slug = crypto.randomBytes(4).toString('hex');
  return path.join(userDataDir(), 'servers', `server-${Date.now()}-${slug}`);
}));

ipcMain.handle('server:chooseFolder', guarded(g, async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for the server files',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}));

// ─── Install (Vanilla/Paper/Fabric) ─────────────────────────────────────────

ipcMain.handle('server:templates', guarded(g, () => serverSettings.TEMPLATES.map((t) => ({
  id: t.id, label: t.label, blurb: t.blurb, type: t.type, bedrock: Boolean(t.bedrock),
}))));

ipcMain.handle('server:install', guarded(g, async (_evt, { name, type, version, port, minRamMb, maxRamMb, serverDir, templateId }) => {
  const template = templateId ? serverSettings.getTemplate(templateId) : null;
  if (templateId && !template) throw new Error('Unknown template.');
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error('Enter a valid server port (1–65535).');
  }
  const minRam = Number(minRamMb);
  const maxRam = Number(maxRamMb);
  if (!Number.isInteger(minRam) || !Number.isInteger(maxRam) || minRam < 256 || maxRam < minRam || maxRam > 131072) {
    throw new Error('Invalid RAM allocation.');
  }
  if (serverDir !== undefined && serverDir !== null && (typeof serverDir !== 'string' || !path.isAbsolute(serverDir))) {
    throw new Error('Invalid server folder.');
  }
  if (!serverProfiles.KNOWN_TYPES.has(type)) throw new Error('Unknown server type.');

  const dir = serverDir || path.join(getServerDir(userDataDir()), '..', 'servers', String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });

  send('install:progress', { phase: 'resolving' });
  const { url, checksum } = await mcVersions.resolveDownload(type, version);

  send('install:progress', { phase: 'downloading', received: 0, total: 0 });
  await downloadServerJar(url, path.join(dir, 'server.jar'), (p) => {
    send('install:progress', { phase: 'downloading', ...p });
  }, checksum);

  writeEula(dir);
  writeServerProperties(dir, { port: portNum, extra: template ? template.properties : {} });

  let profile = serverProfiles.createProfile(userDataDir(), {
    name: name || (template ? template.label : `${type[0].toUpperCase()}${type.slice(1)} server`),
    type, version, serverDir: dir, port: portNum, minRamMb: minRam, maxRamMb: maxRam,
    template: template ? template.id : undefined,
  });

  let warning = null;
  if (template && template.bedrock && bedrockSupported(type)) {
    send('install:progress', { phase: 'bedrock' });
    try {
      await installBedrockSupport({ serverDir: dir, type, version });
      profile = serverProfiles.updateProfile(userDataDir(), profile.id, { bedrock: true });
    } catch (err) {
      warning = `Bedrock support couldn't be added (${err.message}). You can turn it on later in Settings.`;
    }
  }
  send('install:progress', { phase: 'done' });
  return { ok: true, profile, warning };
}));

// ─── Single managed server process (item 6) ─────────────────────────────────

ipcMain.handle('server:start', guarded(g, (_evt, { id }) => startServerProfile(id)));

/**
 * Starts a server profile, first making sure a new-enough Java exists —
 * installing Eclipse Temurin automatically if not. `retried` marks the
 * one automatic restart after a server reported needing a newer Java.
 */
async function startServerProfile(id, { retried = false } = {}) {
  if (preparingJava) return { ok: false, error: 'Already getting Java ready for a server — one moment.' };
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };

  if (serverProc.child && activeServerProfileId !== id) {
    const activeProfile = serverProfiles.getProfile(userDataDir(), activeServerProfileId);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'Switch Server'],
      defaultId: 1,
      cancelId: 0,
      message: `${activeProfile ? activeProfile.name : 'Another server'} is currently running.`,
      detail: `Stop it and start ${profile.name}?`,
    });
    if (response !== 1) return { ok: false, cancelled: true };

    if (publicServerProfileId === activeServerProfileId && tunnel) {
      tunnel.stop();
      await waitForTunnelStopped(10000);
    }
    stopRequested = true;
    serverProc.stop();
    await waitForServerStopped(STOP_WAIT_TIMEOUT_MS);
  } else if (serverProc.child && activeServerProfileId === id) {
    return { ok: true, alreadyRunning: true, port: profile.port };
  }

  serverProfiles.touchProfile(userDataDir(), id);
  activeServerProfileId = id;

  // Prefer the Java VoxelPort installed itself; otherwise java on the PATH.
  // If neither is new enough for this server, fetch the right one first.
  const minMajor = profile.javaMajor || 0;
  let java = await resolveJava(profile.version, minMajor);
  if (!java.satisfied) {
    preparingJava = true;
    broadcastState();
    send('server:log', `[VoxelPort] ${profile.name} needs Java ${java.required}` +
      `${java.found && java.major ? ` (this PC has Java ${java.major})` : ''} — installing it automatically…`);
    try {
      await installJavaOnce(java.required, javaProgressToConsole(java.required));
      java = await resolveJava(profile.version, minMajor);
    } catch (err) {
      java = { satisfied: false, required: java.required, error: err.message };
    } finally {
      preparingJava = false;
    }
    if (!java.satisfied) {
      const error = `Couldn't set up Java ${java.required}${java.error ? `: ${java.error}` : ''}. Check your internet connection and try again.`;
      send('server:log', `[VoxelPort] ${error}`);
      activeServerProfileId = null;
      broadcastState();
      return { ok: false, error };
    }
  }

  javaWatch = { profileId: id, usedMajor: java.major, neededMajor: null, retried };
  stopRequested = false;
  recentLines = [];
  perfState = { cpuPercent: null, memMb: null, tps: null, mspt: null, lagWarnings: 0 };
  serverProc.start({ serverDir: profile.serverDir, minRamMb: profile.minRamMb, maxRamMb: profile.maxRamMb, javaPath: java.javaPath });
  if (serverProc.child && serverProc.child.pid) perf.start(serverProc.child.pid);
  broadcastState();
  return { ok: true, port: profile.port };
}

ipcMain.handle('server:stop', guarded(g, () => {
  stopRequested = true;
  serverProc.stop();
  return { ok: true };
}));

ipcMain.handle('server:command', guarded(g, (_evt, { command }) => {
  serverProc.sendCommand(command);
  return { ok: true };
}));

ipcMain.handle('server:openFolder', guarded(g, (_evt, { id }) => {
  const profile = id ? serverProfiles.getProfile(userDataDir(), id) : null;
  const dir = (profile && profile.serverDir) || getServerDir(userDataDir());
  shell.openPath(dir);
  return { ok: true };
}));

// ─── Settings screen ───────────────────────────────────────────────────────

ipcMain.handle('server:settings:get', guarded(g, (_evt, { id }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) throw new Error('Server profile not found.');
  return {
    profile,
    fields: serverSettings.SETTINGS,
    values: serverSettings.readSettings(profile.serverDir),
    bedrock: { supported: bedrockSupported(profile.type), enabled: Boolean(profile.bedrock), port: bedrockPort(profile.serverDir) },
    listing: profile.listing || { enabled: false, description: '' },
    totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
    running: activeServerProfileId === id && Boolean(serverProc.child),
  };
}));

ipcMain.handle('server:settings:save', guarded(g, (_evt, { id, name, port, ramMb, properties, listing }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) throw new Error('Server profile not found.');

  const props = serverSettings.validateSettings(properties || {});
  const changes = {};
  if (typeof name === 'string' && name.trim()) changes.name = name.trim().slice(0, 60);
  if (port !== undefined) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Enter a valid port (1–65535).');
    changes.port = p;
    props['server-port'] = String(p);
  }
  if (ramMb !== undefined) {
    const r = Number(ramMb);
    if (!Number.isInteger(r) || r < 512 || r > 131072) throw new Error('Invalid RAM amount.');
    changes.minRamMb = r;
    changes.maxRamMb = r;
  }
  if (listing !== undefined) {
    if (!listing || typeof listing.enabled !== 'boolean') throw new Error('Invalid server-list setting.');
    const description = typeof listing.description === 'string' ? listing.description.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) : '';
    changes.listing = { enabled: listing.enabled, description };
  }

  const updated = serverProfiles.updateProfile(userDataDir(), id, changes);
  updateServerPropertiesSafely(updated.serverDir, props);

  if (tunnel && publicServerProfileId === id) tunnel.setListing(buildListing(updated));
  const running = activeServerProfileId === id && Boolean(serverProc.child);
  return { ok: true, profile: updated, restartNeeded: running };
}));

// ─── Bedrock players (Geyser + Floodgate) ─────────────────────────────────

let bedrockBusy = false;
ipcMain.handle('server:bedrock:set', guarded(g, async (_evt, { id, enabled }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  if (bedrockBusy) return { ok: false, error: 'Already setting up Bedrock — one moment.' };
  bedrockBusy = true;
  try {
    if (enabled) {
      if (!bedrockSupported(profile.type)) return { ok: false, error: 'Bedrock players need a Paper or Fabric server.' };
      await installBedrockSupport({
        serverDir: profile.serverDir, type: profile.type, version: profile.version,
        onProgress: (p) => send('bedrock:progress', p),
      });
    } else {
      removeBedrockSupport(profile.serverDir);
    }
    const updated = serverProfiles.updateProfile(userDataDir(), id, { bedrock: Boolean(enabled) });

    // A public tunnel only forwards UDP if it asked for it when connecting.
    if (tunnel && publicServerProfileId === id) {
      tunnel.stop();
      await waitForTunnelStopped(10000);
      tunnel = null;
      publicServerProfileId = null;
      await startTunnelInternal({
        localPort: updated.port, relayUrl: DEFAULT_RELAY_URL, profileId: id,
        udpPort: updated.bedrock ? bedrockPort(updated.serverDir) : null,
      });
    }
    const running = activeServerProfileId === id && Boolean(serverProc.child);
    return { ok: true, profile: updated, restartNeeded: running };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    bedrockBusy = false;
  }
}));

// ─── Custom address (steve.voxelport.in) ──────────────────────────────────

ipcMain.handle('name:get', guarded(g, () => customAddress));

function awaitNameReply(t) {
  return new Promise((resolve) => {
    const done = (res) => {
      clearTimeout(timer);
      t.off('name', onName);
      t.off('nameError', onError);
      resolve(res);
    };
    const onName = (n) => done({ ok: true, ...n });
    const onError = (message) => done({ ok: false, error: message });
    const timer = setTimeout(() => done({ ok: false, error: 'The relay didn\'t answer — try again.' }), 30000);
    t.on('name', onName);
    t.on('nameError', onError);
  });
}

ipcMain.handle('name:claim', guarded(g, async (_evt, { name }) => {
  if (typeof name !== 'string' || name.length > 40) return { ok: false, error: 'Invalid name.' };
  if (!tunnel || !tunnel.running) return { ok: false, error: 'Make a server public first, then pick your address.' };
  const reply = awaitNameReply(tunnel);
  tunnel.claimName(name);
  return reply;
}));

ipcMain.handle('name:release', guarded(g, async () => {
  if (!tunnel || !tunnel.running) return { ok: false, error: 'Make a server public first, then remove your address.' };
  const reply = awaitNameReply(tunnel);
  tunnel.releaseName();
  return reply;
}));

// ─── Fixes offered by crash explanations ──────────────────────────────────

ipcMain.handle('server:fix', guarded(g, (_evt, { id, action }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  if (action === 'eula') {
    writeEula(profile.serverDir);
    return { ok: true };
  }
  return { ok: false, error: 'Unknown fix.' };
}));

ipcMain.handle('server:state', guarded(g, () => ({
  activeServerProfileId,
  publicServerProfileId,
  manualTunnelActive,
  serverStatus: currentServerStatus(),
})));

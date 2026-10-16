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
const accounts = require('./accounts');
const support = require('./support');

const { REGIONS, isRegion, normalizePreference, pickRegion } = require('./regions');
const { NoticeAnnouncer } = require('./notice');
const { DirectMode, directAction, OFF: DIRECT_OFF } = require('./directMode');
const { ElectronRtcWorker } = require('./p2pWorker');
const { P2PHost } = require('./p2pHost');
const { P2PJoin } = require('./p2pJoin');
const { BackupService } = require('./backupService');
const backupsLib = require('./backups');

// "Use VoxelPort's relay" — the region (India / North America) is picked per
// tunnel by regions.js. Any other URL is a self-hosted relay used as-is.
const DEFAULT_RELAY_URL = 'wss://relay.voxelport.in';
const PUBLIC_HOST = REGIONS.in.publicHost;
const STOP_WAIT_TIMEOUT_MS = 25000; // a little past ServerProcess's own 20s force-kill grace

let mainWindow = null;
let tunnel = null;
let deviceToken = '';
let tokenEncryptedAtRest = false;
const serverProc = new ServerProcess();
const updater = new Updater();

// The language the window shows ('en' or 'hinglish'); messages written here use it too.
let uiLang = 'en';
const say = (en, hinglish) => (uiLang === 'hinglish' ? hinglish : en);

// Relay announcements ("the relay will restart") are also said in the game's chat, so players hear them.
const noticeAnnouncer = new NoticeAnnouncer({
  say: (line) => { if (serverProc.child && serverProc.status === 'online') serverProc.sendCommand(`say ${line}`); },
  lang: () => uiLang,
});

// ─── World backups (see backups.js and backupService.js) ───────────────────────
// activeServerProfileId is declared just below; the service only reads it later, when something happens.
const backupService = new BackupService({
  userDataDir: () => app.getPath('userData'),
  getProfile: (id) => serverProfiles.getProfile(app.getPath('userData'), id),
  updateProfile: (id, changes) => serverProfiles.updateProfile(app.getPath('userData'), id, changes),
  serverProc,
  isActive: (id) => id === activeServerProfileId && Boolean(serverProc.child),
  send: (channel, payload) => send(channel, payload),
  appVersion: app.getVersion(),
});

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
// It also lives on one relay region only (addresses claimed before regions
// existed are India's).
let customAddress = { name: '', address: '', region: '' };
function customAddressPath() {
  return path.join(userDataDir(), 'custom-address.json');
}
function loadCustomAddress() {
  try {
    const v = JSON.parse(fs.readFileSync(customAddressPath(), 'utf8'));
    if (v && typeof v.name === 'string' && typeof v.address === 'string') {
      customAddress = { name: v.name, address: v.address, region: v.name ? (isRegion(v.region) ? v.region : 'in') : '' };
    }
  } catch { /* none yet */ }
}
function saveCustomAddress() {
  try { fs.writeFileSync(customAddressPath(), JSON.stringify(customAddress)); } catch { /* best-effort */ }
}

// The custom address as the UI should show it: hidden while the tunnel runs
// in a region it doesn't belong to (players couldn't reach it there).
function visibleCustomAddress() {
  if (customAddress.name && tunnelRegion && customAddress.region !== tunnelRegion.id) {
    return { name: '', address: '', elsewhere: { address: customAddress.address, region: REGIONS[customAddress.region].label } };
  }
  return customAddress;
}

// App-wide preferences (currently just the relay region: auto / in / na).
let prefs = { region: 'auto' };
function prefsPath() {
  return path.join(userDataDir(), 'preferences.json');
}
function loadPrefs() {
  try {
    const v = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
    prefs = { region: normalizePreference(v && v.region) };
  } catch { /* defaults */ }
}
function savePrefs() {
  try { fs.writeFileSync(prefsPath(), JSON.stringify(prefs)); } catch { /* best-effort */ }
}

// Region of the running tunnel (null when stopped or on a self-hosted relay),
// and the last automatic pick, reused for a while so restarting a tunnel
// doesn't measure again.
let tunnelRegion = null;
let autoPick = null; // { regionId, latency, at }
let tunnelStartSeq = 0;
const AUTO_PICK_TTL_MS = 10 * 60 * 1000;
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

// Direct mode: players connect straight to this PC through a port the router forwards (see directMode.js).
const directMode = new DirectMode({ log: (line) => send('tunnel:log', '[Direct] ' + line) });
directMode.on('status', (s) => send('tunnel:direct', s));

/** Starts or stops Direct mode to match the public server's setting and the tunnel's state. */
function syncDirectMode() {
  const profile = publicServerProfileId ? serverProfiles.getProfile(userDataDir(), publicServerProfileId) : null;
  const action = directAction({
    enabled: Boolean(profile && profile.direct),
    online: Boolean(tunnel && tunnel.running),
    official: Boolean(tunnelRegion), // only VoxelPort's own relays know about Direct mode
    state: directMode.status.state,
  });
  if (action === 'start') {
    directMode.start(tunnel, { localPort: profile.port }).catch((err) => send('tunnel:log', '[Direct] ' + err.message));
  } else if (action === 'stop') {
    directMode.stop().catch(() => {});
  }
}

// Join codes: players connect to this server peer-to-peer with a code (see p2pHost.js). The WebRTC connections live in a
// hidden window; the host and the joining side each have their own.
let p2pHost = null;
let hostRtc = null;
let joinCodeText = '';
let p2pJoin = null;
let joinRtc = null;

function publishP2P() {
  send('tunnel:p2p', { code: joinCodeText, peers: p2pHost ? p2pHost.connectedPeers : 0, players: p2pHost ? p2pHost.players : 0 });
}

function teardownP2PHost() {
  if (p2pHost) { p2pHost.detach(); p2pHost = null; }
  if (hostRtc) { hostRtc.close(); hostRtc = null; }
  if (joinCodeText) { joinCodeText = ''; publishP2P(); }
}

/** Turns join codes on or off for the public server to match its setting and the tunnel's state. */
function syncP2P() {
  const profile = publicServerProfileId ? serverProfiles.getProfile(userDataDir(), publicServerProfileId) : null;
  const want = Boolean(profile && profile.p2p && tunnel && tunnel.running && tunnelRegion); // only VoxelPort's own relays
  if (!want) {
    if (tunnel && tunnel.p2p) tunnel.setP2P(false);
    teardownP2PHost();
    return;
  }
  if (!hostRtc) hostRtc = new ElectronRtcWorker();
  if (!p2pHost) {
    p2pHost = new P2PHost({
      worker: hostRtc,
      getLocalPort: () => {
        const p = publicServerProfileId ? serverProfiles.getProfile(userDataDir(), publicServerProfileId) : null;
        return p ? p.port : 25565;
      },
    });
    p2pHost.on('changed', publishP2P);
    p2pHost.on('log', (line) => send('tunnel:log', '[Join code] ' + line));
    hostRtc.on('error', (err) => send('tunnel:log', '[Join code] ' + err.message));
  }
  p2pHost.attach(tunnel); // keeps the players already connected if the tunnel reconnected
  if (!tunnel.p2p) tunnel.setP2P(true);
}

function wireTunnel(t, publicHost) {
  t.on('status', (s) => send('tunnel:status', s));
  t.on('assigned', (port) => {
    send('tunnel:assigned', { port, host: publicHost });
    syncDirectMode(); // a reconnect keeps a working Direct mode; a first connection starts it
    syncP2P();
  });
  t.on('players', (n) => send('tunnel:players', n));
  t.on('ping', (ms) => send('tunnel:ping', ms));
  t.on('log', (line) => send('tunnel:log', line));
  t.on('error', (message) => send('tunnel:error', message));
  t.on('name', (n) => {
    // Only VoxelPort's own relays share the address list; ignore the rest.
    if (!tunnelRegion) return;
    customAddress = n.name
      ? { name: n.name, address: n.address, region: tunnelRegion.id }
      : { name: '', address: '', region: '' };
    saveCustomAddress();
    send('tunnel:name', visibleCustomAddress());
  });
  t.on('nameError', (message) => send('tunnel:nameError', message));
  t.on('listingError', (message) => send('server:log', `[VoxelPort] Server list: ${message}`));
  t.on('notice', (n) => {
    // Only VoxelPort's own relays may announce things; a self-hosted relay is not trusted to talk to your players.
    if (!tunnelRegion) return;
    send('tunnel:notice', n);
    if (publicServerProfileId && publicServerProfileId === activeServerProfileId) noticeAnnouncer.handle(n);
  });
  t.on('udpError', (message) => send('server:log', `[VoxelPort] ${message}`));
  t.on('joinCode', (code) => { if (tunnelRegion) { joinCodeText = code; publishP2P(); } });
  t.on('joinError', (message) => send('server:log', `[VoxelPort] Join code: ${message}`));
  t.on('stopped', () => {
    // The router's port is closed whenever its tunnel goes (an older tunnel's late "stopped" must not stop a newer one's).
    if (directMode.tunnel === t || !directMode.tunnel) directMode.stop({ tunnelAlive: false }).catch(() => {});
    if (!tunnel || tunnel === t) teardownP2PHost();
    send('tunnel:status', 'stopped');
    send('tunnel:notice', { message: '', seconds: 0 });
    noticeAnnouncer.cancel();
    publicServerProfileId = null;
    manualTunnelActive = false;
    if (tunnel === t || !tunnel) {
      tunnelRegion = null;
      send('tunnel:name', visibleCustomAddress());
    }
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
      if (activeServerProfileId) backupService.onServerOnline(activeServerProfileId);
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
    if (activeServerProfileId) backupService.onPlayers(activeServerProfileId, n);
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
    // A normal shutdown gets one last backup, so the finished state is always saved (never when the app is closing).
    if (exitedProfileId && !appClosing) backupService.onServerExit(exitedProfileId, { clean: code === 0 });
    else backupService.stopSchedule();

    const watch = javaWatch;
    javaWatch = null;
    const javaFix = code !== 0 && watch && watch.neededMajor && !watch.retried;
    if (!stopRequested && !javaFix && exitedProfileId) {
      const profile = serverProfiles.getProfile(userDataDir(), exitedProfileId);
      const items = explainCrash(recentLines.slice(-200), { port: profile && profile.port, crashed: code !== 0, lang: uiLang });
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
    loadPrefs();
    createWindow();
    updater.start({ isPackaged: app.isPackaged, platform: process.platform, windowsStore: Boolean(process.windowsStore) });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

let appClosing = false;
app.on('window-all-closed', () => {
  appClosing = true;
  updater.stop();
  perf.stop();
  stopTickPolling();
  if (tunnel) tunnel.stop();
  stopRequested = true;
  if (serverProc.child) serverProc.stop();
  if (p2pJoin) p2pJoin.stop();
  if (joinRtc) { joinRtc.destroy(); joinRtc = null; }
  teardownP2PHost();
  const quit = () => { if (process.platform !== 'darwin') app.quit(); };
  // Give the router a moment to forget the forwarded port before the app exits (it expires by itself anyway).
  Promise.race([directMode.stop({ tunnelAlive: false }), new Promise((r) => setTimeout(r, 2500))]).then(quit, quit);
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

ipcMain.handle('app:setLanguage', guarded(g, (_evt, { lang }) => {
  uiLang = lang === 'hinglish' ? 'hinglish' : 'en';
  return { ok: true };
}));

ipcMain.handle('update:state', guarded(g, () => ({ readyToInstall: updater.readyToInstall })));

// Applying a downloaded update quits and relaunches the app — never do that
// silently while a managed server is running or the tunnel is public
// without asking first, same as any other switch/stop in this app.
ipcMain.handle('update:install', guarded(g, async () => {
  if (!updater.readyToInstall) return { ok: false };

  if (serverProc.child || (tunnel && tunnel.running)) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [say('Cancel', 'Cancel'), say('Restart & Update', 'Restart karo aur Update karo')],
      defaultId: 1,
      cancelId: 0,
      message: serverProc.child
        ? say('A managed server is currently running.', 'Ek managed server abhi chal raha hai.')
        : say('The VoxelPort tunnel is currently public.', 'VoxelPort tunnel abhi public hai.'),
      detail: say('Restarting to install the update will stop it. Continue?', 'Update install karne ke liye restart karne se yeh band ho jayega. Aage badhein?'),
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

/** The VoxelPort region for a new tunnel, logged so the user sees why. */
async function chooseRegion() {
  const pref = prefs.region;
  if (pref === 'auto' && !customAddress.name && autoPick && Date.now() - autoPick.at < AUTO_PICK_TTL_MS) {
    return REGIONS[autoPick.regionId];
  }
  const measuring = pref === 'auto' && !customAddress.name && Object.keys(REGIONS).length > 1;
  if (measuring) send('tunnel:log', 'Finding the fastest VoxelPort region…');
  const { region, reason, latency } = await pickRegion({ preference: pref, nameRegion: customAddress.region });
  if (reason === 'fastest' || reason === 'fallback') autoPick = { regionId: region.id, latency, at: Date.now() };
  const ms = Object.entries(latency).map(([id, v]) => `${REGIONS[id].label} ${v} ms`).join(', ');
  const why = {
    chosen: 'chosen in settings',
    address: `your address ${customAddress.address} lives there`,
    fastest: ms ? `fastest: ${ms}` : 'fastest',
    fallback: 'couldn\'t measure, using the default',
  }[reason];
  // With a single region (reason "only") the choice is implicit — don't log it.
  if (why) send('tunnel:log', `Region: ${region.label} (${why})`);
  return region;
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
      const currentLabel = currentProfile ? currentProfile.name : (currentlyManual ? say('The manual tunnel', 'Manual tunnel') : say('The current tunnel', 'Abhi wala tunnel'));
      const targetLabel = targetProfile ? targetProfile.name : say('the server you already run manually', 'jo server tum manually chalate ho');
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: [say('Cancel', 'Cancel'), say('Switch', 'Badlo')],
        defaultId: 1,
        cancelId: 0,
        message: say(currentLabel + ' is currently public.', currentLabel + ' abhi public hai.'),
        detail: say('Switch the VoxelPort tunnel to ' + targetLabel + '?', 'VoxelPort tunnel ko ' + targetLabel + ' par badlein?'),
      });
      if (response !== 1) return { ok: false, cancelled: true };
      tunnel.stop();
      await waitForTunnelStopped(10000);
    } else {
      return { ok: true, alreadyRunning: true };
    }
  }

  const usingDefault = resolvedRelayUrl.replace(/\/+$/, '') === DEFAULT_RELAY_URL;
  let region = null;
  if (usingDefault) {
    const seq = ++tunnelStartSeq;
    region = await chooseRegion();
    if (seq !== tunnelStartSeq) return { ok: false, cancelled: true }; // stopped (or restarted) meanwhile
    if (tunnel && tunnel.running) return { ok: true, alreadyRunning: true };
  }
  const relayUrls = region ? region.relayUrls : [resolvedRelayUrl];
  const publicHost = region ? region.publicHost : new URL(resolvedRelayUrl).hostname;

  tunnel = new Tunnel();
  tunnelRegion = region;
  wireTunnel(tunnel, publicHost);
  send('tunnel:region', region ? { id: region.id, label: region.label } : null);
  send('tunnel:name', visibleCustomAddress());
  if (profileId) tunnel.setListing(buildListing(serverProfiles.getProfile(userDataDir(), profileId)));
  tunnel.start({ relayUrls, token: deviceToken, localPort: port, udpPort, client: `desktop/${app.getVersion()}` });
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
  tunnelStartSeq++; // cancels a start that is still picking its region
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
    title: say('Choose a folder for the server files', 'Server files ke liye ek folder chuno'),
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
  if (backupService.isBusy(id)) return { ok: false, error: 'A backup or restore is running for this server. Try again in a moment.' };

  if (serverProc.child && activeServerProfileId !== id) {
    const activeProfile = serverProfiles.getProfile(userDataDir(), activeServerProfileId);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [say('Cancel', 'Cancel'), say('Switch Server', 'Server badlo')],
      defaultId: 1,
      cancelId: 0,
      message: say(
        (activeProfile ? activeProfile.name : 'Another server') + ' is currently running.',
        (activeProfile ? activeProfile.name : 'Doosra server') + ' abhi chal raha hai.',
      ),
      detail: say('Stop it and start ' + profile.name + '?', 'Use band karke ' + profile.name + ' start karein?'),
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

// ─── Backups screen ────────────────────────────────────────────────────────

ipcMain.handle('backup:info', guarded(g, (_evt, { id }) => backupService.describe(id)));
ipcMain.handle('backup:create', guarded(g, (_evt, { id }) => backupService.create(id, 'manual')));
ipcMain.handle('backup:settings:set', guarded(g, (_evt, { id, settings }) => backupService.setSettings(id, settings)));
ipcMain.handle('backup:delete', guarded(g, (_evt, { id, name }) => backupService.delete(id, name)));

ipcMain.handle('backup:openFolder', guarded(g, (_evt, { id }) => {
  const dir = backupService.dirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true };
}));

// Putting a backup back replaces the world, so it always asks first (and saves the current world before it does).
ipcMain.handle('backup:restore', guarded(g, async (_evt, { id, name }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  const parsed = backupsLib.parseBackupName(name);
  if (!parsed) return { ok: false, error: 'That is not one of VoxelPort\'s backups.' };
  const when = new Date(parsed.createdAt).toLocaleString();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [say('Cancel', 'Cancel'), say('Restore', 'Restore karo')],
    defaultId: 0,
    cancelId: 0,
    message: say('Restore the backup from ' + when + '?', when + ' wala backup restore karein?'),
    detail: say(
      profile.name + ' goes back to how it was then. Anything built since is replaced. Your current world is saved first, so you can undo this.',
      profile.name + ' waisi ho jayegi jaisi tab thi. Uske baad ka sab kuch badal jayega. Abhi wali world pehle save ho jati hai, to aap undo kar sakte ho.',
    ),
  });
  if (response !== 1) return { ok: false, cancelled: true };
  return backupService.restore(id, name, {
    setLevelName: (serverDir, level) => updateServerPropertiesSafely(serverDir, { 'level-name': level }),
  });
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

// ─── Support VoxelPort: tips, supporter perks, paid-hosting suggestions ────
// The donation target is fixed in support.js. Hosting links come from voxelport.in/support.json,
// are validated there, and are opened here only by id from that validated list — the renderer
// never supplies a URL.
let supportCache = { hosts: new Map() };
ipcMain.handle('support:get', guarded(g, async (_evt, { force } = {}) => {
  const s = await support.getSupport({ dir: userDataDir(), device: 'desktop', force: Boolean(force) });
  supportCache = { hosts: new Map(s.hosts.items.map((h) => [h.id, h.url])) };
  return s;
}));

ipcMain.handle('support:open', guarded(g, (_evt, { what, id } = {}) => {
  let url = null;
  if (what === 'sponsors') url = support.DONATE.sponsorsUrl;
  else if (what === 'page') url = support.DONATE.pageUrl;
  else if (what === 'perks') url = support.DONATE.perksUrl;
  else if (what === 'host') url = supportCache.hosts.get(String(id));
  if (!url || !/^https:\/\//.test(url)) return { ok: false };
  shell.openExternal(url);
  return { ok: true };
}));

ipcMain.handle('support:copyUpi', guarded(g, () => {
  clipboard.writeText(support.DONATE.upiId);
  return { ok: true };
}));

// ─── Player accounts: "cracked" (offline-mode) servers ────────────────────
// online-mode is never part of the ordinary Settings save (serverSettings.js); this is the
// one dedicated, confirmed way to change it. See accounts.js.

ipcMain.handle('server:accounts:get', guarded(g, (_evt, { id }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) throw new Error('Server profile not found.');
  return {
    cracked: accounts.isCracked(profile.serverDir),
    loginPlugin: accounts.hasLoginPlugin(profile.serverDir),
    canInstallLogin: profile.type === 'paper',
    running: activeServerProfileId === id && Boolean(serverProc.child),
  };
}));

ipcMain.handle('server:accounts:set', guarded(g, (_evt, { id, cracked, confirmed }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  try {
    const on = accounts.validateAccountsChange({ cracked, confirmed });
    accounts.setCracked(profile.serverDir, on);
    return { ok: true, cracked: on, restartNeeded: activeServerProfileId === id && Boolean(serverProc.child) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}));

let accountsBusy = false;
ipcMain.handle('server:accounts:installLogin', guarded(g, async (_evt, { id }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  if (accountsBusy) return { ok: false, error: 'Already installing — one moment.' };
  accountsBusy = true;
  try {
    await accounts.installLoginPlugin({
      serverDir: profile.serverDir, type: profile.type, version: profile.version,
      onProgress: (p) => send('accounts:progress', p),
    });
    return { ok: true, restartNeeded: activeServerProfileId === id && Boolean(serverProc.child) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    accountsBusy = false;
  }
}));

// ─── Custom address (steve.voxelport.in) ──────────────────────────────────

ipcMain.handle('name:get', guarded(g, () => visibleCustomAddress()));

// ─── Relay region ─────────────────────────────────────────────────────────

ipcMain.handle('region:get', guarded(g, () => ({
  preference: prefs.region,
  regions: Object.values(REGIONS).map((r) => ({ id: r.id, label: r.label })),
  active: tunnelRegion ? tunnelRegion.id : null,
  addressRegion: customAddress.name ? customAddress.region : null,
})));

ipcMain.handle('region:set', guarded(g, (_evt, { preference }) => {
  prefs.region = normalizePreference(preference);
  savePrefs();
  return { ok: true, preference: prefs.region };
}));

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
  if (!tunnelRegion) return { ok: false, error: 'Custom addresses only work on VoxelPort\'s own relays.' };
  if (customAddress.name && customAddress.region !== tunnelRegion.id) {
    return {
      ok: false,
      error: `You already have ${customAddress.address} on the ${REGIONS[customAddress.region].label} relay. Set the region to ${REGIONS[customAddress.region].label} or Auto to use or change it.`,
    };
  }
  const reply = awaitNameReply(tunnel);
  tunnel.claimName(name);
  return reply;
}));

ipcMain.handle('name:release', guarded(g, async () => {
  if (!tunnel || !tunnel.running) return { ok: false, error: 'Make a server public first, then remove your address.' };
  if (!tunnelRegion || customAddress.region !== tunnelRegion.id) {
    return { ok: false, error: 'Your address lives on another region — switch to it to remove it.' };
  }
  const reply = awaitNameReply(tunnel);
  tunnel.releaseName();
  return reply;
}));

// ─── Direct mode ───────────────────────────────────────────────────────────
// Opt-in per server. Turning it on needs the host's confirmation (the screen asks), because players then
// connect to this PC's own IP address, which is published in DNS for the host's custom address.

ipcMain.handle('server:direct:get', guarded(g, (_evt, { id }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) throw new Error('Server profile not found.');
  const isPublic = publicServerProfileId === id;
  return {
    enabled: Boolean(profile.direct),
    public: isPublic,
    supported: !isPublic || Boolean(tunnelRegion),
    status: isPublic ? directMode.status : DIRECT_OFF,
  };
}));

ipcMain.handle('server:direct:set', guarded(g, (_evt, { id, enabled, confirmed }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  if (enabled && confirmed !== true) return { ok: false, error: 'Direct mode needs your confirmation.' };
  serverProfiles.updateProfile(userDataDir(), id, { direct: Boolean(enabled) });
  if (publicServerProfileId === id) syncDirectMode();
  return { ok: true, enabled: Boolean(enabled) };
}));

ipcMain.handle('server:direct:retry', guarded(g, async (_evt, { id }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  if (publicServerProfileId !== id || !profile.direct) return { ok: false, error: 'Make the server public with Direct mode on first.' };
  await directMode.stop();
  syncDirectMode();
  return { ok: true };
}));

// ─── Join codes (peer-to-peer) ─────────────────────────────────────────────
// A host turns them on per server (confirmed, because the player's PC and the host's then see each other's IP address).
// A player enters the code on the Join screen; see p2pJoin.js for what happens then.

ipcMain.handle('server:p2p:get', guarded(g, (_evt, { id }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) throw new Error('Server profile not found.');
  const isPublic = publicServerProfileId === id;
  return {
    enabled: Boolean(profile.p2p),
    public: isPublic,
    supported: !isPublic || Boolean(tunnelRegion),
    code: isPublic ? joinCodeText : '',
    peers: isPublic && p2pHost ? p2pHost.connectedPeers : 0,
    players: isPublic && p2pHost ? p2pHost.players : 0,
  };
}));

ipcMain.handle('server:p2p:set', guarded(g, (_evt, { id, enabled, confirmed }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  if (enabled && confirmed !== true) return { ok: false, error: 'Join codes need your confirmation.' };
  serverProfiles.updateProfile(userDataDir(), id, { p2p: Boolean(enabled) });
  if (publicServerProfileId === id) syncP2P();
  return { ok: true, enabled: Boolean(enabled) };
}));

ipcMain.handle('server:p2p:rotate', guarded(g, (_evt, { id }) => {
  const profile = serverProfiles.getProfile(userDataDir(), id);
  if (!profile) return { ok: false, error: 'Server profile not found.' };
  if (publicServerProfileId !== id || !profile.p2p || !tunnel || !tunnel.running) return { ok: false, error: 'Make the server public with join codes on first.' };
  tunnel.rotateJoinCode();
  return { ok: true };
}));

ipcMain.handle('p2p:join:start', guarded(g, (_evt, { code, allowRelay }) => {
  if (typeof code !== 'string' || code.trim().length < 6 || code.length > 40) return { ok: false, error: 'Enter the code your friend gave you.' };
  if (p2pJoin) { p2pJoin.stop(); p2pJoin = null; }
  if (joinRtc) { joinRtc.close(); joinRtc = null; }
  joinRtc = new ElectronRtcWorker();
  joinRtc.on('error', (err) => send('p2p:join:status', { state: 'failed', path: '', port: 0, reason: '', message: err.message }));
  p2pJoin = new P2PJoin({ worker: joinRtc });
  const join = p2pJoin;
  join.on('status', (s) => {
    send('p2p:join:status', s);
    if ((s.state === 'failed' || s.state === 'stopped') && p2pJoin === join) {
      // Let go of the hidden window once it is over (after the message has been sent).
      if (p2pJoin === join && joinRtc) { joinRtc.close(); joinRtc = null; }
    }
  });
  // "Direct only" (allowRelay false): the relay is in India, so far from there it would only add delay.
  join.start({ relayUrl: DEFAULT_RELAY_URL, code: code.trim(), client: `desktop/${app.getVersion()}`, allowRelay: allowRelay !== false });
  return { ok: true };
}));

ipcMain.handle('p2p:join:stop', guarded(g, () => {
  if (p2pJoin) { p2pJoin.stop(); p2pJoin = null; }
  if (joinRtc) { joinRtc.close(); joinRtc = null; }
  return { ok: true };
}));

ipcMain.handle('p2p:join:status', guarded(g, () => (p2pJoin ? p2pJoin.status : { state: 'idle', path: '', port: 0, reason: '', message: '' })));

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

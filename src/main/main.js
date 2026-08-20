'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Tunnel } = require('./tunnel');
const { loadOrCreateToken, maskToken } = require('./token');
const mcVersions = require('./mcVersions');
const { checkJava, requiredJavaMajor } = require('./javaCheck');
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

const DEFAULT_RELAY_URL = 'wss://relay.voxelport.in';
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

function userDataDir() {
  return app.getPath('userData');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 800,
    minWidth: 540,
    minHeight: 640,
    backgroundColor: '#0a0a0a',
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

function broadcastState() {
  send('app:state', {
    activeServerProfileId,
    publicServerProfileId,
    manualTunnelActive,
    serverStatus: serverProc.status,
  });
}

function wireTunnel(t) {
  t.on('status', (s) => send('tunnel:status', s));
  t.on('assigned', (port) => send('tunnel:assigned', { port, host: PUBLIC_HOST }));
  t.on('players', (n) => send('tunnel:players', n));
  t.on('ping', (ms) => send('tunnel:ping', ms));
  t.on('log', (line) => send('tunnel:log', line));
  t.on('error', (message) => send('tunnel:error', message));
  t.on('stopped', () => {
    send('tunnel:status', 'stopped');
    publicServerProfileId = null;
    manualTunnelActive = false;
    broadcastState();
  });
}

function wireServerProcess(p) {
  p.on('status', (s) => { send('server:status', s); broadcastState(); });
  p.on('log', (line) => send('server:log', line));
  p.on('players', (n) => send('server:players', n));
  p.on('exit', (code) => {
    send('server:exit', code);
    if (activeServerProfileId && publicServerProfileId === activeServerProfileId) {
      // The managed server backing the public tunnel died — the tunnel
      // still technically runs but has nothing to bridge to; stop it too
      // rather than leaving a misleading "public" state.
      if (tunnel) tunnel.stop();
    }
    activeServerProfileId = null;
    broadcastState();
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
    createWindow();
    updater.start({ isPackaged: app.isPackaged, platform: process.platform });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  updater.stop();
  if (tunnel) tunnel.stop();
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

async function startTunnelInternal({ localPort, relayUrl, profileId }) {
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
  tunnel.start({ relayUrl: resolvedRelayUrl, token: deviceToken, localPort: port });
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
  return startTunnelInternal({ localPort: profile.port, relayUrl: DEFAULT_RELAY_URL, profileId: id });
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

ipcMain.handle('java:check', guarded(g, async (_evt, { version }) => {
  const result = await checkJava();
  const required = requiredJavaMajor(version || '1.20.5');
  return { ...result, required, satisfied: result.found && result.major !== null && result.major >= required };
}));

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

ipcMain.handle('server:install', guarded(g, async (_evt, { name, type, version, port, minRamMb, maxRamMb, serverDir }) => {
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
  writeServerProperties(dir, { port: portNum });

  const profile = serverProfiles.createProfile(userDataDir(), {
    name: name || `${type[0].toUpperCase()}${type.slice(1)} server`,
    type, version, serverDir: dir, port: portNum, minRamMb: minRam, maxRamMb: maxRam,
  });
  send('install:progress', { phase: 'done' });
  return { ok: true, profile };
}));

// ─── Single managed server process (item 6) ─────────────────────────────────

ipcMain.handle('server:start', guarded(g, async (_evt, { id }) => {
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
    serverProc.stop();
    await waitForServerStopped(STOP_WAIT_TIMEOUT_MS);
  } else if (serverProc.child && activeServerProfileId === id) {
    return { ok: true, alreadyRunning: true, port: profile.port };
  }

  serverProfiles.touchProfile(userDataDir(), id);
  activeServerProfileId = id;
  serverProc.start({ serverDir: profile.serverDir, minRamMb: profile.minRamMb, maxRamMb: profile.maxRamMb });
  broadcastState();
  return { ok: true, port: profile.port };
}));

ipcMain.handle('server:stop', guarded(g, () => {
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

ipcMain.handle('server:state', guarded(g, () => ({
  activeServerProfileId,
  publicServerProfileId,
  manualTunnelActive,
  serverStatus: serverProc.status,
})));

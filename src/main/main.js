'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Tunnel } = require('./tunnel');
const { loadOrCreateToken } = require('./token');
const mcVersions = require('./mcVersions');
const { checkJava, requiredJavaMajor } = require('./javaCheck');
const { getServerDir, downloadServerJar, writeEula, writeServerProperties } = require('./serverInstall');
const { ServerProcess } = require('./serverProcess');
const { loadServerConfig, saveServerConfig } = require('./serverConfig');
const { isSafeRelayUrl } = require('./relayUrlSafety');

const DEFAULT_RELAY_URL = 'wss://relay.voxelport.in';
const PUBLIC_HOST = 'play.voxelport.in';

let mainWindow = null;
let tunnel = null;
let deviceToken = '';
const serverProc = new ServerProcess();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 780,
    minWidth: 520,
    minHeight: 620,
    backgroundColor: '#0a0a0a',
    title: 'VoxelPort',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open external links (website, help) in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function wireTunnel(t) {
  t.on('status', (s) => send('tunnel:status', s));
  t.on('assigned', (port) => send('tunnel:assigned', { port, host: PUBLIC_HOST }));
  t.on('players', (n) => send('tunnel:players', n));
  t.on('ping', (ms) => send('tunnel:ping', ms));
  t.on('log', (line) => send('tunnel:log', line));
  t.on('error', (message) => send('tunnel:error', message));
  t.on('stopped', () => send('tunnel:status', 'stopped'));
}

function wireServerProcess(p) {
  p.on('status', (s) => send('server:status', s));
  p.on('log', (line) => send('server:log', line));
  p.on('players', (n) => send('server:players', n));
  p.on('exit', (code) => send('server:exit', code));
}
wireServerProcess(serverProc);

/** ~2GB reserved for the OS, then a tiered slice of what's left. */
function recommendedRamMb(totalMemMb) {
  if (totalMemMb <= 4096) return 1024;
  if (totalMemMb <= 8192) return 3072;
  if (totalMemMb <= 16384) return 6144;
  return 8192;
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
    deviceToken = loadOrCreateToken(app.getPath('userData'));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (tunnel) tunnel.stop();
  if (serverProc.child) serverProc.stop();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:info', () => ({
  publicHost: PUBLIC_HOST,
  defaultRelayUrl: DEFAULT_RELAY_URL,
  token: deviceToken,
  version: app.getVersion(),
}));

ipcMain.handle('tunnel:start', (_evt, { localPort, relayUrl }) => {
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
  if (tunnel) tunnel.stop();
  tunnel = new Tunnel();
  wireTunnel(tunnel);
  tunnel.start({
    relayUrl: resolvedRelayUrl,
    token: deviceToken,
    localPort: port,
  });
  return { ok: true };
});

ipcMain.handle('tunnel:stop', () => {
  if (tunnel) {
    tunnel.stop();
    tunnel = null;
  }
  return { ok: true };
});

// ─── Server install & management ───────────────────────────────────────────

ipcMain.handle('system:specs', () => {
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  return { totalMemMb, recommendedRamMb: recommendedRamMb(totalMemMb) };
});

ipcMain.handle('java:check', async (_evt, { version }) => {
  const result = await checkJava();
  const required = requiredJavaMajor(version || '1.20.5');
  return { ...result, required, satisfied: result.found && result.major !== null && result.major >= required };
});

ipcMain.handle('java:openDownloadPage', () => {
  shell.openExternal('https://adoptium.net/temurin/releases/');
  return { ok: true };
});

ipcMain.handle('server:types', () => mcVersions.getTypes());

ipcMain.handle('server:versions', (_evt, { type }) => mcVersions.listVersions(type));

ipcMain.handle('server:hasExisting', () => loadServerConfig(app.getPath('userData')));

ipcMain.handle('server:defaultDir', () => getServerDir(app.getPath('userData')));

ipcMain.handle('server:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for the server files',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('server:install', async (_evt, { type, version, port, minRamMb, maxRamMb, serverDir }) => {
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

  const userDataDir = app.getPath('userData');
  const dir = serverDir || getServerDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });

  send('install:progress', { phase: 'resolving' });
  const { url, checksum } = await mcVersions.resolveDownload(type, version);

  send('install:progress', { phase: 'downloading', received: 0, total: 0 });
  await downloadServerJar(url, path.join(dir, 'server.jar'), (p) => {
    send('install:progress', { phase: 'downloading', ...p });
  }, checksum);

  writeEula(dir);
  writeServerProperties(dir, { port: portNum });

  const config = { type, version, port: portNum, minRamMb: minRam, maxRamMb: maxRam, serverDir: dir };
  saveServerConfig(userDataDir, config);
  send('install:progress', { phase: 'done' });
  return { ok: true, config };
});

ipcMain.handle('server:start', () => {
  const config = loadServerConfig(app.getPath('userData'));
  if (!config) return { ok: false, error: 'No server installed yet.' };
  serverProc.start({
    serverDir: config.serverDir || getServerDir(app.getPath('userData')),
    minRamMb: config.minRamMb,
    maxRamMb: config.maxRamMb,
  });
  return { ok: true, port: config.port };
});

ipcMain.handle('server:stop', () => {
  serverProc.stop();
  return { ok: true };
});

ipcMain.handle('server:command', (_evt, { command }) => {
  serverProc.sendCommand(command);
  return { ok: true };
});

ipcMain.handle('server:openFolder', () => {
  const config = loadServerConfig(app.getPath('userData'));
  const dir = (config && config.serverDir) || getServerDir(app.getPath('userData'));
  shell.openPath(dir);
  return { ok: true };
});

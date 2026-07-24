'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { Tunnel } = require('./tunnel');
const { loadOrCreateToken } = require('./token');

const DEFAULT_RELAY_URL = 'wss://relay.voxelport.in';
const PUBLIC_HOST = 'play.voxelport.in';

let mainWindow = null;
let tunnel = null;
let deviceToken = '';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 660,
    minWidth: 460,
    minHeight: 560,
    backgroundColor: '#0a0f0d',
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
  if (tunnel) tunnel.stop();
  tunnel = new Tunnel();
  wireTunnel(tunnel);
  tunnel.start({
    relayUrl: (relayUrl && relayUrl.trim()) || DEFAULT_RELAY_URL,
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

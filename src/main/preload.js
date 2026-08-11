'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge — the renderer has no Node access and can only call these.
contextBridge.exposeInMainWorld('vp', {
  info: () => ipcRenderer.invoke('app:info'),
  start: (opts) => ipcRenderer.invoke('tunnel:start', opts),
  stop: () => ipcRenderer.invoke('tunnel:stop'),
  on: (channel, cb) => {
    const allowed = [
      'tunnel:status',
      'tunnel:assigned',
      'tunnel:players',
      'tunnel:ping',
      'tunnel:log',
      'tunnel:error',
      'server:status',
      'server:log',
      'server:players',
      'server:exit',
      'install:progress',
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_evt, payload) => cb(payload));
  },

  system: {
    specs: () => ipcRenderer.invoke('system:specs'),
  },

  java: {
    check: (version) => ipcRenderer.invoke('java:check', { version }),
    openDownloadPage: () => ipcRenderer.invoke('java:openDownloadPage'),
  },

  server: {
    types: () => ipcRenderer.invoke('server:types'),
    versions: (type) => ipcRenderer.invoke('server:versions', { type }),
    hasExisting: () => ipcRenderer.invoke('server:hasExisting'),
    defaultDir: () => ipcRenderer.invoke('server:defaultDir'),
    chooseFolder: () => ipcRenderer.invoke('server:chooseFolder'),
    install: (config) => ipcRenderer.invoke('server:install', config),
    start: () => ipcRenderer.invoke('server:start'),
    stop: () => ipcRenderer.invoke('server:stop'),
    command: (command) => ipcRenderer.invoke('server:command', { command }),
    openFolder: () => ipcRenderer.invoke('server:openFolder'),
  },
});

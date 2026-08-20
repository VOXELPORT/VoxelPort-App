'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge — the renderer has no Node access and can only call these.
contextBridge.exposeInMainWorld('vp', {
  // app:info deliberately never returns the raw device token — see token.js/main.js.
  info: () => ipcRenderer.invoke('app:info'),
  copyToken: () => ipcRenderer.invoke('token:copy'),

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
      'app:state',
      'update:available',
      'update:downloaded',
      'update:error',
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
    defaultDir: () => ipcRenderer.invoke('server:defaultDir'),
    chooseFolder: () => ipcRenderer.invoke('server:chooseFolder'),
    detectExisting: (dir) => ipcRenderer.invoke('server:detectExisting', { dir }),
    install: (config) => ipcRenderer.invoke('server:install', config),
    import: (input) => ipcRenderer.invoke('server:import', input),

    list: () => ipcRenderer.invoke('server:profiles:list'),
    get: (id) => ipcRenderer.invoke('server:profiles:get', { id }),
    update: (id, changes) => ipcRenderer.invoke('server:profiles:update', { id, changes }),
    remove: (id) => ipcRenderer.invoke('server:profiles:delete', { id }),

    start: (id) => ipcRenderer.invoke('server:start', { id }),
    stop: () => ipcRenderer.invoke('server:stop'),
    command: (command) => ipcRenderer.invoke('server:command', { command }),
    openFolder: (id) => ipcRenderer.invoke('server:openFolder', { id }),
    makePublic: (id) => ipcRenderer.invoke('server:makePublic', { id }),

    state: () => ipcRenderer.invoke('server:state'),
  },

  update: {
    state: () => ipcRenderer.invoke('update:state'),
    install: () => ipcRenderer.invoke('update:install'),
  },
});

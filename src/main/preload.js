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
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_evt, payload) => cb(payload));
  },
});

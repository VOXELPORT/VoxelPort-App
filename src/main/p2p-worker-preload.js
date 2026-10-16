'use strict';

// The only way the hidden peer-to-peer window talks to the main process: commands in, events out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('p2pBridge', {
  emit: (evt) => ipcRenderer.send('p2p:worker:evt', evt),
  onCommand: (cb) => ipcRenderer.on('p2p:worker:cmd', (_e, cmd) => cb(cmd)),
});

'use strict';

// Runs the hidden window that holds the WebRTC connections (renderer/p2p-worker.js) and gives the rest of the main
// process a plain object to talk to: send({op…}) in, 'event' ({evt…}) out. Other code only needs this interface, so it
// can be tested with a stand-in (test/helpers/fakeRtc.js).

const path = require('path');
const { EventEmitter } = require('events');

class ElectronRtcWorker extends EventEmitter {
  constructor() {
    super();
    this.win = null;
    this.ready = null;
    this.onIpc = null;
  }

  _ensure() {
    if (this.ready) return this.ready;
    const { BrowserWindow, ipcMain } = require('electron');
    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'p2p-worker-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false, // a hidden window must keep moving data
      },
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.onIpc = (event, evt) => {
      if (!this.win || event.sender.id !== this.win.webContents.id) return; // only our own window
      if (evt && typeof evt === 'object' && typeof evt.evt === 'string') this.emit('event', evt);
    };
    ipcMain.on('p2p:worker:evt', this.onIpc);
    this.ready = new Promise((resolve, reject) => {
      this.win.webContents.once('did-finish-load', resolve);
      this.win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`peer-to-peer window failed to load: ${desc}`)));
    });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'p2p-worker.html'));
    return this.ready;
  }

  send(cmd) {
    this._ensure().then(() => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('p2p:worker:cmd', cmd);
    }).catch((err) => this.emit('error', err));
  }

  /** Closes the hidden window (and with it every connection). */
  destroy() {
    if (this.onIpc) require('electron').ipcMain.removeListener('p2p:worker:evt', this.onIpc);
    this.onIpc = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = null;
  }
}

module.exports = { ElectronRtcWorker };

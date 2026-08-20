'use strict';

const { EventEmitter } = require('events');

/**
 * Wraps electron-updater for the NSIS Windows build only. electron-updater
 * only ever talks to GitHub's API (api.github.com) over HTTPS for this
 * specific repo (owner/repo baked into package.json's build.publish config,
 * not user-configurable at runtime) and verifies the downloaded installer's
 * checksum against the value in the signed latest.yml manifest before ever
 * applying it -- real integrity verification, not "trust the download."
 *
 * Since the app isn't currently code-signed (see SECURITY.md), this gives
 * checksum-verified integrity but not Authenticode publisher verification --
 * stated honestly, not overclaimed.
 *
 * Deliberately does NOT auto-install: an update downloads in the background,
 * but applying it (quitting and relaunching into the new version) always
 * requires an explicit call to install(), so a caller can check "is a
 * managed server running / is the tunnel public right now" first and warn
 * before disrupting either.
 *
 * Events: 'checking', 'available' (version), 'not-available', 'downloaded'
 * (version), 'error' (message), 'progress' (percent).
 */
class Updater extends EventEmitter {
  constructor() {
    super();
    this.autoUpdater = null;
    this.readyToInstall = false;
    this.checkTimer = null;
  }

  /** No-ops safely on unpackaged dev runs and non-Windows platforms -- there's nothing to update to/from. */
  start({ isPackaged, platform }) {
    if (!isPackaged || platform !== 'win32') return;

    // Required lazily (not at module load) so requiring this file in a
    // plain Node test process never touches Electron's app singleton.
    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => this.emit('checking'));
    autoUpdater.on('update-available', (info) => this.emit('available', info.version));
    autoUpdater.on('update-not-available', () => this.emit('not-available'));
    autoUpdater.on('download-progress', (p) => this.emit('progress', Math.round(p.percent)));
    autoUpdater.on('update-downloaded', (info) => {
      this.readyToInstall = true;
      this.emit('downloaded', info.version);
    });
    autoUpdater.on('error', (err) => this.emit('error', err.message));

    // Check shortly after launch (let the window finish loading first),
    // then periodically -- an update published while the app is open should
    // still surface within a reasonable time, not only on next launch.
    setTimeout(() => this.check(), 10000);
    this.checkTimer = setInterval(() => this.check(), 4 * 60 * 60 * 1000);
  }

  check() {
    if (this.autoUpdater) this.autoUpdater.checkForUpdates().catch((err) => this.emit('error', err.message));
  }

  /** Only actually restarts the app if a downloaded update is ready. */
  install() {
    if (this.readyToInstall && this.autoUpdater) {
      this.autoUpdater.quitAndInstall();
    }
  }

  stop() {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
  }
}

module.exports = { Updater };

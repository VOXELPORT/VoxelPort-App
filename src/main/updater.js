'use strict';

const { EventEmitter } = require('events');

/**
 * Wraps electron-updater for the NSIS Windows build only. electron-updater
 * only ever talks to GitHub's API (api.github.com) over HTTPS for this
 * specific repo (owner/repo baked into package.json's build.publish config,
 * not user-configurable at runtime) and checks the downloaded installer's
 * checksum against the value in latest.yml before ever applying it.
 *
 * That guards against a corrupted or truncated download. It is NOT a
 * signature: latest.yml is not signed, and it comes from the same GitHub
 * release as the installer, so if the release itself were compromised the
 * checksum would match the bad file. The app isn't code-signed either (see
 * SECURITY.md), so there is no publisher verification on top -- stated
 * honestly, not overclaimed.
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

  /**
   * No-ops safely on unpackaged dev runs and non-Windows platforms -- there's
   * nothing to update to/from -- and in the Microsoft Store (MSIX) build,
   * where the Store delivers updates and an in-app updater isn't allowed.
   */
  start({ isPackaged, platform, windowsStore = false }) {
    if (!isPackaged || platform !== 'win32' || windowsStore) return;

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

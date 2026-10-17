'use strict';

/**
 * Quitting while a server runs: the app must not exit until the server has saved and stopped, or the world is cut off
 * mid-save. This holds the first quit request, shuts everything down, waits (with a limit), then lets a second quit
 * through. Written with its parts passed in so it can be tested without Electron.
 *
 *   serverRunning()          — is a managed server process still alive?
 *   stopEverything()         — stop the tunnel and tell the server to stop
 *   waitForServerStopped(ms) — resolves when the server has exited, or after ms
 *   quit()                   — asks the app to quit again
 */
function createQuitGate({ serverRunning, stopEverything, waitForServerStopped, quit, timeoutMs }) {
  let quitting = false; // the second request: let it through
  let waiting = false; // the first request is being handled

  return {
    /** The app's 'before-quit' handler. */
    onBeforeQuit(event) {
      if (quitting) return;
      if (!serverRunning()) { quitting = true; return; }
      event.preventDefault();
      if (waiting) return; // another quit request while we wait: the wait already under way covers it
      waiting = true;
      try { stopEverything(); } catch { /* still wait and quit */ }
      Promise.resolve(waitForServerStopped(timeoutMs)).catch(() => {}).then(() => {
        quitting = true;
        quit();
      });
    },
    isQuitting: () => quitting,
  };
}

module.exports = { createQuitGate };

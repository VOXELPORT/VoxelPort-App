'use strict';

/**
 * Central IPC sender validation (item 14). Every privileged ipcMain.handle
 * wraps its handler with validateSender so a frame that isn't our own main
 * window's top-level document — a devtools-injected frame, a stray
 * <webview>, a compromised/renavigated renderer — can never invoke it.
 * Fails closed: anything not explicitly recognized as safe is rejected.
 */
function isTrustedSender(event, mainWindow) {
  if (!event || !event.senderFrame) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (event.senderFrame.top !== event.senderFrame) return false; // must be the top frame, not a subframe
  const wc = mainWindow.webContents;
  return !wc.isDestroyed() && event.senderFrame === wc.mainFrame;
}

/** Wraps an ipcMain.handle listener, rejecting calls from an untrusted sender. */
function guarded(getMainWindow, fn) {
  return (event, ...args) => {
    if (!isTrustedSender(event, getMainWindow())) {
      throw new Error('Rejected: untrusted IPC sender.');
    }
    return fn(event, ...args);
  };
}

module.exports = { isTrustedSender, guarded };

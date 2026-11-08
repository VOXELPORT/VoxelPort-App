'use strict';

// The small changes the "bring the previous app's data over" banner makes to the released Electron renderer: the banner's markup and its script
// tag. tools/build-ui.js applies them (with the other ui-patches-*.js files), and stops if an anchor is missing. The words and buttons live in
// ui-extra/legacy-import.js.

module.exports = [
  {
    file: 'index.html',
    find: '<div id="discordBanner" class="discord-banner hidden" role="status"></div>',
    replace:
      '<div id="discordBanner" class="discord-banner hidden" role="status"></div>\n' +
      '  <div id="legacyBanner" class="update-banner hidden" role="status" style="flex-wrap:wrap">\n' +
      '    <span id="legacyBannerText"></span>\n' +
      '    <span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">\n' +
      '      <button id="legacyBringBtn" class="ghost small" type="button">Bring it over</button>\n' +
      '      <button id="legacyLaterBtn" class="link-btn" type="button">Not now</button>\n' +
      '      <button id="legacyNeverBtn" class="link-btn" type="button">Don\'t ask again</button>\n' +
      '      <button id="legacyCloseBtn" class="ghost small hidden" type="button">OK</button>\n' +
      '    </span>\n' +
      '  </div>',
  },
  { file: 'index.html', find: '<script src="tauri-bridge.js"></script>', replace: '<script src="tauri-bridge.js"></script>\n  <script src="legacy-import.js"></script>' },
];

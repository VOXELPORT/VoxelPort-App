'use strict';

// Web control (testers only): the library card, its own screen and the script that drives them. The logic is in
// ui-extra/webcontrol-ui.js; the backend (src-tauri/src/webcontrol.rs) answers `available: false` unless the app was
// started for web control, and the card then stays hidden. The text of the screen is in tools/webcontrol-screen.html,
// copied from the Electron app's web-control branch.
const fs = require('fs');
const path = require('path');

const screen = fs.readFileSync(path.join(__dirname, 'webcontrol-screen.html'), 'utf8').replace(/\r\n/g, '\n').trimEnd();

/** @type {{file: string, find: string, replace: string, all?: boolean}[]} */
module.exports = [
  {
    file: 'index.html',
    find: '<div class="server-list" id="serverList"></div>\n',
    replace: `<div class="server-list" id="serverList"></div>
      <div class="set-group hidden" id="webControlCard">
        <div class="set-group-title">Web control</div>
        <p class="hint" id="webControlCardText">Let friends start, stop and watch your server from their phone or a browser.</p>
        <button class="ghost" id="webControlOpenBtn" type="button">Set up</button>
      </div>
`,
  },
  { file: 'index.html', find: '    <!-- APP SETTINGS -->', replace: `${screen}\n\n    <!-- APP SETTINGS -->` },
  { file: 'index.html', find: '<script src="discord-ui.js"></script>', replace: '<script src="discord-ui.js"></script>\n  <script src="webcontrol-ui.js"></script>' },
];

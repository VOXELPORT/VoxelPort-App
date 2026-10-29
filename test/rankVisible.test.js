'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', f), 'utf8').replace(/\r\n/g, '\n');
const section = (html, id) => { const s = html.indexOf(`id="${id}"`); return html.slice(s, html.indexOf('</section>', s)); };

test('the Discord account and your rank live in App Settings, not buried in one server\'s settings', () => {
  const html = read('index.html');
  const app = section(html, 'screen-app-settings');
  for (const id of ['setDiscordStatus', 'setDiscordRank', 'setDiscordActions']) assert.ok(app.includes(`id="${id}"`), `${id} is in App Settings`);
  assert.match(app, /Discord account/);
  for (const id of ['setDiscordStatus', 'setDiscordRank', 'setDiscordActions']) assert.equal(html.split(`id="${id}"`).length, 2, `${id} appears exactly once`);
});

test('the rank also shows as a badge in the header of the main screen', () => {
  const html = read('index.html');
  const header = html.slice(html.indexOf('<header class="head">'), html.indexOf('</header>'));
  assert.ok(header.includes('id="rankBadge"'), 'the badge is in the header');
  const ui = read('discord-ui.js');
  assert.match(ui, /rankBadge/);
  assert.match(ui, /textContent = .*RANKS/);
});

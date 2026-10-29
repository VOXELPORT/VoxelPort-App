'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', ...p), 'utf8').replace(/\r\n/g, '\n');

test('App Settings shows the device token (hidden characters) and the short ID, each with a copy button', () => {
  const html = read('index.html');
  const start = html.indexOf('id="screen-app-settings"');
  const screen = html.slice(start, html.indexOf('</section>', start));
  for (const id of ['appTokenField', 'appCopyTokenBtn', 'appSupporterID', 'appCopySupporterIDBtn']) assert.ok(screen.includes(`id="${id}"`), `${id} is on the App Settings screen`);
  assert.match(screen, /Device token/);
});

test('the token fields are filled from the masked value and the copy buttons use the main-process copy, never the raw token', () => {
  const js = read('renderer.js');
  assert.match(js, /appTokenField'\)\.value = info\.maskedToken/);
  assert.match(js, /appSupporterID'\)\.value = info\.supporterID/);
  assert.match(js, /appCopyTokenBtn/);
  assert.match(js, /appCopySupporterIDBtn/);
  assert.ok(!/deviceToken/.test(js), 'the raw token is never handled in the renderer');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'discord-ui.js'), 'utf8').replace(/\r\n/g, '\n');

test('everyone who is not signed in gets the full login page, new installs and existing ones alike', () => {
  const gate = ui.slice(ui.indexOf('function renderGate'), ui.indexOf('function renderBanner'));
  assert.match(gate, /const show = !!state && !state\.allowed && state\.reachable;/);
  assert.ok(!/newInstall/.test(gate), 'the login page does not depend on how old the install is');
});

test('the login page carries the VoxelPort logo and name, and the small banner is only a fallback when the service cannot be reached', () => {
  const gate = ui.slice(ui.indexOf('function renderGate'), ui.indexOf('function renderBanner'));
  assert.match(gate, /icon\.svg/);
  assert.match(gate, /brand-word/);
  const banner = ui.slice(ui.indexOf('function renderBanner'), ui.indexOf('function renderSettings'));
  assert.match(banner, /const blocked = !!state && !state\.allowed && !state\.reachable && state\.banner === 'blocked';/);
});

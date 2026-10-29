'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const main = src('main/main.js');
const html = src('renderer/index.html');
const LANGS = ['de', 'es', 'fr', 'hinglish', 'id', 'it', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'vi', 'zh'];
const STRINGS = [
  'Web control',
  'Let friends start and stop my server from the web',
  'Server friends can start',
  'Sign in with Discord to use web control.',
  'Web control is on. Friends can reach this PC.',
  'Connecting to the web…',
  'Create a server first.',
];

test('App Settings has the Web control section, and it is switched off until the owner chooses', () => {
  for (const id of ['webControlGroup', 'webControlOn', 'webControlProfile', 'webControlStatus']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('<script src="webcontrol-ui.js"></script>'));
  assert.match(main, /webControl: \{ enabled: false, profileId: null \}/);
  assert.match(main, /enabled: !!\(v && v\.enabled === true\)/, 'only an explicit true switches it on');
});

test('every new line of text is translated in all 14 languages', () => {
  for (const lang of LANGS) {
    const file = src(`renderer/lang/${lang}.js`);
    for (const s of STRINGS) assert.ok(file.includes(`'${s.replace(/'/g, "\\'")}':`), `${lang}: ${s}`);
    assert.ok(file.includes("accounts.voxelport.in"), `${lang}: explanation`);
  }
});

test('main registers both handlers and only obeys a signed-in member with no Discord banner', () => {
  assert.match(main, /ipcMain\.handle\('webcontrol:get'/);
  assert.match(main, /ipcMain\.handle\('webcontrol:set'/);
  const allowed = main.slice(main.indexOf('function webControlAllowed()'), main.indexOf('const webControlActions'));
  assert.match(allowed, /snap\.session/);
  assert.match(allowed, /gate\.allowed && gate\.banner === 'none' && !gate\.mustSignIn/);
});

test('the four actions reuse the app’s own start, stop, restart and kick paths and nothing else', () => {
  const actions = main.slice(main.indexOf('const webControlActions'), main.indexOf('function syncWebControl'));
  assert.match(actions, /startServerProfile\(id\)/);
  assert.match(actions, /serverProc\.stop\(\)/);
  assert.match(actions, /restartActiveServer\(\)/);
  assert.match(actions, /serverProc\.playerAction\('kick', name\)/);
  assert.ok(!/sendCommand/.test(actions), 'friends can never send a raw console command');
  assert.deepEqual([...actions.matchAll(/^  (?:async )?(\w+)\(/gm)].map((m) => m[1]).sort(), ['kick', 'restart', 'start', 'status', 'stop']);
});

test('the loop is stopped when web control is switched off, when the account stops being allowed, and on quit', () => {
  const sync = main.slice(main.indexOf('function syncWebControl'), main.indexOf('function webControlState'));
  assert.match(sync, /!want \|\| !remoteControl\.snapshot\(\)\.running/);
  assert.match(sync, /remoteControl\.stop\(\)/);
  assert.match(main, /app\.on\('will-quit', \(\) => \{ presence\.dispose\(\); if \(remoteControl\) remoteControl\.stop\(\); \}\)/);
  assert.match(main, /send\('discord:state', discordState\(\)\);\r?\n  syncWebControl\(\);/);
});

test('the switch needs a real server profile, and a friend’s kick only works on a player who is online', () => {
  assert.match(main, /const pid = typeof profileId === 'string' && serverProfiles\.getProfile\(userDataDir\(\), profileId\) \? profileId : null;/);
  assert.match(main, /enabled: !!enabled && !!pid/);
  assert.match(main, /!serverProc\.online\.has\(name\)/);
});

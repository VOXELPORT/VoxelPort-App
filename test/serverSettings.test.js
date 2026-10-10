'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseProperties, escapeValue, readSettings, validateSettings, TEMPLATES, getTemplate, listingMode,
} = require('../src/main/serverSettings');
const { writeServerProperties, updateServerPropertiesSafely } = require('../src/main/serverInstall');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-settings-'));
}

test('parseProperties reads Minecraft-style server.properties', () => {
  const p = parseProperties('#Minecraft server properties\nmotd=Hi \\u00e9t\\u00e9\nlevel-type=minecraft\\:flat\nmax-players = 12\n\npvp=false\n');
  assert.equal(p.get('motd'), 'Hi été');
  assert.equal(p.get('level-type'), 'minecraft:flat');
  assert.equal(p.get('max-players'), '12');
  assert.equal(p.get('pvp'), 'false');
});

test('escapeValue keeps values on one line and round-trips non-ASCII', () => {
  assert.equal(escapeValue('a\\b'), 'a\\\\b');
  assert.equal(escapeValue('x\nenable-rcon=true'), 'xenable-rcon=true');
  assert.equal(parseProperties('motd=' + escapeValue('Café 🎮')).get('motd'), 'Café 🎮');
});

test('readSettings returns typed values with defaults', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server.properties'), 'gamemode=creative\nhardcore=true\nmax-players=7\nview-distance=oops\n');
  const v = readSettings(dir);
  assert.equal(v.gamemode, 'creative');
  assert.equal(v.hardcore, true);
  assert.equal(v['max-players'], 7);
  assert.equal(v['view-distance'], 10); // unparsable → default
  assert.equal(v.difficulty, 'easy'); // missing → default
  assert.equal(readSettings(path.join(dir, 'nope'))['max-players'], 20);
});

test('validateSettings accepts good values and serialises them', () => {
  const out = validateSettings({ gamemode: 'survival', hardcore: false, 'max-players': 50, motd: '  My Server ', 'white-list': true });
  assert.deepEqual(out, {
    gamemode: 'survival', hardcore: 'false', 'max-players': '50', motd: 'My Server', 'white-list': 'true', 'enforce-whitelist': 'true',
  });
});

test('validateSettings refuses unknown or dangerous keys and bad values', () => {
  assert.throws(() => validateSettings({ 'online-mode': false }), /can't be changed/);
  assert.throws(() => validateSettings({ 'enable-rcon': true }), /can't be changed/);
  assert.throws(() => validateSettings({ gamemode: 'god' }), /Invalid/);
  assert.throws(() => validateSettings({ 'max-players': 0 }), /between/);
  assert.throws(() => validateSettings({ 'max-players': 2.5 }), /between/);
  assert.throws(() => validateSettings({ pvp: 'yes' }), /on or off/);
  assert.throws(() => validateSettings({ motd: 'x'.repeat(60) }), /at most/);
});

test('saved settings land in server.properties without touching other lines', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server.properties'), 'online-mode=true\nmotd=Old\ncustom-plugin-key=keep\n');
  updateServerPropertiesSafely(dir, validateSettings({ motd: 'New ✨', difficulty: 'hard' }));
  const p = parseProperties(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'));
  assert.equal(p.get('motd'), 'New ✨');
  assert.equal(p.get('difficulty'), 'hard');
  assert.equal(p.get('custom-plugin-key'), 'keep');
  assert.equal(p.get('online-mode'), 'true');
});

test('templates are well-formed and apply through writeServerProperties', () => {
  const ids = new Set();
  for (const t of TEMPLATES) {
    assert.ok(!ids.has(t.id), `duplicate template ${t.id}`);
    ids.add(t.id);
    assert.ok(['vanilla', 'paper', 'fabric'].includes(t.type));
    for (const v of Object.values(t.properties)) assert.ok(!/[\r\n]/.test(v));
  }
  const dir = tmpDir();
  writeServerProperties(dir, { port: 25570, extra: getTemplate('creative').properties });
  const p = parseProperties(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'));
  assert.equal(p.get('gamemode'), 'creative');
  assert.equal(p.get('level-type'), 'minecraft:flat');
  assert.equal(p.get('server-port'), '25570');
  assert.equal(getTemplate('crossplay').bedrock, true);
  assert.equal(getTemplate('nope'), null);
});

test('template extras can never override protected keys', () => {
  const dir = tmpDir();
  writeServerProperties(dir, { port: 25565, extra: { 'online-mode': 'false', 'server-port': '1', 'enable-rcon': 'true', motd: 'a\nenable-rcon=true' } });
  const p = parseProperties(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'));
  assert.equal(p.get('online-mode'), 'true');
  assert.equal(p.get('server-port'), '25565');
  assert.equal(p.get('enable-rcon'), undefined);
});

test('listingMode picks the public-list label', () => {
  assert.equal(listingMode({ hardcore: true, gamemode: 'survival' }, 'paper'), 'hardcore');
  assert.equal(listingMode({ gamemode: 'creative' }, 'fabric'), 'modded');
  assert.equal(listingMode({ gamemode: 'creative' }, 'paper'), 'creative');
  assert.equal(listingMode({ gamemode: 'spectator' }, 'paper'), '');
});

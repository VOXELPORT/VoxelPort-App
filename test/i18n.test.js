'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { allStrings, norm } = require('./helpers/i18nKeys');
const { timeLeftPhrase } = require('../src/main/notice');

// The language files add themselves to window.VP_LANGS, and i18n.js reads them from there.
globalThis.window = globalThis;
require('../src/renderer/lang/hinglish.js');
const i18n = require('../src/renderer/i18n.js');
const hinglish = globalThis.VP_LANGS.hinglish;

// Text that reads the same in Hinglish: brand names, technical words, the choices of a setting.
const SAME_IN_BOTH = new Set([
  'wss://relay.voxelport.in', 'Survival SMP', 'VOXEL', 'PORT', '.voxelport.in', 'voxelport.in/servers', 'voxelport.in', 'trazhub@upi',
  'Java', 'MB', 'CPU', 'RAM', 'TPS', 'Vanilla', 'Paper', 'Fabric', 'Bedrock', 'Minecraft EULA', 'Java + Bedrock', 'Hardcore',
  'Survival', 'Creative', 'Adventure', 'Spectator', 'Peaceful', 'Easy', 'Normal', 'Hard', 'PvP',
  'Online', 'Error', 'Public', 'Region', 'Version', 'Server', 'General', 'Gameplay', 'Settings', 'Backups', 'BACKUPS', 'SETTINGS',
  'Manual', 'Automatic', 'Relay URL', 'Device token', 'Server type', 'Local port', '· Port', 'CPU', 'Server settings',
  'Server backups', 'Automatic backups', 'Player accounts', 'Public server list', 'Bedrock players', 'Max players',
  '{n} GB', '{n} MB', '{type} • {version} • port {port}', 'Advanced', 'Server folder', 'Description (MOTD)', 'Game mode', 'Difficulty',
  'Modded (Fabric)', 'Creative Flat', 'Peaceful Chill', 'View distance (chunks)', 'Simulation distance (chunks)', 'Spawn protection (blocks)',
  'Memory (RAM) —', 'affiliate link', 'Off.', 'Relay: {message}', 'Local server port',
  'players', 'relay ping', 'region', 'SERVER SETTINGS', '★ Supporter perks', '♥ Tip jar',
  'Plugins', 'PLUGINS', 'Mods', 'MODS',
]);

// Messages the main process can send back; the screen runs them through t().
const MESSAGES_THE_APP_SENDS = [
  'Server profile not found.', 'Start this server before making it public.', 'Stop and un-publish this server before removing it.',
  'Make a server public first, then pick your address.', 'Make a server public first, then remove your address.',
  'Your address lives on another region — switch to it to remove it.', "The relay didn't answer — try again.",
  'Could not set that address.', 'Could not remove the address.', 'Could not remove this server.', "Couldn't change that.",
  'Already getting Java ready for a server — one moment.', 'Bedrock players need a Paper or Fabric server.',
  'Enter a valid port (1–65535).', 'Enter a valid server port (1–65535).', 'Invalid RAM amount.', 'Invalid RAM allocation.',
  'A backup or restore is already running for this server.', 'A backup or restore is running for this server. Try again in a moment.',
  'A backup or restore is running; try again in a moment.', 'The server is starting or stopping. Try again in a moment.',
  'Stop the server first. A running server would write over the restored world.', 'The backup failed.', 'The restore failed.',
  'That backup is gone.', "That is not one of VoxelPort's backups.", 'That file is not a VoxelPort backup.', 'That backup has no world in it.',
  'That backup is from a newer VoxelPort or is damaged.', 'The backup could not be verified.', 'That backup is too big to restore.',
  'That backup contains a file outside its folder, so it was not restored.',
  'Plugins and mods need a Paper or Fabric server.', 'Invalid project.', 'That one was not installed by VoxelPort.',
  'Stop the server first. A running server has its plugins and mods open.', 'Stop the server first to update one that is already installed.',
  "Couldn't install that.", "Couldn't remove that.",
  'Wait for the server to finish starting, then make it public.', 'The previous server is still shutting down — try again in a few seconds.',
];

const { static: staticStrings, code: codeStrings, data: dataStrings } = allStrings();
const everything = [...new Set([...staticStrings, ...codeStrings, ...dataStrings, ...MESSAGES_THE_APP_SENDS])];

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// ─── Choosing a language ─────────────────────────────────────────────────────

test('the language is what the person chose, else Hinglish on a Hindi system, else English', () => {
  assert.equal(i18n.pickLanguage({ stored: 'hinglish', browser: 'en-US' }), 'hinglish');
  assert.equal(i18n.pickLanguage({ stored: 'en', browser: 'hi-IN' }), 'en', 'a choice beats the system language');
  assert.equal(i18n.pickLanguage({ browser: 'hi-IN' }), 'hinglish');
  assert.equal(i18n.pickLanguage({ browser: 'hi' }), 'hinglish');
  assert.equal(i18n.pickLanguage({ browser: 'en-IN' }), 'en');
  assert.equal(i18n.pickLanguage({ browser: 'hindi-fake' }), 'en');
  assert.equal(i18n.pickLanguage({ stored: 'klingon', browser: 'en-US' }), 'en');
  assert.equal(i18n.pickLanguage({}), 'en');
  assert.equal(i18n.pickLanguage(), 'en');
});

test('translate gives the Hinglish text, fills in values, and falls back to English', () => {
  assert.equal(i18n.translate('hinglish', 'Start server'), 'Server start karo');
  assert.equal(i18n.translate('en', 'Start server'), 'Start server');
  assert.equal(i18n.translate('hinglish', 'Saved!'), 'Save ho gaya!');
  assert.equal(i18n.translate('hinglish', 'in {n} minutes', { n: 5 }), '5 minute mein');
  assert.equal(i18n.translate('en', 'in {n} minutes', { n: 5 }), 'in 5 minutes');
  assert.equal(i18n.translate('hinglish', 'A sentence nobody translated'), 'A sentence nobody translated');
  assert.equal(i18n.translate('hinglish', 'Hello {who}', { who: 'Steve' }), 'Hello Steve');
  assert.equal(i18n.translate('hinglish', 'Hello {who}', {}), 'Hello {who}', 'a value that was not given stays visible');
  assert.equal(i18n.translate('no-such-language', 'Start server'), 'Start server');
});

test('a value cannot reach into the translation table through its name', () => {
  assert.equal(i18n.translate('hinglish', 'constructor'), 'constructor');
  assert.equal(i18n.translate('hinglish', '__proto__'), '__proto__');
  assert.equal(i18n.translate('hinglish', 'toString'), 'toString');
  assert.equal(i18n.translate('en', 'Hi {constructor}', {}), 'Hi {constructor}');
});

// ─── The dictionary is complete and tidy ─────────────────────────────────────

test('every string the app can show has a Hinglish translation (or reads the same on purpose)', () => {
  const missing = everything.filter((s) => !(s in hinglish) && !SAME_IN_BOTH.has(s));
  assert.deepEqual(missing, [], `Add these to src/renderer/lang/hinglish.js:\n  ${missing.map((s) => JSON.stringify(s)).join('\n  ')}`);
});

test('a translation keeps every {value} of the English text, and adds none', () => {
  for (const [en, hi] of Object.entries(hinglish)) {
    assert.deepEqual(placeholders(hi), placeholders(en), `placeholders differ in ${JSON.stringify(en)}`);
  }
});

test('there are no empty translations, and none that just repeat the English', () => {
  for (const [en, hi] of Object.entries(hinglish)) {
    assert.ok(typeof hi === 'string' && hi.trim().length > 0, `${JSON.stringify(en)} is empty`);
    assert.notEqual(hi, en, `${JSON.stringify(en)} is the same in both: drop it from the dictionary and add it to SAME_IN_BOTH in this test if it is meant to stay`);
  }
});

test('Hinglish is written in the English alphabet, as promised', () => {
  for (const [en, hi] of Object.entries(hinglish)) assert.ok(!/[ऀ-ॿ]/.test(hi), `Devanagari in ${JSON.stringify(en)}`);
});

test('no entry is left over from text the app no longer shows', () => {
  const known = new Set(everything);
  const stale = Object.keys(hinglish).filter((k) => !known.has(k));
  assert.deepEqual(stale, [], 'Remove these from src/renderer/lang/hinglish.js (or add the code that uses them)');
});

test('the words that stay the same on purpose really are in the app', () => {
  const known = new Set(everything);
  const unused = [...SAME_IN_BOTH].filter((s) => !known.has(s));
  assert.deepEqual(unused, [], 'Drop these from SAME_IN_BOTH in this test');
});

// ─── The relay-announcement times match in the window and in the game's chat ─

test('the countdown wording on screen matches the wording said in the game', () => {
  for (const minutes of [2, 5, 10, 59, 90]) {
    assert.equal(i18n.translate('en', 'in {n} minutes', { n: minutes }), timeLeftPhrase(minutes * 60, 'en'));
    assert.equal(i18n.translate('hinglish', 'in {n} minutes', { n: minutes }), timeLeftPhrase(minutes * 60, 'hinglish'));
  }
  assert.equal(i18n.translate('hinglish', 'in 1 minute'), timeLeftPhrase(60, 'hinglish'));
  assert.equal(i18n.translate('hinglish', 'in less than a minute'), timeLeftPhrase(30, 'hinglish'));
  assert.equal(i18n.translate('hinglish', 'now'), timeLeftPhrase(0, 'hinglish'));
  assert.equal(i18n.translate('hinglish', 'in about {n} hours', { n: 3 }), timeLeftPhrase(3 * 3600, 'hinglish'));
});

// ─── Translating the page that is already on screen ──────────────────────────

/** A tiny stand-in for the page: a few text pieces and elements with attributes, enough to run applyToPage. */
function fakePage(texts, elements = []) {
  const textNodes = texts.map((t) => ({ nodeValue: t.text, parentElement: { tagName: t.tag || 'SPAN', closest: (sel) => (t.skip && sel === '[data-no-i18n]' ? {} : null) } }));
  const els = elements.map((e) => {
    const attrs = { ...e.attrs };
    return { closest: (sel) => (e.skip && sel === '[data-no-i18n]' ? {} : null), getAttribute: (a) => attrs[a] ?? null, setAttribute: (a, v) => { attrs[a] = v; }, attrs };
  });
  return {
    body: {},
    documentElement: { lang: 'en' },
    createTreeWalker: () => { let i = -1; return { nextNode: () => (++i < textNodes.length ? textNodes[i] : null) }; },
    querySelectorAll: () => els,
    textNodes,
    els,
  };
}

test('page text is translated in place, keeping the spaces around it', () => {
  const doc = fakePage([{ text: '\n      Start server\n    ' }, { text: ' Idle ' }, { text: '   ' }, { text: 'Some text with no translation' }]);
  // applyToPage reads the language from the browser's storage, which a test does not have: run it as Hinglish.
  const hinglishPage = loadI18nAs('hinglish');
  hinglishPage.applyToPage(doc);
  assert.equal(doc.textNodes[0].nodeValue, '\n      Server start karo\n    ');
  assert.equal(doc.textNodes[1].nodeValue, ' Ruka hua ');
  assert.equal(doc.textNodes[2].nodeValue, '   ');
  assert.equal(doc.textNodes[3].nodeValue, 'Some text with no translation');
  assert.equal(doc.documentElement.lang, 'hi-Latn');
});

test('text that was split over several lines is still found', () => {
  const doc = fakePage([{ text: 'Auto uses the relay closest to you.\n          Players anywhere can still join.' }]);
  loadI18nAs('hinglish').applyToPage(doc);
  assert.match(doc.textNodes[0].nodeValue, /sabse paas wala relay/);
});

test('scripts, styles and anything marked data-no-i18n are left alone', () => {
  const doc = fakePage([
    { text: 'Start server', tag: 'SCRIPT' },
    { text: 'Start server', tag: 'STYLE' },
    { text: 'Start server', skip: true },
    { text: 'Start server', tag: 'TEXTAREA' },
  ]);
  loadI18nAs('hinglish').applyToPage(doc);
  assert.deepEqual(doc.textNodes.map((n) => n.nodeValue), ['Start server', 'Start server', 'Start server', 'Start server']);
});

test('placeholders, titles and labels are translated too', () => {
  const doc = fakePage([], [
    { attrs: { placeholder: 'Type a server command…', title: 'Copy' } },
    { attrs: { 'aria-label': 'Server performance' } },
    { attrs: { title: 'Copy' }, skip: true },
  ]);
  loadI18nAs('hinglish').applyToPage(doc);
  assert.equal(doc.els[0].attrs.placeholder, 'Server command likho…');
  assert.equal(doc.els[0].attrs.title, 'Copy karo');
  assert.equal(doc.els[1].attrs['aria-label'], 'Server ki performance');
  assert.equal(doc.els[2].attrs.title, 'Copy', 'marked data-no-i18n');
});

test('in English the page is not touched at all', () => {
  const doc = fakePage([{ text: 'Start server' }], [{ attrs: { title: 'Copy' } }]);
  loadI18nAs('en').applyToPage(doc);
  assert.equal(doc.textNodes[0].nodeValue, 'Start server');
  assert.equal(doc.els[0].attrs.title, 'Copy');
  assert.equal(doc.documentElement.lang, 'en');
});

/** A fresh copy of i18n.js that thinks the person picked `lang`. */
function loadI18nAs(lang) {
  const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
  const code = fs.readFileSync(file, 'utf8');
  const sandboxRoot = { VP_LANGS: globalThis.VP_LANGS, localStorage: { getItem: () => lang, setItem() {} }, navigator: { language: 'en-US' } };
  const module = { exports: {} };
  new Function('root', 'module', `const window = undefined; ${code.replace(/\}\)\(typeof window[^)]*\);\s*$/, '})(root);')}`)(sandboxRoot, module);
  return module.exports;
}

test('the sources are scanned: the numbers below catch a scan that silently found nothing', () => {
  assert.ok(staticStrings.length > 100, `only ${staticStrings.length} page strings found`);
  assert.ok(codeStrings.length > 100, `only ${codeStrings.length} code strings found`);
  assert.ok(dataStrings.length > 20, `only ${dataStrings.length} data strings found`);
  assert.ok(norm('  a   b ') === 'a b');
});

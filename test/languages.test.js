'use strict';

// The languages besides English and Hinglish (Hinglish has its own, stricter checks in i18n.test.js).
// A string with no translation shows in English, so this only insists the files are well formed and
// that they cover everything Hinglish does.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
const CODES = ['es', 'pt', 'fr', 'de', 'it', 'ru', 'pl', 'tr', 'id', 'vi', 'zh', 'ja', 'ko'];
require('../src/renderer/lang/hinglish.js');
for (const code of CODES) require(`../src/renderer/lang/${code}.js`);
const i18n = require('../src/renderer/i18n.js');
const { norm } = require('./helpers/i18nKeys');

const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
const reference = Object.keys(globalThis.VP_LANGS.hinglish);
// Words some language writes exactly like English: they are left out of its file on purpose.
const MAY_READ_THE_SAME = new Set(['{n} downloads', '{n} minutes', '— optional', 'optional', 'Versions', 'System', '1 server', 'Voice chat · Supporter Plus']);

test('every language is offered in the picker and has a dictionary', () => {
  for (const code of CODES) {
    assert.ok(i18n.LANGUAGES[code], `${code} is missing from LANGUAGES in i18n.js`);
    assert.ok(globalThis.VP_LANGS[code], `${code} has no dictionary`);
  }
});

for (const code of CODES) {
  const dict = () => globalThis.VP_LANGS[code];

  test(`${code}: covers every string Hinglish translates`, () => {
    const missing = reference.filter((k) => !(k in dict()) && !MAY_READ_THE_SAME.has(k));
    assert.deepEqual(missing, [], `Add these to src/renderer/lang/${code}.js`);
  });

  test(`${code}: keeps every {value} of the English text, with no empty or untranslated entries`, () => {
    for (const [en, text] of Object.entries(dict())) {
      assert.deepEqual(placeholders(text), placeholders(en), `placeholders differ in ${JSON.stringify(en)}`);
      assert.ok(text.trim().length > 0, `${JSON.stringify(en)} is empty`);
      assert.notEqual(text, en, `${JSON.stringify(en)} is the same as the English: drop it, it shows as it is`);
      assert.equal(norm(en), en, `key ${JSON.stringify(en)} has stray whitespace`);
    }
  });

  test(`${code}: no entry is left over from text the app no longer shows`, () => {
    const known = new Set([...reference, 'Versions', 'System']);
    const stale = Object.keys(dict()).filter((k) => !known.has(k));
    assert.deepEqual(stale, [], `Remove these from src/renderer/lang/${code}.js`);
  });
}

test('a system language picks its translation when nothing was chosen', () => {
  assert.equal(i18n.pickLanguage({ browser: 'es-MX' }), 'es');
  assert.equal(i18n.pickLanguage({ browser: 'pt-BR' }), 'pt');
  assert.equal(i18n.pickLanguage({ browser: 'fr' }), 'fr');
  assert.equal(i18n.pickLanguage({ browser: 'de-AT' }), 'de');
  assert.equal(i18n.pickLanguage({ browser: 'en-GB' }), 'en');
  assert.equal(i18n.pickLanguage({ browser: 'dezzz' }), 'en');
  assert.equal(i18n.pickLanguage({ stored: 'fr', browser: 'de' }), 'fr');
  assert.equal(i18n.pickLanguage({ browser: 'zh-CN' }), 'zh');
  assert.equal(i18n.pickLanguage({ browser: 'ja-JP' }), 'ja');
  assert.equal(i18n.pickLanguage({ browser: 'id-ID' }), 'id');
  assert.equal(i18n.pickLanguage({ browser: 'ru' }), 'ru');
});

test('translate gives each language its text and falls back to English', () => {
  assert.equal(i18n.translate('es', 'My servers'), 'Mis servidores');
  assert.equal(i18n.translate('pt', '{n} servers', { n: 3 }), '3 servidores');
  assert.equal(i18n.translate('fr', 'Saved!'), 'Enregistré !');
  assert.equal(i18n.translate('de', 'Save'), 'Speichern');
  assert.equal(i18n.translate('de', 'A sentence nobody translated'), 'A sentence nobody translated');
});

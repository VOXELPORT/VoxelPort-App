'use strict';

// Finds every piece of text the app can show, so a test can insist each one has a translation.
//   staticStrings(): the words written into index.html (text and placeholder/title/aria-label/alt)
//   codeStrings():   the literals passed to t(...) in the renderer scripts
//   dataStrings():   labels that come from data tables (server settings, templates, the options of a choice)
// Run `node test/helpers/i18nKeys.js` to print them all.

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&hellip;': '…', '&rsaquo;': '›', '&middot;': '·', '&mdash;': '—', '&ndash;': '–' };
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);

/** Text and translatable attributes in index.html. Elements marked data-no-i18n are skipped. */
function staticStrings() {
  let html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|svg|textarea)\b[\s\S]*?<\/\1>/gi, '');
  const out = new Set();

  // Elements to skip entirely (and everything inside them): <a ... data-no-i18n>...</a>
  html = html.replace(/<a\b[^>]*data-no-i18n[^>]*>[\s\S]*?<\/a>/gi, '');

  for (const m of html.matchAll(/<[a-z][^>]*>/gi)) {
    for (const a of m[0].matchAll(/\s(placeholder|title|aria-label|alt)="([^"]*)"/gi)) {
      const v = norm(decode(a[2]));
      if (v) out.add(v);
    }
  }
  // <textarea placeholder> was removed above with the element: add its placeholder back.
  const original = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  for (const m of original.matchAll(/<textarea\b[^>]*placeholder="([^"]*)"/gi)) out.add(norm(decode(m[1])));

  const body = html.slice(html.indexOf('<body'));
  for (const piece of body.split(/<[^>]*>/)) {
    const v = norm(decode(piece));
    if (v && /[A-Za-z]/.test(v)) out.add(v);
  }
  return [...out];
}

const LITERAL = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")`;
const CALL = new RegExp(String.raw`(?<![\w$])t\(\s*(${LITERAL})`, 'g');

function unquote(literal) {
  // The literal came from our own source code, so it is only a plain quoted string.
  return Function(`"use strict"; return ${literal};`)();
}

/** Every literal first argument of t(...) / window.t(...) in the renderer scripts. */
function codeStrings() {
  const out = new Set();
  for (const file of fs.readdirSync(RENDERER)) {
    if (!file.endsWith('.js')) continue;
    if (file === 'i18n.js') continue; // its own comment examples
    const src = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    for (const m of src.matchAll(CALL)) out.add(unquote(m[1]));
  }
  return [...out];
}

/** Labels that are data, not code: settings fields, server templates, and the options of a choice. */
function dataStrings() {
  const { SETTINGS, TEMPLATES } = require('../../src/main/serverSettings');
  const out = new Set();
  for (const s of SETTINGS) {
    out.add(s.label);
    for (const o of s.options || []) out.add(o[0].toUpperCase() + o.slice(1));
  }
  for (const t of TEMPLATES) { out.add(t.label); out.add(t.blurb); }
  return [...out];
}

function allStrings() {
  return { static: staticStrings(), code: codeStrings(), data: dataStrings() };
}

module.exports = { staticStrings, codeStrings, dataStrings, allStrings, norm };

if (require.main === module) {
  const all = allStrings();
  for (const [kind, list] of Object.entries(all)) {
    console.log(`\n=== ${kind} (${list.length})`);
    for (const s of list) console.log(JSON.stringify(s));
  }
}

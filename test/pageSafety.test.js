'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const csp = (/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html) || [])[1] || '';
const directives = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...v] = d.split(/\s+/); return [name, v]; }));

test('the page only runs its own scripts, and cannot be given a base address, a form target or a plug-in', () => {
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['script-src'], ["'self'"], 'no inline scripts and no eval');
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.ok(!/unsafe-eval|https?:/.test(csp), 'nothing is loaded from the internet');
});

test('the page has no forms, plug-ins or frames the policy would have to allow', () => {
  assert.doesNotMatch(html, /<(form|object|embed|iframe|base)\b/i);
});

test('text from servers, players and Modrinth is never put in the page as HTML', () => {
  // The one place a template is written into the page as HTML is the server list, which escapes the name and version.
  const found = [];
  for (const file of fs.readdirSync(RENDERER).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    for (const m of src.matchAll(/(innerHTML|outerHTML)\s*=\s*`/g)) found.push(`${file}:${m[1]}`);
    assert.doesNotMatch(src, /insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/, `${file} builds HTML or code from text`);
  }
  assert.deepEqual(found, ['library.js:innerHTML']);
  const library = fs.readFileSync(path.join(RENDERER, 'library.js'), 'utf8');
  assert.match(library, /\$\{escapeHtml\(profile\.name\)\}/);
  assert.match(library, /\$\{escapeHtml\(profile\.version\)\}/);
});

test('the server type buttons show the name as text', () => {
  const wizard = fs.readFileSync(path.join(RENDERER, 'wizard.js'), 'utf8');
  assert.doesNotMatch(wizard, /innerHTML\s*=\s*`/);
  assert.match(wizard, /title\.textContent = t\.label/);
});

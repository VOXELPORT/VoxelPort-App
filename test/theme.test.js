'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const read = (f) => fs.readFileSync(path.join(RENDERER, f), 'utf8').replace(/\r\n/g, '\n');
const dark = read('theme-dark.css');
const light = read('theme-light.css');
const html = read('index.html');

/** The selectors (with the theme name taken out) of every rule in a theme file. */
function selectors(css, theme) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set();
  for (const m of body.matchAll(/([^{}]+)\{/g)) {
    for (const sel of m[1].split(',')) {
      const s = sel.trim().replace(new RegExp(`html\\[data-theme="${theme}"\\]`, 'g'), 'HTML');
      if (s.startsWith('HTML')) out.add(s.replace(/\s+/g, ' '));
    }
  }
  return out;
}

/** The custom properties set on the theme's html rule: { '--paper': '#181a1b', ... }. */
function palette(css, theme) {
  const block = new RegExp(`html\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))[1];
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

// ─── The two files stay in step ────────────────────────────────────────────────

test('every rule in the dark theme exists in the light theme, and the other way round', () => {
  const d = selectors(dark, 'dark');
  const l = selectors(light, 'light');
  assert.ok(d.size > 100, 'the dark theme was read');
  assert.deepEqual([...d].filter((s) => !l.has(s)), [], 'rules missing from theme-light.css: copy them over (with light colours)');
  assert.deepEqual([...l].filter((s) => !d.has(s)), [], 'rules in theme-light.css that the dark theme does not have');
});

test('each theme only applies under its own name, so the two never fight', () => {
  assert.equal(/html\[data-theme="light"\]/.test(dark), false);
  assert.equal(/html\[data-theme="dark"\]/.test(light.replace(/\/\*[\s\S]*?\*\//g, '')), false);
  // Nothing in the light file is left unscoped (every rule line starts with the theme, or is inside a @media block).
  for (const m of light.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^([^\s@}{][^{]*)\{/gm)) {
    assert.ok(m[1].trim().startsWith('html[data-theme="light"]'), `unscoped rule: ${m[1].trim()}`);
  }
});

test('the light palette sets every colour variable the dark one does, and with different values', () => {
  const d = palette(dark, 'dark');
  const l = palette(light, 'light');
  assert.deepEqual(Object.keys(d).sort(), Object.keys(l).sort());
  for (const v of ['--paper', '--card', '--ink', '--ink-2', '--muted', '--text']) assert.notEqual(l[v], d[v], `${v} should differ`);
  assert.match(l['color-scheme'] || light, /color-scheme: light/);
});

// ─── Readable colours (WCAG contrast, computed) ───────────────────────────────────

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('light theme text is readable on its surfaces (WCAG AA, 4.5:1)', () => {
  const p = palette(light, 'light');
  for (const surface of [p['--paper'], p['--card'], p['--paper-2']]) {
    for (const ink of ['--text', '--ink-2', '--muted', '--grass-dk', '--red']) {
      assert.ok(ratio(p[ink], surface) >= 4.5, `${ink} ${p[ink]} on ${surface} is ${ratio(p[ink], surface).toFixed(2)}:1`);
    }
  }
  // Button text on its button.
  const primary = /\.primary \{[^}]*background: (#[0-9a-f]{6}); color: (#[0-9a-f]{6})/i.exec(light);
  assert.ok(primary, 'the primary button colours were found');
  assert.ok(ratio(primary[1], primary[2]) >= 4.5, `primary button ${ratio(primary[1], primary[2]).toFixed(2)}:1`);
  const stop = /\.primary\.stop \{[^}]*background: var\(--red\); color: (#[0-9a-f]{3,6})/i.exec(light);
  assert.ok(stop && ratio(p['--red'], stop[1].length === 4 ? '#ffffff' : stop[1]) >= 4.5, 'Stop button text is readable');
});

// ─── The switch ──────────────────────────────────────────────────────────────────

/** Runs theme-init.js in a stand-in page and returns the pieces a test needs. */
function page({ stored, systemLight = false, storageBroken = false, noMatchMedia = false } = {}) {
  const attrs = {};
  const listeners = [];
  const store = new Map(stored === undefined ? [] : [['vp-theme', stored]]);
  const media = { matches: systemLight, addEventListener: (_e, fn) => listeners.push(fn) };
  const window = {
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
    localStorage: storageBroken
      ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    matchMedia: noMatchMedia ? undefined : () => media,
  };
  vm.runInNewContext(fs.readFileSync(path.join(RENDERER, 'theme-init.js'), 'utf8'), { window, globalThis: window });
  return {
    attrs, store, VPTheme: window.VPTheme,
    systemChanges(light) { media.matches = light; for (const fn of listeners) fn(); },
  };
}

test('with nothing chosen the app is dark, as it always was', () => {
  const p = page();
  assert.equal(p.attrs['data-theme'], 'dark');
  assert.equal(p.VPTheme.get(), 'dark');
});

test('a chosen light or dark theme is applied straight away and remembered', () => {
  assert.equal(page({ stored: 'light' }).attrs['data-theme'], 'light');
  assert.equal(page({ stored: 'dark', systemLight: true }).attrs['data-theme'], 'dark', 'an explicit choice beats the system');
  const p = page();
  assert.equal(p.VPTheme.set('light'), 'light');
  assert.equal(p.attrs['data-theme'], 'light');
  assert.equal(p.store.get('vp-theme'), 'light');
});

test('"match system" follows the computer, including when it changes while the app is open', () => {
  const p = page({ stored: 'system', systemLight: true });
  assert.equal(p.attrs['data-theme'], 'light');
  p.systemChanges(false);
  assert.equal(p.attrs['data-theme'], 'dark');
  p.systemChanges(true);
  assert.equal(p.attrs['data-theme'], 'light');
});

test('a system change does not override an explicit choice', () => {
  const p = page({ stored: 'dark', systemLight: false });
  p.systemChanges(true);
  assert.equal(p.attrs['data-theme'], 'dark');
});

test('nonsense in storage, broken storage, or no matchMedia all quietly give the dark theme', () => {
  assert.equal(page({ stored: 'purple' }).attrs['data-theme'], 'dark');
  assert.equal(page({ storageBroken: true }).attrs['data-theme'], 'dark');
  assert.equal(page({ stored: 'system', noMatchMedia: true }).attrs['data-theme'], 'dark');
  const p = page({ storageBroken: true });
  assert.equal(p.VPTheme.set('light'), 'light', 'still applied for this session even if it cannot be saved');
  assert.equal(p.attrs['data-theme'], 'light');
  assert.equal(p.VPTheme.set('<script>'), 'dark', 'an unknown value falls back to dark');
});

// ─── The page ────────────────────────────────────────────────────────────────────

test('the theme is chosen in <head> before any stylesheet, and both theme files are linked', () => {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1];
  const iInit = head.indexOf('src="theme-init.js"');
  const iFirstCss = head.indexOf('rel="stylesheet"');
  assert.ok(iInit > -1, 'theme-init.js is in the head');
  assert.ok(iInit < iFirstCss, 'it runs before the first stylesheet, so nothing paints in the wrong colours');
  assert.ok(head.includes('href="theme-dark.css"') && head.includes('href="theme-light.css"'));
  assert.doesNotMatch(head, /<script(?![^>]*\bsrc=)/, 'no inline script (the page policy forbids it)');
});

test('the Settings screen offers dark, light and match-system, and the app remembers the choice', () => {
  const select = /<select id="appThemeSelect">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, 'the theme select exists');
  assert.deepEqual([...select[1].matchAll(/value="(\w+)"/g)].map((m) => m[1]), ['dark', 'light', 'system']);
  const ui = read('app-settings.js');
  assert.match(ui, /VPTheme\.set\(/);
  assert.match(ui, /setTheme\(/);
  assert.match(fs.readFileSync(path.join(RENDERER, '..', 'main', 'preload.js'), 'utf8'), /setTheme: \(theme\) => ipcRenderer\.invoke\('app:setTheme'/);
});

test('the main process accepts only the three theme words and opens the window in the matching colour', () => {
  const main = fs.readFileSync(path.join(RENDERER, '..', 'main', 'main.js'), 'utf8');
  assert.match(main, /const THEMES = new Set\(\['dark', 'light', 'system'\]\)/);
  assert.match(main, /normalizeTheme\(theme\)/);
  assert.match(main, /backgroundColor: windowBackground\(\)/);
  // Default is dark, so nobody's app changes on update.
  assert.match(main, /let prefs = \{ region: 'auto', presence: true, theme: 'dark' \}/);
});

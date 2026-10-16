'use strict';

// UI translation. English is the source text: every string in the app is written in English, and a
// language file (lang/*.js) maps that exact English text to its translation. A string with no
// translation shows in English, so a missing entry is never a broken screen.
//
//   t('Start server')                      -> "Server start karo" in Hinglish, unchanged in English
//   t('{n} players', { n: 3 })             -> placeholders are written as {name}
//
// Text that is already in index.html is translated once when the page loads (applyToPage). The language
// is chosen in the footer; changing it reloads the window, so nothing has to be re-translated live.
(function (root) {
  const LANGUAGES = { en: 'English', hinglish: 'Hinglish' };
  const STORAGE_KEY = 'vp.lang';
  const dictionaries = root.VP_LANGS || (root.VP_LANGS = {});

  /** The language to use: what the person chose, else Hinglish for a Hindi system, else English. */
  function pickLanguage({ stored, browser } = {}) {
    if (stored && Object.prototype.hasOwnProperty.call(LANGUAGES, stored)) return stored;
    return /^hi\b/i.test(String(browser || '')) ? 'hinglish' : 'en';
  }

  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole));
  }

  /** Translates `text` into `lang` (English when there is no translation). */
  function translate(lang, text, vars) {
    const dict = lang !== 'en' ? dictionaries[lang] : null;
    const found = dict && Object.prototype.hasOwnProperty.call(dict, text) ? dict[text] : text;
    return fill(found, vars);
  }

  let current = 'en';
  try {
    current = pickLanguage({ stored: root.localStorage && root.localStorage.getItem(STORAGE_KEY), browser: root.navigator && root.navigator.language });
  } catch { /* storage can be unavailable: English */ }

  const t = (text, vars) => translate(current, text, vars);

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE']);
  const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];

  /** Translates the text and the placeholder/title attributes already in the page. */
  function applyToPage(doc) {
    if (current === 'en') return;
    doc.documentElement.lang = 'hi-Latn';
    const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName) || parent.closest('[data-no-i18n]')) continue;
      const key = norm(node.nodeValue);
      if (!key) continue;
      const out = translate(current, key);
      if (out === key) continue;
      const raw = node.nodeValue;
      node.nodeValue = raw.slice(0, raw.length - raw.trimStart().length) + out + raw.slice(raw.trimEnd().length);
    }
    for (const el of doc.querySelectorAll(ATTRIBUTES.map((a) => `[${a}]`).join(','))) {
      if (el.closest('[data-no-i18n]')) continue;
      for (const a of ATTRIBUTES) {
        const v = el.getAttribute(a);
        if (v) el.setAttribute(a, translate(current, norm(v)));
      }
    }
  }

  function setLanguage(lang) {
    if (!Object.prototype.hasOwnProperty.call(LANGUAGES, lang)) return;
    try { root.localStorage.setItem(STORAGE_KEY, lang); } catch { /* not saved: back to the default next time */ }
    if (root.location && root.location.reload) root.location.reload();
  }

  const api = { LANGUAGES, pickLanguage, translate, t, applyToPage, setLanguage, get lang() { return current; } };
  root.VPI18N = api;
  root.t = t;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // The page's own text is in the document by now (this script is loaded at the end of the body).
  if (root.document && root.document.body) applyToPage(root.document);
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';

// The colour theme. This file is loaded in <head>, before the stylesheets, so the right theme is on the page before
// anything is painted (no flash of the wrong colours). The person's choice is 'dark' (the default), 'light' or
// 'system' (follow the computer's own setting) and is remembered in localStorage, like the language. theme-dark.css and
// theme-light.css each apply only under their own html[data-theme="..."].
(function theme(root) {
  const KEY = 'vp-theme';
  const html = root.document.documentElement;
  const media = root.matchMedia ? root.matchMedia('(prefers-color-scheme: light)') : null;

  /** What was chosen: 'dark', 'light' or 'system'. Anything else, or storage that does not work, is the default. */
  function chosen() {
    try {
      const v = root.localStorage.getItem(KEY);
      return v === 'light' || v === 'system' ? v : 'dark';
    } catch { return 'dark'; }
  }

  /** The theme to show: 'light' or 'dark'. */
  function resolve(pref) {
    return pref === 'light' || (pref === 'system' && media && media.matches) ? 'light' : 'dark';
  }

  function apply(pref) { html.setAttribute('data-theme', resolve(pref)); }

  function set(pref) {
    const value = pref === 'light' || pref === 'system' ? pref : 'dark';
    try { root.localStorage.setItem(KEY, value); } catch { /* not saved: back to the default next time */ }
    apply(value);
    return value;
  }

  apply(chosen());
  // 'system' follows the computer live: switching Windows to light or dark changes the app without a restart.
  if (media && media.addEventListener) media.addEventListener('change', () => { if (chosen() === 'system') apply('system'); });

  root.VPTheme = { get: chosen, set, resolve };
})(typeof window !== 'undefined' ? window : globalThis);

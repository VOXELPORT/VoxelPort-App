'use strict';

// What the Plugins & mods screen says, as plain functions of what the main process reports and a translate function.
// No page access, so it can be tested.
(function (root) {
  /** 950 → "950", 1200 → "1.2K", 48000 → "48K", 2_300_000 → "2.3M". */
  function compactCount(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    const trim = (x) => String(Math.round(x * 10) / 10).replace(/\.0$/, '');
    if (v < 1000) return String(v);
    if (v < 1e6) return `${v < 1e4 ? trim(v / 1e3) : Math.round(v / 1e3)}K`;
    if (v < 1e9) return `${v < 1e7 ? trim(v / 1e6) : Math.round(v / 1e6)}M`;
    return `${trim(v / 1e9)}B`;
  }

  /** Paper takes plugins, Fabric takes mods. Anything else (Vanilla) takes neither. */
  function kind(type) {
    if (type === 'paper') return 'plugins';
    if (type === 'fabric') return 'mods';
    return '';
  }

  /** The screen's words for this kind of server. @returns {object} title, button, intro, search, folder */
  function words(type, t) {
    if (type === 'fabric') {
      return {
        title: t('MODS'),
        button: t('Mods'),
        intro: t('Add mods to this server in one click, from Modrinth. A mod runs code on this PC, so only install ones you trust. Restart the server after adding one.'),
        search: t('Search mods'),
        folder: t('Open mods folder'),
      };
    }
    return {
      title: t('PLUGINS'),
      button: t('Plugins'),
      intro: t('Add plugins to this server in one click, from Modrinth. A plugin runs code on this PC, so only install ones you trust. Restart the server after adding one.'),
      search: t('Search plugins'),
      folder: t('Open plugins folder'),
    };
  }

  /** The line under a search result: who made it and how popular it is. */
  function hitMeta(hit, t) {
    const parts = [];
    if (hit && hit.author) parts.push(t('by {author}', { author: hit.author }));
    parts.push(t('{n} downloads', { n: compactCount(hit && hit.downloads) }));
    return parts.join(' · ');
  }

  /** What to say after an install: the titles, and that a running server has to be restarted to use them. */
  function installedLine(names, restartNeeded, t) {
    const list = (Array.isArray(names) ? names : []).join(', ');
    return restartNeeded
      ? t('Installed: {names}. Restart the server to use it.', { names: list })
      : t('Installed: {names}.', { names: list });
  }

  /** The progress line while one is being installed. */
  function progressLine(p, t) {
    if (!p) return '';
    if (p.stage === 'download') return t('Downloading {title}…', { title: p.title || p.file || '' });
    if (p.stage === 'resolve') return t('Getting {title}…', { title: p.title || '' });
    return '';
  }

  const api = { compactCount, kind, words, hitMeta, installedLine, progressLine };
  root.VPAddons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

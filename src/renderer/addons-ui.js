'use strict';

// The Plugins & mods screen: what is installed, a search of Modrinth, and Install / Remove. The work happens in the main
// process (addons.js); this only shows it. Everything from Modrinth goes in as text, never as HTML, and there are no
// pictures from the internet (the page may only load its own files).

(function () {
  const adTitle = $('adTitle');
  const adSubtitle = $('adSubtitle');
  const adIntro = $('adIntro');
  const adQuery = $('adQuery');
  const adSearchBtn = $('adSearchBtn');
  const adAnyVersion = $('adAnyVersion');
  const adFolderBtn = $('adFolderBtn');
  const adProgressLine = $('adProgress');
  const adStatus = $('adStatus');
  const adInstalled = $('adInstalled');
  const adRunningNote = $('adRunningNote');
  const adResults = $('adResults');
  const adMoreBtn = $('adMoreBtn');

  let profileId = null;
  let info = null;
  let hits = [];
  let more = false;
  let offset = 0;
  let busy = false; // an install or removal is running
  let searchToken = 0; // a slow answer to an old search must not replace a newer one

  const W = () => window.VPAddons.words(info ? info.type : 'paper', t);

  function showStatus(text, isError) {
    adStatus.textContent = text || '';
    adStatus.style.color = isError ? 'var(--red)' : '';
  }

  function installedIds() { return new Set(info ? info.installed.map((a) => a.id) : []); }

  function avatar(title) {
    const a = document.createElement('div');
    a.className = 'ad-avatar';
    a.textContent = (String(title).trim()[0] || '?').toUpperCase();
    return a;
  }

  function row(title, descText, metaText, button) {
    const item = document.createElement('div');
    item.className = 'ad-item';
    const main = document.createElement('div');
    main.className = 'ad-main';
    const name = document.createElement('div');
    name.className = 'ad-name';
    name.textContent = title;
    main.appendChild(name);
    if (descText) {
      const d = document.createElement('div');
      d.className = 'ad-desc';
      d.textContent = descText;
      main.appendChild(d);
    }
    if (metaText) {
      const m = document.createElement('div');
      m.className = 'bk-meta';
      m.textContent = metaText;
      main.appendChild(m);
    }
    item.append(avatar(title), main, button);
    return item;
  }

  function renderInstalled() {
    adInstalled.innerHTML = '';
    if (!info || !info.installed.length) {
      const empty = document.createElement('div');
      empty.className = 'bk-empty';
      empty.textContent = t('Nothing installed from here yet.');
      adInstalled.appendChild(empty);
      return;
    }
    for (const a of info.installed) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost small';
      btn.textContent = t('Remove');
      btn.disabled = busy;
      btn.addEventListener('click', () => removeOne(a));
      adInstalled.appendChild(row(a.title, '', a.file, btn));
    }
  }

  function renderResults() {
    adResults.innerHTML = '';
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'bk-empty';
      empty.textContent = t('Nothing found. Try other words, or tick the box above to include ones not marked for this version.');
      adResults.appendChild(empty);
    }
    const have = installedIds();
    for (const h of hits) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isIn = have.has(h.id);
      btn.className = isIn ? 'ghost small' : 'primary small';
      btn.textContent = isIn ? t('Installed') : t('Install');
      btn.disabled = busy || isIn;
      btn.addEventListener('click', () => installOne(h));
      adResults.appendChild(row(h.title, h.desc, window.VPAddons.hitMeta(h, t), btn));
    }
    adMoreBtn.classList.toggle('hidden', !more || !hits.length);
  }

  function render() {
    const w = W();
    adTitle.textContent = w.title;
    adIntro.textContent = w.intro;
    adQuery.placeholder = w.search;
    adFolderBtn.textContent = w.folder;
    adSubtitle.textContent = info
      ? t('From Modrinth · {type} {version}', { type: info.type === 'fabric' ? 'Fabric' : 'Paper', version: info.version })
      : '';
    adRunningNote.classList.toggle('hidden', !(info && info.running));
    renderInstalled();
    renderResults();
  }

  async function refreshInfo() {
    try { info = await window.vp.addons.get(profileId); } catch { return; }
    render();
  }

  async function search(more_) {
    const token = ++searchToken;
    if (!more_) { offset = 0; hits = []; }
    adSearchBtn.disabled = true;
    adMoreBtn.disabled = true;
    showStatus(t('Looking on Modrinth…'));
    let res;
    try { res = await window.vp.addons.search(profileId, adQuery.value, adAnyVersion.checked, offset); } catch (err) { res = { ok: false, error: String(err && err.message ? err.message : err) }; }
    if (token !== searchToken) return;
    adSearchBtn.disabled = false;
    adMoreBtn.disabled = false;
    if (!res || !res.ok) {
      showStatus(t("Couldn't reach Modrinth: {detail}", { detail: t((res && res.error) || 'unknown error') }), true);
      render();
      return;
    }
    showStatus('');
    hits = hits.concat(res.hits);
    more = Boolean(res.more);
    offset += res.hits.length;
    renderResults();
  }

  function setBusy(on) {
    busy = on;
    adProgressLine.classList.toggle('hidden', !on);
    if (!on) adProgressLine.textContent = '';
    render();
  }

  async function installOne(hit) {
    if (busy) return;
    setBusy(true);
    showStatus('');
    let res;
    try { res = await window.vp.addons.install(profileId, hit.id, hit.title); } catch (err) { res = { ok: false, error: String(err && err.message ? err.message : err) }; }
    await refreshInfo();
    setBusy(false);
    if (res && res.code === 'exists') showStatus(t('A file named {file} is already in {folder}. Remove it first, or keep using it.', { file: String(res.file || ''), folder: info ? info.folder : '' }), true);
    else if (!res || !res.ok) showStatus(t((res && res.error) || "Couldn't install that."), true);
    else showStatus(window.VPAddons.installedLine(res.installed, res.restartNeeded, t));
  }

  async function removeOne(addon) {
    if (busy) return;
    if (!window.confirm(t('Remove {title}? Its file is deleted from the server.', { title: addon.title }))) return;
    setBusy(true);
    showStatus('');
    let res;
    try { res = await window.vp.addons.remove(profileId, addon.id); } catch (err) { res = { ok: false, error: String(err && err.message ? err.message : err) }; }
    await refreshInfo();
    setBusy(false);
    if (!res || !res.ok) showStatus(t((res && res.error) || "Couldn't remove that."), true);
    else showStatus(t('Removed.'));
  }

  window.openAddonsScreen = async function openAddonsScreen(id) {
    profileId = id;
    info = null;
    hits = [];
    more = false;
    offset = 0;
    adQuery.value = '';
    showStatus('');
    showScreen('screen-addons');
    await refreshInfo();
    if (info && info.supported) search(false);
  };

  $('addonsBackBtn').addEventListener('click', () => showScreen('screen-console'));
  adFolderBtn.addEventListener('click', () => { if (profileId) window.vp.addons.openFolder(profileId); });
  adSearchBtn.addEventListener('click', () => search(false));
  adMoreBtn.addEventListener('click', () => search(true));
  adQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(false); });
  adAnyVersion.addEventListener('change', () => search(false));

  window.vp.on('addons:progress', (p) => { adProgressLine.textContent = window.VPAddons.progressLine(p, t); });
  window.onAppState.push(() => { if ($('screen-addons').classList.contains('active')) refreshInfo(); });
})();

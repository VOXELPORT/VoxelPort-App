'use strict';

const $ = (id) => document.getElementById(id);

// ─── Screen router (shared by library.js / wizard.js / import.js / console.js) ─
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  const target = $(id);
  if (target) target.classList.add('active');
  if (id === 'screen-library' && window.refreshLibrary) window.refreshLibrary();
}
window.showScreen = showScreen;

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => showScreen(btn.dataset.back));
});

// ─── Shared app state (item 8) — always reflects what main.js actually reports ──
window.appState = { activeServerProfileId: null, publicServerProfileId: null, manualTunnelActive: false, serverStatus: 'stopped' };
window.onAppState = []; // callback list other screens register to react to state pushes
function applyAppState(state) {
  Object.assign(window.appState, state);
  for (const cb of window.onAppState) {
    try { cb(window.appState); } catch { /* ignore a single bad listener */ }
  }
}

// ─── Manual tunnel screen (host a server you already run elsewhere) ────────
const dot = $('dot');
const statusText = $('statusText');
const localPort = $('localPort');
const toggleBtn = $('toggleBtn');
const share = $('share');
const address = $('address');
const copyBtn = $('copyBtn');
const players = $('players');
const ping = $('ping');
const relayUrl = $('relayUrl');
const tokenField = $('token');
const copyTokenBtn = $('copyTokenBtn');
const logBox = $('log');
const version = $('version');

let running = false;

function log(line, isError) {
  const el = document.createElement('div');
  if (isError) el.className = 'err';
  const t = new Date().toLocaleTimeString();
  el.textContent = `${t}  ${line}`;
  logBox.appendChild(el);
  logBox.scrollTop = logBox.scrollHeight;
  while (logBox.childElementCount > 200) logBox.removeChild(logBox.firstChild);
}

function setStatus(state) {
  dot.className = 'dot';
  if (state === 'online') { dot.classList.add('on'); statusText.textContent = t('Hosting'); }
  else if (state === 'connecting') { dot.classList.add('warn'); statusText.textContent = t('Connecting…'); }
  else if (state === 'reconnecting') { dot.classList.add('warn'); statusText.textContent = t('Reconnecting…'); }
  else if (state === 'error') { dot.classList.add('err'); statusText.textContent = t('Error'); }
  else { statusText.textContent = t('Idle'); }
}

function setRunningUI(on) {
  running = on;
  toggleBtn.textContent = on ? t('Stop hosting') : t('Start hosting');
  toggleBtn.classList.toggle('stop', on);
  localPort.disabled = on;
  relayUrl.disabled = on;
  if (!on) {
    share.classList.add('hidden');
    ping.textContent = '—';
    players.textContent = '0';
  }
}

toggleBtn.addEventListener('click', async () => {
  if (running) {
    await window.vp.stop();
    setRunningUI(false);
    setStatus('idle');
    log(t('Stopped.'));
  } else {
    setStatus('connecting');
    setRunningUI(true);
    const res = await window.vp.start({
      localPort: localPort.value,
      relayUrl: relayUrl.value,
    });
    if (res && res.cancelled) {
      setRunningUI(false);
      setStatus('idle');
    }
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(address.textContent);
    copyBtn.textContent = t('Copied');
    copyBtn.classList.add('copied');
    setTimeout(() => { copyBtn.textContent = t('Copy'); copyBtn.classList.remove('copied'); }, 1400);
  } catch { /* ignore */ }
});

copyTokenBtn.addEventListener('click', async () => {
  // The raw token never reaches the renderer — main.js writes it straight
  // to the OS clipboard (item 12).
  await window.vp.copyToken();
  copyTokenBtn.textContent = t('Copied');
  setTimeout(() => { copyTokenBtn.textContent = t('Copy'); }, 1400);
});

for (const id of ['copySupporterIDBtn', 'setCopySupporterIDBtn', 'supportCopyIDBtn']) {
  $(id).addEventListener('click', async () => {
    try {
      const result = await window.vp.copySupporterID();
      if (!result || !result.ok) throw new Error('copy failed');
      $(id).textContent = t('Copied');
    } catch { $(id).textContent = t('Could not copy ID. Try again.'); }
    setTimeout(() => { $(id).textContent = t('Copy ID'); }, 2500);
  });
}
for (const [buttonID, statusID] of [
  ['setShareSupporterIDBtn', 'setShareSupporterIDStatus'],
  ['supportShareIDBtn', 'supportShareIDStatus'],
]) {
  $(buttonID).addEventListener('click', async () => {
    $(buttonID).disabled = true;
    try {
      const result = await window.vp.copySupporterID();
      if (!result || !result.ok) throw new Error('copy failed');
      $(statusID).textContent = t('ID copied. Paste it into a Discord support ticket to request your rank.');
      try { await window.vp.openDiscord(); }
      catch { $(statusID).textContent = t('ID copied. Discord could not open; open it yourself and paste your ID into a support ticket.'); }
    } catch { $(statusID).textContent = t('Could not copy ID. Try again.'); }
    finally { $(buttonID).disabled = false; }
  });
}
window.renderVoiceState = (state) => {
  window.currentVoiceState = state;
  const text = state.message ? t(state.message) : '';
  $('setVoiceStatus').textContent = text;
  $('srvVoiceStatus').textContent = text;
};
window.vp.on('tunnel:voice', window.renderVoiceState);
window.vp.voiceState().then(window.renderVoiceState);
window.vp.on('tunnel:status', (s) => {
  setStatus(s);
  if (s === 'stopped') setRunningUI(false);
});

window.vp.on('tunnel:assigned', ({ port, host }) => {
  address.textContent = `${host}:${port}`;
  share.classList.remove('hidden');
});

window.vp.on('tunnel:players', (n) => { players.textContent = String(n); });
window.vp.on('tunnel:ping', (ms) => { ping.textContent = `${ms}ms`; });
window.vp.on('tunnel:log', (line) => log(line));
window.vp.on('tunnel:error', (message) => {
  log(message, true);
  setStatus('error');
  setRunningUI(false);
});
window.vp.on('app:state', applyAppState);

// ─── "Copy invite message": a ready-to-paste text for friends (invite.js builds it) ─────────
// The main button copies it in the language the app is in; the small link beside it in the other one.
function wireInviteButtons(mainBtn, altBtn, getData) {
  // Invite messages exist in English and Hinglish only; any other app language copies the English one.
  const mine = VPI18N.lang === 'hinglish' ? 'hinglish' : 'en';
  const other = mine === 'en' ? 'hinglish' : 'en';
  const mainLabel = mainBtn.textContent;
  const altLabel = other === 'hinglish' ? t('Copy in Hinglish') : t('Copy in English');
  if (altBtn) altBtn.textContent = altLabel;
  const copy = (lang, btn, label) => async () => {
    const data = getData();
    if (!data || data.notPublic) {
      // The server isn't public yet: tell the person to make it public first, rather than copying nothing.
      if (data && data.notPublic) { btn.textContent = t('Make it public first'); setTimeout(() => { btn.textContent = label; }, 1800); }
      return;
    }
    try {
      await navigator.clipboard.writeText(VPInvite.buildInviteMessage({ lang, ...data }));
      btn.textContent = t('Copied!');
      setTimeout(() => { btn.textContent = label; }, 1600);
    } catch { /* clipboard unavailable */ }
  };
  mainBtn.addEventListener('click', copy(mine, mainBtn, mainLabel));
  if (altBtn) altBtn.addEventListener('click', copy(other, altBtn, altLabel));
}
window.wireInviteButtons = wireInviteButtons;

// The manual tunnel has no server name or version: just the address.
wireInviteButtons($('inviteBtn'), $('inviteAltBtn'), () => (address.textContent && address.textContent !== '—'
  ? { address: address.textContent }
  : null));

// ─── Announcements from the relay's operator ─────────────────────────────
// "The VoxelPort relay will restart." The relay sends the text and how many seconds are left; this adds
// the time ("in 4 minutes") and counts it down. A later message replaces it; an empty one removes it.
const noticeBanner = $('noticeBanner');
const noticeText = $('noticeText');
let notice = null; // { message, endsAt (ms, or null for no time), dismissed }

function timeLeftText(seconds) {
  if (seconds <= 0) return t('now');
  if (seconds < 60) return t('in less than a minute');
  const minutes = Math.ceil(seconds / 60);
  if (minutes === 1) return t('in 1 minute');
  if (minutes < 120) return t('in {n} minutes', { n: minutes });
  return t('in about {n} hours', { n: Math.round(minutes / 60) });
}

function renderNotice() {
  const over = notice && notice.endsAt && Date.now() - notice.endsAt > 10 * 60 * 1000;
  if (!notice || notice.dismissed || over) { noticeBanner.classList.add('hidden'); return; }
  const when = notice.endsAt ? ` — ${timeLeftText(Math.round((notice.endsAt - Date.now()) / 1000))}` : '';
  noticeText.textContent = notice.message + when;
  noticeBanner.classList.remove('hidden');
}

window.vp.on('tunnel:notice', (n) => {
  if (!n || !n.message) { notice = null; renderNotice(); return; }
  const same = notice && notice.message === n.message;
  notice = { message: n.message, endsAt: n.seconds > 0 ? Date.now() + n.seconds * 1000 : null, dismissed: Boolean(same && notice.dismissed) };
  renderNotice();
});
$('noticeCloseBtn').addEventListener('click', () => { if (notice) notice.dismissed = true; renderNotice(); });
setInterval(renderNotice, 15000);

// ─── Auto-update banner ─────────────────────────────────────────────────
const updateBanner = $('updateBanner');
const updateBannerText = $('updateBannerText');
const updateInstallBtn = $('updateInstallBtn');

window.vp.on('update:downloaded', (version) => {
  updateBannerText.textContent = t('VoxelPort v{version} is ready to install.', { version });
  updateBanner.classList.remove('hidden');
});
window.vp.on('update:error', () => { /* background check failure — nothing actionable for the user */ });

updateInstallBtn.addEventListener('click', async () => {
  updateInstallBtn.disabled = true;
  const res = await window.vp.update.install();
  updateInstallBtn.disabled = false;
  if (res && res.cancelled) return; // user declined the restart-now confirmation
});

// ─── Relay region (shared by the manual and server screens) ─────────────
// One app-wide choice: Auto (fastest relay) or a specific region. It can't
// change while a tunnel is public — the port belongs to the relay. With only
// one region there's nothing to choose, so the controls stay hidden.
const regionSelects = [...document.querySelectorAll('.region-select')];
let regionPickerShown = false;

async function loadRegions() {
  const info = await window.vp.region.get();
  regionPickerShown = info.regions.length > 1;
  // One region: hide the dropdowns and the "region" stat entirely. Inline
  // display wins over the stylesheet and over console.js's class toggles.
  if (!regionPickerShown) {
    for (const sel of regionSelects) {
      const wrap = sel.closest('label');
      if (wrap) wrap.style.display = 'none';
    }
    for (const el of document.querySelectorAll('.region-used')) {
      const tile = el.closest('div');
      if (tile) tile.style.display = 'none';
    }
    return;
  }
  const options = [['auto', t('Auto (fastest)')], ...info.regions.map((r) => [r.id, r.label])];
  for (const sel of regionSelects) {
    sel.innerHTML = '';
    for (const [value, text] of options) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.value = info.preference;
  }
}

for (const sel of regionSelects) {
  sel.addEventListener('change', async () => {
    const res = await window.vp.region.set(sel.value);
    for (const other of regionSelects) other.value = res.preference;
  });
}

window.onAppState.push((state) => {
  const locked = Boolean(state.publicServerProfileId || state.manualTunnelActive);
  for (const sel of regionSelects) sel.disabled = locked;
});

window.vp.on('tunnel:region', (r) => {
  for (const el of document.querySelectorAll('.region-used')) el.textContent = r ? r.label : t('Own relay');
});

// ─── Library entry point ────────────────────────────────────────────────
$('manualModeLink').addEventListener('click', () => showScreen('screen-manual'));

// ─── Init ────────────────────────────────────────────────────────────────
// Waits for DOMContentLoaded before touching anything defined by the other
// <script> tags (library.js/wizard.js/import.js/console.js) — those load
// after this file, so calling into them (e.g. via showScreen's
// window.refreshLibrary hook) before the document has finished parsing is a
// real race: the IPC round-trip below can resolve before the browser has
// gotten around to fetching and executing the later script tags.
function whenDomReady() {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
}

// Tell the main process which language the window shows (see app-settings.js for changing it).
window.vp.setLanguage(VPI18N.lang);

(async function init() {
  const [info, state] = await Promise.all([window.vp.info(), window.vp.server.state()]);
  await whenDomReady();
  relayUrl.placeholder = info.defaultRelayUrl;
  tokenField.value = info.maskedToken;
  $('supporterID').value = info.supporterID;
  $('setSupporterID').value = info.supporterID;
  $('supportPageID').value = info.supporterID;
  $('tokenWarn').classList.toggle('hidden', !info.tokenUnreadable);
  version.textContent = 'v' + info.version;
  log(t('Ready. Set your local port and click Start hosting.'));
  await loadRegions();
  applyAppState(state);
  showScreen('screen-library');
})();

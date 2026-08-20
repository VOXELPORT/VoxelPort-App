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
  if (state === 'online') { dot.classList.add('on'); statusText.textContent = 'Hosting'; }
  else if (state === 'connecting') { dot.classList.add('warn'); statusText.textContent = 'Connecting…'; }
  else if (state === 'reconnecting') { dot.classList.add('warn'); statusText.textContent = 'Reconnecting…'; }
  else if (state === 'error') { dot.classList.add('err'); statusText.textContent = 'Error'; }
  else { statusText.textContent = 'Idle'; }
}

function setRunningUI(on) {
  running = on;
  toggleBtn.textContent = on ? 'Stop hosting' : 'Start hosting';
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
    log('Stopped.');
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
    copyBtn.textContent = 'Copied';
    copyBtn.classList.add('copied');
    setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1400);
  } catch { /* ignore */ }
});

copyTokenBtn.addEventListener('click', async () => {
  // The raw token never reaches the renderer — main.js writes it straight
  // to the OS clipboard (item 12).
  await window.vp.copyToken();
  copyTokenBtn.textContent = 'Copied';
  setTimeout(() => { copyTokenBtn.textContent = 'Copy'; }, 1400);
});

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

// ─── Auto-update banner ─────────────────────────────────────────────────
const updateBanner = $('updateBanner');
const updateBannerText = $('updateBannerText');
const updateInstallBtn = $('updateInstallBtn');

window.vp.on('update:downloaded', (version) => {
  updateBannerText.textContent = `VoxelPort v${version} is ready to install.`;
  updateBanner.classList.remove('hidden');
});
window.vp.on('update:error', () => { /* background check failure — nothing actionable for the user */ });

updateInstallBtn.addEventListener('click', async () => {
  updateInstallBtn.disabled = true;
  const res = await window.vp.update.install();
  updateInstallBtn.disabled = false;
  if (res && res.cancelled) return; // user declined the restart-now confirmation
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

(async function init() {
  const [info, state] = await Promise.all([window.vp.info(), window.vp.server.state()]);
  await whenDomReady();
  relayUrl.placeholder = info.defaultRelayUrl;
  tokenField.value = info.maskedToken;
  version.textContent = 'v' + info.version;
  log('Ready. Set your local port and click Start hosting.');
  applyAppState(state);
  showScreen('screen-library');
})();

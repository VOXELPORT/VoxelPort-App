'use strict';

const $ = (id) => document.getElementById(id);
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
    await window.vp.start({
      localPort: localPort.value,
      relayUrl: relayUrl.value,
    });
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

(async function init() {
  const info = await window.vp.info();
  relayUrl.placeholder = info.defaultRelayUrl;
  tokenField.value = info.token;
  version.textContent = 'v' + info.version;
  log('Ready. Set your local port and click Start hosting.');
})();

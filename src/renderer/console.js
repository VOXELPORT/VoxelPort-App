'use strict';

const srvDot = $('srvDot');
const srvStatusText = $('srvStatusText');
const srvPlayers = $('srvPlayers');
const srvStartBtn = $('srvStartBtn');
const srvStopBtn = $('srvStopBtn');
const srvFolderBtn = $('srvFolderBtn');
const publicShare = $('publicShare');
const srvAddress = $('srvAddress');
const srvCopyBtn = $('srvCopyBtn');
const srvTunnelPlayers = $('srvTunnelPlayers');
const srvPing = $('srvPing');
const makePublicBtn = $('makePublicBtn');
const srvLog = $('srvLog');
const cmdInput = $('cmdInput');
const cmdSendBtn = $('cmdSendBtn');

function srvLogLine(line) {
  const el = document.createElement('div');
  const t = new Date().toLocaleTimeString();
  el.textContent = `${t}  ${line}`;
  srvLog.appendChild(el);
  srvLog.scrollTop = srvLog.scrollHeight;
  while (srvLog.childElementCount > 400) srvLog.removeChild(srvLog.firstChild);
}

function setSrvStatus(state) {
  srvDot.className = 'dot';
  const running = state === 'starting' || state === 'online' || state === 'stopping';
  srvStartBtn.classList.toggle('hidden', running);
  srvStopBtn.classList.toggle('hidden', !running);

  if (state === 'online') { srvDot.classList.add('on'); srvStatusText.textContent = 'Online'; }
  else if (state === 'starting') { srvDot.classList.add('warn'); srvStatusText.textContent = 'Starting…'; }
  else if (state === 'stopping') { srvDot.classList.add('warn'); srvStatusText.textContent = 'Stopping…'; }
  else if (state === 'crashed') { srvDot.classList.add('err'); srvStatusText.textContent = 'Crashed'; }
  else { srvStatusText.textContent = 'Stopped'; }
}

srvStartBtn.addEventListener('click', async () => {
  const res = await window.vp.server.start();
  if (!res.ok) srvLogLine(res.error || 'Could not start server.');
});

srvStopBtn.addEventListener('click', () => window.vp.server.stop());
srvFolderBtn.addEventListener('click', () => window.vp.server.openFolder());

makePublicBtn.addEventListener('click', async () => {
  const config = await window.vp.server.hasExisting();
  if (!config) return;
  makePublicBtn.disabled = true;
  await window.vp.start({ localPort: config.port });
});

srvCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(srvAddress.textContent);
    srvCopyBtn.textContent = 'Copied';
    setTimeout(() => { srvCopyBtn.textContent = 'Copy'; }, 1400);
  } catch { /* ignore */ }
});

function sendCommand() {
  const cmd = cmdInput.value.trim();
  if (!cmd) return;
  window.vp.server.command(cmd);
  cmdInput.value = '';
}
cmdSendBtn.addEventListener('click', sendCommand);
cmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCommand(); });

window.vp.on('server:status', setSrvStatus);
window.vp.on('server:log', srvLogLine);
window.vp.on('server:players', (n) => { srvPlayers.textContent = String(n); });
window.vp.on('server:exit', (code) => srvLogLine(`Server process exited (code ${code}).`));

// The relay tunnel is shared with the manual-hosting screen — reuse its events.
window.vp.on('tunnel:assigned', ({ port, host }) => {
  srvAddress.textContent = `${host}:${port}`;
  publicShare.classList.remove('hidden');
  makePublicBtn.classList.add('hidden');
});
window.vp.on('tunnel:players', (n) => { srvTunnelPlayers.textContent = String(n); });
window.vp.on('tunnel:ping', (ms) => { srvPing.textContent = `${ms}ms`; });
window.vp.on('tunnel:status', (s) => {
  if (s === 'stopped') {
    publicShare.classList.add('hidden');
    makePublicBtn.classList.remove('hidden');
    makePublicBtn.disabled = false;
  }
});
window.vp.on('tunnel:error', (message) => {
  srvLogLine('Relay: ' + message);
  makePublicBtn.disabled = false;
});

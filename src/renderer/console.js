'use strict';

const mgName = $('mgName');
const mgMeta = $('mgMeta');
const srvDot = $('srvDot');
const srvStatusText = $('srvStatusText');
const srvPlayers = $('srvPlayers');
const srvStartBtn = $('srvStartBtn');
const srvStopBtn = $('srvStopBtn');
const srvFolderBtn = $('srvFolderBtn');
const srvRemoveBtn = $('srvRemoveBtn');
const publicShare = $('publicShare');
const srvAddress = $('srvAddress');
const srvCopyBtn = $('srvCopyBtn');
const srvTunnelPlayers = $('srvTunnelPlayers');
const srvPing = $('srvPing');
const makePublicBtn = $('makePublicBtn');
const stopPublicBtn = $('stopPublicBtn');
const srvLog = $('srvLog');
const cmdInput = $('cmdInput');
const cmdSendBtn = $('cmdSendBtn');

let managingProfileId = null;

function srvLogLine(line) {
  const el = document.createElement('div');
  const t = new Date().toLocaleTimeString();
  el.textContent = `${t}  ${line}`;
  srvLog.appendChild(el);
  srvLog.scrollTop = srvLog.scrollHeight;
  while (srvLog.childElementCount > 400) srvLog.removeChild(srvLog.firstChild);
}

function isThisProfileActive() {
  return managingProfileId && managingProfileId === window.appState.activeServerProfileId;
}
function isThisProfilePublic() {
  return managingProfileId && managingProfileId === window.appState.publicServerProfileId;
}

function renderManagementScreen() {
  const active = isThisProfileActive();
  const status = active ? (window.appState.serverStatus || 'stopped') : 'stopped';
  const running = status === 'starting' || status === 'online' || status === 'stopping';

  srvDot.className = 'dot';
  if (status === 'online') { srvDot.classList.add('on'); srvStatusText.textContent = 'Online'; }
  else if (status === 'starting') { srvDot.classList.add('warn'); srvStatusText.textContent = 'Starting…'; }
  else if (status === 'stopping') { srvDot.classList.add('warn'); srvStatusText.textContent = 'Stopping…'; }
  else if (status === 'crashed') { srvDot.classList.add('err'); srvStatusText.textContent = 'Crashed'; }
  else { srvStatusText.textContent = 'Stopped'; }

  srvStartBtn.classList.toggle('hidden', running);
  srvStopBtn.classList.toggle('hidden', !running || !active);
  cmdInput.disabled = !(active && status === 'online');
  cmdSendBtn.disabled = !(active && status === 'online');

  const isPublic = isThisProfilePublic();
  makePublicBtn.classList.toggle('hidden', isPublic || !(active && status === 'online'));
  publicShare.classList.toggle('hidden', !isPublic);
  if (!isPublic) { srvTunnelPlayers.textContent = '0'; srvPing.textContent = '—'; }

  srvRemoveBtn.disabled = active || isPublic;
}
window.onAppState.push(() => { if ($('screen-console').classList.contains('active')) renderManagementScreen(); });

window.openManagementScreen = async function openManagementScreen(id) {
  managingProfileId = id;
  srvLog.innerHTML = '';
  const profile = await window.vp.server.get(id);
  if (!profile) { showScreen('screen-library'); return; }
  mgName.textContent = profile.name;
  mgMeta.textContent = `${{ vanilla: 'Vanilla', paper: 'Paper', fabric: 'Fabric' }[profile.type] || profile.type} • ${profile.version} • port ${profile.port}`;
  renderManagementScreen();
};

srvStartBtn.addEventListener('click', async () => {
  if (!managingProfileId) return;
  const res = await window.vp.server.start(managingProfileId);
  if (res && res.cancelled) return;
  if (!res || !res.ok) srvLogLine(res && res.error ? res.error : 'Could not start server.');
});

srvStopBtn.addEventListener('click', () => window.vp.server.stop());
srvFolderBtn.addEventListener('click', () => window.vp.server.openFolder(managingProfileId));

srvRemoveBtn.addEventListener('click', async () => {
  if (!managingProfileId) return;
  const res = await window.vp.server.remove(managingProfileId);
  if (!res || !res.ok) { srvLogLine((res && res.error) || 'Could not remove this server.'); return; }
  await window.refreshLibrary();
  showScreen('screen-library');
});

makePublicBtn.addEventListener('click', async () => {
  if (!managingProfileId) return;
  makePublicBtn.disabled = true;
  const res = await window.vp.server.makePublic(managingProfileId);
  makePublicBtn.disabled = false;
  if (res && !res.ok && res.error) srvLogLine(res.error);
});

stopPublicBtn.addEventListener('click', () => window.vp.stop());

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

window.vp.on('server:status', () => renderManagementScreen());
window.vp.on('server:log', (line) => { if (isThisProfileActive()) srvLogLine(line); });
window.vp.on('server:players', (n) => { if (isThisProfileActive()) srvPlayers.textContent = String(n); });
window.vp.on('server:exit', (code) => { if (isThisProfileActive()) srvLogLine(`Server process exited (code ${code}).`); });

// The relay tunnel is shared with the manual-hosting screen — reuse its events.
window.vp.on('tunnel:assigned', ({ port, host }) => {
  if (!isThisProfilePublic()) return;
  srvAddress.textContent = `${host}:${port}`;
  publicShare.classList.remove('hidden');
  makePublicBtn.classList.add('hidden');
});
window.vp.on('tunnel:players', (n) => { if (isThisProfilePublic()) srvTunnelPlayers.textContent = String(n); });
window.vp.on('tunnel:ping', (ms) => { if (isThisProfilePublic()) srvPing.textContent = `${ms}ms`; });
window.vp.on('tunnel:error', (message) => {
  if (isThisProfileActive() || isThisProfilePublic()) srvLogLine('Relay: ' + message);
});

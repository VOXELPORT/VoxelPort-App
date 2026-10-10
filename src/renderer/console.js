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
const srvSettingsBtn = $('srvSettingsBtn');
const srvAltAddress = $('srvAltAddress');
const srvBedrock = $('srvBedrock');
const srvBedrockHost = $('srvBedrockHost');
const srvBedrockPort = $('srvBedrockPort');
const srvListed = $('srvListed');
const nameView = $('nameView');
const nameEdit = $('nameEdit');
const nameCurrent = $('nameCurrent');
const nameInput = $('nameInput');
const nameClaimBtn = $('nameClaimBtn');
const nameMsg = $('nameMsg');
const perfPanel = $('perfPanel');
const perfWarn = $('perfWarn');
const diagnosisBox = $('diagnosis');

let managingProfileId = null;
let managingProfile = null;
let assigned = null; // { host, port } of the live public tunnel
let customAddress = { name: '', address: '' };
let editingName = false;

function srvLogLine(line) {
  const el = document.createElement('div');
  const t = new Date().toLocaleTimeString();
  el.textContent = `${t}  ${line}`;
  srvLog.appendChild(el);
  srvLog.scrollTop = srvLog.scrollHeight;
  while (srvLog.childElementCount > 400) srvLog.removeChild(srvLog.firstChild);
}

window.consoleLogLine = srvLogLine;

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
  if (!running || !active) perfPanel.classList.add('hidden');
  if (!running || !active) perfWarn.classList.add('hidden');
  renderAddress();
}

// ─── Public address: custom name, plain host:port, Bedrock ─────────────────

function renderAddress() {
  const isPublic = isThisProfilePublic();
  if (isPublic && assigned) {
    const plain = `${assigned.host}:${assigned.port}`;
    srvAddress.textContent = customAddress.address || plain;
    srvAltAddress.textContent = customAddress.address ? `Also works: ${plain}` : '';
    srvAltAddress.classList.toggle('hidden', !customAddress.address);
    const bedrock = Boolean(managingProfile && managingProfile.bedrock);
    srvBedrock.classList.toggle('hidden', !bedrock);
    srvBedrockHost.textContent = customAddress.address || assigned.host;
    srvBedrockPort.textContent = String(assigned.port);
  }
  srvListed.classList.toggle('hidden', !(managingProfile && managingProfile.listing && managingProfile.listing.enabled));
  const hasName = Boolean(customAddress.name) && !editingName;
  nameView.classList.toggle('hidden', !hasName);
  nameEdit.classList.toggle('hidden', hasName);
  nameCurrent.textContent = customAddress.address || '—';
}

function setNameMsg(text, isError) {
  nameMsg.textContent = text;
  nameMsg.classList.toggle('err', Boolean(isError));
}

nameClaimBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/.test(name) || name.includes('--')) {
    setNameMsg('Use 3–20 lowercase letters, numbers or dashes (not at the start or end).', true);
    return;
  }
  nameClaimBtn.disabled = true;
  setNameMsg(`Setting up ${name}.voxelport.in…`);
  const res = await window.vp.name.claim(name);
  nameClaimBtn.disabled = false;
  if (!res || !res.ok) { setNameMsg((res && res.error) || 'Could not set that address.', true); return; }
  editingName = false;
  customAddress = { name: res.name, address: res.address };
  setNameMsg('Friends join without a port number. 3–20 letters, numbers or dashes.');
  srvLogLine(`Your address is now ${res.address} — it can take a minute to work everywhere.`);
  renderAddress();
});
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameClaimBtn.click(); });

$('nameChangeBtn').addEventListener('click', () => {
  editingName = true;
  nameInput.value = customAddress.name;
  renderAddress();
  nameInput.focus();
});

$('nameRemoveBtn').addEventListener('click', async () => {
  if (!window.confirm(`Remove ${customAddress.address}? Players will need the address with the port again.`)) return;
  const res = await window.vp.name.release();
  if (!res || !res.ok) { srvLogLine((res && res.error) || 'Could not remove the address.'); return; }
  customAddress = { name: '', address: '' };
  renderAddress();
});

window.vp.on('tunnel:name', (n) => { customAddress = n; editingName = false; renderAddress(); });
window.vp.name.get().then((n) => { if (n) { customAddress = n; renderAddress(); } });

// ─── Performance panel ─────────────────────────────────────────────────────

function setBar(id, fraction, level) {
  const bar = $(id);
  bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  bar.className = level || '';
}

window.vp.on('perf:sample', (p) => {
  if (!isThisProfileActive()) return;
  perfPanel.classList.remove('hidden');
  if (p.cpuPercent !== null) {
    $('perfCpu').textContent = `${Math.round(p.cpuPercent)}%`;
    setBar('perfCpuBar', p.cpuPercent / 100, p.cpuPercent > 85 ? 'bad' : p.cpuPercent > 60 ? 'warn' : '');
  }
  if (p.memMb !== null) {
    const gb = (mb) => (mb / 1024).toFixed(1);
    $('perfRam').textContent = p.maxRamMb ? `${gb(p.memMb)}/${gb(p.maxRamMb)} GB` : `${gb(p.memMb)} GB`;
    const frac = p.maxRamMb ? p.memMb / p.maxRamMb : 0;
    setBar('perfRamBar', frac, frac > 0.95 ? 'bad' : frac > 0.8 ? 'warn' : '');
  }
  if (p.tps !== null) {
    $('perfTps').textContent = p.tps.toFixed(1);
    setBar('perfTpsBar', p.tps / 20, p.tps < 15 ? 'bad' : p.tps < 19 ? 'warn' : '');
  }
  if (p.lagWarnings > 0) {
    perfWarn.textContent = `⚠ The server fell behind ${p.lagWarnings} time${p.lagWarnings === 1 ? '' : 's'}. Lower the view distance or give it more RAM in Settings.`;
    perfWarn.classList.remove('hidden');
  }
});

function resetPerf() {
  for (const id of ['perfCpu', 'perfRam', 'perfTps']) $(id).textContent = '—';
  for (const id of ['perfCpuBar', 'perfRamBar', 'perfTpsBar']) setBar(id, 0);
  perfPanel.classList.add('hidden');
  perfWarn.classList.add('hidden');
}

// ─── "Why it stopped" card ─────────────────────────────────────────────────

function clearDiagnosis() {
  diagnosisBox.innerHTML = '';
  diagnosisBox.classList.add('hidden');
}

function renderDiagnosis(items) {
  clearDiagnosis();
  const head = document.createElement('div');
  head.className = 'diag-head';
  const title = document.createElement('span');
  title.textContent = 'Why it stopped';
  const close = document.createElement('button');
  close.className = 'link-btn';
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.addEventListener('click', clearDiagnosis);
  head.append(title, close);
  diagnosisBox.appendChild(head);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'diag-item';
    const h = document.createElement('div');
    h.className = 'diag-title';
    h.textContent = item.title;
    const p = document.createElement('div');
    p.className = 'diag-detail';
    p.textContent = item.detail;
    row.append(h, p);
    if (item.fix) {
      const btn = document.createElement('button');
      btn.className = 'ghost small';
      btn.type = 'button';
      btn.textContent = item.fix.label;
      btn.addEventListener('click', () => runFix(item.fix.action, btn));
      row.appendChild(btn);
    }
    diagnosisBox.appendChild(row);
  }
  diagnosisBox.classList.remove('hidden');
}

async function runFix(action, btn) {
  if (action === 'settings') window.openSettingsScreen(managingProfileId);
  else if (action === 'folder') window.vp.server.openFolder(managingProfileId);
  else if (action === 'eula') {
    btn.disabled = true;
    const res = await window.vp.server.fix(managingProfileId, 'eula');
    btn.textContent = res && res.ok ? 'Accepted — press Start' : 'Could not update eula.txt';
  }
}

window.vp.on('server:diagnosis', ({ profileId, items }) => {
  if (profileId === managingProfileId && Array.isArray(items) && items.length) renderDiagnosis(items);
});

srvSettingsBtn.addEventListener('click', () => { if (managingProfileId) window.openSettingsScreen(managingProfileId); });
window.onAppState.push(() => { if ($('screen-console').classList.contains('active')) renderManagementScreen(); });

window.openManagementScreen = async function openManagementScreen(id) {
  if (managingProfileId !== id) { clearDiagnosis(); resetPerf(); }
  managingProfileId = id;
  srvLog.innerHTML = '';
  const profile = await window.vp.server.get(id);
  if (!profile) { showScreen('screen-library'); return; }
  managingProfile = profile;
  mgName.textContent = profile.name;
  mgMeta.textContent = `${{ vanilla: 'Vanilla', paper: 'Paper', fabric: 'Fabric' }[profile.type] || profile.type} • ${profile.version} • port ${profile.port}`;
  renderManagementScreen();
};

/** Re-reads the profile (after Settings) without clearing the console. */
window.refreshManagedProfile = async function refreshManagedProfile() {
  if (!managingProfileId) return;
  const profile = await window.vp.server.get(managingProfileId);
  if (!profile) return;
  managingProfile = profile;
  mgName.textContent = profile.name;
  mgMeta.textContent = `${{ vanilla: 'Vanilla', paper: 'Paper', fabric: 'Fabric' }[profile.type] || profile.type} • ${profile.version} • port ${profile.port}`;
  renderManagementScreen();
};
window.consoleProfileId = () => managingProfileId;

srvStartBtn.addEventListener('click', async () => {
  if (!managingProfileId) return;
  clearDiagnosis();
  resetPerf();
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
  assigned = { host, port };
  if (!isThisProfilePublic()) return;
  publicShare.classList.remove('hidden');
  makePublicBtn.classList.add('hidden');
  renderAddress();
});
window.vp.on('tunnel:players', (n) => { if (isThisProfilePublic()) srvTunnelPlayers.textContent = String(n); });
window.vp.on('tunnel:ping', (ms) => { if (isThisProfilePublic()) srvPing.textContent = `${ms}ms`; });
window.vp.on('tunnel:error', (message) => {
  if (isThisProfileActive() || isThisProfilePublic()) srvLogLine('Relay: ' + message);
});

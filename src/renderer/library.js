'use strict';

const serverList = $('serverList');
const addServerBtn = $('addServerBtn');
const importServerBtn = $('importServerBtn');

function typeLabel(type) {
  return { vanilla: 'Vanilla', paper: 'Paper', fabric: 'Fabric' }[type] || type;
}

function statusForProfile(profile) {
  if (profile.id === window.appState.activeServerProfileId) return window.appState.serverStatus || 'stopped';
  return 'stopped';
}

function statusLabel(status) {
  return {
    stopped: 'Stopped', starting: 'Starting…', online: 'Online', stopping: 'Stopping…', crashed: 'Crashed',
  }[status] || 'Stopped';
}

function renderCards() {
  serverList.innerHTML = '';
  if (!window.profiles || window.profiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No servers yet — add one to get started.';
    serverList.appendChild(empty);
    return;
  }

  for (const profile of window.profiles) {
    const status = statusForProfile(profile);
    const isPublic = profile.id === window.appState.publicServerProfileId;

    const card = document.createElement('div');
    card.className = 'server-card';

    const info = document.createElement('div');
    info.className = 'server-card-info';
    info.innerHTML = `
      <div class="server-card-name">${escapeHtml(profile.name)}</div>
      <div class="server-card-meta">${typeLabel(profile.type)} • ${escapeHtml(profile.version)}</div>
      <div class="server-card-status">
        <span class="dot ${status === 'online' ? 'on' : (status === 'starting' || status === 'stopping') ? 'warn' : status === 'crashed' ? 'err' : ''}"></span>
        ${statusLabel(status)}${isPublic ? ' · <span class="public-badge">Public</span>' : ''}
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'server-card-actions';

    const startBtn = document.createElement('button');
    startBtn.className = 'ghost small';
    startBtn.textContent = status === 'online' || status === 'starting' ? 'Manage' : 'Start';
    startBtn.addEventListener('click', async () => {
      if (status === 'online' || status === 'starting') {
        openManagement(profile.id);
        return;
      }
      startBtn.disabled = true;
      // Open the console first so start-up output (including any automatic
      // Java download) is visible while it happens.
      openManagement(profile.id);
      const res = await window.vp.server.start(profile.id);
      startBtn.disabled = false;
      if (res && res.cancelled) { showScreen('screen-library'); return; } // user declined the switch
      if (!res || !res.ok) {
        const msg = res && res.error ? res.error : 'Could not start server.';
        log(msg, true);
        if (window.consoleLogLine) window.consoleLogLine(msg);
      }
    });

    const manageBtn = document.createElement('button');
    manageBtn.className = 'ghost small';
    manageBtn.textContent = 'Manage';
    manageBtn.addEventListener('click', () => openManagement(profile.id));

    // A running server's start button already reads "Manage" — don't show it twice.
    if (status !== 'online' && status !== 'starting') actions.appendChild(startBtn);
    actions.appendChild(manageBtn);
    card.appendChild(info);
    card.appendChild(actions);
    serverList.appendChild(card);
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s == null ? '' : s);
  return div.innerHTML;
}

function openManagement(id) {
  window.openManagementScreen(id);
  showScreen('screen-console');
}

async function refreshLibrary() {
  window.profiles = await window.vp.server.list();
  renderCards();
}
window.refreshLibrary = refreshLibrary;
window.onAppState.push(() => {
  if ($('screen-library').classList.contains('active')) renderCards();
});

addServerBtn.addEventListener('click', () => showScreen('screen-type'));
importServerBtn.addEventListener('click', () => showScreen('screen-import'));

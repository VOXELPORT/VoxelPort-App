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
    stopped: t('Stopped'), starting: t('Starting…'), online: t('Online'), stopping: t('Stopping…'), crashed: t('Crashed'),
  }[status] || t('Stopped');
}

function renderCards() {
  serverList.innerHTML = '';
  const profiles = window.profiles || [];
  const running = profiles.filter((profile) => ['online', 'starting', 'stopping'].includes(statusForProfile(profile))).length;
  $('librarySummary').textContent = profiles.length
    ? (profiles.length === 1 ? t('1 server') : t('{n} servers', { n: profiles.length })) + ' · ' + t('{n} running', { n: running })
    : t('Create, manage and share your Minecraft worlds.');
  serverList.classList.toggle('is-empty', profiles.length === 0);
  addServerBtn.classList.toggle('hidden', profiles.length === 0);
  if (profiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'library-empty';
    const icon = document.createElement('div');
    icon.className = 'empty-world';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg width="64" height="64" viewBox="0 0 64 64" fill="none"><path d="M32 9 53 21 32 33 11 21 32 9Z" fill="currentColor" fill-opacity=".22"/><path d="M11 21v24l21 12 21-12V21M32 33v24M11 21l21 12 21-12M11 21 32 9l21 12" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M21 15l21 12M21 27l21-12M21 27v10l-10-6M42 27v10l11-6" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    const title = document.createElement('h2');
    title.textContent = t('Your next world starts here');
    const description = document.createElement('p');
    description.textContent = t('Set up a Minecraft server on your PC, then invite your friends. No port forwarding needed.');
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'primary';
    create.textContent = t('Create your first server');
    create.addEventListener('click', () => showScreen('screen-type'));
    empty.append(icon, title, description, create);
    serverList.appendChild(empty);
    return;
  }

  for (const profile of profiles) {
    const status = statusForProfile(profile);
    const isPublic = profile.id === window.appState.publicServerProfileId;

    const card = document.createElement('div');
    card.className = 'server-card';
    card.dataset.status = status;

    const icon = document.createElement('div');
    icon.className = 'server-card-icon';
    icon.dataset.type = profile.type;
    icon.textContent = ({ paper: 'P', fabric: 'F', vanilla: 'V' })[profile.type] || 'M';
    icon.setAttribute('aria-hidden', 'true');

    const info = document.createElement('div');
    info.className = 'server-card-info';
    info.innerHTML = `
      <div class="server-card-name">${escapeHtml(profile.name)}</div>
      <div class="server-card-meta">${escapeHtml(typeLabel(profile.type))} · ${escapeHtml(profile.version)}</div>
      <div class="server-card-status">
        <span class="dot ${status === 'online' ? 'on' : (status === 'starting' || status === 'stopping') ? 'warn' : status === 'crashed' ? 'err' : ''}"></span>
        ${statusLabel(status)}${isPublic ? ' · <span class="public-badge">' + t('Public') + '</span>' : ''}
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'server-card-actions';

    const startBtn = document.createElement('button');
    startBtn.className = 'primary small';
    startBtn.disabled = status === 'stopping';
    startBtn.textContent = status === 'online' || status === 'starting' ? t('Manage') : t('Start');
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
        const msg = res && res.error ? t(res.error) : t('Could not start server.');
        log(msg, true);
        if (window.consoleLogLine) window.consoleLogLine(msg);
      }
    });

    const manageBtn = document.createElement('button');
    manageBtn.className = 'ghost small';
    manageBtn.textContent = t('Manage');
    manageBtn.addEventListener('click', () => openManagement(profile.id));

    // A running server's start button already reads "Manage" — don't show it twice.
    if (status !== 'online' && status !== 'starting') actions.appendChild(startBtn);
    actions.appendChild(manageBtn);
    card.appendChild(icon);
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

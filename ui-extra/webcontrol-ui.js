'use strict';

// App Settings → Web control: the switch, which server friends may start, and a short status line.
// What a friend may do is decided on the accounts site and in the backend; this only shows the choice.
// Testers only: the backend says `available: false` unless the app was started for web control, and then nothing here shows.
(() => {
  const on = document.getElementById('webControlOn');
  const pick = document.getElementById('webControlProfile');
  const status = document.getElementById('webControlStatus');
  if (!on || !pick || !status || !window.vp || !window.vp.webControlGet) return;
  const cardText = document.getElementById('webControlCardText');
  const cardBtn = document.getElementById('webControlOpenBtn');
  const dashBtn = document.getElementById('webControlDashboardBtn');
  const activity = document.getElementById('webControlActivity');
  const activityEmpty = document.getElementById('webControlActivityEmpty');
  const recent = [];
  const inviteMake = document.getElementById('webControlInviteMake');
  const inviteDays = document.getElementById('webControlInviteDays');
  const inviteMsg = document.getElementById('webControlInviteMsg');
  const inviteList = document.getElementById('webControlInviteList');
  let state = null;

  function describe(s) {
    if (!s.enabled) return '';
    if (!s.allowed) return window.t('Sign in with Discord to use web control.');
    if (s.perk === false) return window.t('Web control is a Supporter+ perk. Get Supporter+ to switch it on.');
    return s.running ? window.t('Web control is on. Friends can reach this PC.') : window.t('Connecting to the web…');
  }
  const card = document.getElementById('webControlCard');
  let timer = null;
  function render() {
    if (!state) return;
    if (card) card.classList.toggle('hidden', !state.available);
    if (state.available === false && timer) { clearInterval(timer); timer = null; }
    on.checked = !!state.enabled;
    pick.replaceChildren(...state.profiles.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.name, selected: p.id === state.profileId })));
    pick.disabled = !state.profiles.length;
    on.disabled = !state.profiles.length;
    status.textContent = state.profiles.length ? describe(state) : window.t('Create a server first.');
    // The card on the library screen shows the state at a glance and opens this screen.
    if (cardText) cardText.textContent = state.enabled && state.profiles.length && describe(state) ? describe(state) : window.t('Let friends start, stop and watch your server from their phone or a browser.');
    if (cardBtn) cardBtn.textContent = window.t('Set up');
  }
  function drawActivity() {
    if (!activity) return;
    activity.replaceChildren(...recent.map((e) => Object.assign(document.createElement('li'), { textContent: e.time + ' · ' + window.t(e.label) + (e.arg ? ' ' + e.arg : '') + ' · ' + (e.ok ? window.t('Done') : window.t('Failed')) })));
    if (activityEmpty) activityEmpty.classList.toggle('hidden', recent.length > 0);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); inviteMsg.textContent = window.t('Link copied.'); } catch { inviteMsg.textContent = text; }
  }
  async function loadInvites() {
    if (!inviteList || !window.vp.webControlInvites) return;
    let r = null;
    try { r = await window.vp.webControlInvites(); } catch { /* keep what is shown */ }
    if (!r || !r.ok) { inviteList.replaceChildren(); return; }
    const rows = r.invites.filter((i) => i.state === 'active' || i.state === 'expired').slice(0, 10);
    inviteList.replaceChildren(...(rows.length ? rows.map((i) => {
      const li = document.createElement('li');
      const days = i.expiresAt ? new Date(i.expiresAt).toLocaleDateString() : window.t('Never expires');
      li.append((i.label || '#' + i.id) + ' · ' + (i.state === 'active' ? days : window.t('expired')) + ' ');
      const rm = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost small', textContent: window.t('Remove') });
      rm.addEventListener('click', async () => { rm.disabled = true; try { await window.vp.webControlInviteRemove(i.id); } catch { /* the list reloads below */ } loadInvites(); });
      li.append(rm);
      return li;
    }) : [Object.assign(document.createElement('li'), { textContent: window.t('No links yet.') })]));
  }
  async function makeInvite() {
    inviteMsg.textContent = '';
    inviteMake.disabled = true;
    try {
      const r = await window.vp.webControlInviteCreate({ days: Number(inviteDays.value) });
      if (r && r.ok) { await copy(r.url); loadInvites(); }
      else inviteMsg.textContent = r && r.error === 'Web control is a Supporter+ perk. Get Supporter+ to switch it on.' ? window.t(r.error) : window.t('Could not create the link.');
    } catch { inviteMsg.textContent = window.t('Could not create the link.'); }
    inviteMake.disabled = false;
  }
  async function save() {
    try { state = await window.vp.webControlSet({ enabled: on.checked, profileId: pick.value || null }); } catch { /* keep what is shown */ }
    render();
  }
  async function load() {
    try { state = await window.vp.webControlGet(); } catch { return; }
    render();
  }
  on.addEventListener('change', save);
  pick.addEventListener('change', () => { if (on.checked) save(); });
  window.vp.on('webcontrol:event', (e) => {
    const label = { start: 'Start', stop: 'Stop', restart: 'Restart', kick: 'Kick' }[e && e.action];
    if (label) { recent.unshift({ time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), label, arg: e.arg || '', ok: !!e.ok }); recent.length = Math.min(recent.length, 10); drawActivity(); }
    load();
  });
  if (cardBtn) cardBtn.addEventListener('click', () => { load(); loadInvites(); window.showScreen('screen-webcontrol'); });
  if (inviteMake) inviteMake.addEventListener('click', makeInvite);
  if (dashBtn) dashBtn.addEventListener('click', () => { window.vp.webControlOpenDashboard().catch(() => {}); });
  window.vp.on('discord:state', load);
  document.addEventListener('click', (event) => { if (event.target.closest && event.target.closest('[data-open="screen-app-settings"], #appSettingsBtn, #webControlOpenBtn')) load(); });
  load();
  timer = setInterval(load, 15000);
})();

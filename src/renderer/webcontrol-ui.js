'use strict';

// App Settings → Web control: the switch, which server friends may start, and a short status line.
// What a friend may do is decided on the accounts site and in the main process; this only shows the choice.
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
  let state = null;

  function describe(s) {
    if (!s.enabled) return '';
    if (!s.allowed) return window.t('Sign in with Discord to use web control.');
    if (s.perk === false) return window.t('Web control is a Supporter+ perk. Get Supporter+ to switch it on.');
    return s.running ? window.t('Web control is on. Friends can reach this PC.') : window.t('Connecting to the web…');
  }
  function render() {
    if (!state) return;
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
  if (cardBtn) cardBtn.addEventListener('click', () => { load(); window.showScreen('screen-webcontrol'); });
  if (dashBtn) dashBtn.addEventListener('click', () => { window.vp.webControlOpenDashboard().catch(() => {}); });
  window.vp.on('discord:state', load);
  document.addEventListener('click', (event) => { if (event.target.closest && event.target.closest('[data-open="screen-app-settings"], #appSettingsBtn, #webControlOpenBtn')) load(); });
  load();
  setInterval(load, 15000);
})();

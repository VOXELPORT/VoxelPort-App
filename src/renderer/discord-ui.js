'use strict';

// "Continue with Discord": the first-run screen for new installs, a banner for people who were already
// using VoxelPort, and the account row in Settings. All decisions come from the main process
// (discordGate.js); this file only shows them. The session and device token never reach this page.
(() => {
  const $ = (id) => document.getElementById(id);
  const gate = $('discordGate');
  const banner = $('discordBanner');
  const accountStatus = $('setDiscordStatus');
  const accountActions = $('setDiscordActions');
  let state = null;
  let signingIn = false;
  let notice = '';
  let bannerDismissed = false;

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const kid of kids) node.append(kid);
    return node;
  }
  const button = (label, onclick, className) => el('button', { type: 'button', className: className || 'ghost', textContent: label, onclick });
  const needsSignIn = (s) => ['signed_out', 'session_rejected', 'recheck'].includes(s.reason);

  async function signIn() {
    if (signingIn) return;
    signingIn = true; notice = ''; render();
    let result = null;
    try { result = await window.vp.discordSignIn(); } catch { result = { ok: false, error: 'failed' }; }
    signingIn = false;
    if (result.state) state = result.state;
    if (!result.ok && result.error !== 'cancelled') notice = window.t("Sign-in didn't finish. Try again.");
    render();
  }
  async function recheck() {
    notice = '';
    try { state = await window.vp.discordRecheck(); } catch { /* keep the last answer */ }
    render();
  }
  const cancel = () => window.vp.discordCancel();
  const openInvite = () => window.vp.discordOpenInvite();

  /** The buttons that move this person forward from where they are. */
  function actions(s) {
    if (signingIn) return [el('p', { className: 'hint', textContent: window.t('Finish signing in in your browser…') }), button(window.t('Cancel'), cancel)];
    if (needsSignIn(s)) return [button(window.t('Continue with Discord'), signIn, 'primary')];
    return [button(window.t('Join the Discord server'), openInvite, 'primary'), button(window.t('Check again'), recheck)];
  }
  function explanation(s) {
    if (s.reason === 'not_in_server') return window.t("You're not in the VoxelPort Discord server yet.");
    if (s.reason === 'screening') return window.t("Finish the server's rules screening, then check again.");
    if (s.reason === 'session_rejected' || s.reason === 'recheck') return window.t('Please sign in with Discord again.');
    return '';
  }

  function renderGate() {
    // The wall only covers the app when the accounts service has answered at least once; if it is down, private play still works.
    const show = !!state && !state.allowed && state.newInstall && state.reachable;
    gate.classList.toggle('hidden', !show);
    document.body.classList.toggle('discord-locked', show);
    if (!show) { gate.replaceChildren(); return; }
    const why = explanation(state);
    gate.replaceChildren(el('div', { className: 'discord-card' },
      el('h1', { id: 'discordGateTitle', textContent: window.t('Join the VoxelPort Discord to continue') }),
      el('p', { textContent: window.t("Everyone who uses VoxelPort joins our Discord server. It's where we share updates, giveaways and help.") }),
      why ? el('p', { className: 'discord-why', textContent: why }) : '',
      notice ? el('p', { className: 'discord-why', role: 'alert', textContent: notice }) : '',
      el('div', { className: 'discord-actions' }, ...actions(state))));
    const first = gate.querySelector('button.primary') || gate.querySelector('button');
    if (first && !signingIn) first.focus();
  }

  function renderBanner() {
    // Existing installs only: new installs get the full screen. While grace lasts the banner can be set aside for this run.
    const inGrace = !!state && state.banner === 'grace' && !bannerDismissed;
    const blocked = !!state && (!state.newInstall || !state.reachable) && state.banner === 'blocked';
    banner.classList.toggle('hidden', !(inGrace || blocked));
    if (!(inGrace || blocked)) { banner.replaceChildren(); return; }
    const text = state.banner === 'grace' && state.graceDaysLeft != null
      ? window.t('Join the VoxelPort Discord within {n} days to keep hosting.', { n: state.graceDaysLeft })
      : window.t('Join the VoxelPort Discord to host your server publicly.');
    const dismiss = state.banner === 'grace' ? [button(window.t('Not now'), () => { bannerDismissed = true; render(); })] : [];
    banner.replaceChildren(el('span', { textContent: text }), notice ? el('span', { textContent: notice }) : '', ...actions(state), ...dismiss);
  }

  function renderSettings() {
    if (!accountStatus || !state) return;
    accountStatus.textContent = state.discordName ? window.t('Signed in as {name}', { name: state.discordName }) : window.t('Not signed in with Discord.');
    const extra = state.linkError ? [el('p', { className: 'hint', textContent: state.linkError })] : [];
    accountActions.replaceChildren(...extra, state.discordName
      ? button(window.t('Sign out'), async () => { try { state = await window.vp.discordSignOut(); } catch { /* keep the old state */ } render(); })
      : signingIn ? button(window.t('Cancel'), cancel) : button(window.t('Continue with Discord'), signIn));
  }

  function render() { renderGate(); renderBanner(); renderSettings(); }

  window.vp.on('discord:state', (next) => { state = next; render(); });
  window.vp.discordState().then((first) => { state = first; render(); }).catch(() => {});
})();

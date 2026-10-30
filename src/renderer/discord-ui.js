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
  const accountRank = $('setDiscordRank');
  const rankBadge = $('rankBadge');
  const backupGroup = $('setBackupGroup');
  const backupStatus = $('setBackupStatus');
  const backupActions = $('setBackupActions');
  const backupForm = $('setBackupForm');
  const RANKS = { free: 'Free', supporter: 'Supporter', supporter_plus: 'Supporter+' };
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
    // The full login page covers the app for everyone who is not signed in, whatever the age of the install. It only waits
    // until the accounts service has answered once: if it is down there is nothing to sign in to, and a small banner is shown instead.
    const show = !!state && !state.allowed && state.reachable;
    gate.classList.toggle('hidden', !show);
    document.body.classList.toggle('discord-locked', show);
    if (!show) { gate.replaceChildren(); return; }
    const why = explanation(state);
    const brand = el('div', { className: 'discord-brand' }, el('img', { src: 'icon.svg', width: 64, height: 64, alt: '' }),
      el('span', { className: 'brand-word' }, 'VOXEL', el('span', {}, 'PORT')));
    gate.replaceChildren(el('div', { className: 'discord-card' }, brand,
      el('h1', { id: 'discordGateTitle', textContent: window.t('Join the VoxelPort Discord to continue') }),
      el('p', { textContent: window.t("Everyone who uses VoxelPort joins our Discord server. It's where we share updates, giveaways and help.") }),
      why ? el('p', { className: 'discord-why', textContent: why }) : '',
      notice ? el('p', { className: 'discord-why', role: 'alert', textContent: notice }) : '',
      el('div', { className: 'discord-actions' }, ...actions(state))));
    const first = gate.querySelector('button.primary') || gate.querySelector('button');
    if (first && !signingIn) first.focus();
  }

  function renderBanner() {
    // The full login page is the normal way in; this banner is for the grace period (if one is set) and for when the accounts service cannot be reached.
    const inGrace = !!state && state.banner === 'grace' && !bannerDismissed;
    const blocked = !!state && !state.allowed && !state.reachable && state.banner === 'blocked';
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
    // The rank the relays give this account (Supporter+ also unlocks voice chat), with the plan it comes from.
    const rank = state.discordName && state.rank ? (RANKS[state.rank] || state.rank) + (state.planName && !['Free', 'Supporter'].includes(state.planName) ? ` (${state.planName})` : '') : '';
    accountRank.textContent = rank ? window.t('Your rank: {rank}', { rank }) : '';
    // The badge in the header appears for a Supporter or Supporter+, so it is the first thing you see.
    const earned = state.discordName && state.rank && state.rank !== 'free';
    rankBadge.textContent = earned ? '★ ' + (RANKS[state.rank] || state.rank) : '';
    rankBadge.classList.toggle('hidden', !earned);
    const extra = state.linkError ? [el('p', { className: 'hint', textContent: state.linkError })] : [];
    accountActions.replaceChildren(...extra, state.discordName
      ? button(window.t('Sign out'), async () => { try { state = await window.vp.discordSignOut(); } catch { /* keep the old state */ } render(); })
      : signingIn ? button(window.t('Cancel'), cancel) : button(window.t('Continue with Discord'), signIn));
  }

  // ─── Address backup ───────────────────────────────────────────────────────────────────────────────
  // The passphrase goes to the main process and nowhere else; the address code itself never comes to this page.
  // The two fields live as long as the page, so a state update while someone types does not wipe them.
  const FAILED = "That didn't work. Check your connection and try again.";
  let backupMode = null; // null | 'save' | 'restore'
  let backupBusy = false;
  let backupNote = { text: '', bad: false }; // shown once: it goes as soon as the person does something else
  const passField = el('input', { type: 'password', autocomplete: 'off', spellcheck: false });
  const againField = el('input', { type: 'password', autocomplete: 'off', spellcheck: false });
  const formError = el('p', { className: 'hint', role: 'alert' });
  const formHelp = el('p', { className: 'hint' });
  const passLabel = el('label', { className: 'field' }, el('span', { className: 'label' }), passField);
  const againLabel = el('label', { className: 'field' }, el('span', { className: 'label' }), againField);
  const submitButton = el('button', { type: 'submit', className: 'primary' });
  const cancelButton = el('button', { type: 'button', className: 'ghost', onclick: () => closeBackupForm() });
  backupForm.append(formHelp, passLabel, againLabel, formError, el('div', { className: 'discord-actions' }, submitButton, cancelButton));

  function closeBackupForm() { backupMode = null; passField.value = ''; againField.value = ''; formError.textContent = ''; renderBackup(); }
  function openBackupForm(mode) {
    backupMode = mode; backupNote = { text: '', bad: false }; formError.textContent = ''; passField.value = ''; againField.value = '';
    renderBackup();
    passField.focus();
  }
  // The same rules the main process enforces (12 characters, 5 different ones), so the person hears it before anything is sent.
  function passphraseProblem(raw) {
    const p = String(raw).normalize('NFC');
    if (p.length < 12) return window.t('Use at least 12 characters.');
    if (new Set(p.split('')).size < 5) return window.t('Choose something less repetitive.');
    return '';
  }
  async function submitBackup(event) {
    event.preventDefault();
    if (backupBusy) return;
    const saving = backupMode === 'save';
    const passphrase = passField.value;
    // Restoring has no length rule of its own (the backup says if it opens), only that something was typed.
    const problem = saving ? passphraseProblem(passphrase) || (passphrase !== againField.value ? window.t("The two passphrases don't match.") : '') : (passphrase ? '' : window.t('Use at least 12 characters.'));
    if (problem) { formError.textContent = problem; return; }
    backupBusy = true; formError.textContent = ''; renderBackup();
    let result;
    try { result = await (saving ? window.vp.identitySave(passphrase) : window.vp.identityRestore(passphrase)); } catch { result = { ok: false, error: FAILED }; }
    backupBusy = false;
    if (result.ok) { backupNote = { text: window.t(result.message), bad: false }; closeBackupForm(); return; }
    // A wrong passphrase or a refusal keeps the form open for another try.
    formError.textContent = window.t(result.error);
    renderBackup();
  }
  async function deleteBackup() {
    if (backupBusy) return;
    backupBusy = true; backupNote = { text: '', bad: false }; renderBackup();
    let result;
    try { result = await window.vp.identityDelete(); } catch { result = { ok: false, error: FAILED }; }
    backupBusy = false;
    backupNote = { text: window.t(result.ok ? result.message : result.error), bad: !result.ok };
    renderBackup();
  }
  backupForm.addEventListener('submit', submitBackup);

  function renderBackup() {
    const signedIn = !!state && !!state.discordName;
    backupGroup.classList.toggle('hidden', !signedIn);
    if (!signedIn) { backupMode = null; passField.value = ''; againField.value = ''; backupNote = { text: '', bad: false }; return; }
    const info = state.backup;
    let status = '';
    if (info && info.thisPc) status = window.t('Your address is backed up to your Discord account.');
    else if (info) status = window.t('Your Discord account has a backed-up address (ending {id}) that is not the one on this PC. Restore it to use that address here.', { id: info.id });
    backupStatus.textContent = backupNote.text || status;
    backupStatus.setAttribute('role', backupNote.bad ? 'alert' : 'status');
    const open = backupMode !== null;
    backupForm.classList.toggle('hidden', !open);
    backupActions.classList.toggle('hidden', open);
    if (open) {
      const saving = backupMode === 'save';
      formHelp.textContent = saving
        ? window.t("Choose a passphrase of at least 12 characters. Only you know it: VoxelPort can't recover it, and without it the backup can't be opened.")
        : window.t('Type the passphrase you chose when you backed up your address. This PC will then use that address, and the one it has now is left behind.');
      passLabel.firstChild.textContent = window.t('Passphrase');
      againLabel.firstChild.textContent = window.t('Type it again');
      passField.setAttribute('aria-label', window.t('Passphrase')); againField.setAttribute('aria-label', window.t('Type it again'));
      againLabel.classList.toggle('hidden', !saving);
      submitButton.textContent = backupBusy ? window.t('Working…') : saving ? window.t('Back up my address') : window.t('Restore');
      cancelButton.textContent = window.t('Cancel');
      for (const node of [submitButton, cancelButton, passField, againField]) node.disabled = backupBusy;
      return;
    }
    const buttons = [button(window.t('Back up my address'), () => openBackupForm('save'))];
    if (info && !info.thisPc) buttons.push(button(window.t('Restore my address'), () => openBackupForm('restore')));
    if (info) buttons.push(button(window.t('Delete backup'), deleteBackup));
    backupActions.replaceChildren(...(backupBusy ? [el('span', { className: 'hint', textContent: window.t('Working…') })] : buttons));
  }

  function render() { renderBackup(); renderGate(); renderBanner(); renderSettings(); }

  window.vp.on('discord:state', (next) => { state = next; render(); });
  window.vp.discordState().then((first) => { state = first; render(); }).catch(() => {});
})();

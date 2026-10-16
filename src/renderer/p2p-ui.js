'use strict';

// Join codes on the screens: the Join screen (a player enters a code), the switch in Settings (a host turns codes on),
// and the code row on the server page. What they say comes from p2pText.js; the work happens in the main process.

// ─── Joining with a code ──────────────────────────────────────────────────

const joinCodeInput = $('joinCodeInput');
const joinStartBtn = $('joinStartBtn');
const joinStopBtn = $('joinStopBtn');
const joinStatus = $('joinStatus');
const joinStatusText = $('joinStatusText');
const joinPath = $('joinPath');
const joinAddressBox = $('joinAddressBox');
const joinAddress = $('joinAddress');
const joinCopyBtn = $('joinCopyBtn');
const joinAllowRelay = $('joinAllowRelay');
// The relay is in India: it is only allowed by default for players there (anywhere else it would mean a high ping).
joinAllowRelay.checked = window.VPP2P.defaultAllowRelay(Intl.DateTimeFormat().resolvedOptions().timeZone);

function paintJoin(status) {
  const d = window.VPP2P.describeJoin(status, t);
  joinStatus.classList.toggle('hidden', !d.text);
  joinStatusText.textContent = d.text;
  joinStatus.dataset.tone = d.tone;
  joinPath.classList.toggle('hidden', !d.pill);
  joinPath.textContent = d.pill;
  joinAddressBox.classList.toggle('hidden', !d.address);
  joinAddress.textContent = d.address || '—';
  joinStartBtn.classList.toggle('hidden', d.running);
  joinStopBtn.classList.toggle('hidden', !d.running);
  joinCodeInput.disabled = d.running;
  joinAllowRelay.disabled = d.running;
}

$('joinCodeLink').addEventListener('click', async () => {
  showScreen('screen-join');
  paintJoin(await window.vp.join.status());
  if (!joinCodeInput.disabled) joinCodeInput.focus();
});

joinStartBtn.addEventListener('click', async () => {
  const code = joinCodeInput.value.trim();
  if (code.replace(/[^0-9A-Za-z]/g, '').length < 8) {
    paintJoin({ state: 'failed', message: 'Enter the code your friend gave you.' });
    return;
  }
  joinStartBtn.disabled = true;
  const res = await window.vp.join.start(code, joinAllowRelay.checked);
  joinStartBtn.disabled = false;
  if (!res || !res.ok) paintJoin({ state: 'failed', message: (res && res.error) || 'Could not join.' });
});
joinCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinStartBtn.click(); });
joinStopBtn.addEventListener('click', async () => { await window.vp.join.stop(); paintJoin({ state: 'stopped' }); });
joinCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(joinAddress.textContent);
    const label = joinCopyBtn.textContent;
    joinCopyBtn.textContent = t('Copied!');
    setTimeout(() => { joinCopyBtn.textContent = label; }, 1600);
  } catch { /* clipboard unavailable */ }
});
window.vp.on('p2p:join:status', paintJoin);

// ─── Hosting: the switch in Settings ──────────────────────────────────────

const setP2P = $('setP2P');
const setP2PWarn = $('setP2PWarn');
const setP2PMsg = $('setP2PMsg');

function renderP2PSetting(d) {
  setP2P.checked = d.enabled;
  setP2P.disabled = !d.supported;
  setP2PWarn.classList.toggle('hidden', !d.enabled);
  if (!d.supported) setP2PMsg.textContent = t("Join codes only work on VoxelPort's own relays.");
  else if (d.enabled && d.public) setP2PMsg.textContent = d.code ? t('On. Your code is shown on the server page.') : t('Getting your code…');
  else if (d.enabled) setP2PMsg.textContent = t('On. Your code appears when your server is public.');
  else setP2PMsg.textContent = '';
}

// Opening Settings also loads this switch (settings.js does the rest).
const openSettingsWithoutP2P = window.openSettingsScreen;
window.openSettingsScreen = async function openSettingsScreenWithP2P(id) {
  await openSettingsWithoutP2P(id);
  setP2PMsg.textContent = '';
  renderP2PSetting(await window.vp.server.p2p.get(id));
};

/** Asks the host to confirm turning join codes on (their PC and the friend's can then see each other's IP address). */
function confirmJoinCodes() {
  return window.confirm(
    t('Turn on join codes?') + '\n\n' +
    t('Friends who have your code can connect straight to your PC from VoxelPort, with the lowest ping and no port forwarding.') + '\n\n' +
    t("• Their PC and yours can see each other's IP address while they play.") + '\n' +
    t('• Anyone you give the code to can join, so only share it with people you trust. You can make a new code at any time.') + '\n' +
    t("• If a direct connection can't be made, they are connected through the relay instead.")
  );
}

setP2P.addEventListener('change', async () => {
  const wantOn = setP2P.checked;
  if (wantOn && !confirmJoinCodes()) {
    setP2P.checked = false;
    return;
  }
  setP2P.disabled = true;
  const res = await window.vp.server.p2p.set(settingsProfileId, wantOn, wantOn);
  setP2P.disabled = false;
  if (!res || !res.ok) {
    setP2P.checked = !wantOn;
    setP2PMsg.textContent = t((res && res.error) || "Couldn't change that.");
    return;
  }
  renderP2PSetting(await window.vp.server.p2p.get(settingsProfileId));
  if (!wantOn) setP2PMsg.textContent = t('Off.');
  if (window.joinCodeSettingChanged) window.joinCodeSettingChanged();
});

// ─── Hosting: the code on the server page ─────────────────────────────────

const srvJoinCode = $('srvJoinCode');
const srvJoinCodeText = $('srvJoinCodeText');
const srvJoinCodeHint = $('srvJoinCodeHint');
const srvJoinOffer = $('srvJoinOffer');
const srvJoinOnBtn = $('srvJoinOnBtn');
const srvJoinCopyBtn = $('srvJoinCopyBtn');
const srvJoinNewBtn = $('srvJoinNewBtn');

let p2pInfo = null;
let p2pInfoFor = null;

function paintJoinCodeRow() {
  const d = window.VPP2P.describeHost(p2pInfo, t);
  srvJoinOffer.classList.toggle('hidden', !d.showOffer);
  srvJoinCode.classList.toggle('hidden', !d.showRow);
  if (!d.showRow) return;
  srvJoinCodeText.textContent = d.code || '—';
  srvJoinCodeHint.textContent = d.line;
  srvJoinCopyBtn.classList.toggle('hidden', !d.code);
  srvJoinNewBtn.classList.toggle('hidden', !d.code);
}

// Called by console.js whenever the public address area is drawn.
window.renderJoinCodeRow = async function renderJoinCodeRow() {
  if (typeof managingProfileId === 'undefined' || !managingProfileId || !isThisProfilePublic()) {
    p2pInfo = null; p2pInfoFor = null; paintJoinCodeRow(); return;
  }
  if (p2pInfoFor !== managingProfileId) {
    p2pInfoFor = managingProfileId;
    try { p2pInfo = await window.vp.server.p2p.get(managingProfileId); } catch { p2pInfo = null; }
  }
  paintJoinCodeRow();
};

window.vp.on('tunnel:p2p', (s) => {
  if (!p2pInfo) { p2pInfoFor = null; window.renderJoinCodeRow(); return; }
  p2pInfo = { ...p2pInfo, code: s.code, peers: s.peers, players: s.players };
  paintJoinCodeRow();
});

window.joinCodeSettingChanged = function joinCodeSettingChanged() { p2pInfoFor = null; window.renderJoinCodeRow(); };

// The same switch as in Settings, one click from where the address is shown.
srvJoinOnBtn.addEventListener('click', async () => {
  if (!confirmJoinCodes()) return;
  srvJoinOnBtn.disabled = true;
  const res = await window.vp.server.p2p.set(managingProfileId, true, true);
  srvJoinOnBtn.disabled = false;
  if (!res || !res.ok) { srvLogLine(t((res && res.error) || "Couldn't change that.")); return; }
  p2pInfoFor = null;
  window.renderJoinCodeRow();
});

srvJoinCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(srvJoinCodeText.textContent);
    const label = srvJoinCopyBtn.textContent;
    srvJoinCopyBtn.textContent = t('Copied!');
    setTimeout(() => { srvJoinCopyBtn.textContent = label; }, 1600);
  } catch { /* clipboard unavailable */ }
});
srvJoinNewBtn.addEventListener('click', async () => {
  if (!window.confirm(t('Make a new code? The old one stops working.'))) return;
  await window.vp.server.p2p.rotate(managingProfileId);
});

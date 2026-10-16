'use strict';

// ─── Server settings screen ──────────────────────────────────────────────

const setSubtitle = $('setSubtitle');
const setName = $('setName');
const setPort = $('setPort');
const setRam = $('setRam');
const setRamLabel = $('setRamLabel');
const setFields = $('setFields');
const setBedrock = $('setBedrock');
const setBedrockMsg = $('setBedrockMsg');
const setDirect = $('setDirect');
const setDirectWarn = $('setDirectWarn');
const setDirectMsg = $('setDirectMsg');
const setCracked = $('setCracked');
const setCrackedWarn = $('setCrackedWarn');
const setLoginBtn = $('setLoginBtn');
const setAccountsMsg = $('setAccountsMsg');
const setListed = $('setListed');
const setListingDesc = $('setListingDesc');
const setSaveBtn = $('setSaveBtn');
const setMsg = $('setMsg');

let settingsProfileId = null;
let fieldDefs = [];

function showSetMsg(text, kind) {
  setMsg.textContent = text;
  setMsg.className = `set-msg ${kind || ''}`;
}

function buildField(def, value) {
  const wrap = document.createElement('label');
  wrap.className = def.type === 'bool' ? 'toggle-row compact' : 'field';
  let input;
  if (def.type === 'bool') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
    const text = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = t(def.label);
    text.appendChild(b);
    wrap.append(input, text);
  } else {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = t(def.label);
    if (def.type === 'enum') {
      input = document.createElement('select');
      for (const opt of def.options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = t(opt[0].toUpperCase() + opt.slice(1));
        input.appendChild(o);
      }
      input.value = value;
    } else {
      input = document.createElement('input');
      input.type = def.type === 'int' ? 'number' : 'text';
      if (def.type === 'int') { input.min = def.min; input.max = def.max; input.inputMode = 'numeric'; } else input.maxLength = def.max;
      input.value = value;
    }
    wrap.append(label, input);
  }
  input.dataset.key = def.key;
  input.dataset.type = def.type;
  if (def.key === 'motd' || def.key === 'level-seed') wrap.classList.add('span-2');
  return wrap;
}

window.openSettingsScreen = async function openSettingsScreen(id) {
  settingsProfileId = id;
  showSetMsg('', 'hidden');
  setBedrockMsg.textContent = '';
  setDirectMsg.textContent = '';
  setAccountsMsg.textContent = '';
  const data = await window.vp.server.getSettings(id);
  const { profile, fields, values, bedrock, listing, totalMemMb } = data;
  fieldDefs = fields;

  setSubtitle.textContent = profile.name;
  setName.value = profile.name;
  setPort.value = profile.port;
  setRam.max = Math.max(1024, Math.min(totalMemMb - 1024, 32768));
  setRam.value = profile.maxRamMb;
  setRamLabel.textContent = profile.maxRamMb;

  setFields.innerHTML = '';
  // On/off switches go last so the two-column grid of inputs stays even.
  const ordered = [...fields].sort((a, b) => (a.type === 'bool') - (b.type === 'bool'));
  for (const def of ordered) setFields.appendChild(buildField(def, values[def.key]));

  setBedrock.checked = bedrock.enabled;
  setBedrock.disabled = !bedrock.supported;
  if (!bedrock.supported) setBedrockMsg.textContent = t("Bedrock players need a Paper or Fabric server — Vanilla can't run Geyser.");
  else if (bedrock.enabled) setBedrockMsg.textContent = t('On — Bedrock players join on the same port as Java (Geyser listens on {port}).', { port: bedrock.port });

  renderDirect(await window.vp.server.direct.get(id));
  renderAccounts(await window.vp.accounts.get(id));

  setListed.checked = listing.enabled;
  setListingDesc.value = listing.description || '';
  setListingDesc.disabled = !listing.enabled;

  if (data.running) showSetMsg(t('This server is running — gameplay changes apply after a restart.'), 'info');
  showScreen('screen-settings');
};

setRam.addEventListener('input', () => { setRamLabel.textContent = setRam.value; });
setListed.addEventListener('change', () => { setListingDesc.disabled = !setListed.checked; });

$('settingsBackBtn').addEventListener('click', async () => {
  showScreen('screen-console');
  if (window.refreshManagedProfile) await window.refreshManagedProfile();
});

setSaveBtn.addEventListener('click', async () => {
  const properties = {};
  for (const input of setFields.querySelectorAll('[data-key]')) {
    const { key, type } = input.dataset;
    if (type === 'bool') properties[key] = input.checked;
    else if (type === 'int') properties[key] = Number(input.value);
    else properties[key] = input.value;
  }
  setSaveBtn.disabled = true;
  try {
    const res = await window.vp.server.saveSettings({
      id: settingsProfileId,
      name: setName.value,
      port: Number(setPort.value),
      ramMb: Number(setRam.value),
      properties,
      listing: { enabled: setListed.checked, description: setListingDesc.value },
    });
    setSubtitle.textContent = res.profile.name;
    showSetMsg(res.restartNeeded ? t('Saved! Restart the server to apply the changes.') : t('Saved!'), 'ok');
    if (window.refreshLibrary) window.refreshLibrary();
  } catch (err) {
    // ipcRenderer.invoke wraps the main-process error message.
    showSetMsg(t(String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), 'err');
  } finally {
    setSaveBtn.disabled = false;
  }
});

setBedrock.addEventListener('change', async () => {
  const enabled = setBedrock.checked;
  setBedrock.disabled = true;
  setBedrockMsg.textContent = enabled ? t('Downloading Geyser + Floodgate…') : t('Removing Geyser + Floodgate…');
  const res = await window.vp.server.setBedrock(settingsProfileId, enabled);
  setBedrock.disabled = false;
  if (!res || !res.ok) {
    setBedrock.checked = !enabled;
    setBedrockMsg.textContent = enabled
      ? t("Couldn't add Bedrock support: {why}", { why: t((res && res.error) || 'unknown error') })
      : t("Couldn't remove Bedrock support: {why}", { why: t((res && res.error) || 'unknown error') });
    return;
  }
  if (enabled) setBedrockMsg.textContent = res.restartNeeded ? t('On — Bedrock players join on the same address and port as Java. Restart the server to load Geyser.') : t('On — Bedrock players join on the same address and port as Java.');
  else setBedrockMsg.textContent = res.restartNeeded ? t('Off. Restart the server to apply.') : t('Off.');
  if (window.refreshManagedProfile) window.refreshManagedProfile();
});

window.vp.on('bedrock:progress', (p) => {
  if (!p) return;
  if (p.stage === 'resolve') setBedrockMsg.textContent = t('Finding the right Geyser build…');
  else if (p.stage === 'download') setBedrockMsg.textContent = t('Downloading {file}…', { file: p.file });
});

// ─── Direct mode: players connect straight to this PC ─────────────────────

function renderDirect(d) {
  setDirect.checked = d.enabled;
  setDirect.disabled = !d.supported;
  setDirectWarn.classList.toggle('hidden', !d.enabled);
  if (!d.supported) setDirectMsg.textContent = t("Direct mode only works on VoxelPort's own relays.");
  else if (d.enabled && d.public) setDirectMsg.textContent = window.VPDirect.describeDirect(d.status, t).text;
  else if (d.enabled) setDirectMsg.textContent = t('On. It starts when your server is public.');
}

setDirect.addEventListener('change', async () => {
  const wantOn = setDirect.checked;
  if (wantOn && !window.confirm(
    t('Turn on Direct mode?') + '\n\n' +
    t('Players will connect straight to your PC, so they get a lower ping if they live near you.') + '\n\n' +
    t('• Your home IP address becomes visible to anyone who joins, and it is published in DNS for your custom address while Direct mode is on.') + '\n' +
    t('• VoxelPort opens a port on your router (UPnP) while your server is public, and closes it when you stop.') + '\n' +
    t('• It only works if your router allows it and your internet provider gives you your own public address. If not, nothing changes: players keep using the relay.') + '\n' +
    t('• If your server stops answering, players are sent back to the relay by themselves.')
  )) {
    setDirect.checked = false;
    return;
  }
  setDirect.disabled = true;
  const res = await window.vp.server.direct.set(settingsProfileId, wantOn, wantOn);
  setDirect.disabled = false;
  if (!res || !res.ok) {
    setDirect.checked = !wantOn;
    setDirectMsg.textContent = t((res && res.error) || "Couldn't change that.");
    return;
  }
  renderDirect(await window.vp.server.direct.get(settingsProfileId));
  if (!wantOn) setDirectMsg.textContent = t('Off.');
  if (window.directSettingChanged) window.directSettingChanged();
});

window.vp.on('tunnel:direct', async () => {
  // While this screen is open for the public server, keep its message in step with what the main process reports.
  if (!settingsProfileId || !document.getElementById('screen-settings').classList.contains('active')) return;
  renderDirect(await window.vp.server.direct.get(settingsProfileId));
});

// ─── Player accounts: cracked (offline-mode) servers ──────────────────────

function renderAccounts(acc) {
  setCracked.checked = acc.cracked;
  setCrackedWarn.classList.toggle('hidden', !acc.cracked);
  // The login plugin (AuthMe) is for Paper servers; hide the button once it's installed.
  setLoginBtn.classList.toggle('hidden', !(acc.cracked && acc.canInstallLogin && !acc.loginPlugin));
  if (acc.cracked && acc.loginPlugin) setAccountsMsg.textContent = t('Login plugin installed (AuthMe): players use /register and /login.');
}

setCracked.addEventListener('change', async () => {
  const wantOn = setCracked.checked;
  if (wantOn && !window.confirm(
    t('Allow cracked players?') + '\n\n' +
    t("This turns off Minecraft's account check, so people without a paid account can join.") + '\n\n' +
    t("• Anyone can join under any name, including yours or an admin's, unless you use the whitelist or a login plugin.") + '\n' +
    t("• Switching changes every player's ID: inventories, ops and whitelist entries from the other mode won't match.") + '\n' +
    t('• Skins may not show for cracked players.')
  )) {
    setCracked.checked = false;
    return;
  }
  setCracked.disabled = true;
  // Turning it on carries the confirmation the dialog above just collected; the main process insists on it.
  const res = await window.vp.accounts.set(settingsProfileId, wantOn, wantOn);
  setCracked.disabled = false;
  if (!res || !res.ok) {
    setCracked.checked = !wantOn;
    setAccountsMsg.textContent = t((res && res.error) || "Couldn't change that.");
    return;
  }
  renderAccounts(await window.vp.accounts.get(settingsProfileId));
  setAccountsMsg.textContent = res.restartNeeded ? t('Saved. Restart the server to apply.') : t('Saved. Applies the next time you start the server.');
});

setLoginBtn.addEventListener('click', async () => {
  setLoginBtn.disabled = true;
  setAccountsMsg.textContent = t('Installing AuthMe…');
  const res = await window.vp.accounts.installLogin(settingsProfileId);
  setLoginBtn.disabled = false;
  if (!res || !res.ok) { setAccountsMsg.textContent = t("Couldn't install AuthMe: {why}", { why: t((res && res.error) || 'unknown error') }); return; }
  renderAccounts(await window.vp.accounts.get(settingsProfileId));
  setAccountsMsg.textContent = res.restartNeeded ? t('AuthMe installed. Restart the server to load it.') : t('AuthMe installed. It loads when you start the server.');
});

window.vp.on('accounts:progress', (p) => {
  if (!p) return;
  if (p.stage === 'resolve') setAccountsMsg.textContent = t('Finding AuthMe for your Minecraft version…');
  else if (p.stage === 'download') setAccountsMsg.textContent = t('Downloading {file}…', { file: p.file });
});

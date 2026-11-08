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
  setAccountsMsg.textContent = '';
  const data = await window.vp.server.getSettings(id);
  const { profile, fields, values, bedrock, listing, totalMemMb } = data;
  fieldDefs = fields;
  window.VPBedrockServer.applySettingsLayout(data);

  setSubtitle.textContent = profile.name;
  setName.value = profile.name;
  window.renderVoiceState(await window.vp.voiceState());
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

  renderAccounts(await window.vp.accounts.get(id));

  setListed.checked = listing.enabled;
  setListingDesc.value = listing.description || '';
  setListingDesc.disabled = !listing.enabled;

  if (!data.bedrockServer) await renderRuntimeInfo(id, profile, data.running);

  if (data.running) showSetMsg(t('This server is running — gameplay changes apply after a restart.'), 'info');
  showScreen('screen-settings');
};

// Installed Minecraft version (read from the jar), plugin versions, staged
// updates and Bedrock compatibility, plus the change-version control.
async function renderRuntimeInfo(id, profile, running) {
  const installedEl = $('setInstalledVersion');
  const pluginsRow = $('setPluginsRow');
  const pluginsEl = $('setPlugins');
  const stagedMsg = $('setStagedMsg');
  const bedrockMsg = $('setBedrockCompatMsg');
  const select = $('setVersionSelect');
  const changeBtn = $('setChangeVersionBtn');
  const changeMsg = $('setChangeVersionMsg');
  changeMsg.textContent = '';
  stagedMsg.classList.add('hidden');
  bedrockMsg.classList.add('hidden');

  let info = null;
  try { info = await window.vp.server.runtimeInfo(id); } catch { /* fall back to stored */ }
  const running_ = info && info.ok ? info.runningVersion : profile.version;
  const buildNote = info && info.ok && info.build ? ` (build ${info.build})` : '';
  const typeName = { paper: 'Paper', fabric: 'Fabric', vanilla: 'Vanilla' }[profile.type] || profile.type;
  installedEl.textContent = `${typeName} ${running_}${buildNote}`;

  if (info && info.ok && info.plugins && info.plugins.length) {
    pluginsEl.textContent = info.plugins.map((p) => `${p.label} ${p.version || '?'}`).join(' · ');
    pluginsRow.classList.remove('hidden');
  } else {
    pluginsRow.classList.add('hidden');
  }

  if (info && info.ok && info.stagedUpdates && info.stagedUpdates.length) {
    stagedMsg.textContent = t('An update for {names} is ready — restart the server to apply it.', { names: info.stagedUpdates.map((s) => s.name).join(', ') });
    stagedMsg.classList.remove('hidden');
  }
  if (info && info.ok && info.bedrock && info.bedrockCompatible === false) {
    bedrockMsg.textContent = t("No Geyser build supports Minecraft {version}, so Bedrock players would be disconnected. Change to a version Geyser supports, or turn Bedrock off.", { version: running_ });
    bedrockMsg.classList.remove('hidden');
  }

  // Fill the version dropdown for this server's type; mark the current one.
  const placeholder = (text) => { select.replaceChildren(); const o = document.createElement('option'); o.textContent = text; select.appendChild(o); };
  placeholder(t('Loading…'));
  changeBtn.disabled = true;
  try {
    const versions = await window.vp.server.versions(profile.type);
    select.replaceChildren();
    for (const v of versions) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v === profile.version ? `${v} ${t('(current)')}` : v;
      if (v === profile.version) opt.selected = true;
      select.appendChild(opt);
    }
    changeBtn.disabled = running; // can't switch a running server's jar
    if (running) changeMsg.textContent = t('Stop the server to change its Minecraft version.');
  } catch {
    placeholder(t('Could not load versions'));
  }
}

$('setChangeVersionBtn').addEventListener('click', async () => {
  const id = settingsProfileId;
  const version = $('setVersionSelect').value;
  const changeMsg = $('setChangeVersionMsg');
  const btn = $('setChangeVersionBtn');
  if (!id || !version) return;
  btn.disabled = true;
  changeMsg.textContent = t('Backing up, then downloading Minecraft {version}…', { version });
  try {
    const res = await window.vp.server.changeVersion(id, version);
    if (res && res.ok) {
      changeMsg.textContent = t('Now on Minecraft {version}.', { version }) + (res.warning ? ' ' + res.warning : '');
      await openSettingsScreen(id); // refresh the whole screen with the new version
    } else {
      changeMsg.textContent = (res && res.error) || t('Could not change the version.');
      btn.disabled = false;
    }
  } catch (err) {
    changeMsg.textContent = err && err.message ? err.message : t('Could not change the version.');
    btn.disabled = false;
  }
});

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

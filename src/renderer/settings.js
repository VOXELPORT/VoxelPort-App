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
    b.textContent = def.label;
    text.appendChild(b);
    wrap.append(input, text);
  } else {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = def.label;
    if (def.type === 'enum') {
      input = document.createElement('select');
      for (const opt of def.options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt[0].toUpperCase() + opt.slice(1);
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
  if (!bedrock.supported) setBedrockMsg.textContent = 'Bedrock players need a Paper or Fabric server — Vanilla can\'t run Geyser.';
  else if (bedrock.enabled) setBedrockMsg.textContent = `On — Bedrock players join on the same port as Java (Geyser listens on ${bedrock.port}).`;

  setListed.checked = listing.enabled;
  setListingDesc.value = listing.description || '';
  setListingDesc.disabled = !listing.enabled;

  if (data.running) showSetMsg('This server is running — gameplay changes apply after a restart.', 'info');
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
    showSetMsg(res.restartNeeded ? 'Saved! Restart the server to apply the changes.' : 'Saved!', 'ok');
    if (window.refreshLibrary) window.refreshLibrary();
  } catch (err) {
    // ipcRenderer.invoke wraps the main-process error message.
    showSetMsg(String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
  } finally {
    setSaveBtn.disabled = false;
  }
});

setBedrock.addEventListener('change', async () => {
  const enabled = setBedrock.checked;
  setBedrock.disabled = true;
  setBedrockMsg.textContent = enabled ? 'Downloading Geyser + Floodgate…' : 'Removing Geyser + Floodgate…';
  const res = await window.vp.server.setBedrock(settingsProfileId, enabled);
  setBedrock.disabled = false;
  if (!res || !res.ok) {
    setBedrock.checked = !enabled;
    setBedrockMsg.textContent = `Couldn't ${enabled ? 'add' : 'remove'} Bedrock support: ${(res && res.error) || 'unknown error'}`;
    return;
  }
  setBedrockMsg.textContent = enabled
    ? `On — Bedrock players join on the same address and port as Java.${res.restartNeeded ? ' Restart the server to load Geyser.' : ''}`
    : `Off.${res.restartNeeded ? ' Restart the server to apply.' : ''}`;
  if (window.refreshManagedProfile) window.refreshManagedProfile();
});

window.vp.on('bedrock:progress', (p) => {
  if (!p) return;
  if (p.stage === 'resolve') setBedrockMsg.textContent = 'Finding the right Geyser build…';
  else if (p.stage === 'download') setBedrockMsg.textContent = `Downloading ${p.file}…`;
});

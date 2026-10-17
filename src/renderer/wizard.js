'use strict';

// Shared state for the install wizard.
const wizardState = { name: null, type: null, version: null, ramMb: null, serverDir: null, templateId: null };

const serverNameInput = $('serverName');
const typeGrid = $('typeGrid');
const versionSelect = $('versionSelect');
const typeNextBtn = $('typeNextBtn');
const templateGrid = $('templateGrid');

const javaStatusText = $('javaStatusText');
const installJavaBtn = $('installJavaBtn');
const recheckJavaBtn = $('recheckJavaBtn');
const ramSlider = $('ramSlider');
const ramValueLabel = $('ramValueLabel');
const ramHint = $('ramHint');
const serverPort = $('serverPort');
const serverDirDisplay = $('serverDirDisplay');
const chooseFolderBtn = $('chooseFolderBtn');
const eulaCheck = $('eulaCheck');
const installBtn = $('installBtn');

const installFill = $('installFill');
const installText = $('installText');

let javaSatisfied = false;

// ─── Step 1: template (optional) + server type + version ───────────────
let templates = [];

async function loadTemplates() {
  templates = await window.vp.server.templates();
  templateGrid.innerHTML = '';
  for (const t of templates) { // (inside this loop `t` is the template, so the translator is window.t)
    const btn = document.createElement('button');
    btn.className = 'mode-card template-card';
    btn.type = 'button';
    btn.dataset.template = t.id;
    const title = document.createElement('div');
    title.className = 'mode-title';
    title.textContent = window.t(t.label);
    const desc = document.createElement('div');
    desc.className = 'mode-desc';
    desc.textContent = window.t(t.blurb);
    btn.append(title, desc);
    if (t.bedrock) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = window.t('Bedrock');
      btn.appendChild(pill);
    }
    btn.addEventListener('click', () => selectTemplate(t, btn));
    templateGrid.appendChild(btn);
  }
}

function selectTemplate(t, btn) {
  const wasSelected = btn.classList.contains('selected');
  templateGrid.querySelectorAll('.template-card').forEach((el) => el.classList.remove('selected'));
  if (wasSelected) { wizardState.templateId = null; serverNameInput.placeholder = window.t('Survival SMP'); return; }
  btn.classList.add('selected');
  wizardState.templateId = t.id;
  serverNameInput.placeholder = window.t(t.label);
  const typeBtn = typeGrid.querySelector(`[data-type="${t.type}"]`);
  if (typeBtn && wizardState.type !== t.type) selectType(t.type, typeBtn, { keepTemplate: true });
}

async function loadTypes() {
  const types = await window.vp.server.types();
  typeGrid.innerHTML = '';
  for (const t of types) {
    const btn = document.createElement('button');
    btn.className = 'mode-card small';
    btn.dataset.type = t.id;
    const title = document.createElement('div');
    title.className = 'mode-title';
    title.textContent = t.label;
    btn.appendChild(title);
    btn.addEventListener('click', () => selectType(t.id, btn));
    typeGrid.appendChild(btn);
  }
}

async function selectType(type, btn, { keepTemplate = false } = {}) {
  typeGrid.querySelectorAll('.mode-card').forEach((el) => el.classList.remove('selected'));
  btn.classList.add('selected');
  wizardState.type = type;
  // Picking a different type by hand drops a template made for another type.
  const tpl = templates.find((t) => t.id === wizardState.templateId);
  if (!keepTemplate && tpl && tpl.type !== type) {
    wizardState.templateId = null;
    templateGrid.querySelectorAll('.template-card').forEach((el) => el.classList.remove('selected'));
  }

  versionSelect.innerHTML = '<option>' + window.t('Loading…') + '</option>';
  typeNextBtn.disabled = true;
  const versions = await window.vp.server.versions(type);
  versionSelect.innerHTML = '';
  for (const v of versions.slice(0, 40)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    versionSelect.appendChild(opt);
  }
  wizardState.version = versionSelect.value;
  typeNextBtn.disabled = !wizardState.version;
}

versionSelect.addEventListener('change', () => { wizardState.version = versionSelect.value; });

serverNameInput.addEventListener('input', () => { wizardState.name = serverNameInput.value.trim(); });

typeNextBtn.addEventListener('click', async () => {
  const tpl = templates.find((t) => t.id === wizardState.templateId);
  wizardState.name = serverNameInput.value.trim() || (tpl ? tpl.label : '');
  showScreen('screen-config');
  await Promise.all([loadSpecs(), runJavaCheck(), loadDefaultDir()]);
  updateInstallEnabled();
});

// ─── Server folder ────────────────────────────────────────────────────────
async function loadDefaultDir() {
  wizardState.serverDir = await window.vp.server.defaultDir();
  serverDirDisplay.value = wizardState.serverDir;
}

chooseFolderBtn.addEventListener('click', async () => {
  const dir = await window.vp.server.chooseFolder();
  if (dir) {
    wizardState.serverDir = dir;
    serverDirDisplay.value = dir;
  }
});

// ─── Step 2: RAM + Java + EULA ───────────────────────────────────────────
async function loadSpecs() {
  const { totalMemMb, recommendedRamMb } = await window.vp.system.specs();
  const max = Math.max(1024, totalMemMb - 1024);
  ramSlider.min = 512;
  ramSlider.max = Math.min(max, 16384);
  ramSlider.step = 256;
  ramSlider.value = Math.min(recommendedRamMb, ramSlider.max);
  wizardState.ramMb = Number(ramSlider.value);
  ramValueLabel.textContent = ramSlider.value;
  ramHint.textContent = window.t('Recommended {mb} MB for a system with {gb} GB RAM.', { mb: recommendedRamMb, gb: (totalMemMb / 1024).toFixed(1) });
}

ramSlider.addEventListener('input', () => {
  ramValueLabel.textContent = ramSlider.value;
  wizardState.ramMb = Number(ramSlider.value);
});

async function runJavaCheck() {
  javaStatusText.textContent = window.t('Checking for Java…');
  installJavaBtn.classList.add('hidden');
  recheckJavaBtn.classList.add('hidden');

  const result = await window.vp.java.check(wizardState.version);
  javaSatisfied = result.satisfied;

  if (result.satisfied) {
    javaStatusText.textContent = result.managed
      ? window.t('Java {major} (installed by VoxelPort) — ready.', { major: result.major })
      : window.t('Java {major} detected — ready.', { major: result.major });
  } else if (result.found) {
    javaStatusText.textContent = window.t('Found Java {major}, but this version needs Java {required}+.', { major: result.major ?? '?', required: result.required });
    installJavaBtn.classList.remove('hidden');
  } else {
    javaStatusText.textContent = window.t('Java not found. This version needs Java {required}+.', { required: result.required });
    installJavaBtn.classList.remove('hidden');
  }
  recheckJavaBtn.classList.remove('hidden');
  updateInstallEnabled();
}

// Downloads Eclipse Temurin into VoxelPort's own folder — no admin, no website.
installJavaBtn.addEventListener('click', async () => {
  installJavaBtn.disabled = true;
  recheckJavaBtn.disabled = true;
  installJavaBtn.textContent = window.t('Installing Java…');
  javaStatusText.textContent = window.t('Finding the right Java build…');
  const res = await window.vp.java.install(wizardState.version);
  installJavaBtn.disabled = false;
  recheckJavaBtn.disabled = false;
  installJavaBtn.textContent = window.t('Install Java for me');
  if (!res || !res.ok) {
    javaStatusText.textContent = window.t("Couldn't install Java: {why}. Check your connection and try again.", { why: (res && res.error) || window.t('unknown error') });
    return;
  }
  await runJavaCheck();
});

window.vp.on('java:progress', (p) => {
  if (!p) return;
  if (p.stage === 'resolve') javaStatusText.textContent = window.t('Finding the right Java build…');
  else if (p.stage === 'download') {
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    javaStatusText.textContent = p.total
      ? window.t('Downloading Java… {done} / {total} MB ({pct}%)', { done: mb(p.received), total: mb(p.total), pct: Math.floor((p.received / p.total) * 100) })
      : window.t('Downloading Java… {done} MB', { done: mb(p.received) });
  } else if (p.stage === 'extract') javaStatusText.textContent = window.t('Unpacking Java…');
  else if (p.stage === 'done') javaStatusText.textContent = window.t('Java installed — checking…');
});
recheckJavaBtn.addEventListener('click', runJavaCheck);

function updateInstallEnabled() {
  installBtn.disabled = !(javaSatisfied && eulaCheck.checked);
}
eulaCheck.addEventListener('change', updateInstallEnabled);

installBtn.addEventListener('click', async () => {
  showScreen('screen-install');
  installFill.style.width = '0%';
  installText.textContent = window.t('Preparing…');

  let result;
  try {
    result = await window.vp.server.install({
      name: wizardState.name,
      type: wizardState.type,
      version: wizardState.version,
      port: Number(serverPort.value) || 25565,
      minRamMb: wizardState.ramMb,
      maxRamMb: wizardState.ramMb,
      serverDir: wizardState.serverDir,
      templateId: wizardState.templateId || undefined,
    });
  } catch (err) {
    installText.textContent = window.t('Install failed: {why}', { why: err && err.message ? err.message : err });
    return;
  }

  await window.refreshLibrary();
  await window.openManagementScreen(result.profile.id);
  showScreen('screen-console');
  if (result.warning && window.consoleLogLine) window.consoleLogLine(result.warning);
  const startRes = await window.vp.server.start(result.profile.id);
  if (startRes && startRes.cancelled) return; // shouldn't happen for a brand-new profile, but handled anyway
});

window.vp.on('install:progress', (p) => {
  if (p.phase === 'resolving') {
    installText.textContent = window.t('Finding download…');
  } else if (p.phase === 'downloading') {
    const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
    installFill.style.width = pct + '%';
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    installText.textContent = p.total
      ? window.t('Downloading… {pct}% ({done} / {total} MB)', { pct, done: mb(p.received), total: mb(p.total) })
      : window.t('Downloading…');
  } else if (p.phase === 'bedrock') {
    installFill.style.width = '100%';
    installText.textContent = window.t('Adding Bedrock support (Geyser + Floodgate)…');
  } else if (p.phase === 'done') {
    installFill.style.width = '100%';
    installText.textContent = window.t('Starting server…');
  }
});

loadTypes();
loadTemplates();

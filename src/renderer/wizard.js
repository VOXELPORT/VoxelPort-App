'use strict';

// Shared state for the install wizard.
const wizardState = { name: null, type: null, version: null, ramMb: null, serverDir: null };

const serverNameInput = $('serverName');
const typeGrid = $('typeGrid');
const versionSelect = $('versionSelect');
const typeNextBtn = $('typeNextBtn');

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

// ─── Step 1: server type + version ──────────────────────────────────────
async function loadTypes() {
  const types = await window.vp.server.types();
  typeGrid.innerHTML = '';
  for (const t of types) {
    const btn = document.createElement('button');
    btn.className = 'mode-card small';
    btn.dataset.type = t.id;
    btn.innerHTML = `<div class="mode-title">${t.label}</div>`;
    btn.addEventListener('click', () => selectType(t.id, btn));
    typeGrid.appendChild(btn);
  }
}

async function selectType(type, btn) {
  typeGrid.querySelectorAll('.mode-card').forEach((el) => el.classList.remove('selected'));
  btn.classList.add('selected');
  wizardState.type = type;

  versionSelect.innerHTML = '<option>Loading…</option>';
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
  wizardState.name = serverNameInput.value.trim();
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
  ramHint.textContent = `Recommended ${recommendedRamMb} MB for a system with ${(totalMemMb / 1024).toFixed(1)} GB RAM.`;
}

ramSlider.addEventListener('input', () => {
  ramValueLabel.textContent = ramSlider.value;
  wizardState.ramMb = Number(ramSlider.value);
});

async function runJavaCheck() {
  javaStatusText.textContent = 'Checking for Java…';
  installJavaBtn.classList.add('hidden');
  recheckJavaBtn.classList.add('hidden');

  const result = await window.vp.java.check(wizardState.version);
  javaSatisfied = result.satisfied;

  if (result.satisfied) {
    javaStatusText.textContent = result.managed
      ? `Java ${result.major} (installed by VoxelPort) — ready.`
      : `Java ${result.major} detected — ready.`;
  } else if (result.found) {
    javaStatusText.textContent = `Found Java ${result.major ?? '?'}, but this version needs Java ${result.required}+.`;
    installJavaBtn.classList.remove('hidden');
  } else {
    javaStatusText.textContent = `Java not found. This version needs Java ${result.required}+.`;
    installJavaBtn.classList.remove('hidden');
  }
  recheckJavaBtn.classList.remove('hidden');
  updateInstallEnabled();
}

// Downloads Eclipse Temurin into VoxelPort's own folder — no admin, no website.
installJavaBtn.addEventListener('click', async () => {
  installJavaBtn.disabled = true;
  recheckJavaBtn.disabled = true;
  installJavaBtn.textContent = 'Installing Java…';
  javaStatusText.textContent = 'Finding the right Java build…';
  const res = await window.vp.java.install(wizardState.version);
  installJavaBtn.disabled = false;
  recheckJavaBtn.disabled = false;
  installJavaBtn.textContent = 'Install Java for me';
  if (!res || !res.ok) {
    javaStatusText.textContent = `Couldn't install Java: ${(res && res.error) || 'unknown error'}. Check your connection and try again.`;
    return;
  }
  await runJavaCheck();
});

window.vp.on('java:progress', (p) => {
  if (!p) return;
  if (p.stage === 'resolve') javaStatusText.textContent = 'Finding the right Java build…';
  else if (p.stage === 'download') {
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    javaStatusText.textContent = p.total
      ? `Downloading Java… ${mb(p.received)} / ${mb(p.total)} MB (${Math.floor((p.received / p.total) * 100)}%)`
      : `Downloading Java… ${mb(p.received)} MB`;
  } else if (p.stage === 'extract') javaStatusText.textContent = 'Unpacking Java…';
  else if (p.stage === 'done') javaStatusText.textContent = 'Java installed — checking…';
});
recheckJavaBtn.addEventListener('click', runJavaCheck);

function updateInstallEnabled() {
  installBtn.disabled = !(javaSatisfied && eulaCheck.checked);
}
eulaCheck.addEventListener('change', updateInstallEnabled);

installBtn.addEventListener('click', async () => {
  showScreen('screen-install');
  installFill.style.width = '0%';
  installText.textContent = 'Preparing…';

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
    });
  } catch (err) {
    installText.textContent = 'Install failed: ' + (err && err.message ? err.message : err);
    return;
  }

  await window.refreshLibrary();
  window.openManagementScreen(result.profile.id);
  showScreen('screen-console');
  const startRes = await window.vp.server.start(result.profile.id);
  if (startRes && startRes.cancelled) return; // shouldn't happen for a brand-new profile, but handled anyway
});

window.vp.on('install:progress', (p) => {
  if (p.phase === 'resolving') {
    installText.textContent = 'Finding download…';
  } else if (p.phase === 'downloading') {
    const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
    installFill.style.width = pct + '%';
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    installText.textContent = p.total
      ? `Downloading… ${pct}% (${mb(p.received)} / ${mb(p.total)} MB)`
      : 'Downloading…';
  } else if (p.phase === 'done') {
    installFill.style.width = '100%';
    installText.textContent = 'Starting server…';
  }
});

loadTypes();

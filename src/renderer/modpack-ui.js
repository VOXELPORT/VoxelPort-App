'use strict';

// Import a Modrinth .mrpack: choose the file, show what will and won't be installed, then build a Fabric server.

(() => {
  const chooseBtn = $('modpackChooseBtn');
  const errorEl = $('modpackError');
  const planBox = $('modpackPlan');
  const nameInput = $('modpackName');
  const summary = $('modpackSummary');
  const skippedBox = $('modpackSkippedBox');
  const skippedSummary = $('modpackSkippedSummary');
  const skippedList = $('modpackSkippedList');
  const portInput = $('modpackPort');
  const ramSlider = $('modpackRamSlider');
  const ramLabel = $('modpackRamValueLabel');
  const installBtn = $('modpackInstallBtn');
  const progress = $('modpackProgress');
  const progressText = $('modpackProgressText');

  let chosen = null; // { file, name, minecraft, quilt, install, skipped }

  ramSlider.addEventListener('input', () => { ramLabel.textContent = ramSlider.value; });

  // A friendly phrase for why a mod was left off the server.
  const reasonText = (reason) => ({
    'client-only': t('client-side only'),
    'not for servers': t('not made for servers'),
    'not on Modrinth': t('not available from Modrinth'),
    'no checksum': t('no checksum to verify it'),
  }[reason] || reason);

  function resetToChoose() {
    chosen = null;
    planBox.classList.add('hidden');
    progress.classList.add('hidden');
    chooseBtn.classList.remove('hidden');
    chooseBtn.disabled = false;
  }

  function showPlan() {
    nameInput.value = chosen.name || '';
    nameInput.placeholder = chosen.name || t('My modpack server');
    const loader = chosen.quilt ? 'Quilt → Fabric' : 'Fabric';
    summary.textContent = t('{count} server mods will be installed. Minecraft {mc}, {loader}.',
      { count: chosen.install, mc: chosen.minecraft, loader });
    if (chosen.skipped && chosen.skipped.length) {
      skippedBox.classList.remove('hidden');
      skippedSummary.textContent = t('{n} items skipped (they only work on each player’s own game) — show', { n: chosen.skipped.length });
      skippedList.innerHTML = '';
      for (const s of chosen.skipped.slice(0, 200)) {
        const li = document.createElement('li');
        li.textContent = `${s.name} — ${reasonText(s.reason)}`;
        skippedList.appendChild(li);
      }
    } else {
      skippedBox.classList.add('hidden');
    }
    chooseBtn.classList.add('hidden');
    planBox.classList.remove('hidden');
    progress.classList.add('hidden');
  }

  chooseBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    chooseBtn.disabled = true;
    try {
      const r = await window.vp.modpack.choose();
      if (!r) { chooseBtn.disabled = false; return; } // cancelled
      if (!r.ok) {
        errorEl.textContent = r.error || t('That modpack could not be read.');
        chooseBtn.disabled = false;
        return;
      }
      if (r.install === 0) {
        errorEl.textContent = t('This modpack has no mods that run on a server. There is nothing to install.');
        chooseBtn.disabled = false;
        return;
      }
      chosen = r;
      showPlan();
    } catch (err) {
      errorEl.textContent = (err && err.message) || String(err);
      chooseBtn.disabled = false;
    }
  });

  window.vp.on('install:progress', (p) => {
    if (progress.classList.contains('hidden')) return; // only while a modpack install is running
    if (p.phase === 'resolving') progressText.textContent = t('Getting the Fabric server…');
    else if (p.phase === 'downloading') progressText.textContent = t('Downloading the Fabric server…');
    else if (p.phase === 'mods') progressText.textContent = p.total ? t('Installing mods… {i} of {n}', { i: p.index || 0, n: p.total }) : t('Installing mods…');
    else if (p.phase === 'done') progressText.textContent = t('Done!');
  });

  installBtn.addEventListener('click', async () => {
    if (!chosen) return;
    installBtn.disabled = true;
    planBox.classList.add('hidden');
    progress.classList.remove('hidden');
    progressText.textContent = t('Starting…');
    try {
      const result = await window.vp.modpack.install({
        file: chosen.file,
        name: nameInput.value.trim(),
        port: Number(portInput.value) || 25565,
        minRamMb: Number(ramSlider.value),
        maxRamMb: Number(ramSlider.value),
      });
      if (!result || !result.ok) throw new Error((result && result.error) || t('Import failed.'));
      await window.refreshLibrary();
      window.openManagementScreen(result.profile.id);
      showScreen('screen-console');
      resetToChoose();
      errorEl.textContent = '';
    } catch (err) {
      progress.classList.add('hidden');
      planBox.classList.remove('hidden');
      errorEl.textContent = t('Could not import: {why}', { why: (err && err.message) || err });
    } finally {
      installBtn.disabled = false;
    }
  });

  $('importModpackBtn').addEventListener('click', () => { resetToChoose(); errorEl.textContent = ''; showScreen('screen-modpack'); });
})();

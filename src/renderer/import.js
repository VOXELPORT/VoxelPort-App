'use strict';

const importDirDisplay = $('importDirDisplay');
const importChooseFolderBtn = $('importChooseFolderBtn');
const importDetectText = $('importDetectText');
const importName = $('importName');
const importType = $('importType');
const importPort = $('importPort');
const importRamSlider = $('importRamSlider');
const importRamValueLabel = $('importRamValueLabel');
const importConfirmBtn = $('importConfirmBtn');

let importDir = null;

importRamSlider.addEventListener('input', () => { importRamValueLabel.textContent = importRamSlider.value; });

function updateImportEnabled() {
  importConfirmBtn.disabled = !(importDir && importName.value.trim());
}
importName.addEventListener('input', updateImportEnabled);

importChooseFolderBtn.addEventListener('click', async () => {
  const dir = await window.vp.server.chooseFolder();
  if (!dir) return;
  importDir = dir;
  importDirDisplay.value = dir;

  const info = await window.vp.server.detectExisting(dir);
  if (!info.looksLikeServer) {
    importDetectText.textContent = 'This folder doesn\'t look like an existing Minecraft server yet — you can still add it, VoxelPort just won\'t detect any settings.';
  } else {
    const found = [];
    if (info.hasServerJar) found.push('server.jar');
    if (info.hasProperties) found.push('server.properties');
    if (info.hasWorld) found.push('world/');
    if (info.hasMods) found.push('mods/');
    if (info.hasPlugins) found.push('plugins/');
    importDetectText.textContent = `Found: ${found.join(', ')}. Nothing here will be overwritten.`;
  }
  if (info.guessedType) importType.value = info.guessedType;
  if (info.guessedPort) importPort.value = info.guessedPort;
  updateImportEnabled();
});

importConfirmBtn.addEventListener('click', async () => {
  importConfirmBtn.disabled = true;
  try {
    const result = await window.vp.server.import({
      name: importName.value.trim(),
      type: importType.value,
      port: Number(importPort.value) || 25565,
      minRamMb: Number(importRamSlider.value),
      maxRamMb: Number(importRamSlider.value),
      serverDir: importDir,
    });
    if (!result || !result.ok) throw new Error((result && result.error) || 'Import failed.');
    await window.refreshLibrary();
    window.openManagementScreen(result.profile.id);
    showScreen('screen-console');
    // reset for next time
    importDir = null;
    importDirDisplay.value = '';
    importName.value = '';
    importDetectText.textContent = '';
  } catch (err) {
    importDetectText.textContent = 'Could not import: ' + (err && err.message ? err.message : err);
  } finally {
    importConfirmBtn.disabled = false;
  }
});

'use strict';

// App settings: the language, and which versions of VoxelPort and Java are in use.

const appLangSelect = $('appLangSelect');
const aboutCopyBtn = $('aboutCopyBtn');
let aboutText = '';

for (const [code, name] of Object.entries(VPI18N.LANGUAGES)) {
  const option = document.createElement('option');
  option.value = code;
  option.textContent = name;
  appLangSelect.appendChild(option);
}
appLangSelect.value = VPI18N.lang;
appLangSelect.addEventListener('change', () => VPI18N.setLanguage(appLangSelect.value));

const javaList = (majors) => majors.map((m) => 'Java ' + m).join(', ');

async function loadVersions() {
  let v;
  try { v = await window.vp.versions(); } catch { v = null; }
  if (!v) return;
  const systemJava = v.systemJava ? 'Java ' + v.systemJava : t('Not found');
  const managedJava = v.managedJava.length ? javaList(v.managedJava) : t('None yet');
  $('aboutApp').textContent = 'v' + v.app;
  $('aboutSystemJava').textContent = systemJava;
  $('aboutManagedJava').textContent = managedJava;
  $('aboutPlatform').textContent = v.platform;
  aboutText = [
    'VoxelPort v' + v.app,
    'Java on this PC: ' + (v.systemJava ? 'Java ' + v.systemJava : 'not found'),
    'Java installed by VoxelPort: ' + (v.managedJava.length ? javaList(v.managedJava) : 'none'),
    'System: ' + v.platform + ' (Electron ' + v.electron + ')',
  ].join('\n');
}

aboutCopyBtn.addEventListener('click', async () => {
  if (!aboutText) return;
  try {
    await navigator.clipboard.writeText(aboutText);
    aboutCopyBtn.textContent = t('Copied!');
  } catch {
    aboutCopyBtn.textContent = t('Could not copy');
  }
  setTimeout(() => { aboutCopyBtn.textContent = t('Copy version details'); }, 1500);
});

$('appSettingsLink').addEventListener('click', (e) => {
  e.preventDefault();
  loadVersions();
  showScreen('screen-app-settings');
});

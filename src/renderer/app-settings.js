'use strict';

// App settings: the language, and which versions of VoxelPort and Java are in use.

const appLangSelect = $('appLangSelect');
const aboutCopyBtn = $('aboutCopyBtn');
let aboutText = '';
let aboutVersion = '';

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
  aboutVersion = v.app;
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

// "Check for updates": says what the check found. The Store build is updated by the Store, and Linux has no automatic updates.
const updateCheckBtn = $('updateCheckBtn');
const updateCheckStatus = $('updateCheckStatus');
function updateCheckText(res) {
  if (res.status === 'up-to-date') return t("You're up to date (v{version}).", { version: aboutVersion });
  if (res.status === 'available') return t('VoxelPort v{version} is downloading. You will be told when it is ready to install.', { version: res.version });
  if (res.status === 'downloaded') return t('VoxelPort v{version} is ready to install.', { version: res.version });
  if (res.status === 'unsupported') {
    return res.reason === 'store' ? t('Updates come from the Microsoft Store.') : t("Updates aren't automatic on this system. Get the newest version from voxelport.in/download.");
  }
  return t("Couldn't check for updates. Check your connection and try again.");
}
updateCheckBtn.addEventListener('click', async () => {
  updateCheckBtn.disabled = true;
  updateCheckStatus.textContent = t('Checking…');
  let res;
  try { res = await window.vp.update.check(); } catch { res = { status: 'error' }; }
  updateCheckStatus.textContent = updateCheckText(res);
  updateCheckBtn.disabled = false;
});

$('appSettingsLink').addEventListener('click', (e) => {
  e.preventDefault();
  loadVersions();
  showScreen('screen-app-settings');
});

'use strict';

// The Files screen: browse the server folder and edit its plain-text settings files.
// Every path is checked in the main process (serverFiles.js); this only shows it. File names and contents are put in the page as text only.

(function () {
  const flSubtitle = $('flSubtitle');
  const flRunningNote = $('flRunningNote');
  const flBrowser = $('flBrowser');
  const flCrumbs = $('flCrumbs');
  const flList = $('flList');
  const flEditor = $('flEditor');
  const flFileName = $('flFileName');
  const flText = $('flText');
  const flSaveBtn = $('flSaveBtn');
  const flCloseBtn = $('flCloseBtn');
  const flStatus = $('flStatus');

  let profileId = null;
  let folder = ''; // relative to the server folder, '' = the top
  let openFile = null; // relative path of the file in the editor
  let savedText = '';

  function showStatus(text, isError) {
    flStatus.textContent = text || '';
    flStatus.style.color = isError ? 'var(--red)' : '';
  }

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return t('{n} MB', { n: (bytes / 1024 / 1024).toFixed(1) });
    if (bytes >= 1024) return t('{n} KB', { n: Math.round(bytes / 1024) });
    return t('{n} B', { n: bytes });
  }

  const join = (dir, name) => (dir ? `${dir}/${name}` : name);

  function isDirty() {
    return openFile !== null && flText.value !== savedText;
  }

  /** True when it is fine to leave the file in the editor (nothing unsaved, or the user agrees to lose it). */
  function canLeaveFile() {
    return !isDirty() || window.confirm(t('You have unsaved changes in this file. Leave without saving?'));
  }

  function renderCrumbs() {
    flCrumbs.innerHTML = '';
    const parts = folder ? folder.split('/') : [];
    const add = (label, target, last) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.disabled = last;
      if (!last) btn.addEventListener('click', () => { if (canLeaveFile()) { closeEditor(); loadFolder(target); } });
      flCrumbs.appendChild(btn);
    };
    add(t('Server folder'), '', parts.length === 0);
    parts.forEach((part, i) => {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      flCrumbs.appendChild(sep);
      add(part, parts.slice(0, i + 1).join('/'), i === parts.length - 1);
    });
  }

  function renderList(entries) {
    flList.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = t('This folder is empty.');
      flList.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'bk-item file-item';
      const main = document.createElement('div');
      main.className = 'bk-item-main';
      const name = document.createElement('strong');
      name.textContent = entry.dir ? `${entry.name}/` : entry.name;
      main.appendChild(name);
      row.appendChild(main);
      if (!entry.dir) {
        const size = document.createElement('span');
        size.className = 'file-size';
        size.textContent = formatSize(entry.size);
        row.appendChild(size);
      }
      if (entry.dir || entry.editable) {
        row.classList.add('openable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        const go = () => {
          if (!canLeaveFile()) return;
          if (entry.dir) { closeEditor(); loadFolder(join(folder, entry.name)); } else openInEditor(join(folder, entry.name));
        };
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      }
      flList.appendChild(row);
    }
  }

  async function loadFolder(rel) {
    showStatus('');
    const res = await window.vp.files.list(profileId, rel);
    if (!res || !res.ok) { showStatus(t((res && res.error) || 'Could not read that folder.'), true); return; }
    folder = res.path;
    renderCrumbs();
    renderList(res.entries);
  }

  function closeEditor() {
    openFile = null;
    savedText = '';
    flText.value = '';
    flEditor.classList.add('hidden');
  }

  async function openInEditor(rel) {
    showStatus('');
    const res = await window.vp.files.read(profileId, rel);
    if (!res || !res.ok) { showStatus(t((res && res.error) || 'Could not open that file.'), true); return; }
    openFile = rel;
    savedText = res.text;
    flFileName.textContent = rel;
    flText.value = res.text;
    flEditor.classList.remove('hidden');
    flText.focus();
  }

  flSaveBtn.addEventListener('click', async () => {
    if (openFile === null) return;
    flSaveBtn.disabled = true;
    const res = await window.vp.files.write(profileId, openFile, flText.value);
    flSaveBtn.disabled = false;
    if (!res || !res.ok) { showStatus(t((res && res.error) || 'Could not save that file.'), true); return; }
    savedText = flText.value;
    showStatus(t('Saved!'));
  });

  flCloseBtn.addEventListener('click', () => { if (canLeaveFile()) { closeEditor(); showStatus(''); } });

  // Ctrl+S / Cmd+S saves while the editor has focus.
  flText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flSaveBtn.click(); }
  });

  $('filesBackBtn').addEventListener('click', () => {
    if (!canLeaveFile()) return;
    closeEditor();
    showScreen('screen-console');
  });

  window.openFilesScreen = async function openFilesScreen(id) {
    profileId = id;
    closeEditor();
    folder = '';
    const profile = await window.vp.server.get(id);
    flSubtitle.textContent = profile ? profile.name : t('Server files');
    const running = window.appState && window.appState.activeServerProfileId === id;
    flRunningNote.classList.toggle('hidden', !running);
    flBrowser.classList.remove('hidden');
    await loadFolder('');
    showScreen('screen-files');
  };
})();

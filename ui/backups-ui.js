'use strict';

// The Backups screen: back up now, the list (restore / delete), and the automatic-backup settings.
// The work happens in the main process (backupService.js); this only shows it.

(function () {
  const bkSubtitle = $('bkSubtitle');
  const bkNowBtn = $('bkNowBtn');
  const bkFolderBtn = $('bkFolderBtn');
  const bkProgress = $('bkProgress');
  const bkFill = $('bkFill');
  const bkStatus = $('bkStatus');
  const bkAuto = $('bkAuto');
  const bkInterval = $('bkInterval');
  const bkKeep = $('bkKeep');
  const bkList = $('bkList');
  const bkRunningNote = $('bkRunningNote');

  const INTERVALS = [10, 15, 30, 60, 120, 240];
  const KEEPS = [3, 5, 10, 20];

  let profileId = null;
  let info = null;
  let working = false; // a backup or restore is running (here or started elsewhere)

  const REASON_LABEL = () => ({
    auto: t('Automatic'),
    manual: t('Manual'),
    stop: t('When stopped'),
    'before-restore': t('Before a restore'),
  });

  function formatSize(bytes) {
    if (bytes >= 1024 ** 3) return t('{n} GB', { n: (bytes / 1024 ** 3).toFixed(1) });
    return t('{n} MB', { n: Math.max(1, Math.round(bytes / 1024 ** 2)) });
  }

  function fillSelect(select, values, current, label) {
    select.innerHTML = '';
    const all = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
    for (const v of all) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = label(v);
      select.appendChild(o);
    }
    select.value = String(current);
  }

  function minutesLabel(m) {
    if (m % 60 === 0) return m === 60 ? t('1 hour') : t('{n} hours', { n: m / 60 });
    return t('{n} minutes', { n: m });
  }

  function showStatus(text, isError) {
    bkStatus.textContent = text || '';
    bkStatus.style.color = isError ? 'var(--red)' : '';
  }

  function setWorking(on) {
    working = on;
    bkProgress.classList.toggle('hidden', !on);
    if (!on) bkFill.style.width = '0%';
    render();
  }

  function render() {
    if (!info) return;
    bkAuto.checked = info.settings.auto;
    fillSelect(bkInterval, INTERVALS, info.settings.intervalMin, minutesLabel);
    fillSelect(bkKeep, KEEPS, info.settings.keep, (n) => String(n));

    bkNowBtn.disabled = working || !info.hasWorld;
    bkRunningNote.classList.toggle('hidden', !info.running);

    bkList.innerHTML = '';
    if (!info.backups.length) {
      const empty = document.createElement('div');
      empty.className = 'bk-empty';
      empty.textContent = info.hasWorld
        ? t('No backups yet. Press "Back up now", or leave the server running and one is made for you.')
        : t('There is no world to back up yet. Start the server once so it creates one.');
      bkList.appendChild(empty);
      return;
    }
    const labels = REASON_LABEL();
    for (const b of info.backups) {
      const item = document.createElement('div');
      item.className = 'bk-item';

      const main = document.createElement('div');
      main.className = 'bk-item-main';
      const when = document.createElement('div');
      when.className = 'bk-when';
      when.textContent = new Date(b.createdAt).toLocaleString();
      const meta = document.createElement('div');
      meta.className = 'bk-meta';
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = labels[b.reason] || b.reason;
      const size = document.createElement('span');
      size.textContent = formatSize(b.size);
      meta.append(pill, size);
      main.append(when, meta);

      const actions = document.createElement('div');
      actions.className = 'bk-item-actions';
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'ghost small';
      restore.textContent = t('Restore');
      restore.disabled = working || info.running;
      restore.addEventListener('click', () => restoreBackup(b.name));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost small';
      del.textContent = t('Delete');
      del.disabled = working;
      del.addEventListener('click', () => deleteBackup(b.name));
      actions.append(restore, del);

      item.append(main, actions);
      bkList.appendChild(item);
    }
  }

  async function refresh() {
    if (!profileId) return;
    try { info = await window.vp.backups.info(profileId); } catch { return; }
    working = info.busy;
    bkProgress.classList.toggle('hidden', !working);
    render();
  }

  window.openBackupsScreen = async function openBackupsScreen(id) {
    profileId = id;
    showStatus('');
    const profile = await window.vp.server.get(id);
    bkSubtitle.textContent = profile ? profile.name : t('Server backups');
    await refresh();
    showScreen('screen-backups');
  };

  $('backupsBackBtn').addEventListener('click', () => showScreen('screen-console'));
  bkFolderBtn.addEventListener('click', () => { if (profileId) window.vp.backups.openFolder(profileId); });

  bkNowBtn.addEventListener('click', async () => {
    showStatus('');
    setWorking(true);
    const res = await window.vp.backups.create(profileId);
    setWorking(false);
    if (!res || !res.ok) showStatus(t((res && res.error) || 'The backup failed.'), true);
    await refresh();
  });

  async function restoreBackup(name) {
    showStatus('');
    setWorking(true);
    const res = await window.vp.backups.restore(profileId, name);
    setWorking(false);
    if (res && res.cancelled) { await refresh(); return; }
    if (!res || !res.ok) showStatus(t((res && res.error) || 'The restore failed.'), true);
    else showStatus(t('Restored. You can start the server now. The world from before is saved as a "Before a restore" backup, in case you want it back.'));
    await refresh();
  }

  async function deleteBackup(name) {
    if (!window.confirm(t('Delete this backup? It cannot be undone.'))) return;
    try { await window.vp.backups.remove(profileId, name); } catch (err) { showStatus(String(err && err.message ? err.message : err), true); }
    await refresh();
  }

  async function saveSettings() {
    try {
      await window.vp.backups.setSettings(profileId, {
        auto: bkAuto.checked,
        intervalMin: Number(bkInterval.value),
        keep: Number(bkKeep.value),
      });
    } catch (err) {
      showStatus(String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    }
    await refresh();
  }
  bkAuto.addEventListener('change', saveSettings);
  bkInterval.addEventListener('change', saveSettings);
  bkKeep.addEventListener('change', saveSettings);

  // What the main process is doing right now.
  window.vp.on('backup:progress', (p) => {
    if (!p || p.profileId !== profileId) return;
    if (p.phase === 'done' || p.phase === 'failed') {
      if (p.phase === 'failed' && p.reason !== 'manual' && p.reason !== 'restore') showStatus(t('An automatic backup failed: {why}', { why: t(p.error || '') }), true);
      refresh();
      return;
    }
    working = true;
    bkProgress.classList.remove('hidden');
    let pct = null;
    let text = t('Getting ready…');
    if (p.phase === 'zipping') { pct = p.total ? Math.round((p.done / p.total) * 100) : 0; text = t('Backing up… {pct}%', { pct }); }
    else if (p.phase === 'checking') text = t('Checking the backup…');
    else if (p.phase === 'saving-current') text = t('Saving your current world first…');
    else if (p.phase === 'unpacking') { pct = p.total ? Math.round((p.done / p.total) * 100) : 0; text = t('Restoring… {pct}%', { pct }); }
    else if (p.phase === 'swapping') text = t('Putting the world back…');
    if (pct !== null) bkFill.style.width = `${pct}%`;
    showStatus(text);
    render();
  });

  window.onAppState.push(() => { if ($('screen-backups').classList.contains('active')) refresh(); });
})();

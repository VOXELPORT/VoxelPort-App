'use strict';

// The banner that offers to bring the previous (Electron) VoxelPort's data over: the VoxelPort ID (so the address, custom name and supporter perks
// carry over), the server list, its backups and the settings. It only counts what is there until the person presses the button, and says in plain
// words what will and will not happen. The work is done by the app (src-tauri/src/legacyimport.rs); this file is only the words and the buttons.
(function (root) {
  const byId = (id) => document.getElementById(id);
  const say = (text, vars) => (typeof root.t === 'function' ? root.t(text, vars) : text);
  const plural = (n, one, many) => (n === 1 ? one : many);

  let found = null;

  function what(s) {
    const parts = [];
    if (s.identity === 'new') parts.push(say('your VoxelPort ID ({id}), which keeps your address and supporter perks', { id: s.vpId }));
    if (s.newServers) parts.push(`${s.newServers} ${plural(s.newServers, say('server'), say('servers'))}`);
    if (s.backupFiles) parts.push(`${s.backupFiles} ${plural(s.backupFiles, say('backup'), say('backups'))} (${(s.backupBytes / (1024 * 1024)).toFixed(0)} MB)`);
    return parts.join(', ');
  }

  function show(s) {
    found = s;
    byId('legacyBannerText').textContent = say('The previous VoxelPort app was found on this PC. Bring over {things}?', { things: what(s) || say('your settings') });
    for (const id of ['legacyBringBtn', 'legacyLaterBtn', 'legacyNeverBtn']) byId(id).classList.remove('hidden');
    byId('legacyCloseBtn').classList.add('hidden');
    byId('legacyBanner').classList.remove('hidden');
  }

  function finish(text) {
    byId('legacyBannerText').textContent = text;
    for (const id of ['legacyBringBtn', 'legacyLaterBtn', 'legacyNeverBtn']) byId(id).classList.add('hidden');
    byId('legacyCloseBtn').classList.remove('hidden');
  }

  /** What was done, in words: counts, and what the person still has to do if part of it could not come. */
  function report(r) {
    const f = r.files || {};
    const done = [];
    if (r.identity === 'imported') done.push(say('your VoxelPort ID ({id})', { id: r.vpId }));
    if (r.identity === 'already') done.push(say('your VoxelPort ID was already this one'));
    if (f.serversAdded) done.push(`${f.serversAdded} ${plural(f.serversAdded, say('server'), say('servers'))}`);
    const backups = (f.backupsLinked || 0) + (f.backupsCopied || 0);
    if (backups) done.push(`${backups} ${plural(backups, say('backup'), say('backups'))}`);
    if (f.preferences) done.push(say('your settings'));
    const lines = [done.length ? say('Brought over: {things}.', { things: done.join(', ') }) : say('There was nothing new to bring over.')];
    if (r.identity === 'unreadable') lines.push(say("The old app's VoxelPort ID could not be opened on this PC (it is protected for the Windows account it was made under). Restore it from your Discord backup in Settings instead."));
    if (r.identity === 'missing') lines.push(say('The old app had no VoxelPort ID to bring over.'));
    if (f.serversFolderMissing) lines.push(say("{n} server(s) were left out because their folders are gone.", { n: f.serversFolderMissing }));
    if (f.serversInsideOldFolder) lines.push(say("{n} of the servers live inside the old app's own folder: keep that folder (do not remove the old app's data) or move them.", { n: f.serversInsideOldFolder }));
    return lines.join(' ');
  }

  async function bring() {
    const s = found || {};
    const lines = [
      say('Bring your data over from the previous VoxelPort?'),
      '',
      say("This copies {things} into this app. The old app's files are not changed or removed.", { things: what(s) || say('your settings') }),
      say('Servers stay in their own folders (they are listed here, not copied), so do not run the same server in both apps at once.'),
    ];
    if (s.insideOldFolder) lines.push(say("{n} of them are stored inside the old app's own folder: keep that folder.", { n: s.insideOldFolder }));
    if (s.identity === 'new') lines.push(say("This PC's VoxelPort ID is replaced by the old app's (the one it has now is kept in a backup file beside it)."));
    lines.push(say('A public address must not be running.'));
    if (!root.confirm(lines.join('\n'))) return;
    byId('legacyBringBtn').disabled = true;
    try {
      const r = await root.vp.legacyImport.run();
      if (!r || !r.ok) {
        finish((r && r.error) || say('Could not bring your data over.'));
        return;
      }
      finish(report(r));
      if (typeof root.refreshLibrary === 'function') root.refreshLibrary();
    } catch (err) {
      finish(String(err && err.message ? err.message : err));
    } finally {
      byId('legacyBringBtn').disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    byId('legacyBringBtn').addEventListener('click', bring);
    byId('legacyLaterBtn').addEventListener('click', () => byId('legacyBanner').classList.add('hidden'));
    byId('legacyCloseBtn').addEventListener('click', () => byId('legacyBanner').classList.add('hidden'));
    byId('legacyNeverBtn').addEventListener('click', async () => {
      byId('legacyBanner').classList.add('hidden');
      try { await root.vp.legacyImport.dismiss(); } catch { /* it will simply ask again next time */ }
    });
    // Counting what is there changes nothing (the app opens the old ID in memory only to show its short form).
    // When the previous app's "update" button started this app, the data is already being brought over: say so, wait for it, then say what came.
    // (The switch can also arrive while the window is already open: keep an eye out for a while after the first look.)
    let looks = 0;
    const look = (first) => root.vp.legacyImport.detect().then((s) => {
      if (s && s.working) {
        finish(say('Bringing your data over from the previous VoxelPort…'));
        byId('legacyCloseBtn').classList.add('hidden');
        byId('legacyBanner').classList.remove('hidden');
        setTimeout(look, 1000);
        return;
      }
      if (s && s.announce) {
        finish(report(s.announce));
        byId('legacyBanner').classList.remove('hidden');
        if (typeof root.refreshLibrary === 'function') root.refreshLibrary();
        return;
      }
      if (first && s && s.available) show(s);
      if (++looks < 40) setTimeout(look, 3000); // about two minutes of watching, then it stops
    }).catch(() => {});
    look(true);
  });

  root.VPLegacyImport = { what, report };
})(window);

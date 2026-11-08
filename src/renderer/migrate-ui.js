'use strict';

// "VoxelPort has moved": the banner and the screen that explain the new app and move everything over with one button.
// The work (download, signature check, install, bringing the data across, removing this app) is done by the main process
// (migrateToTauri.js); this file is only the words, the progress bar and the buttons. It shows nothing at all until the new
// app is really published, so an update of this app never promises something that cannot be delivered yet.
(function () {
  const $ = (id) => document.getElementById(id);
  const banner = $('moveBanner');
  const SEEN_KEY = 'vp.moveSeen';
  let info = null;
  let working = false;

  const seen = () => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } };
  const markSeen = (version) => { try { localStorage.setItem(SEEN_KEY, version); } catch { /* it will simply be offered again */ } };
  const toggle = (id, visible) => $(id).classList.toggle('hidden', !visible);
  const say = (text) => { $('movedStatus').textContent = text; };

  // How far along each step is, as one bar: download is the long part.
  const WHERE = { checking: 3, verifying: 50, stopping: 55, installing: 65, importing: 80, removing: 95, done: 100 };

  function progress(event) {
    const bar = $('movedFill');
    if (event.phase === 'downloading') bar.style.width = `${5 + Math.round((event.percent || 0) * 0.43)}%`;
    else if (WHERE[event.phase] !== undefined) bar.style.width = `${WHERE[event.phase]}%`;
    switch (event.phase) {
      case 'checking': say(t('Looking for the new VoxelPort…')); break;
      case 'downloading': say(t('Downloading the new VoxelPort… {percent}%', { percent: event.percent || 0 })); break;
      case 'verifying': say(t('Checking that the download is genuine…')); break;
      case 'stopping': say(t('Stopping your server and public address…')); break;
      case 'installing': say(t('Installing the new VoxelPort…')); break;
      case 'importing': say(t('Bringing your data over…')); break;
      case 'removing': say(t('Removing this old app…')); break;
      case 'done': say(event.mode === 'portable'
        ? t('All done! The new VoxelPort is open. You can delete this portable file.')
        : t('All done! The new VoxelPort is open. This app will close in a moment.')); break;
      default: break;
    }
  }

  /** Why it stopped, in words the person can act on. */
  function reasonFor(result) {
    switch (result.step) {
      case 'manifest':
      case 'download': return t('Could not find or download the new VoxelPort.');
      case 'signature': return t('The download could not be verified, so it was not used.');
      case 'install': return result.blocked ? t('Windows blocked the installer. You can get it from our website instead.') : t('Windows would not install it.');
      case 'launch':
      case 'import':
      case 'timeout': return t('The new app did not finish bringing your data over.');
      default: return t('Something went wrong.');
    }
  }

  function fail(result) {
    say(result.installed
      ? t('The new VoxelPort is installed, but bringing your data over did not finish. {reason} Open the new VoxelPort and use the banner there. This app was not removed.', { reason: reasonFor(result) })
      : t('It did not work. {reason} Nothing was removed: this app and your data are untouched.', { reason: reasonFor(result) }));
    toggle('movedProgress', false);
    toggle('movedPageBtn', true);
    $('movedUpdateBtn').disabled = false;
  }

  async function update() {
    if (working) return;
    working = true;
    $('movedUpdateBtn').disabled = true;
    toggle('movedPageBtn', false);
    $('movedFill').style.width = '0%';
    toggle('movedProgress', true);
    say(t('Looking for the new VoxelPort…'));
    try {
      const result = await window.vp.migrate.start();
      if (result && result.cancelled) {
        toggle('movedProgress', false);
        say('');
        $('movedUpdateBtn').disabled = false;
      } else if (!result || !result.ok) {
        fail(result || {});
      }
      // On success the progress events already said "All done".
    } catch {
      fail({});
    } finally {
      working = false;
    }
  }

  function open({ byPerson = false } = {}) {
    window.showScreen('screen-moved');
    if (!info || !info.version) return;
    if (byPerson) { markSeen(info.version); return; }
    // Opened by itself: it only counts as seen if it is still up a moment later. The app can still be finding its feet as it starts (it goes to the
    // home screen, and the sign-in page can cover everything), and then the person has not really been shown it.
    setTimeout(() => {
      if ($('screen-moved').classList.contains('active') && !document.body.classList.contains('discord-locked')) markSeen(info.version);
    }, 1500);
  }

  async function refresh() {
    let found = null;
    try { found = await window.vp.migrate.info(); } catch { /* nothing to offer */ }
    if (!found || !found.available) return;
    info = found;
    banner.classList.remove('hidden');
    toggle('movedUpdateBtn', Boolean(found.canInstall));
    toggle('movedStoreNote', found.mode === 'store');
    toggle('movedPageBtn', found.mode === 'store');
    toggle('movedHow', Boolean(found.canInstall));
    maybeOpen();
  }

  // The first time, on the home screen, show it without being asked. Not while the sign-in page is up: when that goes away, it is shown then.
  function maybeOpen() {
    if (!info || seen() === info.version) return;
    const locked = document.body.classList.contains('discord-locked');
    if (!locked && $('screen-library').classList.contains('active')) open();
  }
  new MutationObserver(maybeOpen).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  $('moveBannerBtn').addEventListener('click', () => open({ byPerson: true }));
  $('movedBackBtn').addEventListener('click', () => window.showScreen('screen-library'));
  $('movedUpdateBtn').addEventListener('click', update);
  $('movedPageBtn').addEventListener('click', () => { window.vp.migrate.openPage(); });
  window.vp.on('migrate:progress', progress);
  refresh();
})();

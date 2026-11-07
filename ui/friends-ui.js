'use strict';

// Friends-only (whitelist): turn it on, add friends by username, remove them, and copy an invite.

(() => {
  const enabledBox = $('friendsEnabled');
  const stateText = $('friendsState');
  const crackedWarn = $('friendsCrackedWarn');
  const input = $('friendsInput');
  const addBtn = $('friendsAddBtn');
  const addMsg = $('friendsAddMsg');
  const listEl = $('friendsList');
  const emptyEl = $('friendsEmpty');

  let friendsProfileId = null;
  let friendsProfile = null;

  function render(status) {
    enabledBox.checked = Boolean(status.enabled);
    stateText.textContent = status.enabled
      ? t('On. Only the people below can join your server.')
      : t('Off. Anyone with the address can join. Turn it on to keep it to your friends.');
    crackedWarn.classList.toggle('hidden', !status.cracked);
    if (status.cracked) {
      crackedWarn.textContent = t('Your server is in cracked (offline) mode, so the whitelist matches the exact name a person types. Anyone using a name on the list gets in.');
    }
    const friends = Array.isArray(status.friends) ? status.friends : [];
    listEl.innerHTML = '';
    for (const name of friends) {
      const li = document.createElement('li');
      li.className = 'server-row';
      li.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
      const span = document.createElement('span');
      span.textContent = name;
      const rm = document.createElement('button');
      rm.className = 'link-btn';
      rm.textContent = t('Remove');
      rm.addEventListener('click', () => removeFriend(name));
      li.append(span, rm);
      listEl.appendChild(li);
    }
    emptyEl.classList.toggle('hidden', friends.length > 0);
  }

  async function refresh() {
    if (!friendsProfileId) return;
    const r = await window.vp.whitelist.status(friendsProfileId);
    if (r && r.ok) render(r);
  }

  async function removeFriend(name) {
    const r = await window.vp.whitelist.remove(friendsProfileId, name);
    if (r && r.ok) {
      addMsg.textContent = r.restartNeeded ? t('Removed. It applies next time you start the server.') : t('Removed.');
      await refresh();
    } else {
      addMsg.textContent = (r && r.error) || t('Could not remove that name.');
    }
  }

  addBtn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    addBtn.disabled = true;
    try {
      const r = await window.vp.whitelist.add(friendsProfileId, text);
      if (!r || !r.ok) { addMsg.textContent = (r && r.error) || t('Could not add those names.'); return; }
      input.value = '';
      const parts = [];
      if (r.added.length) parts.push(t('Added {names}.', { names: r.added.join(', ') }));
      if (r.already.length) parts.push(t('Already on the list: {names}.', { names: r.already.join(', ') }));
      if (r.invalid.length) parts.push(t('Not valid usernames: {names}.', { names: r.invalid.join(', ') }));
      if (r.restartNeeded) parts.push(t('They apply next time you start the server.'));
      addMsg.textContent = parts.join(' ');
      await refresh();
    } finally {
      addBtn.disabled = false;
    }
  });

  enabledBox.addEventListener('change', async () => {
    const r = await window.vp.whitelist.setEnabled(friendsProfileId, enabledBox.checked);
    if (r && r.ok) { await refresh(); } else { await refresh(); }
  });

  // Copy invite message: reuse the shared builder. The live public address lives on the console screen
  // (window.__friendsInvite is set there when a tunnel is up); when the server isn't public, say so.
  window.wireInviteButtons($('friendsInviteBtn'), null, () => {
    if (!friendsProfile) return null;
    const live = typeof window.currentInviteData === 'function' ? window.currentInviteData() : null;
    if (live) return live;
    return { name: friendsProfile.name, version: friendsProfile.version, address: '', plainAddress: '', notPublic: true };
  });

  window.openFriendsScreen = async function openFriendsScreen(id) {
    friendsProfileId = id;
    friendsProfile = await window.vp.server.get(id);
    $('friendsServerName').textContent = (friendsProfile && friendsProfile.name) || '';
    addMsg.textContent = '';
    input.value = '';
    await refresh();
    showScreen('screen-friends');
  };

  $('friendsBackBtn').addEventListener('click', () => showScreen('screen-console'));
  $('srvFriendsBtn').addEventListener('click', () => { if (window.managingProfileId) window.openFriendsScreen(window.managingProfileId); });
})();

'use strict';

// The Support VoxelPort screen. Everything that came from voxelport.in/support.json is put on the
// page with textContent (never innerHTML), and hosting links are opened by id, not by URL.
(function () {
  const $ = (id) => document.getElementById(id);
  let previous = 'screen-library';

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderTiers(supporter) {
    const box = $('supportTiers');
    box.replaceChildren();
    for (const t of supporter.tiers) {
      const card = el('div', 'support-tier');
      const head = el('div', 'support-tier-head');
      head.append(el('span', 'support-tier-name', t.name), el('span', 'support-tier-price', `₹${t.inr}+`));
      const list = el('ul', 'support-tier-perks');
      for (const p of t.perks) list.append(el('li', '', p));
      card.append(head, list);
      box.append(card);
    }
  }

  function renderHosts(hosts) {
    const group = $('supportHostsGroup');
    const box = $('supportHosts');
    box.replaceChildren();
    group.classList.toggle('hidden', !hosts.items.length);
    if (!hosts.items.length) return;
    $('supportHostsIntro').textContent = hosts.intro;
    $('supportDisclosure').textContent = hosts.disclosure;
    for (const h of hosts.items) {
      const row = el('div', 'support-host');
      const info = el('div', 'support-host-info');
      const name = el('div', 'support-host-name', h.name);
      if (h.affiliate) name.append(el('span', 'support-optional', 'affiliate link'));
      info.append(name);
      if (h.blurb) info.append(el('div', 'support-host-blurb', h.blurb));
      const open = el('button', 'ghost small', 'Visit');
      open.type = 'button';
      open.addEventListener('click', () => window.vp.support.open('host', h.id));
      row.append(info, open);
      box.append(row);
    }
  }

  async function load(force) {
    let s;
    try { s = await window.vp.support.get(force); } catch { return; }
    if (!s) return;
    $('supportUpi').textContent = s.donate.upiId;
    $('supportIntro').textContent = s.supporter.intro;
    $('supportHow').textContent = s.supporter.how;
    $('supportFine').textContent = s.supporter.fine;
    renderTiers(s.supporter);
    renderHosts(s.hosts);
  }

  function open() {
    const active = document.querySelector('.screen.active');
    if (active && active.id !== 'screen-support') previous = active.id;
    window.showScreen('screen-support');
    load(false);
  }

  $('supportLink').addEventListener('click', (e) => { e.preventDefault(); open(); });
  $('supportBackBtn').addEventListener('click', () => window.showScreen(previous));
  $('supportSponsorsBtn').addEventListener('click', () => window.vp.support.open('sponsors'));
  $('supportPerksBtn').addEventListener('click', () => window.vp.support.open('perks'));
  $('supportCopyBtn').addEventListener('click', async () => {
    const btn = $('supportCopyBtn');
    await window.vp.support.copyUpi();
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
})();

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = path.join(__dirname, '../src/renderer');

// Use the actual page's IDs and initial classes so missing markup cannot pass silently.
function element(tagName, attrs = {}) {
  const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
  return {
    tagName: tagName.toUpperCase(), textContent: '', innerHTML: '', style: {},
    getAttribute: (name) => attrs[name] ?? null,
    get className() { return [...classes].join(' '); },
    set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name); else classes.delete(name);
        return force;
      },
    },
    addEventListener() {},
  };
}

async function openRenderer({ bedrock = true, custom = '', lang = 'en' } = {}) {
  const elements = new Map();
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (attrs.id) elements.set(attrs.id, element(match[1], attrs));
  }
  const profile = { id: 'world', name: 'Survival SMP', type: 'paper', version: '1.21.11', port: 25565, bedrock };
  const events = new Map();
  const context = vm.createContext({
    $: (id) => {
      assert.ok(elements.has(id), `index.html needs #${id}`);
      return elements.get(id);
    },
    appState: { activeServerProfileId: 'world', publicServerProfileId: 'world', serverStatus: 'online' },
    onAppState: [],
    VPAddons: { kind: () => '' },
    localStorage: { getItem: () => lang },
    document: { createElement: (tag) => element(tag) },
    wireInviteButtons() {},
    vp: {
      on: (event, handler) => events.set(event, handler),
      name: { get: async () => ({ name: custom ? 'world' : '', address: custom }) },
      server: { get: async (id) => ({ ...profile, id }) },
    },
  });
  context.window = context;
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(renderer, file), 'utf8'), context, { filename: file });
  if (lang !== 'en') load(`lang/${lang}.js`);
  load('i18n.js');
  load('invite.js');
  load('console.js');
  await context.openManagementScreen('world');
  return {
    profile, context,
    get: (id) => {
      assert.ok(elements.has(id), `index.html needs #${id}`);
      return elements.get(id);
    },
    emit: (event, data) => events.get(event)?.(data),
    invite: () => context.VPInvite.buildInviteMessage({ lang, ...context.currentInviteData() }),
  };
}

const ready = { host: 'play.voxelport.in', port: 26043, bedrockPort: 19147, bedrockReady: true };

test('ready Bedrock uses its relay host and separate port while Java keeps its custom address', async () => {
  const ui = await openRenderer({ custom: 'play.example.net' });
  ui.emit('tunnel:assigned', ready);
  assert.equal(ui.get('publicShare').classList.contains('hidden'), false);
  assert.equal(ui.get('srvAddress').textContent, 'play.example.net');
  assert.equal(ui.get('srvAltAddress').textContent, 'Also works: play.voxelport.in:26043');
  assert.equal(ui.get('srvBedrock').classList.contains('hidden'), false);
  assert.equal(ui.get('srvBedrockHost').textContent, 'play.voxelport.in');
  assert.equal(ui.get('srvBedrockPort').textContent, '19147');
  assert.match(ui.invite(), /Address: play\.example\.net\n\(or: play\.voxelport\.in:26043\)/);
  assert.match(ui.invite(), /Server: play\.voxelport\.in   Port: 19147/);

  ui.emit('tunnel:name', { name: 'new-world', address: 'new-world.voxelport.in' });
  assert.equal(ui.get('srvAddress').textContent, 'new-world.voxelport.in');
  assert.equal(ui.get('srvBedrockHost').textContent, 'play.voxelport.in');
  assert.match(ui.invite(), /Server: play\.voxelport\.in   Port: 19147/);
});

test('without a custom name Java still uses its own port and Bedrock uses its separate port', async () => {
  const ui = await openRenderer();
  ui.emit('tunnel:assigned', ready);
  assert.equal(ui.get('srvAddress').textContent, 'play.voxelport.in:26043');
  assert.equal(ui.get('srvAltAddress').classList.contains('hidden'), true);
  assert.match(ui.invite(), /Address: play\.voxelport\.in:26043/);
  assert.doesNotMatch(ui.invite(), /\(or:/);
  assert.match(ui.invite(), /Server: play\.voxelport\.in   Port: 19147/);
});

test('a pending Bedrock mapping displays the restart notice and stays out of invites', async () => {
  const ui = await openRenderer();
  ui.emit('tunnel:assigned', { ...ready, bedrockReady: false });
  assert.equal(ui.get('srvBedrockHost').textContent, 'play.voxelport.in');
  assert.equal(ui.get('srvBedrockPort').textContent, '19147');
  assert.equal(ui.get('srvBedrock').classList.contains('hidden'), false);
  const status = ui.get('srvBedrockStatus');
  assert.equal(status.tagName, 'P');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.classList.contains('hidden'), false);
  assert.equal(status.textContent, 'Restart your server once to activate this Bedrock address.');
  assert.doesNotMatch(ui.invite(), /Bedrock|Server: .*   Port:/);
  assert.match(ui.invite(), /Address: play\.voxelport\.in:26043/);
});

test('Bedrock readiness must be confirmed before an invite includes the address', async () => {
  const ui = await openRenderer();
  for (const bedrockReady of [undefined, false]) {
    ui.emit('tunnel:assigned', { ...ready, bedrockReady });
    assert.equal(ui.context.currentInviteData().bedrock, null);
  }
});

test('missing or invalid Bedrock ports never fall back to the Java port, even if marked ready', async () => {
  const ui = await openRenderer();
  for (const bedrockPort of [null, undefined, 0, -1, 65536, 19147.5, '19147', NaN, Infinity]) {
    for (const bedrockReady of [false, true]) {
      ui.emit('tunnel:assigned', ready);
      ui.emit('tunnel:assigned', { ...ready, bedrockPort, bedrockReady });
      assert.equal(ui.context.currentInviteData().bedrock, null, `invalid Bedrock port ${bedrockPort}`);
      assert.equal(ui.get('srvBedrock').classList.contains('hidden'), true);
      assert.equal(ui.get('srvBedrockHost').textContent, '—');
      assert.equal(ui.get('srvBedrockPort').textContent, '—');
      assert.equal(ui.get('srvBedrockStatus').classList.contains('hidden'), false);
      assert.equal(ui.get('srvBedrockStatus').textContent, 'Bedrock needs an updated relay.');
      assert.doesNotMatch(ui.invite(), /Bedrock/);
    }
  }
});

test('both valid Bedrock port boundaries are shared when ready', async () => {
  const ui = await openRenderer();
  for (const bedrockPort of [1, 65535]) {
    ui.emit('tunnel:assigned', { ...ready, bedrockPort });
    assert.equal(ui.get('srvBedrockPort').textContent, String(bedrockPort));
    assert.equal(ui.context.currentInviteData().bedrock.port, bedrockPort);
  }
});

test('fresh assignments replace Bedrock details and clear the restart notice once ready', async () => {
  const ui = await openRenderer();
  ui.emit('tunnel:assigned', { ...ready, bedrockReady: false });
  ui.emit('tunnel:assigned', { ...ready, host: 'eu.voxelport.in', bedrockPort: 19148 });
  assert.equal(ui.get('srvBedrockHost').textContent, 'eu.voxelport.in');
  assert.equal(ui.get('srvBedrockPort').textContent, '19148');
  assert.equal(ui.get('srvBedrockStatus').textContent, '');
  assert.equal(ui.get('srvBedrockStatus').classList.contains('hidden'), true);
  assert.match(ui.invite(), /Server: eu\.voxelport\.in   Port: 19148/);
});

for (const status of ['connecting', 'reconnecting', 'stopped']) {
  test(`${status} invalidates Bedrock until a fresh assignment, even after online or another render`, async () => {
    const ui = await openRenderer({ custom: 'play.example.net' });
    ui.emit('tunnel:assigned', ready);
    assert.match(ui.invite(), /Server: play\.voxelport\.in   Port: 19147/);

    ui.emit('tunnel:status', status);
    assert.equal(ui.context.currentInviteData()?.bedrock ?? null, null);
    assert.doesNotMatch(ui.invite(), /Bedrock/);
    assert.equal(ui.get('srvBedrock').classList.contains('hidden'), true);
    assert.equal(ui.get('srvBedrockHost').textContent, '—');
    assert.equal(ui.get('srvBedrockPort').textContent, '—');
    assert.equal(ui.get('srvBedrockStatus').classList.contains('hidden'), true);
    assert.equal(ui.get('srvBedrockStatus').textContent, '');
    if (status === 'stopped') {
      assert.equal(ui.context.currentInviteData(), null);
    } else {
      assert.equal(ui.context.currentInviteData().address, 'play.example.net');
      assert.equal(ui.context.currentInviteData().plainAddress, 'play.voxelport.in:26043');
    }

    ui.emit('tunnel:status', 'online');
    await ui.context.refreshManagedProfile();
    assert.equal(ui.context.currentInviteData()?.bedrock ?? null, null);
    assert.doesNotMatch(ui.invite(), /Bedrock/);
    assert.equal(ui.get('srvBedrock').classList.contains('hidden'), true);
    assert.equal(ui.get('srvBedrockStatus').classList.contains('hidden'), true);

    ui.emit('tunnel:assigned', { ...ready, host: 'eu.voxelport.in', bedrockPort: 19148, bedrockReady: false });
    assert.equal(ui.context.currentInviteData().bedrock, null);
    assert.equal(ui.get('srvBedrockPort').textContent, '19148');
    assert.equal(ui.get('srvBedrockStatus').textContent, 'Restart your server once to activate this Bedrock address.');
    ui.emit('tunnel:assigned', { ...ready, host: 'eu.voxelport.in', bedrockPort: 19148 });
    assert.match(ui.invite(), /Server: eu\.voxelport\.in   Port: 19148/);
    assert.equal(ui.get('srvBedrockStatus').classList.contains('hidden'), true);
  });
}

test('online status preserves a fresh Bedrock assignment', async () => {
  const ui = await openRenderer();
  ui.emit('tunnel:assigned', ready);
  ui.emit('tunnel:status', 'online');
  assert.equal(ui.get('srvBedrock').classList.contains('hidden'), false);
  assert.match(ui.invite(), /Server: play\.voxelport\.in   Port: 19147/);
});

test('turning Bedrock off hides its address and notice and leaves it out of invites', async () => {
  const ui = await openRenderer();
  ui.emit('tunnel:assigned', { ...ready, bedrockReady: false });
  ui.profile.bedrock = false;
  await ui.context.refreshManagedProfile();
  for (const assignment of [ready, { ...ready, bedrockPort: null, bedrockReady: false }]) {
    ui.emit('tunnel:assigned', assignment);
    assert.equal(ui.get('srvBedrock').classList.contains('hidden'), true);
    assert.equal(ui.get('srvBedrockStatus').classList.contains('hidden'), true);
    assert.equal(ui.get('srvBedrockStatus').textContent, '');
    assert.doesNotMatch(ui.invite(), /Bedrock/);
  }
});

test('Bedrock details are hidden before assignment and when viewing a different profile', async () => {
  const ui = await openRenderer();
  assert.equal(ui.get('srvBedrock').classList.contains('hidden'), true);
  assert.equal(ui.get('srvBedrockStatus').classList.contains('hidden'), true);
  ui.emit('tunnel:assigned', { ...ready, bedrockReady: false });
  await ui.context.openManagementScreen('other-world');
  assert.equal(ui.get('publicShare').classList.contains('hidden'), true);
  assert.equal(ui.get('srvBedrock').classList.contains('hidden'), true);
  assert.equal(ui.get('srvBedrockStatus').classList.contains('hidden'), true);
});

test('both Bedrock notices use the chosen language', async () => {
  const ui = await openRenderer({ lang: 'hinglish' });
  ui.emit('tunnel:assigned', { ...ready, bedrockPort: null, bedrockReady: false });
  assert.equal(ui.get('srvBedrockStatus').textContent, 'Bedrock ke liye updated relay chahiye.');
  ui.emit('tunnel:assigned', { ...ready, bedrockReady: false });
  assert.equal(ui.get('srvBedrockStatus').textContent, 'Ye Bedrock address chalu karne ke liye apna server ek baar restart karo.');
});

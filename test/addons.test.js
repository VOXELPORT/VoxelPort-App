'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { searchAddons, installAddon, removeAddon, installedAddons, projectsInFolder, folderFor, supported } = require('../src/main/addons');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vp-addons-'));
const ID = (c) => c.repeat(8); // a project id looks like 8 letters/digits
const SHA = 'a'.repeat(128);

/** A Modrinth that answers from a table of url-prefix → body. Records what was asked. */
function fakeModrinth(routes) {
  const asked = [];
  const fetchImpl = async (url, opts = {}) => {
    asked.push({ url, opts });
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(url, opts) : body) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, asked };
}

const version = (over = {}) => ({
  version_type: 'release', dependencies: [],
  files: [{ primary: true, filename: 'Thing-1.0.jar', url: 'https://cdn.modrinth.com/data/x/Thing-1.0.jar', hashes: { sha512: SHA } }],
  ...over,
});

/** A download that writes a small jar and remembers what it was asked for. */
function fakeDownload() {
  const calls = [];
  const download = async (url, dest, _progress, checksum) => { calls.push({ url, dest, checksum }); fs.writeFileSync(dest, 'jar:' + path.basename(dest)); };
  return { download, calls };
}

// ─── Search ───────────────────────────────────────────────────────────────

test('search asks for Paper plugins (with Spigot and Bukkit) and for this Minecraft version', async () => {
  const { fetchImpl, asked } = fakeModrinth({ 'https://api.modrinth.com/v2/search': { hits: [] } });
  await searchAddons({ type: 'paper', version: '1.21.4', query: 'worldedit', fetchImpl });
  const url = new URL(asked[0].url);
  const facets = JSON.parse(url.searchParams.get('facets'));
  assert.deepEqual(facets[0], ['project_type:mod', 'project_type:plugin']);
  assert.deepEqual(facets[1], ['categories:paper', 'categories:spigot', 'categories:bukkit']);
  assert.deepEqual(facets[2], ['versions:1.21.4']);
  assert.equal(url.searchParams.get('query'), 'worldedit');
  assert.equal(url.searchParams.get('index'), 'relevance');
});

test('search for Fabric asks for mods only; with no words it lists the most downloaded', async () => {
  const { fetchImpl, asked } = fakeModrinth({ 'https://api.modrinth.com/v2/search': { hits: [] } });
  await searchAddons({ type: 'fabric', version: '1.21.4', fetchImpl });
  const url = new URL(asked[0].url);
  const facets = JSON.parse(url.searchParams.get('facets'));
  assert.deepEqual(facets[0], ['project_type:mod']);
  assert.deepEqual(facets[1], ['categories:fabric']);
  assert.equal(url.searchParams.get('index'), 'downloads');
});

test('"any version" leaves the Minecraft version out of the search', async () => {
  const { fetchImpl, asked } = fakeModrinth({ 'https://api.modrinth.com/v2/search': { hits: [] } });
  await searchAddons({ type: 'paper', version: '1.21.4', anyVersion: true, fetchImpl });
  assert.equal(JSON.parse(new URL(asked[0].url).searchParams.get('facets')).length, 2);
});

test('search cleans what it was given: long words are cut, a bad page number becomes the first page', async () => {
  const { fetchImpl, asked } = fakeModrinth({ 'https://api.modrinth.com/v2/search': { hits: [] } });
  await searchAddons({ type: 'paper', version: '1.21.4', query: 'x'.repeat(500), offset: -5, fetchImpl });
  await searchAddons({ type: 'paper', version: '1.21.4', offset: '20; drop', fetchImpl });
  await searchAddons({ type: 'paper', version: '1.21.4', offset: 40, fetchImpl });
  assert.equal(new URL(asked[0].url).searchParams.get('query').length, 100);
  assert.equal(new URL(asked[0].url).searchParams.get('offset'), '0');
  assert.equal(new URL(asked[1].url).searchParams.get('offset'), '0');
  assert.equal(new URL(asked[2].url).searchParams.get('offset'), '40');
});

test('a version that is not a plain version number is not put in the URL', async () => {
  const { fetchImpl, asked } = fakeModrinth({ 'https://api.modrinth.com/v2/search': { hits: [] } });
  await searchAddons({ type: 'paper', version: '1.21"],["x', fetchImpl });
  assert.equal(JSON.parse(new URL(asked[0].url).searchParams.get('facets')).length, 2);
});

test('search results keep only what is shown, as text, and drop anything without a proper id', async () => {
  const { fetchImpl } = fakeModrinth({
    'https://api.modrinth.com/v2/search': {
      hits: [
        { project_id: ID('A'), slug: 'a', title: 'Alpha', description: '<img src=x onerror=1>', downloads: 1200, author: 'zed', icon_url: 'https://evil.example/x.png', extra: 1 },
        { project_id: '../../etc', title: 'Bad' },
        { title: 'No id' },
        null,
      ],
    },
  });
  const { hits, more } = await searchAddons({ type: 'paper', version: '1.21.4', fetchImpl });
  assert.deepEqual(hits, [{ id: ID('A'), slug: 'a', title: 'Alpha', desc: '<img src=x onerror=1>', downloads: 1200, author: 'zed' }]);
  assert.equal(more, false);
});

test('a full page says there may be more', async () => {
  const hits = Array.from({ length: 20 }, (_, i) => ({ project_id: String(10000000 + i), title: 't' + i }));
  const { fetchImpl } = fakeModrinth({ 'https://api.modrinth.com/v2/search': { hits } });
  assert.equal((await searchAddons({ type: 'paper', version: '1.21.4', fetchImpl })).more, true);
});

test('vanilla has no plugins or mods', async () => {
  assert.equal(supported('vanilla'), false);
  await assert.rejects(searchAddons({ type: 'vanilla', version: '1.21.4', fetchImpl: async () => { throw new Error('should not ask'); } }), /Paper or Fabric/);
  assert.equal(folderFor('paper'), 'plugins');
  assert.equal(folderFor('fabric'), 'mods');
});

test('Modrinth being down is an error the screen can show', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(searchAddons({ type: 'paper', version: '1.21.4', fetchImpl }), /HTTP 503/);
});

// ─── Install ──────────────────────────────────────────────────────────────

test('install downloads the newest release into plugins/, checks its checksum, and remembers it', async () => {
  const dir = tmpDir();
  const { fetchImpl, asked } = fakeModrinth({
    [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [
      version({ version_type: 'beta', files: [{ primary: true, filename: 'Thing-2.0-beta.jar', url: 'https://cdn.modrinth.com/b.jar', hashes: { sha512: SHA } }] }),
      version(),
    ],
  });
  const { download, calls } = fakeDownload();
  const done = await installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), title: 'Thing', fetchImpl, download });
  assert.deepEqual(done, ['Thing']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dest, path.join(dir, 'plugins', 'Thing-1.0.jar'), 'the release, not the newer beta');
  assert.deepEqual(calls[0].checksum, { algorithm: 'sha512', expected: SHA });
  assert.deepEqual(installedAddons(dir), [{ id: ID('A'), title: 'Thing', file: 'Thing-1.0.jar', dir: 'plugins' }]);
  const q = new URL(asked[0].url).searchParams;
  assert.deepEqual(JSON.parse(q.get('loaders')), ['paper', 'spigot', 'bukkit']);
  assert.deepEqual(JSON.parse(q.get('game_versions')), ['1.21.4']);
});

test('with only betas it takes the newest beta; with nothing it says so', async () => {
  const dir = tmpDir();
  const beta = version({ version_type: 'beta', files: [{ primary: true, filename: 'B-1.jar', url: 'https://cdn.modrinth.com/b.jar', hashes: { sha512: SHA } }] });
  const a = fakeModrinth({ [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [beta] });
  const { download, calls } = fakeDownload();
  await installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), fetchImpl: a.fetchImpl, download });
  assert.equal(path.basename(calls[0].dest), 'B-1.jar');

  const none = fakeModrinth({ [`https://api.modrinth.com/v2/project/${ID('C')}/version`]: [] });
  await assert.rejects(installAddon({ serverDir: dir, type: 'fabric', version: '1.21.4', projectId: ID('C'), title: 'Nope', fetchImpl: none.fetchImpl, download }), /Nope has no Fabric version for Minecraft 1\.21\.4/);
});

test('Fabric mods go in mods/ and the libraries they need are installed first', async () => {
  const dir = tmpDir();
  const lib = version({ files: [{ primary: true, filename: 'fabric-api-1.jar', url: 'https://cdn.modrinth.com/l.jar', hashes: { sha512: SHA } }] });
  const mod = version({ dependencies: [{ dependency_type: 'required', project_id: ID('L') }, { dependency_type: 'optional', project_id: ID('O') }, { dependency_type: 'required', project_id: null }] });
  const { fetchImpl } = fakeModrinth({
    [`https://api.modrinth.com/v2/project/${ID('M')}/version`]: [mod],
    [`https://api.modrinth.com/v2/project/${ID('L')}/version`]: [lib],
    [`https://api.modrinth.com/v2/project/${ID('L')}`]: { title: 'Fabric API' },
  });
  const { download, calls } = fakeDownload();
  const done = await installAddon({ serverDir: dir, type: 'fabric', version: '1.21.4', projectId: ID('M'), title: 'Mod', fetchImpl, download });
  assert.deepEqual(done, ['Fabric API', 'Mod'], 'the library first; optional ones are not installed');
  assert.deepEqual(calls.map((c) => path.relative(dir, c.dest)), [path.join('mods', 'fabric-api-1.jar'), path.join('mods', 'Thing-1.0.jar')]);
  assert.deepEqual(installedAddons(dir).map((a) => a.title).sort(), ['Fabric API', 'Mod']);
});

test('a library already in the folder (put there by hand) is recognised by its fingerprint and not downloaded again', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'mods'));
  const handMade = Buffer.from('a fabric api someone copied in');
  fs.writeFileSync(path.join(dir, 'mods', 'fabric-api-copied.jar'), handMade);
  const hash = crypto.createHash('sha512').update(handMade).digest('hex');
  const mod = version({ dependencies: [{ dependency_type: 'required', project_id: ID('L') }] });
  const { fetchImpl, asked } = fakeModrinth({
    [`https://api.modrinth.com/v2/project/${ID('M')}/version`]: [mod],
    'https://api.modrinth.com/v2/version_files': (_u, opts) => ({ [JSON.parse(opts.body).hashes[0]]: { project_id: ID('L') } }),
  });
  const { download, calls } = fakeDownload();
  const done = await installAddon({ serverDir: dir, type: 'fabric', version: '1.21.4', projectId: ID('M'), title: 'Mod', fetchImpl, download });
  assert.deepEqual(done, ['Mod']);
  assert.equal(calls.length, 1, 'only the mod was downloaded');
  const post = asked.find((a) => a.url.endsWith('/version_files'));
  assert.deepEqual(JSON.parse(post.opts.body), { hashes: [hash], algorithm: 'sha512' });
});

test('if the fingerprint lookup fails, the library is simply installed', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'mods', 'x.jar'), 'x');
  const mod = version({ dependencies: [{ dependency_type: 'required', project_id: ID('L') }] });
  const { fetchImpl } = fakeModrinth({
    [`https://api.modrinth.com/v2/project/${ID('M')}/version`]: [mod],
    [`https://api.modrinth.com/v2/project/${ID('L')}/version`]: [version({ files: [{ primary: true, filename: 'lib.jar', url: 'https://cdn.modrinth.com/l.jar', hashes: { sha512: SHA } }] })],
    'https://api.modrinth.com/v2/version_files': () => { throw new Error('offline'); },
  });
  const { download, calls } = fakeDownload();
  await installAddon({ serverDir: dir, type: 'fabric', version: '1.21.4', projectId: ID('M'), fetchImpl, download });
  assert.equal(calls.length, 2);
});

test('libraries that need libraries stop after two levels, and a loop is not followed forever', async () => {
  const dir = tmpDir();
  const needs = (id) => version({ dependencies: [{ dependency_type: 'required', project_id: id }], files: [{ primary: true, filename: `f${id}.jar`, url: 'https://cdn.modrinth.com/f.jar', hashes: { sha512: SHA } }] });
  const { fetchImpl } = fakeModrinth({
    [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [needs(ID('B'))],
    [`https://api.modrinth.com/v2/project/${ID('B')}/version`]: [needs(ID('C'))],
    [`https://api.modrinth.com/v2/project/${ID('C')}/version`]: [needs(ID('A'))], // loops back
    'https://api.modrinth.com/v2/project/': { title: 'x' },
    'https://api.modrinth.com/v2/version_files': {},
  });
  const { download, calls } = fakeDownload();
  await installAddon({ serverDir: dir, type: 'fabric', version: '1.21.4', projectId: ID('A'), fetchImpl, download });
  assert.equal(calls.length, 3);
});

test('a file that is not a plain .jar name is refused, whatever Modrinth says', async () => {
  for (const filename of ['../../evil.jar', 'thing.zip', 'a b.jar', 'x'.repeat(130) + '.jar', '..\\..\\evil.jar']) {
    const dir = tmpDir();
    const { fetchImpl } = fakeModrinth({ [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [version({ files: [{ primary: true, filename, url: 'https://cdn.modrinth.com/x', hashes: { sha512: SHA } }] })] });
    const { download, calls } = fakeDownload();
    await assert.rejects(installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), fetchImpl, download }), /\.jar/, filename);
    assert.equal(calls.length, 0, filename);
    assert.equal(fs.existsSync(path.join(dir, 'plugins')), false, 'nothing was created for ' + filename);
  }
});

test('a download with no checksum is refused', async () => {
  const dir = tmpDir();
  const { fetchImpl } = fakeModrinth({ [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [version({ files: [{ primary: true, filename: 'a.jar', url: 'https://cdn.modrinth.com/x', hashes: {} }] })] });
  const { download, calls } = fakeDownload();
  await assert.rejects(installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), fetchImpl, download }), /checksum/);
  assert.equal(calls.length, 0);
});

test('a failed download leaves nothing registered', async () => {
  const dir = tmpDir();
  const { fetchImpl } = fakeModrinth({ [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [version()] });
  const download = async () => { throw new Error('Checksum mismatch'); };
  await assert.rejects(installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), fetchImpl, download }), /Checksum/);
  assert.deepEqual(installedAddons(dir), []);
});

test('installing again replaces the older file of the same project', async () => {
  const dir = tmpDir();
  const route = (name) => ({ [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [version({ files: [{ primary: true, filename: name, url: 'https://cdn.modrinth.com/x', hashes: { sha512: SHA } }] })] });
  const { download } = fakeDownload();
  await installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), title: 'Thing', fetchImpl: fakeModrinth(route('Thing-1.jar')).fetchImpl, download });
  await installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), title: 'Thing', fetchImpl: fakeModrinth(route('Thing-2.jar')).fetchImpl, download });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plugins')), ['Thing-2.jar']);
  assert.equal(installedAddons(dir).length, 1);
});

test('while the server runs a new one can be added, but one already there cannot be replaced', async () => {
  const dir = tmpDir();
  const { fetchImpl } = fakeModrinth({ [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [version()] });
  const { download, calls } = fakeDownload();
  await installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), running: true, fetchImpl, download });
  assert.equal(calls.length, 1, 'a new one is fine');
  await assert.rejects(installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), running: true, fetchImpl, download }), /Stop the server first/);
  assert.equal(calls.length, 1);
});

test('install refuses bad input before it asks Modrinth anything', async () => {
  const fetchImpl = async () => { throw new Error('should not ask'); };
  const dir = tmpDir();
  await assert.rejects(installAddon({ serverDir: dir, type: 'vanilla', version: '1', projectId: ID('A'), fetchImpl }), /Paper or Fabric/);
  await assert.rejects(installAddon({ serverDir: dir, type: 'paper', version: '1', projectId: '../x', fetchImpl }), /Invalid project/);
  await assert.rejects(installAddon({ serverDir: 'relative', type: 'paper', version: '1', projectId: ID('A'), fetchImpl }), /Invalid server folder/);
});

// ─── The list and Remove ──────────────────────────────────────────────────

test('the installed list only shows files that are still there, and ignores a damaged list', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'plugins', 'here.jar'), 'x');
  fs.writeFileSync(path.join(dir, 'voxelport-addons.json'), JSON.stringify([
    { id: ID('A'), title: 'Here', file: 'here.jar', dir: 'plugins' },
    { id: ID('B'), title: 'Gone', file: 'gone.jar', dir: 'plugins' },
    { id: ID('C'), title: 'Escapes', file: '../server.properties', dir: 'plugins' },
    { id: ID('D'), title: 'Elsewhere', file: 'here.jar', dir: '..' },
    { id: 'bad', title: 'Bad id', file: 'here.jar', dir: 'plugins' },
  ]));
  assert.deepEqual(installedAddons(dir).map((a) => a.title), ['Here']);
  fs.writeFileSync(path.join(dir, 'voxelport-addons.json'), '{not json');
  assert.deepEqual(installedAddons(dir), []);
  fs.writeFileSync(path.join(dir, 'voxelport-addons.json'), '{"a":1}');
  assert.deepEqual(installedAddons(dir), []);
});

test('Remove deletes only the file VoxelPort installed, and forgets it', async () => {
  const dir = tmpDir();
  const { fetchImpl } = fakeModrinth({ [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [version()] });
  const { download } = fakeDownload();
  await installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), title: 'Thing', fetchImpl, download });
  fs.writeFileSync(path.join(dir, 'plugins', 'by-hand.jar'), 'mine');
  fs.writeFileSync(path.join(dir, 'plugins', 'Geyser-Spigot.jar'), 'geyser');
  removeAddon({ serverDir: dir, projectId: ID('A') });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plugins')).sort(), ['Geyser-Spigot.jar', 'by-hand.jar']);
  assert.deepEqual(installedAddons(dir), []);
});

test('Remove will not touch a project VoxelPort did not install, or anything while the server runs', async () => {
  const dir = tmpDir();
  assert.throws(() => removeAddon({ serverDir: dir, projectId: ID('A') }), /not installed by VoxelPort/);
  const { fetchImpl } = fakeModrinth({ [`https://api.modrinth.com/v2/project/${ID('A')}/version`]: [version()] });
  const { download } = fakeDownload();
  await installAddon({ serverDir: dir, type: 'paper', version: '1.21.4', projectId: ID('A'), fetchImpl, download });
  assert.throws(() => removeAddon({ serverDir: dir, projectId: ID('A'), running: true }), /Stop the server first/);
  assert.equal(installedAddons(dir).length, 1, 'still installed');
  assert.throws(() => removeAddon({ serverDir: dir, projectId: '../../x' }), /Invalid project/);
});

test('fingerprint lookup handles an empty or missing folder', async () => {
  const fetchImpl = async () => { throw new Error('should not ask'); };
  assert.equal((await projectsInFolder(path.join(tmpDir(), 'nope'), fetchImpl)).size, 0);
  assert.equal((await projectsInFolder(tmpDir(), fetchImpl)).size, 0);
});

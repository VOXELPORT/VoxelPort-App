// End to end through the real Tauri window: plugins and mods (search, install with a library, remove), the "what is installed"
// panel, Bedrock players (Geyser + Floodgate), the Bedrock template, and modpack import, on servers installed through the app from
// stand-in services (Mojang/Paper/Fabric, Modrinth and GeyserMC all come from tools/fake-mc.mjs).
//   node tools/e2e-addons.mjs <debug-exe> <data-dir> <test-root> <stand-in-java-dir>
// Development builds only (uses debug-only env switches). Ends only the processes it starts, by PID.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeMc } from './fake-mc.mjs';
import { storedZip } from './fake-adoptium.mjs';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';

const [exe, dataDir, testRoot, javaDir] = process.argv.slice(2);
const ACCOUNTS = 8799, MC = 8797;
const { check, done } = reporter();
if (!dataDir.includes('in.voxelport.app.dev') || !testRoot.includes('vp-tauri-test')) throw new Error('refusing to touch folders that are not the dev ones');

for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json']) fs.rmSync(path.join(dataDir, f), { force: true });
fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });
const profilesFile = path.join(dataDir, 'server-profiles.json');
const originalProfiles = fs.existsSync(profilesFile) ? fs.readFileSync(profilesFile, 'utf8') : null;
fs.writeFileSync(profilesFile, JSON.stringify({ version: 2, servers: [] }));

const packFile = path.join(testRoot, 'pack.mrpack');
const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const mc = await startFakeMc(MC);
await sleep(600);

const app = launch(exe, { env: { PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_MC_API: mc.base, VOXELPORT_MODRINTH_API: `${mc.base}/v2`, VOXELPORT_GEYSER_API: `${mc.base}/geyser`, VOXELPORT_TEST_FILE: packFile } });
const page = await connect();
const J = JSON.stringify;
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const hexOf = async (algo, buf) => { const { createHash } = await import('node:crypto'); return createHash(algo).update(buf).digest('hex'); };

const pack = async ({ deps = { minecraft: '1.21.4', 'fabric-loader': '0.16.9' }, files = [], extra = [], name = 'Test Pack' }) => {
  const index = { formatVersion: 1, game: 'minecraft', name, dependencies: deps, files };
  fs.writeFileSync(packFile, storedZip([['modrinth.index.json', Buffer.from(JSON.stringify(index))], ...extra.map(([n, t]) => [n, Buffer.from(t)])]));
};

try {
  await page.ev("(window.__ap = [], window.__bp = [], window.__ip = [], vp.on('addons:progress', (p) => window.__ap.push(p.stage)), vp.on('bedrock:progress', (p) => window.__bp.push(p.stage)), vp.on('install:progress', (p) => window.__ip.push(p.phase)), true)");
  const s = await page.ev('vp.discordSignIn()');
  check('signed in first', s.ok && s.state.allowed, J(s));

  const pdir = path.join(testRoot, 'paper');
  const inst = await page.ev(`vp.server.install({ name: 'Add-on Test', type: 'paper', version: '1.21.4', port: 25571, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(pdir)}, templateId: 'survival' })`);
  const id = inst.profile?.id;
  check('a Paper server to add plugins to is installed through the app', inst.ok === true, J(inst));

  // ── Plugins ──────────────────────────────────────────────────────────────
  let g = await page.ev(`vp.addons.get(${J(id)})`);
  check('a Paper server takes plugins, from plugins/, with nothing installed yet', g.supported === true && g.type === 'paper' && g.version === '1.21.4' && g.folder === 'plugins' && g.installed.length === 0 && g.others.length === 0 && g.running === false, J(g));
  const sr = await page.ev(`vp.addons.search(${J(id)}, '  cool ', false, 0)`);
  check('search lists the plugin and drops a hit with a malformed id', sr.ok && sr.hits.length === 1 && sr.hits[0].id === 'AAAAAAAA' && sr.hits[0].title === 'Cool Plugin' && sr.hits[0].icon === 'https://cdn.modrinth.com/data/AAAAAAAA/icon.png' && sr.more === false, J(sr));
  const q = decodeURIComponent(mc.state.lastSearch);
  check('and asks Modrinth for Paper plugins for this Minecraft version', q.includes('query=cool&') && q.includes('categories:paper') && q.includes('project_type:plugin') && q.includes('versions:1.21.4') && q.includes('index=relevance'), q);
  const noMatch = await page.ev(`vp.addons.search('nope', 'x', false, 0)`);
  check('searching for an unknown server is reported, not thrown', noMatch.ok === false && noMatch.error === 'Server profile not found.');
  const bad = [await page.ev(`vp.addons.install(${J(id)}, 'short', 'x', '')`), await page.ev(`vp.addons.install(${J(id)}, '../../../x', 'x', '')`)];
  check('a bad project id is refused with nothing downloaded', bad.every((b) => b.ok === false && b.error === 'Invalid project.') && ls(path.join(pdir, 'plugins')).length === 0, J(bad));

  const ins = await page.ev(`vp.addons.install(${J(id)}, 'AAAAAAAA', 'Cool Plugin', 'https://cdn.modrinth.com/data/AAAAAAAA/icon.png')`);
  check('installing brings the required library first and says so', ins.ok === true && JSON.stringify(ins.installed) === '["The Library","Cool Plugin"]' && ins.restartNeeded === false, J(ins));
  check('both jars are in plugins/ with the right bytes', J(ls(path.join(pdir, 'plugins'))) === '["CoolPlugin-1.0.jar","Lib-2.jar"]' && fs.readFileSync(path.join(pdir, 'plugins', 'CoolPlugin-1.0.jar'), 'utf8') === 'Cool Plugin bytes');
  check('and progress ran resolve, download and done', /^resolve,resolve,download,download,done$/.test(await page.ev('window.__ap.join(",")')) || (await page.ev('window.__ap.join(",")')).endsWith('done'), await page.ev('window.__ap.join(",")'));
  fs.writeFileSync(path.join(pdir, 'plugins', 'Handmade-1.2.3.jar'), 'mine');
  g = await page.ev(`vp.addons.get(${J(id)})`);
  const ids = g.installed.map((a) => a.id).sort();
  check('the screen lists what VoxelPort installed and shows the hand-made jar separately with its version', J(ids) === '["AAAAAAAA","BBBBBBBB"]' && g.others.length === 1 && g.others[0].file === 'Handmade-1.2.3.jar' && g.others[0].version === '1.2.3' && g.others[0].bedrock === false, J(g));
  const again = await page.ev(`vp.addons.install(${J(id)}, 'AAAAAAAA', 'Cool Plugin', '')`);
  check('installing the same one again (stopped) updates it in place', again.ok === true, J(again));
  fs.writeFileSync(path.join(pdir, 'plugins', 'CoolPlugin-1.0.jar'), 'tampered');
  const icon = await page.ev(`vp.addons.icon('https://evil.example/x.png')`);
  check('an icon address that is not Modrinth\'s image host gives no icon and no request', icon === '' );
  const rem = await page.ev(`vp.addons.remove(${J(id)}, 'AAAAAAAA')`);
  check('remove deletes only what VoxelPort installed for that project', rem.ok && J(ls(path.join(pdir, 'plugins'))) === '["Handmade-1.2.3.jar","Lib-2.jar"]', J(rem) + J(ls(path.join(pdir, 'plugins'))));
  check('removing something VoxelPort did not install is refused', (await page.ev(`vp.addons.remove(${J(id)}, 'ZZZZZZZZ')`)).error === 'That one was not installed by VoxelPort.');
  check('opening the folder works', (await page.ev(`vp.addons.openFolder(${J(id)})`)).ok === true);

  // ── Bedrock players ──────────────────────────────────────────────────────
  const bd = await page.ev(`vp.server.setBedrock(${J(id)}, true)`);
  check('turning Bedrock on installs Geyser and Floodgate and marks the profile', bd.ok === true && bd.profile.bedrock === true && bd.restartNeeded === false, J(bd));
  check('with the right files, recorded in voxelport-bedrock.json', ls(path.join(pdir, 'plugins')).includes('Geyser-Spigot.jar') && ls(path.join(pdir, 'plugins')).includes('floodgate-spigot.jar') && fs.existsSync(path.join(pdir, 'voxelport-bedrock.json')) && /^resolve,download,download,done$/.test(await page.ev('window.__bp.join(",")')), await page.ev('window.__bp.join(",")'));
  g = await page.ev(`vp.addons.get(${J(id)})`);
  check('the add-ons screen shows them as managed by Bedrock support, never removable', g.others.filter((o) => o.bedrock).map((o) => o.title).sort().join() === 'Floodgate,Geyser' && g.installed.every((a) => a.id !== 'geyser'), J(g.others));
  let ri = await page.ev(`vp.server.runtimeInfo(${J(id)})`);
  check('what is really installed comes from the disk: version, plugins, Geyser support', ri.ok && ri.type === 'paper' && ri.storedVersion === '1.21.4' && ri.runningVersion === '1.21.4' && ri.jarVersionReadable === true && ri.bedrock === true && ri.bedrockCompatible === true && ri.plugins.some((p) => p.key === 'geyser' && p.label === 'Geyser') && ri.plugins.some((p) => p.key === 'floodgate') && Array.isArray(ri.stagedUpdates), J(ri));
  fs.mkdirSync(path.join(pdir, 'plugins', 'update'), { recursive: true });
  fs.writeFileSync(path.join(pdir, 'plugins', 'update', 'Geyser-Spigot.jar'), 'x');
  ri = await page.ev(`vp.server.runtimeInfo(${J(id)})`);
  check('an update waiting for the next restart is reported', J(ri.stagedUpdates) === '[{"dir":"plugins","name":"Geyser-Spigot.jar"}]', J(ri.stagedUpdates));
  check('an unknown server is reported', (await page.ev("vp.server.runtimeInfo('nope')")).error === 'Server profile not found.');
  const off = await page.ev(`vp.server.setBedrock(${J(id)}, false)`);
  check('turning Bedrock off removes only those two jars', off.ok && off.profile.bedrock === false && J(ls(path.join(pdir, 'plugins'))) === '["Handmade-1.2.3.jar","Lib-2.jar","update"]' && !fs.existsSync(path.join(pdir, 'voxelport-bedrock.json')), J(ls(path.join(pdir, 'plugins'))));

  // ── Bedrock template, and a version Geyser does not support ──────────────
  const cdir = path.join(testRoot, 'crossplay');
  const cross = await page.ev(`vp.server.install({ name: 'Crossplay', type: 'paper', version: '1.21.4', port: 25572, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(cdir)}, templateId: 'crossplay' })`);
  check('the Bedrock template installs Geyser and Floodgate too, with a "bedrock" phase', cross.ok && cross.profile.bedrock === true && cross.warning == null && ls(path.join(cdir, 'plugins')).includes('Geyser-Spigot.jar') && (await page.ev('window.__ip.includes("bedrock")')), J(cross));
  const old = await page.ev(`vp.server.install({ name: 'Old', type: 'paper', version: '1.20.6', port: 25573, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(path.join(testRoot, 'old'))}, templateId: 'crossplay' })`);
  check('where no Geyser supports the version, the server still installs and the warning says Bedrock can be turned on later', old.ok === true && old.profile.bedrock !== true && /Bedrock support couldn't be added/.test(old.warning || '') && /later in Settings/.test(old.warning || ''), J(old));
  const oldOn = await page.ev(`vp.server.setBedrock(${J(old.profile?.id)}, true)`);
  check('and turning it on by hand is refused with the same reason, nothing written', oldOn.ok === false && /No Geyser build supports Minecraft 1\.20\.6/.test(oldOn.error) && !fs.existsSync(path.join(testRoot, 'old', 'plugins')), J(oldOn));
  const van = await page.ev(`vp.server.install({ name: 'Van', type: 'vanilla', version: '1.21.4', port: 25574, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(path.join(testRoot, 'van'))} })`);
  const vg = await page.ev(`vp.addons.get(${J(van.profile?.id)})`);
  const vb = await page.ev(`vp.server.setBedrock(${J(van.profile?.id)}, true)`);
  check('Vanilla takes neither plugins nor Bedrock', vg.supported === false && vg.folder === '' && vg.installed.length === 0 && vb.ok === false && /Paper or Fabric/.test(vb.error), J({ vg, vb }));

  // ── A running server ─────────────────────────────────────────────────────
  check('the Paper server starts', (await page.ev(`vp.server.start(${J(id)})`)).ok === true);
  await sleep(1500);
  g = await page.ev(`vp.addons.get(${J(id)})`);
  check('the add-ons screen reports it running', g.running === true);
  const rr = await page.ev(`vp.addons.remove(${J(id)}, 'BBBBBBBB')`);
  check('a plugin cannot be removed while the server runs', rr.ok === false && /Stop the server first/.test(rr.error) && fs.existsSync(path.join(pdir, 'plugins', 'Lib-2.jar')), J(rr));
  const upd = await page.ev(`vp.addons.install(${J(id)}, 'AAAAAAAA', 'Cool Plugin', '')`);
  check('a new plugin can be added to a running server, and the screen is told a restart is needed', upd.ok === true && upd.restartNeeded === true, J(upd));
  const upd2 = await page.ev(`vp.addons.install(${J(id)}, 'AAAAAAAA', 'Cool Plugin', '')`);
  check('but one already installed cannot be replaced while it runs', upd2.ok === false && /Stop the server first/.test(upd2.error), J(upd2));
  await page.ev('vp.server.stop()'); await sleep(2500);

  // ── Fabric: mods, and the library check ──────────────────────────────────
  const fdir = path.join(testRoot, 'fabric');
  const fab = await page.ev(`vp.server.install({ name: 'Fab', type: 'fabric', version: '1.21.4', port: 25575, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(fdir)} })`);
  const fid = fab.profile?.id;
  const fg = await page.ev(`vp.addons.get(${J(fid)})`);
  check('a Fabric server takes mods, from mods/', fg.supported === true && fg.folder === 'mods' && fg.type === 'fabric', J(fg));
  const fs1 = await page.ev(`vp.addons.search(${J(fid)}, '', true, 0)`);
  check('Fabric search asks for mods only, for any version when asked', fs1.ok && fs1.hits[0].id === 'EEEEEEEE' && decodeURIComponent(mc.state.lastSearch).includes('categories:fabric') && !decodeURIComponent(mc.state.lastSearch).includes('versions:') && decodeURIComponent(mc.state.lastSearch).includes('index=downloads'), decodeURIComponent(mc.state.lastSearch));
  const fi = await page.ev(`vp.addons.install(${J(fid)}, 'EEEEEEEE', 'Cool Mod', '')`);
  check('a mod installs into mods/', fi.ok && J(ls(path.join(fdir, 'mods'))) === '["cool-mod-3.jar"]', J(fi));
  const fb = await page.ev(`vp.server.setBedrock(${J(fid)}, true)`);
  check('Bedrock on Fabric installs Fabric API, Geyser and Floodgate into mods/', fb.ok && J(ls(path.join(fdir, 'mods'))) === '["Floodgate-Fabric-2.2.jar","cool-mod-3.jar","fabric-api-0.100.jar","geyser-fabric-2.9.jar"]', J(fb) + J(ls(path.join(fdir, 'mods'))));
  const fo = await page.ev(`vp.server.setBedrock(${J(fid)}, false)`);
  check('and off leaves Fabric API (other mods may need it) and the mod VoxelPort added', fo.ok && J(ls(path.join(fdir, 'mods'))) === '["cool-mod-3.jar","fabric-api-0.100.jar"]', J(ls(path.join(fdir, 'mods'))));

  // ── Modpacks ─────────────────────────────────────────────────────────────
  const h = await hexOf('sha512', Buffer.from('x'));
  const modFile = (p, env) => ({ path: p, hashes: { sha512: h }, downloads: [`https://cdn.modrinth.com/data/x/${p.split('/').pop()}`], fileSize: 10, ...(env ? { env } : {}) });
  await pack({ name: 'Big Pack', files: [modFile('mods/lithium.jar'), modFile('mods/sodium.jar', { client: 'required', server: 'unsupported' }), modFile('shaderpacks/pretty.zip')] });
  let ch = await page.ev('vp.modpack.choose()');
  check('choosing a pack reads its plan without installing: name, versions, how many go on the server and what was skipped', ch.ok && ch.name === 'Big Pack' && ch.minecraft === '1.21.4' && ch.quilt === false && ch.install === 1 && J(ch.skipped) === '[{"name":"sodium.jar","reason":"client-only"},{"name":"pretty.zip","reason":"client-only"}]' && ch.file === packFile, J(ch));
  await pack({ deps: { minecraft: '1.20.1', forge: '47.2.0' } });
  ch = await page.ev('vp.modpack.choose()');
  check('a Forge pack is refused with its own code', ch.ok === false && ch.code === 'forge' && /Forge or NeoForge/.test(ch.error), J(ch));
  await pack({ files: [{ path: 'mods/../../evil.jar', hashes: { sha512: h }, downloads: ['https://cdn.modrinth.com/x'] }] });
  ch = await page.ev('vp.modpack.choose()');
  check('a pack naming a file outside the server folder is refused as unsafe', ch.ok === false && ch.code === 'unsafe', J(ch));
  fs.writeFileSync(packFile, 'this is not a zip');
  ch = await page.ev('vp.modpack.choose()');
  check('a file that is not a modpack is refused clearly', ch.ok === false && ch.code === 'bad-pack', J(ch));

  await pack({ name: 'Tiny Pack', extra: [['overrides/config/tuned.toml', 'a = 1'], ['server-overrides/config/tuned.toml', 'a = 2'], ['overrides/options.txt', 'client'], ['overrides/mods/shipped.jar', 'shipped']] });
  const mdir = path.join(testRoot, 'modpack');
  const badPort = await page.ev(`vp.modpack.install({ file: ${J(packFile)}, name: 'M', port: 0, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(mdir)} })`);
  const badRam = await page.ev(`vp.modpack.install({ file: ${J(packFile)}, name: 'M', port: 25576, minRamMb: 10, maxRamMb: 20, serverDir: ${J(mdir)} })`);
  check('a bad port or RAM is refused before anything is written', badPort.ok === false && badRam.ok === false && !fs.existsSync(mdir), J({ badPort, badRam }));
  await page.ev('window.__ip.length = 0');
  const mi = await page.ev(`vp.modpack.install({ file: ${J(packFile)}, name: '', port: 25576, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(mdir)} })`);
  check('importing creates a Fabric server named after the pack, with its profile', mi.ok === true && mi.profile.name === 'Tiny Pack' && mi.profile.type === 'fabric' && mi.profile.version === '1.21.4' && mi.profile.port === 25576 && mi.modsInstalled === 0 && Array.isArray(mi.skipped), J(mi));
  check('with the Fabric jar, EULA and port in place', fs.existsSync(path.join(mdir, 'server.jar')) && /eula=true/.test(fs.readFileSync(path.join(mdir, 'eula.txt'), 'utf8')) && /server-port=25576/.test(fs.readFileSync(path.join(mdir, 'server.properties'), 'utf8')));
  check('the pack\'s config is copied (server-overrides win), its client files are not', fs.readFileSync(path.join(mdir, 'config', 'tuned.toml'), 'utf8') === 'a = 2' && fs.readFileSync(path.join(mdir, 'mods', 'shipped.jar'), 'utf8') === 'shipped' && !fs.existsSync(path.join(mdir, 'options.txt')));
  const ip = await page.ev('window.__ip.join(",")');
  check('and progress went resolving, downloading, verifying, mods, done', /resolving.*downloading.*verifying.*mods.*done$/.test(ip), ip);
  const listed = await page.ev('vp.server.list()');
  check('the new server is in the list', listed.some((p) => p.id === mi.profile.id));
  const twice = await page.ev(`vp.modpack.install({ file: ${J(packFile)}, name: 'Again', port: 25577, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(mdir)} })`);
  check('importing into a folder that already has a server is refused and leaves it as it was', twice.ok === false && fs.readFileSync(path.join(mdir, 'config', 'tuned.toml'), 'utf8') === 'a = 2' && (await page.ev('vp.server.list()')).length === listed.length, J(twice));
  await pack({ files: [modFile('mods/offsite.jar')] });
  const odir = path.join(testRoot, 'offline-pack');
  const fail = await page.ev(`vp.modpack.install({ file: ${J(packFile)}, name: 'F', port: 25578, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(odir)} })`);
  check('a pack whose mod cannot be downloaded fails with a reason and leaves no half-made server behind', fail.ok === false && typeof fail.error === 'string' && !fs.existsSync(odir) && (await page.ev('vp.server.list()')).length === listed.length, J(fail));
} finally {
  page.close(); kill(app); kill(accounts); mc.close();
  if (originalProfiles !== null) fs.writeFileSync(profilesFile, originalProfiles); else fs.rmSync(profilesFile, { force: true });
  fs.rmSync(testRoot, { recursive: true, force: true });
}
process.exit(done());

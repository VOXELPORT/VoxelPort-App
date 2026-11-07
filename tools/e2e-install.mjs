// End to end through the real Tauri window: server types and versions, install (checked jar, files, profile), import,
// edit, run, and delete (Recycle Bin), against stand-in Mojang/Paper/Fabric services.
//   node tools/e2e-install.mjs <debug-exe> <data-dir> <test-root> <stand-in-java-dir>
// Development builds only (uses debug-only env switches). Ends only the processes it starts, by PID.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeMc } from './fake-mc.mjs';
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

const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const mc = await startFakeMc(MC);
await sleep(600);

/** One app run with the given dialog answer. */
async function session(removeAnswer, fn) {
  const app = launch(exe, { env: { PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_MC_API: mc.base, VOXELPORT_MODRINTH_API: `${mc.base}/v2`, VOXELPORT_GEYSER_API: `${mc.base}/geyser`, VOXELPORT_TEST_REMOVE: removeAnswer } });
  const page = await connect();
  try { await fn(page); } finally { page.close(); kill(app); await sleep(1200); }
}
const rejects = async (page, expr) => { const r = await page.ev(`(async () => { try { await ${expr}; return null; } catch (e) { return String(e); } })()`); return r; };
const dir = (n) => path.join(testRoot, n);
const exists = (p) => fs.existsSync(p);
let paperId, importedId;

try {
  await session('cancel', async (page) => {
    await page.ev("(window.__progress = [], vp.on('install:progress', (p) => window.__progress.push(p.phase)), true)");
    const s = await page.ev('vp.discordSignIn()');
    check('signed in first', s.ok && s.state.allowed, JSON.stringify(s));

    check('the three server types are listed', JSON.stringify((await page.ev('vp.server.types()')).map((t) => t.id)) === '["vanilla","paper","fabric"]');
    check('vanilla lists releases only', JSON.stringify(await page.ev("vp.server.versions('vanilla')")) === '["1.21.4","1.20.1"]');
    check('paper lists newest group first', JSON.stringify(await page.ev("vp.server.versions('paper')")) === '["1.21.4","1.21.3","1.20.6"]');
    check('fabric lists stable versions only', JSON.stringify(await page.ev("vp.server.versions('fabric')")) === '["1.21.4"]');
    check('an unknown type is refused', /Unknown server type/.test(await rejects(page, "vp.server.versions('forge')")));

    const def = await page.ev('vp.server.defaultDir()');
    check('the suggested folder is a fresh one under the app data folder', typeof def === 'string' && def.startsWith(path.join(dataDir, 'servers')) && /server-\d+-[0-9a-f]{8}$/.test(def), String(def));
    check('a relative folder is not accepted for detection', /Invalid folder/.test(await rejects(page, "vp.server.detectExisting('relative')")));
    const empty = await page.ev(`vp.server.detectExisting(${JSON.stringify(dir('empty'))})`);
    check('an empty folder does not look like a server', empty.looksLikeServer === false);

    // Install a Paper server from the Creative template.
    const r = await page.ev(`vp.server.install({ name: '', type: 'paper', version: '1.21.4', port: 25570, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('paper'))}, templateId: 'creative' })`);
    paperId = r.profile?.id;
    check('a Paper server installs', r.ok === true && r.warning === null && r.profile.type === 'paper' && r.profile.build === '90' && r.profile.template === 'creative' && r.profile.name === 'Creative Flat', JSON.stringify(r));
    check('its files are all there, no temporary files', JSON.stringify(fs.readdirSync(dir('paper')).sort()) === '["eula.txt","server.jar","server.properties"]', JSON.stringify(fs.readdirSync(dir('paper'))));
    const props = fs.readFileSync(path.join(dir('paper'), 'server.properties'), 'utf8');
    check('the template settings are in, the safety settings are not overridden', /gamemode=creative/.test(props) && /level-type=minecraft\\:flat/.test(props) && /online-mode=true/.test(props) && /server-port=25570/.test(props), props);
    const phases = await page.ev('window.__progress.join(",")');
    check('progress was reported through each phase', /resolving.*downloading.*verifying.*done/.test(phases), phases);
    check('the server is in the list', (await page.ev('vp.server.list()')).length === 1);

    check('installing into a folder that already has a server is refused', /Import Existing Server/.test(await rejects(page, `vp.server.install({ type: 'paper', version: '1.21.4', port: 25571, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('paper'))} })`)));
    check('bad port, bad RAM, bad type, bad folder and bad template are refused', (await Promise.all([
      rejects(page, "vp.server.install({ type: 'paper', version: '1.21.4', port: 0, minRamMb: 1024, maxRamMb: 2048 })"),
      rejects(page, "vp.server.install({ type: 'paper', version: '1.21.4', port: 25565, minRamMb: 100, maxRamMb: 2048 })"),
      rejects(page, "vp.server.install({ type: 'forge', version: '1.21.4', port: 25565, minRamMb: 1024, maxRamMb: 2048 })"),
      rejects(page, "vp.server.install({ type: 'paper', version: '1.21.4', port: 25565, minRamMb: 1024, maxRamMb: 2048, serverDir: 'rel' })"),
      rejects(page, "vp.server.install({ type: 'paper', version: '1.21.4', port: 25565, minRamMb: 1024, maxRamMb: 2048, templateId: 'nope' })"),
    ])).every((e) => e && /Enter a valid|Invalid|Unknown/.test(e)));

    check('a cracked server is refused until the risks are confirmed', /Confirm that you want to allow cracked players first/.test(await rejects(page, `vp.server.install({ type: 'paper', version: '1.21.4', port: 25572, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('cracked'))}, templateId: 'cracked' })`)) && !exists(dir('cracked')));
    const cr = await page.ev(`vp.server.install({ type: 'paper', version: '1.21.4', port: 25572, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('cracked'))}, templateId: 'cracked', crackedConfirmed: true })`);
    const crProps = fs.readFileSync(path.join(dir('cracked'), 'server.properties'), 'utf8');
    check('once confirmed it installs with the login plugin first, then offline mode, then skins, and no warning', cr.ok && cr.warning === null && /online-mode=false/.test(crProps) && /enforce-secure-profile=false/.test(crProps) && fs.existsSync(path.join(dir('cracked'), 'plugins', 'AuthMe-5.7.0.jar')) && fs.existsSync(path.join(dir('cracked'), 'plugins', 'SkinsRestorer.jar')), JSON.stringify(cr) + crProps);
    mc.state.mode.noAuthMe = true;
    const nc = await page.ev(`vp.server.install({ type: 'paper', version: '1.21.4', port: 25577, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('cracked2'))}, templateId: 'cracked', crackedConfirmed: true })`);
    mc.state.mode.noAuthMe = false;
    check('if the login plugin cannot be had, offline mode is never switched on and the warning says so', nc.ok && /Cracked mode was NOT turned on/.test(nc.warning) && /online-mode=true/.test(fs.readFileSync(path.join(dir('cracked2'), 'server.properties'), 'utf8')) && !exists(path.join(dir('cracked2'), 'plugins', 'SkinsRestorer.jar')), JSON.stringify(nc));
    const bd = await page.ev(`vp.server.install({ type: 'paper', version: '1.21.4', port: 25573, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('bedrock'))}, templateId: 'crossplay' })`);
    check('a Bedrock template installs Geyser and Floodgate and marks the server Bedrock-ready (more in e2e-addons.mjs)', bd.ok && bd.profile.bedrock === true && !bd.warning && fs.existsSync(path.join(dir('bedrock'), 'plugins', 'Geyser-Spigot.jar')), JSON.stringify(bd));

    const fab = await page.ev(`vp.server.install({ type: 'fabric', version: '1.21.4', port: 25574, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('fabric'))} })`);
    check('Fabric installs without a version file in its jar', fab.ok && fab.profile.build === 'loader 0.16.8 / installer 1.0.1' && fab.profile.name === 'Fabric server', JSON.stringify(fab));

    mc.state.mode.wrongVersion = true;
    const wrong = await rejects(page, `vp.server.install({ type: 'vanilla', version: '1.21.4', port: 25575, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('wrong'))} })`);
    mc.state.mode.wrongVersion = false;
    check('a jar of a different Minecraft version is refused and leaves no folder behind', /Minecraft 9\.9\.9, not the 1\.21\.4 you selected/.test(wrong) && !exists(dir('wrong')), wrong);
    const van = await page.ev(`vp.server.install({ type: 'vanilla', version: '1.21.4', port: 25576, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('vanilla'))} })`);
    check('Vanilla installs once the jar is right', van.ok && van.profile.build === undefined && exists(path.join(dir('vanilla'), 'server.jar')), JSON.stringify(van));

    // Import an existing server.
    fs.mkdirSync(path.join(dir('mine'), 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir('mine'), 'server.properties'), '#mine\nview-distance=12\nserver-port=25599\nwhite-list=true\n');
    fs.writeFileSync(path.join(dir('mine'), 'server.jar'), 'not touched');
    const det = await page.ev(`vp.server.detectExisting(${JSON.stringify(dir('mine'))})`);
    check('an existing server is recognised, with its type and port guessed', det.looksLikeServer && det.hasWorld && det.guessedType === 'vanilla' && det.guessedPort === 25599, JSON.stringify(det));
    const imp = await page.ev(`vp.server.import({ name: 'Mine', type: 'vanilla', version: '1.20.1', port: 25599, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir('mine'))} })`);
    importedId = imp.profile?.id;
    check('importing records the server and touches none of its files', imp.ok && fs.readFileSync(path.join(dir('mine'), 'server.jar'), 'utf8') === 'not touched' && fs.readFileSync(path.join(dir('mine'), 'server.properties'), 'utf8').includes('white-list=true'), JSON.stringify(imp));
    check('import refuses a missing folder, a bad port and a bad type', (await Promise.all([
      rejects(page, `vp.server.import({ name: 'x', type: 'vanilla', version: '1', port: 25565, serverDir: ${JSON.stringify(dir('nowhere'))} })`),
      rejects(page, `vp.server.import({ name: 'x', type: 'vanilla', version: '1', port: 99999, serverDir: ${JSON.stringify(dir('mine'))} })`),
      rejects(page, `vp.server.import({ name: 'x', type: 'forge', version: '1', port: 25565, serverDir: ${JSON.stringify(dir('mine'))} })`),
    ])).every((e) => e));

    // Edit it.
    const up = await page.ev(`vp.server.update(${JSON.stringify(importedId)}, { name: '  Renamed  ', port: '25601', maxRamMb: 4096, serverDir: 'C:\\\\evil' })`);
    const mineProps = fs.readFileSync(path.join(dir('mine'), 'server.properties'), 'utf8');
    check('editing changes name, port and RAM only (a folder change is ignored)', up.name === 'Renamed' && up.port === 25601 && up.maxRamMb === 4096 && up.serverDir === dir('mine'), JSON.stringify(up));
    check('and the new port is written into server.properties without touching other lines', mineProps === '#mine\nview-distance=12\nserver-port=25601\nwhite-list=true\n', JSON.stringify(mineProps));
    check('an invalid port is refused and changes nothing', /Invalid server profile/.test(await rejects(page, `vp.server.update(${JSON.stringify(importedId)}, { port: 'abc' })`)) && (await page.ev(`vp.server.get(${JSON.stringify(importedId)})`)).port === 25601);

    // Run the installed server, then try to delete it while it runs.
    check('the installed server starts', (await page.ev(`vp.server.start(${JSON.stringify(paperId)})`)).ok === true);
    await sleep(1500);
    check('and is online', (await page.ev('vp.server.state()')).serverStatus === 'online');
    const busy = await page.ev(`vp.server.remove(${JSON.stringify(paperId)})`);
    check('a running server cannot be removed', busy.ok === false && /Stop and un-publish/.test(busy.error), JSON.stringify(busy));
    await page.ev('vp.server.stop()'); await sleep(2500);
    const lastUsed = (await page.ev(`vp.server.get(${JSON.stringify(paperId)})`)).lastUsedAt;
    check('starting noted when the server was last used', lastUsed !== r.profile.createdAt, lastUsed);

    const cancelled = await page.ev(`vp.server.remove(${JSON.stringify(paperId)})`);
    check('cancelling the delete question changes nothing', cancelled.ok === false && cancelled.cancelled === true && exists(dir('paper')) && (await page.ev('vp.server.list()')).some((s) => s.id === paperId), JSON.stringify(cancelled));
  });

  await session('delete', async (page) => {
    const s = await page.ev('vp.discordSignIn()');
    // Shared folders: B lives inside A, so neither may be deleted, only listed off.
    fs.mkdirSync(path.join(dir('shared'), 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dir('shared'), 'server.properties'), 'x');
    fs.writeFileSync(path.join(dir('shared'), 'inner', 'server.properties'), 'y');
    const a = (await page.ev(`vp.server.import({ name: 'A', type: 'vanilla', version: '1', port: 25610, serverDir: ${JSON.stringify(dir('shared'))} })`)).profile.id;
    await page.ev(`vp.server.import({ name: 'B', type: 'vanilla', version: '1', port: 25611, serverDir: ${JSON.stringify(path.join(dir('shared'), 'inner'))} })`);
    const rA = await page.ev(`vp.server.remove(${JSON.stringify(a)})`);
    check('a folder another saved server shares is never deleted, only taken off the list', rA.ok === true && rA.deletedFiles === false && exists(path.join(dir('shared'), 'server.properties')) && !(await page.ev('vp.server.list()')).some((x) => x.id === a), JSON.stringify(rA));

    const rP = await page.ev(`vp.server.remove(${JSON.stringify(paperId)})`);
    check('"delete server and files" moves a clearly-its-own folder to the Recycle Bin and forgets it', rP.ok === true && rP.deletedFiles === true && !exists(dir('paper')) && !(await page.ev('vp.server.list()')).some((x) => x.id === paperId), JSON.stringify(rP));

    // A profile whose folder is gone, and one that is not a server folder at all.
    fs.mkdirSync(dir('notes'), { recursive: true });
    fs.writeFileSync(path.join(dir('notes'), 'todo.txt'), 'x');
    const n = (await page.ev(`vp.server.import({ name: 'Notes', type: 'vanilla', version: '1', port: 25612, serverDir: ${JSON.stringify(dir('notes'))} })`)).profile.id;
    const rN = await page.ev(`vp.server.remove(${JSON.stringify(n)})`);
    check('a folder that does not look like a server is never deleted', rN.ok === true && rN.deletedFiles === false && exists(path.join(dir('notes'), 'todo.txt')), JSON.stringify(rN));
    const v = (await page.ev('vp.server.list()')).find((x) => x.name === 'Fabric server').id;
    fs.rmSync(dir('fabric'), { recursive: true, force: true });
    const rF = await page.ev(`vp.server.remove(${JSON.stringify(v)})`);
    check('a server whose folder is already gone is simply taken off the list', rF.ok === true && rF.folderGone === true && rF.deletedFiles === false, JSON.stringify(rF));
    check('removing an unknown server is reported', (await page.ev("vp.server.remove('nope')")).error === 'Server profile not found.');
  });

  await session('list', async (page) => {
    await page.ev('vp.discordSignIn()');
    const r = await page.ev(`vp.server.remove(${JSON.stringify(importedId)})`);
    check('"only remove from the list" keeps every file of an imported server', r.ok === true && r.deletedFiles === false && exists(path.join(dir('mine'), 'world')) && exists(path.join(dir('mine'), 'server.jar')), JSON.stringify(r));
    check('and the language setting reaches the dialogs without breaking them', (await page.ev("vp.setLanguage('hinglish').then(() => true)")) === true);
  });
} finally {
  kill(accounts); mc.close();
  if (originalProfiles !== null) fs.writeFileSync(profilesFile, originalProfiles); else fs.rmSync(profilesFile, { force: true });
  fs.rmSync(testRoot, { recursive: true, force: true });
}
process.exit(done());

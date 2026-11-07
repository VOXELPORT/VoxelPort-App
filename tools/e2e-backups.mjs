// End to end through the real Tauri window: backups (manual, live, at stop), restore (asked first, undoable), settings,
// delete, and changing a server's Minecraft version (which backs up first), on a server installed through the app.
//   node tools/e2e-backups.mjs <debug-exe> <data-dir> <test-root> <stand-in-java-dir>
// Development builds only (uses debug-only env switches). Ends only the processes it starts, by PID.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

async function session(restoreAnswer, fn) {
  const app = launch(exe, { env: { PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_MC_API: mc.base, VOXELPORT_TEST_RESTORE: restoreAnswer } });
  const page = await connect();
  try { await page.ev('vp.discordSignIn()'); await fn(page); } finally { page.close(); kill(app); await sleep(1200); }
}
const J = JSON.stringify;
const dir = path.join(testRoot, 'bk');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const region = path.join(dir, 'world', 'region', 'r.0.0.mca');
const jar = path.join(dir, 'server.jar');
const rejects = (page, expr) => page.ev(`(async () => { try { await ${expr}; return null; } catch (e) { return String(e); } })()`);
let id, backupsDir, regionSha;
const listing = () => fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).sort() : [];

try {
  await session('no', async (page) => {
    await page.ev("(window.__log = [], window.__bp = [], vp.on('server:log', (l) => window.__log.push(l)), vp.on('backup:progress', (p) => window.__bp.push(p.phase + ':' + p.reason)), true)");
    const inst = await page.ev(`vp.server.install({ name: 'Backup Test', type: 'paper', version: '1.21.4', port: 25570, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(dir)} })`);
    id = inst.profile?.id;
    backupsDir = path.join(dataDir, 'backups', id);
    check('a server is installed through the app', inst.ok === true, J(inst));
    let info = await page.ev(`vp.backups.info(${J(id)})`);
    check('with no world yet the screen says so and offers no backup', info.hasWorld === false && info.backups.length === 0 && info.settings.auto === true && info.settings.intervalMin === 30 && info.settings.keep === 5 && info.dir === backupsDir && info.busy === false && info.running === false, J(info));
    const early = await page.ev(`vp.backups.create(${J(id)})`);
    check('a backup before any world exists is refused with a plain reason and leaves nothing', early.ok === false && early.code === 'no-world' && /Start the server once/.test(early.error) && listing().length === 0, J(early));

    // Give the server a world.
    fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'world_nether'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), crypto.randomBytes(1500));
    fs.writeFileSync(region, crypto.randomBytes(40_000));
    fs.writeFileSync(path.join(dir, 'world', 'session.lock'), 'held');
    fs.writeFileSync(path.join(dir, 'world_nether', 'level.dat'), crypto.randomBytes(400));
    fs.writeFileSync(path.join(dir, 'ops.json'), '[{"name":"Steve"}]');
    regionSha = sha(region);

    const b = await page.ev(`vp.backups.create(${J(id)})`);
    check('a manual backup is made', b.ok === true && /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_manual\.zip$/.test(b.backup.name) && b.backup.size > 0 && JSON.stringify([...b.backup.worlds].sort()) === '["world","world_nether"]', J(b));
    check('its time is right: the local-time name converts to the real moment', Math.abs(b.backup.createdAt - Date.now()) < 5000, `${b.backup.createdAt} vs ${Date.now()}`);
    const phases = await page.ev('window.__bp.join(",")');
    check('progress was reported from start to done', /starting:manual.*zipping:manual.*done:manual/.test(phases), phases);
    info = await page.ev(`vp.backups.info(${J(id)})`);
    check('the screen lists it, with a world now present', info.hasWorld === true && info.backups.length === 1 && info.backups[0].name === b.backup.name && info.backups[0].reason === 'manual');
    check('no temporary files are left in the backups folder', listing().every((n) => !n.endsWith('.partial')) && listing().length === 1);

    // Settings.
    const st = await page.ev(`vp.backups.setSettings(${J(id)}, { auto: false, intervalMin: '15', keep: 3 })`);
    check('backup settings are saved and kept on the profile', st.auto === false && st.intervalMin === 15 && st.keep === 3 && (await page.ev(`vp.server.get(${J(id)})`)).backups.keep === 3, J(st));
    const badSettings = await Promise.all([rejects(page, `vp.backups.setSettings(${J(id)}, { intervalMin: 2 })`), rejects(page, `vp.backups.setSettings(${J(id)}, { keep: 0 })`), rejects(page, `vp.backups.setSettings(${J(id)}, { auto: 'yes' })`), rejects(page, "vp.backups.setSettings('nope', {})")]);
    check('bad settings are refused with the Electron wording', /Minutes between backups must be between 5 and 720/.test(badSettings[0]) && /Backups to keep must be between 1 and 30/.test(badSettings[1]) && /must be on or off/.test(badSettings[2]) && /Server profile not found/.test(badSettings[3]), J(badSettings));
    await page.ev(`vp.backups.setSettings(${J(id)}, { auto: true })`);

    // Restore: cancelling the question changes nothing.
    fs.writeFileSync(region, 'wrecked by a creeper');
    const c = await page.ev(`vp.backups.restore(${J(id)}, ${J(b.backup.name)})`);
    check('cancelling the restore question changes nothing', c.ok === false && c.cancelled === true && fs.readFileSync(region, 'utf8') === 'wrecked by a creeper' && listing().length === 1, J(c));
    check('a bad backup name is refused before the question', (await page.ev(`vp.backups.restore(${J(id)}, '../../x.zip')`)).error === "That is not one of VoxelPort's backups.");
  });

  await session('yes', async (page) => {
    await page.ev("(window.__log = [], window.__bp = [], vp.on('server:log', (l) => window.__log.push(l)), vp.on('backup:progress', (p) => window.__bp.push(p.phase + ':' + p.reason)), true)");
    const name = listing().find((n) => n.endsWith('_manual.zip'));
    fs.writeFileSync(path.join(dir, 'world', 'new-build.txt'), 'built after the backup');
    fs.writeFileSync(path.join(dir, 'ops.json'), '[]');
    const r = await page.ev(`vp.backups.restore(${J(id)}, ${J(name)})`);
    const regionNow = sha(region);
    check('confirmed, the restore puts the world back exactly', r.ok === true && r.levelName === 'world' && r.safetyBackup?.endsWith('_before-restore.zip') && !fs.existsSync(path.join(dir, 'world', 'new-build.txt')) && fs.readFileSync(path.join(dir, 'ops.json'), 'utf8') === '[{"name":"Steve"}]' && regionNow === regionSha, J(r));
    check('no temporary folders remain',  fs.readdirSync(dir).every((n) => !n.startsWith('.vp-')), J(fs.readdirSync(dir)));
    check('the world as it was just before is saved first, so the restore can be undone', listing().some((n) => n === r.safetyBackup));
    const undo = await page.ev(`vp.backups.restore(${J(id)}, ${J(r.safetyBackup)})`);
    check('and undoing it brings back the build made after the backup', undo.ok === true && fs.readFileSync(path.join(dir, 'world', 'new-build.txt'), 'utf8') === 'built after the backup', J(undo));
    check('restore progress reached done', /unpacking:restore.*done:restore/.test(await page.ev('window.__bp.join(",")')));

    // A running server: restore is refused, a backup saves first and switches saving back on.
    check('the server starts', (await page.ev(`vp.server.start(${J(id)})`)).ok === true);
    await sleep(1500);
    const busy = await page.ev(`vp.backups.restore(${J(id)}, ${J(name)})`);
    check('a running server cannot be restored over', busy.ok === false && busy.code === 'running', J(busy));
    await page.ev('window.__log.length = 0');
    const live = await page.ev(`vp.backups.create(${J(id)})`);
    const lg = await page.ev('window.__log.join(" | ")');
    check('a live backup holds saving, saves, copies, and switches saving back on', live.ok === true && /Saving the world for a backup/.test(lg) && lg.indexOf('Automatic saving is now disabled') < lg.indexOf('Saved the game') && lg.indexOf('Saved the game') < lg.indexOf('Backup saved') && lg.indexOf('Backup saved') < lg.lastIndexOf('Automatic saving is now enabled'), lg);
    const off = await page.ev(`vp.backups.info(${J(id)})`);
    check('the screen reports it running', off.running === true);
    await page.ev('vp.server.stop()'); await sleep(2500);
  });

  await session('yes', async (page) => {
    // Backup at stop: after a clean stop a server nobody backed up gets one last backup.
    for (const e of (await page.ev(`vp.backups.info(${J(id)})`)).backups) await page.ev(`vp.backups.remove(${J(id)}, ${J(e.name)})`);
    check('every backup can be deleted, one file each', listing().length === 0);
    check('start for the stop-time backup', (await page.ev(`vp.server.start(${J(id)})`)).ok === true);
    await sleep(1500);
    await page.ev('vp.server.stop()');
    let made = false;
    for (let i = 0; i < 40 && !made; i++) { await sleep(250); made = listing().some((n) => n.endsWith('_stop.zip')); }
    check('a clean stop makes one last backup (reason "stop")', made, J(listing()));

    // With automatic backups off there is none.
    for (const e of (await page.ev(`vp.backups.info(${J(id)})`)).backups) await page.ev(`vp.backups.remove(${J(id)}, ${J(e.name)})`);
    await page.ev(`vp.backups.setSettings(${J(id)}, { auto: false })`);
    await page.ev(`vp.server.start(${J(id)})`); await sleep(1500);
    await page.ev('vp.server.stop()'); await sleep(3500);
    check('with automatic backups off, a stop makes none', listing().length === 0, J(listing()));
    await page.ev(`vp.backups.setSettings(${J(id)}, { auto: true })`);
    check('deleting with a bad name is refused', /not one of VoxelPort's backups/.test(await rejects(page, `vp.backups.remove(${J(id)}, '../x.zip')`)));

    // ── Changing the Minecraft version ────────────────────────────────────────
    const manual = await page.ev(`vp.backups.create(${J(id)})`); // a backup of 1.21.4 with its jar
    await page.ev('window.__bp = [], vp.on("install:progress", (p) => window.__bp.push(p.phase)), true');
    const before = sha(jar);
    const regionBefore = sha(region);
    const prof = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
    prof.servers[0].javaMajor = 21; // learned for the old jar: a restore of the old jar forgets it
    fs.writeFileSync(profilesFile, JSON.stringify(prof, null, 2));
    const n0 = listing().length;
    const cv = await page.ev(`vp.server.changeVersion(${J(id)}, '1.21.3')`);
    check('changing the version works, backs up first, and says what to check', cv.ok === true && cv.profile.version === '1.21.3' && cv.profile.build === '90' && /Check that your plugins support Minecraft 1\.21\.3/.test(cv.warning) && listing().length === n0 + 1, J(cv));
    check('only server.jar changed: the new jar is the new version, the world is untouched, no side file remains', sha(jar) !== before && sha(region) === regionBefore && !fs.existsSync(path.join(dir, '.server.jar.new')));
    check('progress ran backing-up, resolving, downloading, verifying, done', /backing-up.*resolving.*downloading.*verifying.*done/.test(await page.ev('window.__bp.join(",")')));
    check('the same version again is refused', (await page.ev(`vp.server.changeVersion(${J(id)}, '1.21.3')`)).error === 'This server is already on Minecraft 1.21.3.');
    check('an unknown version is refused and nothing changes', /Minecraft 9\.9 isn't available for paper/.test((await page.ev(`vp.server.changeVersion(${J(id)}, '9.9')`)).error) && sha(jar) !== before);
    const jarNow = sha(jar);
    mc.state.mode.wrongVersion = true;
    const wrong = await page.ev(`vp.server.changeVersion(${J(id)}, '1.20.6')`);
    mc.state.mode.wrongVersion = false;
    check('a jar of the wrong version is refused and the server keeps its jar', wrong.ok === false && /Minecraft 9\.9\.9, not the 1\.20\.6 you selected/.test(wrong.error) && sha(jar) === jarNow && !fs.existsSync(path.join(dir, '.server.jar.new')), J(wrong));
    check('an empty choice is refused', (await page.ev(`vp.server.changeVersion(${J(id)}, '  ')`)).error === 'Choose a Minecraft version.');
    const started = await page.ev(`vp.server.start(${J(id)})`);
    await sleep(1500);
    const running = await page.ev(`vp.server.changeVersion(${J(id)}, '1.20.6')`);
    check('a running server is refused', started.ok === true && running.error === 'Stop the server before changing its Minecraft version.', J(running));
    await page.ev('vp.server.stop()'); await sleep(3500);

    // Restoring the backup that has the old jar brings the old version back, and forgets the Java minimum.
    const old = await page.ev(`vp.backups.restore(${J(id)}, ${J(manual.backup.name)})`);
    const p2 = await page.ev(`vp.server.get(${J(id)})`);
    check('restoring a backup with the old jar puts the old version back on the profile and drops the Java minimum', old.ok === true && old.restoredServer.version === '1.21.4' && p2.version === '1.21.4' && p2.javaMajor === undefined && sha(jar) === before, J({ old, p2 }));

    // A server whose world never existed cannot be version-changed (the backup it needs cannot be made).
    const bare = await page.ev(`vp.server.install({ type: 'paper', version: '1.21.4', port: 25571, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(path.join(testRoot, 'bare'))} })`);
    const bareCv = await page.ev(`vp.server.changeVersion(${J(bare.profile.id)}, '1.21.3')`);
    check('with no world to back up, the version change is refused and the server untouched', bareCv.ok === false && /Couldn't back the server up first, so nothing was changed/.test(bareCv.error) && (await page.ev(`vp.server.get(${J(bare.profile.id)})`)).version === '1.21.4', J(bareCv));
  });
} finally {
  kill(accounts); mc.close();
  if (originalProfiles !== null) fs.writeFileSync(profilesFile, originalProfiles); else fs.rmSync(profilesFile, { force: true });
  fs.rmSync(testRoot, { recursive: true, force: true });
  if (id) fs.rmSync(path.join(dataDir, 'backups', id), { recursive: true, force: true });
}
process.exit(done());

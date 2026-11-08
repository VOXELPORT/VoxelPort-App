// End to end through the real Tauri window: bringing the previous (Electron) app's data over. The "previous app" is a synthetic folder made
// the way Electron makes it: a Windows-DPAPI-protected AES key in `Local State` (protected here by PowerShell, which calls the same DPAPI
// Chromium uses), a made-up device token sealed with that key as "v10" + nonce + AES-GCM, a server list, backups and settings.
// No real person's data is read: a development build only looks where VOXELPORT_LEGACY_DIR says.
//   node tools/e2e-legacy-import.mjs <debug-exe> <data-dir> <test-root>
// Development builds only. Ends only the processes it starts, by PID.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeRelay } from './fake-relay.mjs';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';
import { ID_A, newToken, vpIdOf, makeOldApp as makeOld, snapshot } from './legacy-fixture.mjs';

const [exe, dataDir, testRoot] = process.argv.slice(2);
const ACCOUNTS = 8799;
const { check, done } = reporter();
if (!dataDir.includes('in.voxelport.app.dev') || !testRoot.includes('vp-tauri-test')) throw new Error('refusing to touch folders that are not the dev ones');

const J = JSON.stringify;
const TOKEN = newToken();
const VP_ID = vpIdOf(TOKEN);
const IDENTITY_FILES = ['device-token.json', 'discord-gate.json', 'app-session.json', 'custom-address.json', 'preferences.json', 'bedrock-endpoints.json', 'legacy-import.json', 'legacy-handoff.json'];
const handoffFile = path.join(dataDir, 'legacy-handoff.json');
const readHandoff = () => { try { return JSON.parse(fs.readFileSync(handoffFile, 'utf8')); } catch { return null; } };
const unreadableCopies = () => fs.readdirSync(dataDir).filter((f) => f.startsWith('device-token.unreadable-'));

fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });
const profilesFile = path.join(dataDir, 'server-profiles.json');
const originalProfiles = fs.existsSync(profilesFile) ? fs.readFileSync(profilesFile, 'utf8') : null;
// A copy on disk too, so a run that is killed half way cannot lose the developer's own server list (it is restored below, in `finally`).
if (originalProfiles !== null) {
  const keep = path.join(path.dirname(testRoot), 'profile-backup');
  fs.mkdirSync(keep, { recursive: true });
  fs.writeFileSync(path.join(keep, `server-profiles.${Date.now()}.json`), originalProfiles);
}

const makeOldApp = (name, opts) => makeOld(testRoot, name, TOKEN, opts);

function resetData() {
  for (const f of IDENTITY_FILES) fs.rmSync(path.join(dataDir, f), { force: true });
  for (const f of unreadableCopies()) fs.rmSync(path.join(dataDir, f), { force: true });
  fs.rmSync(path.join(dataDir, 'backups', ID_A), { recursive: true, force: true });
  fs.writeFileSync(profilesFile, J({ version: 2, servers: [] }));
}

const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const relay = await startFakeRelay();
await sleep(600);

async function session(env, fn, args = []) {
  const app = launch(exe, { args, env: { VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_RELAY_URL: relay.url, ...env } });
  const page = await connect();
  try {
    await page.ev("(window.confirm = () => true, true)"); // the "are you sure" box answers yes; the test reads what it would have said below
    await page.ev('vp.discordSignIn()');
    await fn(page);
  } finally { page.close(); kill(app); await sleep(1500); }
}
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const banner = (page) => page.ev("(() => { const b = document.getElementById('legacyBanner'); return { visible: !b.classList.contains('hidden'), text: document.getElementById('legacyBannerText').textContent }; })()");
const supporterId = (page) => page.ev('vp.info().then((i) => i.supporterID)');

try {
  // ── a development build looks nowhere by itself ──
  resetData();
  const oldApp = makeOldApp('electron-userdata');
  await session({}, async (page) => {
    await sleep(800);
    check('a development build never goes looking for a real old app: nothing offered', (await page.ev('vp.legacyImport.detect()')).available === false && (await banner(page)).visible === false);
    check('and running the import with nothing to find says so', (await page.ev('vp.legacyImport.run()')).ok === false);
  });

  // ── what is offered, with a public address running, then the import ──
  resetData();
  const before = snapshot(oldApp);
  await session({ VOXELPORT_LEGACY_DIR: oldApp }, async (page) => {
    const mine = await supporterId(page);
    check('this PC starts with an ID of its own', /^[0-9a-f]{12}$/.test(mine) && mine !== VP_ID, mine);
    const s = await page.ev('vp.legacyImport.detect()');
    check('the banner counts what is there: a new ID, one usable server, its two backups', s.available === true && s.identity === 'new' && s.vpId === VP_ID && s.newServers === 1 && s.backupFiles === 2 && s.servers.length === 2, J(s));
    check('the screen is never given the token itself', !J(s).includes(TOKEN) && !J(s).includes('vp_'));
    check('the banner shows, in words', await waitFor(async () => (await banner(page)).visible) && /1 server/.test((await banner(page)).text) && new RegExp(VP_ID).test((await banner(page)).text), J(await banner(page)));
    await page.ev("document.getElementById('legacyLaterBtn').click()");
    check('"Not now" hides it for this run', (await banner(page)).visible === false);

    // A running public address must not have its ID swapped under it.
    await page.ev('vp.start({ localPort: 25999 })');
    check('a public address is running', await waitFor(async () => relay.state.registers.length >= 1 && relay.connected()));
    const refused = await page.ev('vp.legacyImport.run()');
    check('the import refuses while a public address runs, and changes nothing', refused.ok === false && /Stop the public address/.test(refused.error) && (await supporterId(page)) === mine && (await page.ev('vp.server.list()')).length === 0, J(refused));
    await page.ev('vp.stop()');
    await sleep(800);

    // The button.
    await page.ev("document.getElementById('legacyBanner').classList.remove('hidden')");
    await page.ev("document.getElementById('legacyBringBtn').click()");
    check('pressing the button brings it over and says what came', await waitFor(async () => /Brought over/.test((await banner(page)).text), 15000), J(await banner(page)));
    const said = (await banner(page)).text;
    check('the message names the ID, the server and the backups', said.includes(VP_ID) && /1 server/.test(said) && /2 backups/.test(said), said);
    check('this PC now has the old app\'s VoxelPort ID, live (no restart)', (await supporterId(page)) === VP_ID);
    check('the one usable server is in the list, under its own id and folder', await waitFor(async () => (await page.ev('vp.server.list()')).some((p) => p.id === ID_A && p.name === 'Old Survival' && p.serverDir === path.join(oldApp, 'servers', 'survival'))));
    check('the server whose folder is gone was left out', (await page.ev('vp.server.list()')).length === 1);
    const bk = path.join(dataDir, 'backups', ID_A);
    check('both backups are in the new app, byte for byte', fs.readdirSync(bk).length === 2 && fs.readFileSync(path.join(bk, '2026-01-02_03-04-05_manual.zip'), 'utf8') === 'zip one');
    const bi = await page.ev(`vp.backups.info(${J(ID_A)})`);
    check('and the Backups screen lists them', bi.backups.length === 2, J(bi));
    const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'));
    check('the region and presence choices came, and nothing else of the old preferences', J(prefs) === J({ region: 'eu', presence: false }), J(prefs));
    check('the custom address came with the ID', J(JSON.parse(fs.readFileSync(path.join(dataDir, 'custom-address.json'), 'utf8'))) === J({ name: 'mycraft', address: 'mycraft.voxelport.in', region: 'eu' }));
    check('the Bedrock address came (its key is made with the token)', Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, 'bedrock-endpoints.json'), 'utf8'))).some((e) => e.publicPort === 26335));
    check('the ID this PC had before is kept in a file beside the new one', unreadableCopies().length === 1);
    check('the banner now offers only "OK"', await page.ev("document.getElementById('legacyCloseBtn').classList.contains('hidden') === false && document.getElementById('legacyBringBtn').classList.contains('hidden')"));
  });
  check('the old app\'s folder is exactly as it was (every file, byte for byte)', snapshot(oldApp) === before);

  // ── it is offered once ──
  await session({ VOXELPORT_LEGACY_DIR: oldApp }, async (page) => {
    await sleep(800);
    check('after an import it is not offered again', (await page.ev('vp.legacyImport.detect()')).available === false && (await banner(page)).visible === false);
    check('the ID survived the restart of the app (stored encrypted, read back)', (await supporterId(page)) === VP_ID);
    check('and so did the server', (await page.ev('vp.server.list()')).some((p) => p.id === ID_A));
  });

  // ── "Don't ask again" ──
  resetData();
  await session({ VOXELPORT_LEGACY_DIR: oldApp }, async (page) => {
    check('offered again on a fresh data folder', await waitFor(async () => (await banner(page)).visible));
    await page.ev("document.getElementById('legacyNeverBtn').click()");
    await sleep(500);
    check('"Don\'t ask again" hides it and writes the note', (await banner(page)).visible === false && JSON.parse(fs.readFileSync(path.join(dataDir, 'legacy-import.json'), 'utf8')).dismissed === true);
  });
  await session({ VOXELPORT_LEGACY_DIR: oldApp }, async (page) => {
    await sleep(800);
    check('and it stays away on the next start', (await page.ev('vp.legacyImport.detect()')).available === false);
  });

  // ── the previous app's "update" button: this app is started with --migrate-from-electron and brings everything over at once ──
  resetData();
  const beforeHandoff = snapshot(oldApp);
  await session({ VOXELPORT_LEGACY_DIR: oldApp }, async (page) => {
    check('started with the switch, it answers the previous app (ok, and which ID)', await waitFor(async () => readHandoff()?.ok === true, 20000) && readHandoff().identity === 'imported', J(readHandoff()));
    check('this PC has the old app\'s ID and the server, with no button pressed', (await supporterId(page)) === VP_ID && (await page.ev('vp.server.list()')).some((p) => p.id === ID_A));
    check('the screen says what came, once', await waitFor(async () => /Brought over/.test((await banner(page)).text)) && (await banner(page)).visible, J(await banner(page)));
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, 'legacy-import.json'), 'utf8'));
    check('the import is recorded as done and the announcement was used up', marker.done === true && marker.announce === undefined && (await page.ev('vp.legacyImport.detect()')).available === false);
    check('the answer file carries no secret', !fs.readFileSync(handoffFile, 'utf8').includes(TOKEN));
  }, ['--migrate-from-electron']);
  check('the old app\'s folder is exactly as it was after that too', snapshot(oldApp) === beforeHandoff);

  // The same switch on a copy that is already open (the installer starts its own copy first, then the button starts another).
  resetData();
  await session({ VOXELPORT_LEGACY_DIR: oldApp }, async (page) => {
    await sleep(800);
    check('open without the switch it only offers', readHandoff() === null && (await supporterId(page)) !== VP_ID);
    const second = spawn(exe, ['--migrate-from-electron'], { stdio: 'ignore', env: { ...process.env, VOXELPORT_LEGACY_DIR: oldApp } });
    const ended = await new Promise((resolve) => { const t = setTimeout(() => { kill(second); resolve(false); }, 10000); second.on('exit', () => { clearTimeout(t); resolve(true); }); });
    check('the second copy ends at once', ended);
    check('the open copy brought the data over when the second one asked', await waitFor(async () => readHandoff()?.ok === true, 20000) && (await supporterId(page)) === VP_ID, J(readHandoff()));
    check('and its screen says what came', await waitFor(async () => /Brought over/.test((await banner(page)).text), 15000), J(await banner(page)));
  });

  // The same switch while a public address is running: refused, and the answer says so (the old app then keeps itself).
  resetData();
  await session({ VOXELPORT_LEGACY_DIR: oldApp }, async (page) => {
    await page.ev('vp.start({ localPort: 25999 })');
    check('a public address is running', await waitFor(async () => relay.state.registers.length >= 1 && relay.connected()));
    const mine = await supporterId(page);
    const second = spawn(exe, ['--migrate-from-electron'], { stdio: 'ignore', env: { ...process.env, VOXELPORT_LEGACY_DIR: oldApp } });
    await new Promise((resolve) => { const t = setTimeout(() => { kill(second); resolve(); }, 10000); second.on('exit', () => { clearTimeout(t); resolve(); }); });
    check('the answer is "no", with the reason, and nothing changed', await waitFor(async () => readHandoff()?.ok === false, 15000) && /public address/i.test(readHandoff().error) && (await supporterId(page)) === mine && !fs.existsSync(path.join(dataDir, 'legacy-import.json')), J(readHandoff()));
    await page.ev('vp.stop()');
    await sleep(500);
  });

  // ── an ID that cannot be opened: the rest still comes, and the person is told what to do ──
  resetData();
  const damaged = makeOldApp('electron-userdata-damaged', { key: false });
  await session({ VOXELPORT_LEGACY_DIR: damaged }, async (page) => {
    const mine = await supporterId(page);
    const s = await page.ev('vp.legacyImport.detect()');
    check('an ID that cannot be opened is shown as such (but the servers are still worth bringing)', s.available === true && s.identity === 'unreadable' && s.vpId === null && s.newServers === 1, J(s));
    await page.ev("document.getElementById('legacyBringBtn').click()");
    check('the import still brings the servers and tells the person to restore from the Discord backup', await waitFor(async () => /Discord backup/.test((await banner(page)).text), 15000), J(await banner(page)));
    check('this PC\'s own ID is left alone', (await supporterId(page)) === mine && unreadableCopies().length === 0);
    check('and the caches that belong to the old ID were not copied', !fs.existsSync(path.join(dataDir, 'custom-address.json')) && !fs.existsSync(path.join(dataDir, 'bedrock-endpoints.json')));
    check('the server is there', (await page.ev('vp.server.list()')).some((p) => p.id === ID_A));
  });
} finally {
  accounts.kill(); relay.close();
  for (const f of IDENTITY_FILES) fs.rmSync(path.join(dataDir, f), { force: true });
  for (const f of unreadableCopies()) fs.rmSync(path.join(dataDir, f), { force: true });
  fs.rmSync(path.join(dataDir, 'backups', ID_A), { recursive: true, force: true });
  if (originalProfiles === null) fs.rmSync(profilesFile, { force: true }); else fs.writeFileSync(profilesFile, originalProfiles);
}
process.exit(done());

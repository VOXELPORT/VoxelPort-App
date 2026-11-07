// End to end through the real Tauri window: updating the app. A stand-in installer is signed with a throwaway key (made here, never kept),
// served by a stand-in update server, and the app is driven through the cases that matter: a good update, one whose bytes were changed, one
// signed for an older version but announced as a newer one (a downgrade), one signed with another key, a version that is not newer, a build
// that is not set up for updates, and the question asked before an update stops a running server.
//   node tools/e2e-update.mjs <debug-exe> <data-dir> <test-root> <stand-in-java-dir> <stand-in-installer-exe>
// Development builds only (uses debug-only env switches). Ends only the processes it starts, by PID.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startFakeMc } from './fake-mc.mjs';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';

const [exe, dataDir, testRoot, javaDir, installerExe] = process.argv.slice(2);
const ACCOUNTS = 8799, MC = 8797, UPDATES = 8793;
const { check, done } = reporter();
if (!dataDir.includes('in.voxelport.app.dev') || !testRoot.includes('vp-tauri-test')) throw new Error('refusing to touch folders that are not the dev ones');

for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json']) fs.rmSync(path.join(dataDir, f), { force: true });
fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });
const profilesFile = path.join(dataDir, 'server-profiles.json');
const originalProfiles = fs.existsSync(profilesFile) ? fs.readFileSync(profilesFile, 'utf8') : null;
fs.writeFileSync(profilesFile, JSON.stringify({ version: 2, servers: [] }));

// ── Throwaway signing keys and a signed stand-in installer ──────────────────────────────────────────────────
const repo = path.join(import.meta.dirname, '..');
const cli = path.join(repo, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const signer = (...args) => execFileSync(process.execPath, [cli, 'signer', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const makeKey = (name) => { const f = path.join(testRoot, name); signer('generate', '--ci', '-p', '', '-w', f); return { priv: f, pub: fs.readFileSync(`${f}.pub`, 'utf8').trim() }; };
const good = makeKey('good.key'), other = makeKey('other.key');
const installerBytes = fs.readFileSync(installerExe);
const installerFile = path.join(testRoot, 'installer.exe');
fs.writeFileSync(installerFile, installerBytes);
/** The signature of the installer by `key`, bound to `version`. */
const sign = (key, version) => { signer('sign', '-f', key.priv, '-p', '', '--app-version', version, installerFile); const sig = fs.readFileSync(`${installerFile}.sig`, 'utf8').trim(); fs.rmSync(`${installerFile}.sig`); return sig; };
const signatures = { goodNew: sign(good, '99.0.0'), goodOld: sign(good, '0.0.1'), goodAs1: sign(good, '1.0.0'), otherKey: sign(other, '99.0.0') };

// ── The stand-in update server ──────────────────────────────────────────────────────────────────────────────
const scenario = { version: '99.0.0', signature: signatures.goodNew, bytes: installerBytes, manifestHits: 0, downloads: 0 };
const setScenario = (version, signature, bytes = installerBytes) => Object.assign(scenario, { version, signature, bytes });
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${UPDATES}`;
  if (req.url.startsWith('/latest.json')) {
    scenario.manifestHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ version: scenario.version, notes: 'A test update', pub_date: '2026-11-08T00:00:00Z', platforms: { 'windows-x86_64': { signature: scenario.signature, url: `${base}/installer.exe` } } }));
  }
  if (req.url.startsWith('/installer.exe')) { scenario.downloads++; res.writeHead(200, { 'content-length': scenario.bytes.length }); return res.end(scenario.bytes); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(UPDATES, '127.0.0.1', r));
const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const mc = await startFakeMc(MC);
await sleep(600);

const J = JSON.stringify;
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const installMark = path.join(testRoot, 'installer-ran.txt');
const stopMark = path.join(testRoot, 'server-stopped.txt');
const events = (page) => page.ev('window.__up');
const dir = path.join(testRoot, 'srv');

/** Runs the app against the update server (or with no update settings at all) and gives the page to `fn`. */
async function session({ configured = true, switchAnswer = 'no', pubkey = good.pub }, fn) {
  const env = { PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_MC_API: mc.base, VOXELPORT_MODRINTH_API: `${mc.base}/v2`, VOXELPORT_TEST_SWITCH: switchAnswer, VP_FAKE_INSTALL_MARK: installMark, VP_FAKE_STOP_MARK: stopMark, VOXELPORT_DISCORD_PIPE: 'vp-no-such-discord' };
  if (configured) Object.assign(env, { VOXELPORT_UPDATE_URL: `http://127.0.0.1:${UPDATES}/latest.json`, VOXELPORT_UPDATE_PUBKEY: pubkey });
  const app = launch(exe, { env });
  let exited = false;
  app.on('exit', () => { exited = true; });
  const page = await connect();
  try {
    await page.ev("(window.__up = [], ['update:available','update:downloaded','update:error'].forEach((c) => vp.on(c, (p) => window.__up.push([c, p]))), true)");
    await page.ev('vp.discordSignIn()');
    await fn(page, () => exited);
  } finally { page.close(); kill(app); await sleep(1200); }
}

let id;
const online = async (page) => waitFor(async () => (await page.ev('vp.server.state()')).serverStatus === 'online', 15000);
const stopped = async (page) => waitFor(async () => (await page.ev('vp.server.state()')).serverStatus === 'stopped', 15000);

try {
  // ── A good update, and the question before it stops a server ────────────
  await session({ switchAnswer: 'no' }, async (page) => {
    const inst = await page.ev(`vp.server.install({ name: 'Update Test', type: 'paper', version: '1.21.4', port: 25592, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(dir)} })`);
    id = inst.profile?.id;
    check('a server is installed through the app', inst.ok === true, J(inst));
    check('before any check, nothing is waiting to be installed', J(await page.ev('vp.update.state()')) === '{"readyToInstall":false}');
    const found = await page.ev('vp.update.check()');
    check('the Check for updates button finds the new version', found.status === 'available' && found.version === '99.0.0', J(found));
    check('it downloads and verifies in the background, and the banner is told', await waitFor(async () => (await events(page)).some((e) => e[0] === 'update:downloaded' && e[1] === '99.0.0')) && (await events(page)).some((e) => e[0] === 'update:available' && e[1] === '99.0.0'), J(await events(page)));
    check('then it is ready to install, and pressing the button again says so without downloading again', (await page.ev('vp.update.state()')).readyToInstall === true && J(await page.ev('vp.update.check()')) === '{"status":"downloaded","version":"99.0.0"}' && scenario.downloads === 1, `downloads=${scenario.downloads}`);
    const r = await page.ev(`vp.server.start(${J(id)})`);
    check('a server is running', r.ok === true && await online(page), J(r));
    const no = await page.ev('vp.update.install()');
    check('installing asks first when a server runs, and "no" changes nothing', no.ok === false && no.cancelled === true && (await page.ev('vp.server.state()')).serverStatus === 'online' && (await page.ev('vp.update.state()')).readyToInstall === true && !fs.existsSync(installMark), J(no));
    await page.ev('vp.server.stop()');
    await stopped(page);
    fs.rmSync(stopMark, { force: true });
  });

  await session({ switchAnswer: 'yes' }, async (page, exited) => {
    await page.ev('vp.update.check()');
    check('(in a fresh run the good update is downloaded again)', await waitFor(async () => (await page.ev('vp.update.state()')).readyToInstall === true));
    await page.ev(`vp.server.start(${J(id)})`);
    await online(page);
    page.ev('vp.update.install()').catch(() => {}); // the app ends before this answers
    check('with "yes" the server is saved and stopped, the installer runs, and the app ends', await waitFor(() => fs.existsSync(installMark) && exited(), 30000), `mark=${fs.existsSync(installMark)} exited=${exited()}`);
    check('and the server had stopped before the installer started', fs.existsSync(stopMark) && fs.existsSync(installMark) && fs.statSync(stopMark).mtimeMs <= fs.statSync(installMark).mtimeMs, `stop=${fs.existsSync(stopMark)}`);
    check('the installer ran with the arguments the updater gives it', fs.existsSync(installMark) && /^ran with: /.test(fs.readFileSync(installMark, 'utf8')), fs.existsSync(installMark) ? fs.readFileSync(installMark, 'utf8') : 'no mark');
  });
  fs.rmSync(installMark, { force: true });

  // ── Updates that must never be installed ────────────────────────────────
  const refused = async (name, version, signature, bytes) => {
    setScenario(version, signature, bytes);
    await session({}, async (page) => {
      const r = await page.ev('vp.update.check()');
      await sleep(2500);
      const ev = await events(page);
      check(`${name}: it is never offered`, !ev.some((e) => e[0] === 'update:downloaded') && (await page.ev('vp.update.state()')).readyToInstall === false && (await page.ev('vp.update.install()')).ok === false, J({ r, ev }));
      check(`${name}: the person is told it failed`, ev.some((e) => e[0] === 'update:error' && typeof e[1] === 'string' && e[1].length > 0) || r.status === 'error', J({ r, ev }));
    });
    check(`${name}: and no installer ran`, !fs.existsSync(installMark));
  };
  await refused('bytes changed after signing', '99.0.0', signatures.goodNew, Buffer.concat([installerBytes, Buffer.from('tampered')]));
  await refused('signed for an older version but announced as a newer one (a downgrade)', '99.0.0', signatures.goodAs1, installerBytes);
  await refused('signed with another key', '99.0.0', signatures.otherKey, installerBytes);

  // ── Nothing newer ───────────────────────────────────────────────────────
  setScenario('0.0.1', signatures.goodOld);
  await session({}, async (page) => {
    const r = await page.ev('vp.update.check()');
    check('an older version is "up to date"', r.status === 'up-to-date' && (await page.ev('vp.update.state()')).readyToInstall === false, J(r));
  });
  setScenario('0.1.0', signatures.goodNew);
  await session({}, async (page) => {
    check('the same version is "up to date" too', (await page.ev('vp.update.check()')).status === 'up-to-date');
  });

  // ── A build that is not set up for updates ──────────────────────────────
  scenario.manifestHits = 0;
  await session({ configured: false }, async (page) => {
    const r = await page.ev('vp.update.check()');
    check('a development build says it cannot update itself, and why', r.status === 'unsupported' && r.reason === 'dev', J(r));
    check('and it never installs anything', (await page.ev('vp.update.install()')).ok === false && J(await page.ev('vp.update.state()')) === '{"readyToInstall":false}');
    await sleep(500);
    check('and never asked the update server', scenario.manifestHits === 0, `hits=${scenario.manifestHits}`);
  });
} finally {
  kill(accounts); server.close(); mc.close();
  if (originalProfiles !== null) fs.writeFileSync(profilesFile, originalProfiles); else fs.rmSync(profilesFile, { force: true });
  fs.rmSync(testRoot, { recursive: true, force: true });
}
process.exit(done());

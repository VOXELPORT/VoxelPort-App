// End to end through the real Tauri window: the Settings screen, friends-only (whitelist), the file browser, player accounts
// (cracked mode), the small fixes and restart, on a server installed through the app from stand-in services.
//   node tools/e2e-config.mjs <debug-exe> <data-dir> <test-root> <stand-in-java-dir>
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

const app = launch(exe, { env: { PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_MC_API: mc.base, VOXELPORT_MODRINTH_API: `${mc.base}/v2` } });
const page = await connect();
const rejects = async (expr) => page.ev(`(async () => { try { await ${expr}; return null; } catch (e) { return String(e); } })()`);
const J = JSON.stringify;
const dir = path.join(testRoot, 'cfg');
const props = () => fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
const logs = () => page.ev('window.__log.join(" | ")');

try {
  await page.ev("(window.__log = [], window.__acc = [], vp.on('server:log', (l) => window.__log.push(l)), vp.on('accounts:progress', (p) => window.__acc.push(p.stage)), true)");
  const s = await page.ev('vp.discordSignIn()');
  check('signed in first', s.ok && s.state.allowed, J(s));
  const inst = await page.ev(`vp.server.install({ name: 'Config Test', type: 'paper', version: '1.21.4', port: 25570, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(dir)}, templateId: 'survival' })`);
  const id = inst.profile?.id;
  check('a server to configure is installed through the app', inst.ok === true, J(inst));

  // ── Settings ─────────────────────────────────────────────────────────────
  let g = await page.ev(`vp.server.getSettings(${J(id)})`);
  check('the settings screen gets the profile, 12 fields (none of them online-mode), typed values and the Bedrock port', g.profile.id === id && g.fields.length === 12 && !g.fields.some((f) => f.key === 'online-mode' || f.key.startsWith('rcon')) && g.values.gamemode === 'survival' && g.values.difficulty === 'normal' && g.values['max-players'] === 20 && g.values.pvp === true && g.bedrock.supported === true && g.bedrock.enabled === false && g.bedrock.port === 19132 && g.running === false && g.totalMemMb > 0 && g.listing.enabled === false, J({ ...g, fields: g.fields.length }));

  const save = await page.ev(`vp.server.saveSettings({ id: ${J(id)}, name: '  Renamed Server ', port: 25580, ramMb: 2048, properties: { motd: 'Hello ✨', difficulty: 'hard', 'white-list': true, 'max-players': '30' }, listing: { enabled: true, description: ' a\\u0001 b ' }, voice: { enabled: true, plugin: 'simple', port: 24454 } })`);
  check('saving applies name, port, RAM, listing and voice to the profile', save.ok && save.restartNeeded === false && save.profile.name === 'Renamed Server' && save.profile.port === 25580 && save.profile.minRamMb === 2048 && save.profile.maxRamMb === 2048 && save.profile.listing.description === 'a b' && save.profile.voice.port === 24454, J(save));
  const p1 = props();
  check('and writes only the asked-for lines into server.properties, escaped, safety settings untouched', /server-port=25580/.test(p1) && /motd=Hello \\u2728/.test(p1) && /difficulty=hard/.test(p1) && /max-players=30/.test(p1) && /white-list=true/.test(p1) && /enforce-whitelist=true/.test(p1) && /online-mode=true/.test(p1) && /enable-command-block=false/.test(p1), p1);

  const bad = await Promise.all([
    rejects(`vp.server.saveSettings({ id: ${J(id)}, properties: { 'online-mode': false } })`),
    rejects(`vp.server.saveSettings({ id: ${J(id)}, properties: { 'enable-rcon': true } })`),
    rejects(`vp.server.saveSettings({ id: ${J(id)}, properties: { gamemode: 'god' } })`),
    rejects(`vp.server.saveSettings({ id: ${J(id)}, properties: { motd: 'x'.repeat(60) } })`),
    rejects(`vp.server.saveSettings({ id: ${J(id)}, port: 0 })`),
    rejects(`vp.server.saveSettings({ id: ${J(id)}, ramMb: 100 })`),
    rejects(`vp.server.saveSettings({ id: ${J(id)}, voice: { enabled: true, plugin: 'evil', port: 24454 } })`),
    rejects(`vp.server.saveSettings({ id: 'nope', properties: {} })`),
  ]);
  check('dangerous keys and bad values are refused with the Electron wording', bad[0]?.includes("can't be changed here") && bad[1]?.includes("can't be changed here") && /Invalid game mode/.test(bad[2]) && /at most 59/.test(bad[3]) && /Enter a valid port/.test(bad[4]) && /Invalid RAM amount/.test(bad[5]) && /valid voice plugin/.test(bad[6]) && /Server profile not found/.test(bad[7]), J(bad));
  check('and a refused save changes nothing', (await page.ev(`vp.server.get(${J(id)})`)).port === 25580 && /online-mode=true/.test(props()));

  // ── Friends-only ─────────────────────────────────────────────────────────
  let w = await page.ev(`vp.whitelist.status(${J(id)})`);
  check('friends-only starts on (the settings turned it on) with nobody listed', w.ok && w.enabled === true && w.friends.length === 0 && w.cracked === false && w.running === false, J(w));
  w = await page.ev(`vp.whitelist.add(${J(id)}, 'Steve, Alex ab steve')`);
  check('adding friends reports added and invalid names, and a restart is needed while stopped', w.ok && JSON.stringify(w.added) === '["Steve","Alex"]' && JSON.stringify(w.invalid) === '["ab"]' && w.restartNeeded === true && w.total === 2, J(w));
  check('the list is in whitelist.json', JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'whitelist.json'), 'utf8')).map((e) => e.name)) === '["Steve","Alex"]');
  w = await page.ev(`vp.whitelist.remove(${J(id)}, 'Steve')`);
  check('removing a friend works', w.ok && w.total === 1 && (await page.ev(`vp.whitelist.status(${J(id)})`)).friends[0] === 'Alex');
  check('a bad name is refused', (await page.ev(`vp.whitelist.remove(${J(id)}, 'bad name')`)).ok === false);
  w = await page.ev(`vp.whitelist.setEnabled(${J(id)}, false)`);
  check('turning friends-only off keeps the names', w.ok && w.on === false && /white-list=false/.test(props()) && (await page.ev(`vp.whitelist.status(${J(id)})`)).friends.length === 1);
  check('an unknown server is reported', (await page.ev("vp.whitelist.status('nope')")).error === 'Server profile not found.');

  // ── Files ────────────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(dir, 'ops.json'), '[]');
  fs.writeFileSync(path.join(dir, 'latest.log'), 'log');
  const l = await page.ev(`vp.files.list(${J(id)}, '')`);
  const byName = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  check('the file browser lists the folder, marking what can be edited', l.ok && l.path === '' && byName['server.properties'].editable === true && byName['server.jar'].editable === false && byName['latest.log'].editable === false && byName['ops.json'].editable === true, J(l.entries.map((e) => e.name)));
  const r = await page.ev(`vp.files.read(${J(id)}, 'server.properties')`);
  check('a text file can be read', r.ok && /server-port=25580/.test(r.text) && r.readOnly === false);
  check('a log is read-only', (await page.ev(`vp.files.read(${J(id)}, 'latest.log')`)).readOnly === true && /cannot be edited/.test((await page.ev(`vp.files.write(${J(id)}, 'latest.log', 'x')`)).error));
  check('a path that leaves the folder is refused', (await Promise.all(['../x.txt', 'C:/Windows/win.ini', 'ops.json:evil', '..\\..\\x'].map((p) => page.ev(`vp.files.read(${J(id)}, ${J(p)})`)))).every((x) => x.ok === false && /not allowed/.test(x.error)));
  const wr = await page.ev(`vp.files.write(${J(id)}, 'ops.json', '[{"name":"a"}]')`);
  check('an existing JSON file is saved when valid', wr.ok && fs.readFileSync(path.join(dir, 'ops.json'), 'utf8') === '[{"name":"a"}]');
  const wb = await page.ev(`vp.files.write(${J(id)}, 'ops.json', '[{')`);
  check('and refused, with the old file kept, when it is not', wb.ok === false && /not valid JSON/.test(wb.error) && fs.readFileSync(path.join(dir, 'ops.json'), 'utf8') === '[{"name":"a"}]');
  check('no new file can be made from here', (await page.ev(`vp.files.write(${J(id)}, 'brand-new.txt', 'x')`)).ok === false && !fs.existsSync(path.join(dir, 'brand-new.txt')));

  // ── Accounts (cracked mode) ──────────────────────────────────────────────
  let a = await page.ev(`vp.accounts.get(${J(id)})`);
  check('a normal server is premium-only, with no login plugin, and can take one (Paper)', a.cracked === false && a.loginPlugin === false && a.canInstallLogin === true && a.running === false, J(a));
  const noConfirm = await page.ev(`vp.accounts.set(${J(id)}, true, false)`);
  check('cracked mode is refused until confirmed', noConfirm.ok === false && /Confirm that you understand/.test(noConfirm.error) && /online-mode=true/.test(props()));
  const il = await page.ev(`vp.accounts.installLogin(${J(id)})`);
  check('the login plugin installs from Modrinth into plugins/ with progress', il.ok === true && fs.existsSync(path.join(dir, 'plugins', 'AuthMe-5.7.0.jar')) && (await page.ev('window.__acc.join(",")')).startsWith('resolve,download'), J(il) + (await page.ev('window.__acc.join(",")')));
  const on = await page.ev(`vp.accounts.set(${J(id)}, true, true)`);
  check('confirmed, cracked mode turns on (only the two keys change)', on.ok && on.cracked === true && /online-mode=false/.test(props()) && /enforce-secure-profile=false/.test(props()) && /server-port=25580/.test(props()) && /motd=Hello/.test(props()), props());
  w = await page.ev(`vp.whitelist.add(${J(id)}, 'Zed')`);
  check('friends-only warns that names are not account-checked on a cracked server', w.ok && w.cracked === true);
  const off = await page.ev(`vp.accounts.set(${J(id)}, false)`);
  check('and it turns off with no confirmation', off.ok && off.cracked === false && /online-mode=true/.test(props()) && (await page.ev(`vp.accounts.get(${J(id)})`)).loginPlugin === true);

  // ── Fix ──────────────────────────────────────────────────────────────────
  fs.rmSync(path.join(dir, 'eula.txt'));
  check('the "accept the EULA" fix writes eula.txt', (await page.ev(`vp.server.fix(${J(id)}, 'eula')`)).ok && /eula=true/.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8')));
  check('an unknown fix is refused', (await page.ev(`vp.server.fix(${J(id)}, 'format-c')`)).error === 'Unknown fix.');

  // ── A running server ─────────────────────────────────────────────────────
  check('restart with nothing running says so', (await page.ev('vp.server.restart()')).error === 'The server is not running.');
  check('the server starts', (await page.ev(`vp.server.start(${J(id)})`)).ok === true);
  await sleep(1500);
  g = await page.ev(`vp.server.getSettings(${J(id)})`);
  check('settings now report it running', g.running === true);
  const sv = await page.ev(`vp.server.saveSettings({ id: ${J(id)}, properties: { motd: 'Live' } })`);
  check('saving while it runs says a restart is needed', sv.ok && sv.restartNeeded === true);
  const wl = await page.ev(`vp.whitelist.add(${J(id)}, 'Bob')`);
  await sleep(500);
  const lg = await logs();
  check('adding a friend to a running server sends the whitelist commands at once, no restart needed', wl.ok && wl.restartNeeded === false && /Unknown command: whitelist add Bob/.test(lg) && /Unknown command: whitelist on/.test(lg) && /Unknown command: whitelist reload/.test(lg), lg.slice(-300));
  check('the accounts screen says it is running', (await page.ev(`vp.accounts.get(${J(id)})`)).running === true);
  await page.ev('window.__log.length = 0');
  const rs = await page.ev('vp.server.restart()');
  let back = false;
  for (let i = 0; i < 60 && !back; i++) { await sleep(250); back = (await page.ev('vp.server.state()')).serverStatus === 'online' && /Done \(/.test(await logs()); }
  check('restart stops the server and starts the same one again', rs.ok === true && back && (await page.ev('vp.server.state()')).activeServerProfileId === id, J(rs));
  await page.ev('vp.server.stop()'); await sleep(2500);
  check('and it stops cleanly afterwards', (await page.ev('vp.server.state()')).serverStatus === 'stopped');
} finally {
  page.close(); kill(app); kill(accounts); mc.close();
  if (originalProfiles !== null) fs.writeFileSync(profilesFile, originalProfiles); else fs.rmSync(profilesFile, { force: true });
  fs.rmSync(testRoot, { recursive: true, force: true });
}
process.exit(done());

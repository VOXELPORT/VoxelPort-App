// End to end through the real Tauri window: a Bedrock Dedicated Server created through the wizard, started with no Java on the PATH,
// its players, console buttons, friends-only (allow-list), settings, live and stopped backups and a restore, and made public through a
// stand-in relay (a Bedrock player's datagram reaches the server and the reply comes back). The server is the stand-in
// (`vp-fake-server`, posing as bedrock_server.exe); Mojang's download service is a local stand-in too.
//   node tools/e2e-bedrock-server.mjs <debug-exe> <data-dir> <test-root> <stand-in-server-exe>
// Development builds only (uses debug-only env switches). Ends only the processes it starts, by PID.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeMc } from './fake-mc.mjs';
import { startFakeRelay } from './fake-relay.mjs';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';

const [exe, dataDir, testRoot, fakeServer] = process.argv.slice(2);
const ACCOUNTS = 8799, MC = 8797, PORT = 19145;
const { check, done } = reporter();
if (!dataDir.includes('in.voxelport.app.dev') || !testRoot.includes('vp-tauri-test')) throw new Error('refusing to touch folders that are not the dev ones');
if (!fs.existsSync(fakeServer)) throw new Error(`stand-in server not found: ${fakeServer}`);

for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json', 'custom-address.json', 'preferences.json', 'bedrock-endpoints.json']) fs.rmSync(path.join(dataDir, f), { force: true });
fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });
const profilesFile = path.join(dataDir, 'server-profiles.json');
const originalProfiles = fs.existsSync(profilesFile) ? fs.readFileSync(profilesFile, 'utf8') : null;
fs.writeFileSync(profilesFile, JSON.stringify({ version: 2, servers: [] }));
const serversBefore = fs.existsSync(path.join(dataDir, 'servers')) ? new Set(fs.readdirSync(path.join(dataDir, 'servers'))) : new Set();

const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const mc = await startFakeMc(MC, { bedrockExe: fakeServer });
const relay = await startFakeRelay();
await sleep(600);

// No Java anywhere: a Bedrock server must start without it.
const noJavaPath = process.env.PATH.split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'java.exe'))).join(path.delimiter);

async function session(restoreAnswer, fn) {
  const app = launch(exe, { env: { PATH: noJavaPath, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_BDS_API: mc.base, VOXELPORT_RELAY_URL: relay.url, VOXELPORT_TEST_RESTORE: restoreAnswer, VP_FAKE_UDP_ECHO: '1' } });
  const page = await connect();
  try {
    await page.ev("(window.__log = [], window.__ev = [], vp.on('server:log', (l) => window.__log.push(l)), ['tunnel:assigned','tunnel:status','server:players','server:playerNames','server:status','app:state'].forEach((c) => vp.on(c, (p) => window.__ev.push([c, p]))), true)");
    await page.ev('vp.discordSignIn()');
    await fn(page);
  } finally { page.close(); kill(app); await sleep(1500); }
}
const J = JSON.stringify;
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const log = (page) => page.ev('window.__log.join("\\n")');
const status = (page) => page.ev('vp.server.state().then((s) => s.serverStatus)');
const rejects = (page, expr) => page.ev(`(async () => { try { await ${expr}; return null; } catch (e) { return String(e); } })()`);
const click = (page, id) => page.ev(`document.getElementById(${J(id)}).click()`);
const hidden = (page, sel) => page.ev(`document.querySelector(${J(sel)}).classList.contains('hidden')`);
let id, dir;

try {
  await session('yes', async (page) => {
    // ── the screens know the type ──
    check('the page has the Bedrock server helpers', await page.ev("typeof window.VPBedrockServer === 'object'"));
    const types = await page.ev('vp.server.types()');
    check('Bedrock Server is one of the types', JSON.stringify(types.map((t) => t.id)) === '["vanilla","paper","fabric","bedrock-server"]', J(types));
    check('its one version is the current release Mojang names', J(await page.ev("vp.server.versions('bedrock-server')")) === '["1.26.63.1"]');

    // ── the wizard, driven through the real screens ──
    await page.ev("(() => { const o = vp.server.install; vp.server.install = (c) => { window.__installArgs = c; return o(c); }; return true; })()");
    await click(page, 'addServerBtn');
    await page.ev("(() => { const n = document.getElementById('serverName'); n.value = 'Pocket Realm'; n.dispatchEvent(new Event('input')); return true; })()");
    check('the type grid offers Bedrock Server', await page.ev("!!document.querySelector('#typeGrid [data-type=\"bedrock-server\"]')"));
    await page.ev("document.querySelector('#typeGrid [data-type=\"bedrock-server\"]').click()");
    check('choosing it fills the version list with the current release', await waitFor(async () => (await page.ev("document.getElementById('versionSelect').value")) === '1.26.63.1'));
    await click(page, 'typeNextBtn');
    check('step 2 has no Java row and no memory row', await waitFor(async () => (await hidden(page, '#javaBlock')) === true) && (await hidden(page, '#ramField')) === true);
    check('the port starts on 19132 and the terms mention the privacy statement', (await page.ev("document.getElementById('serverPort').value")) === '19132' && /Privacy Statement/.test(await page.ev("document.getElementById('eulaText').textContent")));
    check('Install stays off until the terms are accepted, then turns on without any Java check', (await page.ev("document.getElementById('installBtn').disabled")) === true && (await click(page, 'eulaCheck'), await page.ev("document.getElementById('installBtn').disabled")) === false);
    await page.ev("(() => { document.getElementById('serverPort').value = '19145'; return true; })()");
    await click(page, 'installBtn');
    check('Install & start installs, opens the server screen and starts it', await waitFor(async () => (await page.ev('vp.server.list()')).length === 1, 20000));
    const profile = (await page.ev('vp.server.list()'))[0];
    id = profile.id; dir = profile.serverDir;
    check('the profile is a Bedrock server on the chosen port, with the downloaded version', profile.type === 'bedrock-server' && profile.version === '1.26.63.1' && profile.port === PORT && profile.name === 'Pocket Realm' && !profile.template && !profile.javaMajor, J(profile) + ' sent: ' + await page.ev('JSON.stringify(window.__installArgs)'));
    const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    check('the server was unpacked and only its own lines were changed', fs.existsSync(path.join(dir, 'bedrock_server.exe')) && props.includes('# Mojang defaults') && props.includes(`server-port=${PORT}`) && props.includes(`server-portv6=${PORT + 1}`) && props.includes('server-name=Pocket Realm') && props.includes('online-mode=true'), props);
    check('it came online without Java (its own "Server started." line)', await waitFor(async () => (await status(page)) === 'online', 20000), await log(page));
    check('and no Java was looked for or installed', !/Java/i.test(await log(page)), await log(page));
    check('the screen shows Bedrock Server and the version', /Bedrock Server/.test(await page.ev("document.getElementById('mgMeta').textContent")) && /1\.26\.63\.1/.test(await page.ev("document.getElementById('mgMeta').textContent")));
    check('the library card says Bedrock Server', (await page.ev("(window.refreshLibrary ? window.refreshLibrary() : 0, 0)")) === 0 && (await waitFor(async () => /Bedrock Server/.test(await page.ev("document.getElementById('serverList').textContent")))));

    // ── players and console buttons ──
    await page.ev("vp.server.command('join Steve Smith')");
    check('a Bedrock player (a name with a space) shows as online', await waitFor(async () => (await page.ev('window.__ev.filter((e) => e[0] === "server:playerNames").map((e) => e[1])')).some((n) => n.length === 1 && n[0] === 'Steve Smith')));
    check('the player count follows', (await page.ev('window.__ev.filter((e) => e[0] === "server:players").map((e) => e[1]).pop()')) === 1);
    check('Kick sends the quoted name', (await page.ev("vp.server.playerAction('kick', 'Steve Smith')")).ok === true && await waitFor(async () => /Command received: kick "Steve Smith"/.test(await log(page))));
    check('Ban is refused (a Bedrock server has none)', (await page.ev("vp.server.playerAction('ban', 'Steve Smith')")).ok === false);
    await page.ev("vp.server.command('leave Steve Smith')");
    check('the player leaves', await waitFor(async () => (await page.ev('window.__ev.filter((e) => e[0] === "server:players").map((e) => e[1]).pop()')) === 0));

    // ── settings ──
    await page.ev(`window.openSettingsScreen(${J(id)})`);
    await sleep(500);
    check('the settings screen drops the Java-only groups and says how Bedrock players join', await page.ev("[...document.querySelectorAll('#screen-settings [data-java-only]')].every((e) => e.classList.contains('hidden'))") && (await hidden(page, '#setBdsNote')) === false && /Bedrock Dedicated Server 1\.26\.63\.1/.test(await page.ev("document.getElementById('setBdsNote').textContent")));
    const fields = await page.ev(`vp.server.getSettings(${J(id)}).then((d) => ({ keys: d.fields.map((f) => f.key), values: d.values, bedrockServer: d.bedrockServer }))`);
    check('the fields are the Bedrock ones, read from its file', fields.bedrockServer === true && fields.keys.includes('server-name') && fields.keys.includes('allow-list') && !fields.keys.includes('motd') && fields.values['server-name'] === 'Pocket Realm' && fields.values.gamemode === 'survival', J(fields));
    const saved = await page.ev(`vp.server.saveSettings({ id: ${J(id)}, name: 'Pocket Realm', port: ${PORT}, properties: { gamemode: 'creative', 'max-players': 6 } })`);
    const after = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    check('saving writes the Bedrock keys, keeps the rest, and asks for a restart', saved.ok === true && saved.restartNeeded === true && after.includes('gamemode=creative') && after.includes('max-players=6') && after.includes('# Mojang defaults') && after.includes('online-mode=true'), J(saved) + after);
    check('a Java key is refused on a Bedrock server', /can't be changed/.test(await rejects(page, `vp.server.saveSettings({ id: ${J(id)}, properties: { motd: 'x' } })`) || ''));

    // ── friends only (the allow-list) ──
    await page.ev(`window.openFriendsScreen(${J(id)})`);
    await sleep(400);
    check('the friends screen speaks of gamertags', /gamertag/i.test(await page.ev("document.getElementById('friendsInput').closest('label').textContent")) && (await page.ev("document.getElementById('friendsInput').placeholder")) === 'Steve, Alex Smith');
    const add = await page.ev(`vp.whitelist.add(${J(id)}, 'Steve Smith, Alex')`);
    check('adding friends reports them and does not ask for a restart on a running server', add.ok === true && J(add.added) === '["Steve Smith","Alex"]' && add.restartNeeded === false, J(add));
    check('the running server was told (quoted names)', await waitFor(async () => /Command received: allowlist add "Steve Smith"/.test(await log(page)) && /Command received: allowlist on/.test(await log(page))));
    const allow = JSON.parse(fs.readFileSync(path.join(dir, 'allowlist.json'), 'utf8'));
    check('allowlist.json holds them and the allow-list is on', allow.map((e) => e.name).join() === 'Steve Smith,Alex' && fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').includes('allow-list=true'));
    const st = await page.ev(`vp.whitelist.status(${J(id)})`);
    check('the status screen agrees', st.enabled === true && J(st.friends) === '["Steve Smith","Alex"]' && st.cracked === false, J(st));

    // ── a backup while it runs (save hold / query / resume) ──
    const live = await page.ev(`vp.backups.create(${J(id)})`);
    check('a live backup is made', live.ok === true && /_manual\.zip$/.test(live.backup.name) && J(live.backup.worlds) === '["Bedrock level"]', J(live));
    const lg = await log(page);
    check('the server was asked to hold, was queried, and was told to resume', /Command received|Saving\.\.\./.test(lg) && /Saving\.\.\./.test(lg) && /Data saved\. Files are now ready to be copied\./.test(lg) && /Changes to the world are resumed\./.test(lg), lg);
    const backupFile = path.join(dataDir, 'backups', id, live.backup.name);
    check('the zip is on disk', fs.existsSync(backupFile) && fs.statSync(backupFile).size > 0);
    const info = await page.ev(`vp.backups.info(${J(id)})`);
    check('the Backups screen sees the world and lists it', info.hasWorld === true && info.backups.length === 1 && info.running === true, J(info));
    check('restoring while it runs is refused', (await page.ev(`vp.backups.restore(${J(id)}, ${J(live.backup.name)})`)).code === 'running');

    // ── public through the relay: a Bedrock player's datagram reaches the server ──
    const pub = await page.ev(`vp.server.makePublic(${J(id)})`);
    check('making it public works', pub.ok === true, J(pub));
    check('the relay was asked for plain UDP only (one port), not a separate Bedrock endpoint', await waitFor(async () => relay.state.registers.length >= 1 && relay.state.registers[0].udp === true && relay.state.registers[0].bedrock === undefined), J(relay.state.registers));
    check('the one public port arrives as the Bedrock address', await waitFor(async () => (await page.ev('window.__ev.filter((e) => e[0] === "tunnel:assigned").map((e) => e[1])')).some((a) => a.port === 26137 && a.bedrockPort === 26137 && a.bedrockServer === true)));
    check('the first time, the server is restarted once so it can be told that public address', await waitFor(async () => /Activating the Bedrock address — restarting the server once\. Players reconnect/.test(await log(page)), 20000));
    check('and it comes back online', await waitFor(async () => (await status(page)) === 'online', 30000));
    const udpLine = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').split('\n').find((l) => l.startsWith('server-udp-ports='));
    // The test relay stands in for the connection only: the public host is still the chosen region's real one, and is looked up for real.
    const udpForm = new RegExp(`^server-udp-ports=\\d+\\.\\d+\\.\\d+\\.\\d+:26137:${PORT}$`);
    check('its own setting names the relay\'s IP address, the public port and the local port (the form its documentation gives)', udpForm.test(udpLine || ''), udpLine);
    check('it was restarted only once', (await log(page)).split('Activating the Bedrock address').length === 2);
    const reply = await relay.udp('hello bedrock');
    check('a datagram from a Bedrock player reaches the server and its answer comes back', reply !== null && reply.toString() === 'echo:hello bedrock', String(reply));
    check('the share box shows only the Bedrock server and port (no Java address, no custom name)', (await hidden(page, '#shareAddressRow')) === true && (await hidden(page, '#nameBox')) === true && (await hidden(page, '#srvBedrock')) === false && (await page.ev("document.getElementById('srvBedrockPort').textContent")) === '26137' && (await hidden(page, '#srvVoiceStatus')) === true && (await hidden(page, '#srvBedrockStatus')) === true);
    const invite = await page.ev("(() => { const d = window.currentInviteData(); return d ? VPInvite.buildInviteMessage({ lang: 'en', ...d }) : null; })()");
    check('the invite names the Bedrock server and port, and not a Java address', invite && /Bedrock/.test(invite) && /Port: 26137/.test(invite) && !/Minecraft Java/.test(invite) && /Add Server/.test(invite), invite);
    check('the server is not sent to the public list', relay.state.listings.every((l) => l === null));
    await page.ev('vp.stop()');

    // ── stop, then break the world and restore it ──
    await page.ev('vp.server.stop()');
    check('it stops cleanly', await waitFor(async () => (await status(page)) === 'stopped', 20000));
    await sleep(1200);
    const world = path.join(dir, 'worlds', 'Bedrock level');
    const original = fs.readFileSync(path.join(world, 'level.dat'), 'utf8');
    fs.writeFileSync(path.join(world, 'level.dat'), 'damaged');
    const restored = await page.ev(`vp.backups.restore(${J(id)}, ${J(live.backup.name)})`);
    check('the restore (asked first, answered yes) puts the world back and saves the damaged one first', restored.ok === true && !!restored.safetyBackup && fs.readFileSync(path.join(world, 'level.dat'), 'utf8') === original, J(restored));

    // ── importing the folder, and removing the server ──
    const found = await page.ev(`vp.server.detectExisting(${J(dir)})`);
    check('a Bedrock server folder is recognised as one', found.looksLikeServer === true && found.guessedType === 'bedrock-server' && found.hasBedrockServer === true && found.guessedPort === PORT, J(found));
    check('changing the version is declined plainly', /not built for Bedrock servers/.test((await page.ev(`vp.server.changeVersion(${J(id)}, '1.26.63.1')`)).error || ''));
  });

  // A second run: it starts again from what is on disk, and a missing program is a plain error.
  await session('no', async (page) => {
    check('after a restart of the app the server is still listed and starts again', (await page.ev(`vp.server.start(${J(id)})`)).ok === true && await waitFor(async () => (await status(page)) === 'online', 20000));
    check('this time it starts already told its public address (remembered), so no restart will be needed', new RegExp(`^server-udp-ports=\\d+\\.\\d+\\.\\d+\\.\\d+:26137:${PORT}$`, 'm').test(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')));
    await page.ev('vp.server.stop()');
    await waitFor(async () => (await status(page)) === 'stopped', 20000);
    await sleep(1500);
    fs.renameSync(path.join(dir, 'bedrock_server.exe'), path.join(dir, 'bedrock_server.exe.gone'));
    const gone = await page.ev(`vp.server.start(${J(id)})`);
    check('a folder without its program says so and nothing is left running', gone.ok === false && /bedrock_server\.exe is missing/.test(gone.error) && (await page.ev('vp.server.state().then((s) => s.activeServerProfileId)')) === null, J(gone));
    fs.renameSync(path.join(dir, 'bedrock_server.exe.gone'), path.join(dir, 'bedrock_server.exe'));
  });
} finally {
  accounts.kill(); mc.close(); relay.close();
  if (originalProfiles === null) fs.rmSync(profilesFile, { force: true }); else fs.writeFileSync(profilesFile, originalProfiles);
  // Remove only what this run made: its backups, and the server folder the wizard put under the dev data folder.
  if (id) fs.rmSync(path.join(dataDir, 'backups', id), { recursive: true, force: true });
  const root = path.join(dataDir, 'servers');
  if (fs.existsSync(root)) for (const d of fs.readdirSync(root)) if (!serversBefore.has(d)) fs.rmSync(path.join(root, d), { recursive: true, force: true });
}
process.exit(done());

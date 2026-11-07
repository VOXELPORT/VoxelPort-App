// End to end through the real Tauri window: the Support screen (against a stand-in website), the copy buttons, the community link, Discord
// presence (against a stand-in Discord on a real named pipe), automatic voice chat (stand-in relay and Modrinth), and the error report.
//   node tools/e2e-app.mjs <debug-exe> <data-dir> <test-root> <stand-in-java-dir>
// Development builds only (uses debug-only env switches, including ones that keep the real clipboard, browser and Discord untouched).
// Ends only the processes it starts, by PID.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { startFakeMc } from './fake-mc.mjs';
import { startFakeRelay } from './fake-relay.mjs';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';

const [exe, dataDir, testRoot, javaDir] = process.argv.slice(2);
const ACCOUNTS = 8799, MC = 8797, SUPPORT = 8795;
const PIPE = String.raw`\\.\pipe\vp-e2e-discord`;
const APP_ID = '1506829006794657902';
const { check, done } = reporter();
if (!dataDir.includes('in.voxelport.app.dev') || !testRoot.includes('vp-tauri-test')) throw new Error('refusing to touch folders that are not the dev ones');

for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json', 'custom-address.json', 'preferences.json', 'bedrock-endpoints.json', 'support-cache.json']) fs.rmSync(path.join(dataDir, f), { force: true });
fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });
const profilesFile = path.join(dataDir, 'server-profiles.json');
const originalProfiles = fs.existsSync(profilesFile) ? fs.readFileSync(profilesFile, 'utf8') : null;
fs.writeFileSync(profilesFile, JSON.stringify({ version: 2, servers: [] }));
const clipboard = path.join(testRoot, 'clipboard.txt');
const reportFile = path.join(testRoot, 'report.txt');
fs.mkdirSync(reportFile); // a directory where the report should go: the first save must fail cleanly

// ── A stand-in for voxelport.in/support.json ────────────────────────────────────────────────────────────────
const site = { hits: 0, up: true };
const supportJson = {
  version: 1,
  donate: { upiId: 'evil@upi' },
  supporter: { intro: 'Thanks <b>so</b> much', tiers: [{ name: 'Gold', inr: 149.6, perks: ['Shiny', '', 'Very shiny'] }, { name: 'Broken', inr: 0, perks: ['x'] }] },
  hosts: { intro: { desktop: 'For your PC', android: 'For your phone' }, items: [
    { id: 'good', name: 'Good Host', blurb: 'Fast', url: 'https://good.example/plans', affiliate: true },
    { id: 'evil', name: 'Evil', url: 'javascript:alert(1)' },
    { id: 'plain', name: 'Plain http', url: 'http://plain.example/' },
    { id: 'ip', name: 'By IP', url: 'https://192.168.1.5/' },
    { id: 'phone', name: 'Phone only', url: 'https://phone.example/', for: ['android'] },
  ] },
};
const supportServer = http.createServer((req, res) => {
  site.hits++;
  if (!site.up) { res.writeHead(503); return res.end('down'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(supportJson));
});
await new Promise((r) => supportServer.listen(SUPPORT, '127.0.0.1', r));

// ── A stand-in for the Discord app, on a real named pipe ────────────────────────────────────────────────────
const discord = { handshakes: [], activities: [], connections: 0, closed: 0, sockets: new Set() };
const frame = (op, v) => { const body = Buffer.from(JSON.stringify(v)); const head = Buffer.alloc(8); head.writeInt32LE(op, 0); head.writeInt32LE(body.length, 4); return Buffer.concat([head, body]); };
const discordServer = net.createServer((sock) => {
  discord.connections++; discord.sockets.add(sock);
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      const body = JSON.parse(buf.subarray(8, 8 + len).toString());
      buf = buf.subarray(8 + len);
      if (op === 0) { discord.handshakes.push(body); sock.write(frame(1, { evt: 'READY', cmd: 'DISPATCH' })); }
      else if (op === 1 && body.cmd === 'SET_ACTIVITY') discord.activities.push(body.args.activity);
    }
  });
  sock.on('close', () => { discord.closed++; discord.sockets.delete(sock); });
  sock.on('error', () => {});
});
await new Promise((r) => discordServer.listen(`${PIPE}-0`, r));

const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const mc = await startFakeMc(MC);
const relay = await startFakeRelay();
await sleep(600);

const app = launch(exe, { env: {
  PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_MC_API: mc.base, VOXELPORT_MODRINTH_API: `${mc.base}/v2`,
  VOXELPORT_RELAY_URL: relay.url, VOXELPORT_SUPPORT_URL: `http://127.0.0.1:${SUPPORT}/support.json`, VOXELPORT_DISCORD_PIPE: PIPE, VOXELPORT_TEST_CLIPBOARD_FILE: clipboard, VOXELPORT_TEST_SAVE_FILE: reportFile,
} });
const page = await connect();
const J = JSON.stringify;
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const lastActivity = () => discord.activities.at(-1);
const dir = path.join(testRoot, 'app');

try {
  await page.ev("(window.__log = [], window.__voice = [], window.__status = '', vp.on('server:log', (l) => window.__log.push(l)), vp.on('tunnel:voice', (v) => window.__voice.push(v)), vp.on('server:status', (s) => window.__status = s), true)");
  const s = await page.ev('vp.discordSignIn()');
  check('signed in first', s.ok && s.state.allowed, J(s));

  // ── One copy at a time ───────────────────────────────────────────────────
  const second = launch(exe, { env: { VOXELPORT_NO_BROWSER: '1' }, cdpPort: 9444 });
  let secondExited = false;
  second.on('exit', () => { secondExited = true; });
  const gone = await waitFor(() => secondExited, 10000);
  if (!gone) kill(second);
  check('starting the app a second time ends the second copy at once and leaves the first running', gone && (await page.ev('1 + 1')) === 2);

  // ── Support ──────────────────────────────────────────────────────────────
  const sup = await page.ev('vp.support.get(false)');
  check('the Support screen shows the website\'s words, cleaned', sup.supporter.intro === 'Thanks b so /b much' && J(sup.supporter.tiers) === '[{"name":"Gold","inr":150,"perks":["Shiny","Very shiny"]}]', J(sup.supporter));
  check('only safe hosting links for this app are kept, with an affiliate note', J(sup.hosts.items.map((h) => h.id)) === '["good"]' && sup.hosts.intro === 'For your PC' && /affiliate/.test(sup.hosts.disclosure) && sup.hosts.items[0].affiliate === true, J(sup.hosts));
  check('the donation target is fixed whatever the website says', sup.donate.upiId === 'trazhub@upi' && sup.donate.sponsorsUrl === 'https://github.com/sponsors/trazhub' && sup.contact === 'traz@voxelport.in', J(sup.donate));
  check('it is cached on disk', fs.existsSync(path.join(dataDir, 'support-cache.json')) && site.hits === 1, `hits=${site.hits}`);
  await page.ev('vp.support.get(false)');
  check('a second look inside twelve hours does not ask the website again', site.hits === 1, `hits=${site.hits}`);
  await page.ev('vp.support.get(true)');
  check('a forced refresh does', site.hits === 2, `hits=${site.hits}`);
  const open = async (what, id) => (await page.ev(`vp.support.open(${J(what)}, ${J(id)})`)).ok;
  check('the fixed pages open, and a hosting link opens only by an id from the list', await open('sponsors') && await open('page') && await open('perks') && await open('host', 'good'));
  check('an id that is not in the list, a made-up kind, or a URL passed as an id opens nothing', !(await open('host', 'evil')) && !(await open('host', 'ip')) && !(await open('host', 'https://evil.example/')) && !(await open('url', 'https://evil.example/')) && !(await open('nonsense')));
  check('copying the UPI ID puts it on the clipboard', (await page.ev('vp.support.copyUpi()')).ok && fs.readFileSync(clipboard, 'utf8') === 'trazhub@upi');
  site.up = false;
  const down = await page.ev('vp.support.get(true)');
  check('with the website down, the last good copy is shown', down.supporter.tiers[0].name === 'Gold' && down.hosts.items[0].id === 'good');
  site.up = true;

  // ── Copy buttons and the community link ──────────────────────────────────
  const info = await page.ev('vp.info()');
  check('copying the supporter ID puts exactly that ID on the clipboard', (await page.ev('vp.copySupporterID()')).ok && fs.readFileSync(clipboard, 'utf8') === info.supporterID && /^[0-9a-f]{12}$/.test(info.supporterID), J(info));
  check('copying the token puts the real token on the clipboard, and the page never sees it', (await page.ev('vp.copyToken()')).ok && /^vp_/.test(fs.readFileSync(clipboard, 'utf8')) && !J(info).includes(fs.readFileSync(clipboard, 'utf8')), fs.readFileSync(clipboard, 'utf8').slice(0, 6));
  check('the community link opens', (await page.ev('vp.openDiscord()')).ok === true);

  // ── Presence ─────────────────────────────────────────────────────────────
  check('presence is available and on by default', J(await page.ev('vp.presence.get()')) === '{"available":true,"enabled":true}');
  check('the app says hello to Discord with its application id', await waitFor(() => discord.handshakes.length === 1) && discord.handshakes[0].client_id === APP_ID && discord.handshakes[0].v === 1, J(discord.handshakes));
  check('and with nothing running shows no line', await waitFor(() => discord.activities.length === 1) && lastActivity() === null);
  const inst = await page.ev(`vp.server.install({ name: 'App Test', type: 'paper', version: '1.21.4', port: 25591, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(dir)}, templateId: 'survival' })`);
  const id = inst.profile?.id;
  check('a server is installed through the app', inst.ok === true, J(inst));
  check('the server starts', (await page.ev(`vp.server.start(${J(id)})`)).ok === true && await waitFor(async () => (await page.ev('window.__status')) === 'online', 15000));
  check('Discord shows what is being hosted, with no server name or address', await waitFor(() => lastActivity()?.details === 'Hosting a Paper 1.21.4 server') && lastActivity().state === '0 players online' && !J(lastActivity()).includes('App Test'), J(lastActivity()));
  await page.ev("vp.server.command('join Steve')");
  check('a player joining shows in the count', await waitFor(() => lastActivity()?.state === '1 player online'), J(lastActivity()));
  await page.ev('vp.region.set("eu")');
  const off = await page.ev('vp.presence.set(false)');
  check('switching it off takes the line down and closes the connection', off.ok && off.enabled === false && await waitFor(() => lastActivity() === null && discord.sockets.size === 0), J({ off, last: lastActivity(), sockets: discord.sockets.size }));
  const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'));
  check('the choice is saved without losing the region preference', prefs.presence === false && prefs.region === 'eu', J(prefs));
  const quiet = discord.activities.length;
  await page.ev("vp.server.command('join Alex')");
  await sleep(1000);
  check('while off nothing is sent', discord.activities.length === quiet && J(await page.ev('vp.presence.get()')) === '{"available":true,"enabled":false}');
  const on = await page.ev('vp.presence.set(true)');
  check('switching it on again reconnects and shows the running server', on.ok && on.enabled === true && await waitFor(() => discord.handshakes.length === 2) && await waitFor(() => lastActivity()?.details === 'Hosting a Paper 1.21.4 server' && lastActivity()?.state === '2 players online'), J({ on, last: lastActivity() }));
  await page.ev('vp.region.set("in")');

  // ── Automatic voice chat ─────────────────────────────────────────────────
  const voice = () => page.ev('window.__voice.map((v) => v.message)');
  const plugins = path.join(dir, 'plugins');
  relay.state.rank = 'supporter';
  check('before anything is public the voice line says what to do', (await page.ev('vp.voiceState()')).message === 'Make your server public to sync your supporter rank.');
  check('a server is made public (a plain supporter)', (await page.ev(`vp.server.makePublic(${J(id)})`)).ok === true && await waitFor(async () => (await voice()).length > 0));
  check('a plain supporter is told automatic voice chat needs Supporter Plus, and nothing is installed', (await voice()).includes('Your supporter rank is synced. Automatic voice chat requires Supporter Plus.') && !fs.existsSync(path.join(plugins, 'voicechat-bukkit-2.5.jar')), J(await voice()));
  await page.ev('vp.stop()');
  await waitFor(async () => (await page.ev('vp.server.state()')).publicServerProfileId === null);

  relay.state.rank = 'supporter_plus';
  relay.state.voicePort = 30001;
  await page.ev('window.__voice.length = 0');
  check('made public again as Supporter Plus', (await page.ev(`vp.server.makePublic(${J(id)})`)).ok === true);
  check('the relay was asked for an automatic voice port', await waitFor(() => relay.state.registers.at(-1)?.voice_auto === true), J(relay.state.registers.at(-1)));
  check('the voice plugin is installed by its real project id and configured for the public address', await waitFor(() => fs.existsSync(path.join(plugins, 'voicechat', 'voicechat-server.properties')), 15000) && fs.existsSync(path.join(plugins, 'voicechat-bukkit-2.5.jar')));
  const props = fs.readFileSync(path.join(plugins, 'voicechat', 'voicechat-server.properties'), 'utf8');
  check('with the local port, the local address and the relay\'s public voice address', /bind_address=127\.0\.0\.1/.test(props) && /port=24454/.test(props) && /voice_host=play\.voxelport\.in:30001/.test(props), props);
  check('the status line walks from "setting up" to "restart once"', await waitFor(async () => (await voice()).some((m) => /^Voice chat is configured\. Restart your server once/.test(m))) && (await voice()).includes('Supporter Plus synced. Setting up voice chat…'), J(await voice()));
  const prof = await page.ev(`vp.server.get(${J(id)})`);
  check('the profile remembers the voice plugin and port', J(prof.voice) === '{"enabled":true,"plugin":"simple","port":24454}', J(prof.voice));
  check('and the status line is what the screen asks for', (await page.ev('vp.voiceState()')).rank === 'supporter_plus' && /Restart your server once/.test((await page.ev('vp.voiceState()')).message));
  await page.ev('vp.stop()');
  await page.ev('vp.server.stop()');
  await waitFor(async () => (await page.ev('window.__status')) === 'stopped', 15000);
  await page.ev('window.__voice.length = 0');
  check('the server starts again', (await page.ev(`vp.server.start(${J(id)})`)).ok === true && await waitFor(async () => (await page.ev('window.__status')) === 'online', 15000));
  check('and that start is the restart voice chat asked for', await waitFor(async () => (await voice()).includes('Voice chat is configured automatically. Players join using your server address and the matching voice mod.')), J(await voice()));

  // ── The error report ─────────────────────────────────────────────────────
  await page.ev("vp.server.command('say [12:00:00] [Server thread/INFO]: token=abc123SECRET password=hunter2 from 203.0.113.9 at C:\\\\Users\\\\Garv\\\\x.log')");
  await page.ev("vp.server.command('say [12:00:01] [Server thread/ERROR]: **** FAILED TO BIND TO PORT!')");
  await sleep(500);
  await page.ev("vp.server.command('crash')");
  check('the server crashes', await waitFor(async () => (await page.ev('window.__status')) === 'crashed', 10000));
  const bad = await page.ev('vp.exportDiagnostics()');
  check('a report that cannot be saved says so plainly', bad.ok === false && bad.error === 'Could not save the error report. Try another folder.', J(bad));
  fs.rmdirSync(reportFile);
  const good = await page.ev('vp.exportDiagnostics()');
  check('and one that can is saved', good.ok === true && fs.existsSync(reportFile), J(good));
  const report = fs.readFileSync(reportFile, 'utf8');
  check('the report names the app, the server and what went wrong', /^VoxelPort diagnostic report v1\nCreated: 20\d\d-/.test(report) && /\nServer: paper \| Minecraft: 1\.21\.4 \(build 90\) \| Status: crashed\n/.test(report) && /VP-PORT_IN_USE: The port is already in use/.test(report) && /port 25591/.test(report), report.slice(0, 700));
  check('and keeps secrets, addresses and names out', !/abc123SECRET|hunter2|203\.0\.113\.9|Garv/.test(report) && /\[secret removed\]/.test(report) && /\[ip removed\]/.test(report) && /C:\\Users\\\[user\]/.test(report), report.slice(report.indexOf('Recent session output'), report.indexOf('Recent session output') + 1200));
  check('with a way to share it', /Attach this \.txt file to a Discord support ticket/.test(report));
} finally {
  page.close(); kill(app); kill(accounts); mc.close(); relay.close(); supportServer.close();
  for (const s of discord.sockets) s.destroy();
  discordServer.close();
  if (originalProfiles !== null) fs.writeFileSync(profilesFile, originalProfiles); else fs.rmSync(profilesFile, { force: true });
  fs.rmSync(path.join(dataDir, 'preferences.json'), { force: true });
  fs.rmSync(testRoot, { recursive: true, force: true });
}
process.exit(done());

// End to end through the real Tauri window: making a server public through a stand-in relay (start, players, region, custom address,
// listing, notices, reconnect, switching, stopping, the Bedrock address), against a server installed through the app.
//   node tools/e2e-tunnel.mjs <debug-exe> <data-dir> <test-root> <stand-in-java-dir>
// Development builds only (uses debug-only env switches). Ends only the processes it starts, by PID.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startFakeMc } from './fake-mc.mjs';
import { startFakeRelay } from './fake-relay.mjs';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';

const [exe, dataDir, testRoot, javaDir] = process.argv.slice(2);
const ACCOUNTS = 8799, MC = 8797, SERVER_PORT = 25590;
const { check, done } = reporter();
if (!dataDir.includes('in.voxelport.app.dev') || !testRoot.includes('vp-tauri-test')) throw new Error('refusing to touch folders that are not the dev ones');

for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json', 'custom-address.json', 'preferences.json', 'bedrock-endpoints.json']) fs.rmSync(path.join(dataDir, f), { force: true });
fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });
const profilesFile = path.join(dataDir, 'server-profiles.json');
const originalProfiles = fs.existsSync(profilesFile) ? fs.readFileSync(profilesFile, 'utf8') : null;
fs.writeFileSync(profilesFile, JSON.stringify({ version: 2, servers: [] }));

const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const mc = await startFakeMc(MC);
const relay = await startFakeRelay();
// A local Minecraft stand-in on the server's port: it echoes, so what a "player" sends comes back through the tunnel.
const local = net.createServer((s) => s.on('data', (b) => s.write(b)));
await new Promise((r) => local.listen(SERVER_PORT, '127.0.0.1', r));
await sleep(600);

async function session(switchAnswer, fn) {
  const app = launch(exe, { env: { PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_MC_API: mc.base, VOXELPORT_RELAY_URL: relay.url, VOXELPORT_TEST_SWITCH: switchAnswer } });
  const page = await connect();
  try {
    await page.ev("(window.__ev = [], ['tunnel:status','tunnel:assigned','tunnel:players','tunnel:log','tunnel:error','tunnel:name','tunnel:nameError','tunnel:notice','tunnel:region','server:log'].forEach((c) => vp.on(c, (p) => window.__ev.push([c, p]))), true)");
    await page.ev('vp.discordSignIn()');
    await fn(page);
  } finally { page.close(); kill(app); await sleep(1500); }
}
const J = JSON.stringify;
const events = (page, channel) => page.ev(`window.__ev.filter((e) => e[0] === ${J(channel)}).map((e) => e[1])`);
const waitFor = async (what, fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const rejects = (page, expr) => page.ev(`(async () => { try { await ${expr}; return null; } catch (e) { return String(e); } })()`);
const dir = path.join(testRoot, 'pub');
let id;

try {
  await session('no', async (page) => {
    const inst = await page.ev(`vp.server.install({ name: 'Public Test', type: 'paper', version: '1.21.4', port: ${SERVER_PORT}, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(dir)} })`);
    id = inst.profile?.id;
    check('a server is installed through the app', inst.ok === true, J(inst));

    check('making a server public before it is started is refused', (await page.ev(`vp.server.makePublic(${J(id)})`)).error === 'Start this server before making it public.');
    check('an unknown server is refused', (await page.ev("vp.server.makePublic('nope')")).error === 'Server profile not found.');
    let reg = await page.ev('vp.region.get()');
    check('the region screen starts on Auto with both regions and no active one', reg.preference === 'auto' && JSON.stringify(reg.regions.map((r) => r.id)) === '["in","eu"]' && reg.active === null && reg.addressRegion === null, J(reg));
    check('a region can be chosen, and a nonsense one becomes Auto', (await page.ev("vp.region.set('in')")).preference === 'in' && (await page.ev("vp.region.set('mars')")).preference === 'auto' && (await page.ev("vp.region.set('in')")).preference === 'in');
    check('the choice is saved in preferences.json', JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8')).region === 'in');

    check('the server starts', (await page.ev(`vp.server.start(${J(id)})`)).ok === true);
    await sleep(1500);
    const pub = await page.ev(`vp.server.makePublic(${J(id)})`);
    check('then it can be made public', pub.ok === true, J(pub));
    check('the tunnel comes online with the relay\'s port, the region\'s host and no Bedrock', await waitFor('online', async () => (await events(page, 'tunnel:assigned')).length > 0));
    const assigned = (await events(page, 'tunnel:assigned'))[0];
    check('the screen is told the port, host and that Bedrock is off', assigned.port === 26137 && assigned.host === 'play.voxelport.in' && assigned.bedrockPort === null && assigned.bedrockReady === false, J(assigned));
    const statuses = await events(page, 'tunnel:status');
    check('status went connecting then online', statuses.indexOf('connecting') >= 0 && statuses.indexOf('online') > statuses.indexOf('connecting'), J(statuses));
    check('the region is announced', J((await events(page, 'tunnel:region'))[0]) === '{"id":"in","label":"India"}');
    const regOnce = relay.state.registers.at(-1);
    check('registration carries the device token, protocol v2 and the app version, and no UDP', /^vp_/.test(regOnce.token) && regOnce.bin === 1 && /^desktop\/\d/.test(regOnce.client) && regOnce.udp === undefined && regOnce.bedrock === undefined, J({ ...regOnce, token: '(hidden)' }));
    const st = await page.ev('vp.server.state()');
    check('the app state says which server is public', st.publicServerProfileId === id && st.manualTunnelActive === false, J(st));
    reg = await page.ev('vp.region.get()');
    check('the region screen shows the active region', reg.active === 'in');
    const info = await page.ev('vp.info()');
    check('the raw token never reaches the page', !J(info).includes(regOnce.token) && !J(await page.ev('window.__ev')).includes(regOnce.token));

    // A player through the relay reaches the local server and the echo comes back.
    const p1 = await relay.player('hello from a player');
    check('a player\'s bytes reach the local server and the answer comes back', p1.got.toString() === 'hello from a player');
    check('the screen counts the player', await waitFor('players', async () => (await events(page, 'tunnel:players')).includes(1)));
    p1.close();
    check('and sees them leave', await waitFor('players 0', async () => { const ps = await events(page, 'tunnel:players'); return ps.lastIndexOf(0) > ps.indexOf(1); }));

    // Custom address.
    const claim = await page.ev("vp.name.claim('steve')");
    check('a custom address can be claimed on the India relay', claim.ok === true && claim.name === 'steve' && claim.address === 'steve.voxelport.in', J(claim));
    const gotName = await page.ev('vp.name.get()');
    check('it is remembered, with its region', gotName.name === 'steve' && gotName.region === 'in' && JSON.parse(fs.readFileSync(path.join(dataDir, 'custom-address.json'), 'utf8')).name === 'steve', J(gotName));
    check('a taken name is explained', (await page.ev("vp.name.claim('taken')")).error?.includes('taken') === true);
    check('a name that is far too long is refused', (await page.ev(`vp.name.claim('${'x'.repeat(41)}')`)).error === 'Invalid name.');
    const rel = await page.ev('vp.name.release()');
    check('the address can be released', rel.ok === true && (await page.ev('vp.name.get()')).name === '', J(rel));

    // The public list entry.
    const save = await page.ev(`vp.server.saveSettings({ id: ${J(id)}, listing: { enabled: true, description: 'Come play' } })`);
    check('saving a list entry on the public server sends it to the relay at once', save.ok && await waitFor('listing', async () => relay.state.listings.some((l) => l && l.title === 'Public Test' && l.description === 'Come play' && l.version === '1.21.4' && l.max_players === 20 && l.mode === 'survival')), J(relay.state.listings));
    await page.ev(`vp.server.saveSettings({ id: ${J(id)}, listing: { enabled: false, description: '' } })`);
    check('and turning it off withdraws it', await waitFor('withdrawn', async () => relay.state.listings.at(-1) === null));

    // Notices.
    relay.notice('The VoxelPort relay will restart.', 600);
    check('a relay notice reaches the screen', await waitFor('notice', async () => (await events(page, 'tunnel:notice')).some((n) => n.message === 'The VoxelPort relay will restart.' && n.seconds === 600)));

    // Safety nets while public.
    check('a public server cannot be removed', (await page.ev(`vp.server.remove(${J(id)})`)).error === 'Stop and un-publish this server before removing it.');
    check('restoring the address from a backup is refused while public', (await page.ev("vp.identityRestore('correct horse battery staple')")).error === 'Stop the public address first, then restore.');
    check('making the same server public again changes nothing', (await page.ev(`vp.server.makePublic(${J(id)})`)).alreadyRunning === true);

    // Reconnect: the relay drops the connection and the tunnel comes back by itself.
    const before = relay.state.connections;
    relay.drop();
    check('after a drop the tunnel reconnects and registers again', await waitFor('reconnect', async () => relay.state.connections > before && relay.connected()) && (await events(page, 'tunnel:status')).includes('reconnecting'));
    check('and is online again', await waitFor('online again', async () => (await events(page, 'tunnel:assigned')).length >= 2));

    // Switching to a manual tunnel asks first; saying no keeps the public server.
    const sw = await page.ev(`vp.start({ localPort: ${SERVER_PORT}, relayUrl: ${J(relay.url)} })`);
    check('switching to another target asks, and "no" keeps the public server', sw.ok === false && sw.cancelled === true && (await page.ev('vp.server.state()')).publicServerProfileId === id, J(sw));
    check('a bad local port is refused with a message', (await page.ev("vp.start({ localPort: 0 })")).ok === false && (await events(page, 'tunnel:error')).includes('Enter a valid local port (1–65535).'));
    check('a relay address with plain ws:// to a remote host is refused', (await page.ev("vp.start({ localPort: 25565, relayUrl: 'ws://example.com' })")).ok === false && (await events(page, 'tunnel:error')).some((m) => /must be wss/.test(m)));

    // Stopping.
    const stop = await page.ev('vp.stop()');
    check('stopping ends the tunnel and clears the state', stop.ok === true && await waitFor('stopped', async () => (await events(page, 'tunnel:status')).at(-1) === 'stopped') && (await page.ev('vp.server.state()')).publicServerProfileId === null);
    check('a second stop is harmless', (await page.ev('vp.stop()')).ok === true);
    check('a custom address cannot be claimed with nothing public', (await page.ev("vp.name.claim('alex')")).error === 'Make a server public first, then pick your address.' && (await page.ev('vp.name.release()')).error === 'Make a server public first, then remove your address.');
    await page.ev('vp.server.stop()'); await sleep(2500);
  });

  await session('yes', async (page) => {
    // Switching with "yes": the public server's tunnel is replaced by the manual one.
    await page.ev(`vp.server.start(${J(id)})`); await sleep(1500);
    await page.ev(`vp.server.makePublic(${J(id)})`);
    await waitFor('online', async () => (await events(page, 'tunnel:assigned')).length > 0);
    const sw = await page.ev(`vp.start({ localPort: ${SERVER_PORT}, relayUrl: ${J(relay.url)} })`);
    check('confirming the switch replaces the public tunnel with the manual one', sw.ok === true && await waitFor('manual', async () => { const s = await page.ev('vp.server.state()'); return s.manualTunnelActive === true && s.publicServerProfileId === null; }), J(sw));
    check('the manual tunnel registers and comes online', await waitFor('manual online', async () => (await events(page, 'tunnel:assigned')).length >= 2));
    check('a self-hosted relay is not a VoxelPort region: no region, and no custom address', (await events(page, 'tunnel:region')).at(-1) === null && /own relays/.test((await page.ev("vp.name.claim('alex')")).error));
    await page.ev('vp.stop()'); await waitFor('stopped', async () => (await events(page, 'tunnel:status')).at(-1) === 'stopped');

    // The tunnel ends when the server it was bridging to ends.
    await page.ev(`vp.server.makePublic(${J(id)})`);
    await waitFor('online', async () => (await events(page, 'tunnel:assigned')).length >= 3);
    await page.ev('vp.server.stop()');
    check('when the public server stops, the tunnel stops with it', await waitFor('stopped with server', async () => (await events(page, 'tunnel:status')).at(-1) === 'stopped' && (await page.ev('vp.server.state()')).publicServerProfileId === null, 12000));
  });

  await session('no', async (page) => {
    // Bedrock: the relay gives a second port; the server is restarted once so Geyser advertises it.
    const p = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
    p.servers[0].bedrock = true;
    fs.writeFileSync(profilesFile, JSON.stringify(p, null, 2));
    await page.ev(`vp.server.start(${J(id)})`); await sleep(1500);
    const before = relay.state.registers.length;
    await page.ev(`vp.server.makePublic(${J(id)})`);
    check('a Bedrock server registers for UDP and Bedrock', await waitFor('register', async () => relay.state.registers.length > before) && relay.state.registers.at(-1).udp === true && relay.state.registers.at(-1).bedrock === true);
    check('the screen is told the Bedrock port, and that it is not yet advertised', await waitFor('assigned', async () => (await events(page, 'tunnel:assigned')).some((a) => a.bedrockPort === 26138)) && (await events(page, 'tunnel:assigned')).find((a) => a.bedrockPort === 26138).bedrockReady === false);
    check('the address is remembered for the next start, without the token', await waitFor('cache', async () => fs.existsSync(path.join(dataDir, 'bedrock-endpoints.json'))) && !fs.readFileSync(path.join(dataDir, 'bedrock-endpoints.json'), 'utf8').includes(relay.state.registers.at(-1).token));
    check('the server is restarted once to activate it', await waitFor('restart', async () => (await page.ev('window.__ev.filter((e) => e[0] === "server:log").map((e) => e[1]).join("|")')).includes('Activating the Bedrock address — restarting the server once')));
    check('and comes back online', await waitFor('online', async () => (await page.ev('vp.server.state()')).serverStatus === 'online', 15000));
    const gotBedrock = await relay.player('bedrock hello', { bedrock: true });
    check('Bedrock signalling is routed to the Bedrock port, not to Java (nothing listens there here, so it is cleaned up)', gotBedrock.got.length === 0);
    const n = (await events(page, 'tunnel:assigned')).length;
    relay.drop();
    check('after a reconnect the server already advertises the address: ready, and no second restart', await waitFor('assigned again', async () => (await events(page, 'tunnel:assigned')).length > n) && (await events(page, 'tunnel:assigned')).at(-1).bedrockReady === true);
    await page.ev('vp.stop()'); await page.ev('vp.server.stop()'); await sleep(2500);
  });
} finally {
  kill(accounts); mc.close(); relay.close(); local.close();
  if (originalProfiles !== null) fs.writeFileSync(profilesFile, originalProfiles); else fs.rmSync(profilesFile, { force: true });
  fs.rmSync(testRoot, { recursive: true, force: true });
  for (const f of ['custom-address.json', 'preferences.json', 'bedrock-endpoints.json']) fs.rmSync(path.join(dataDir, f), { force: true });
  if (id) fs.rmSync(path.join(dataDir, 'backups', id), { recursive: true, force: true });
}
process.exit(done());

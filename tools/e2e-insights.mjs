// End to end through the real Tauri window: the performance panel (CPU, memory and TPS, with our own `tick query` kept out of the
// console, and lag warnings counted) and the "why did it stop" explanations (none for a stop the person asked for, one for a crash,
// the port named, Hinglish wording), on a server installed through the app from stand-in services.
//   node tools/e2e-insights.mjs <debug-exe> <data-dir> <test-root> <stand-in-java-dir>
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
const J = JSON.stringify;
const dir = path.join(testRoot, 'insights');
const logs = () => page.ev('window.__log.join("\\n")');
const waitFor = async (expr, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await page.ev(expr)) return true; await sleep(250); } return false; };
const startAndWait = async (id) => { const r = await page.ev(`vp.server.start(${J(id)})`); const up = await waitFor("window.__status === 'online'", 15000); return r.ok === true && up; };
const stopAndWait = async () => { await page.ev('vp.server.stop()'); await waitFor("window.__status === 'stopped' || window.__status === 'crashed'", 15000); };

try {
  await page.ev("(window.__log = [], window.__perf = [], window.__diag = [], window.__status = '', vp.on('server:log', (l) => window.__log.push(l)), vp.on('perf:sample', (p) => window.__perf.push(p)), vp.on('server:diagnosis', (d) => window.__diag.push(d)), vp.on('server:status', (s) => window.__status = s), true)");
  const s = await page.ev('vp.discordSignIn()');
  check('signed in first', s.ok && s.state.allowed, J(s));
  const inst = await page.ev(`vp.server.install({ name: 'Insights Test', type: 'paper', version: '1.21.4', port: 25581, minRamMb: 1024, maxRamMb: 2048, serverDir: ${J(dir)}, templateId: 'survival' })`);
  const id = inst.profile?.id;
  check('a server is installed through the app', inst.ok === true, J(inst));

  // ── The performance panel ────────────────────────────────────────────────
  check('the server starts and comes online', await startAndWait(id));
  check('CPU and memory samples arrive from the operating system, with the RAM limit for the bar', await waitFor('window.__perf.some((p) => p.cpuPercent !== null && p.memMb > 0)', 12000));
  const p0 = (await page.ev('window.__perf.find((p) => p.memMb > 0)'));
  check('and look sensible: a percentage, a positive size, the profile\'s own limit', p0.cpuPercent >= 0 && p0.cpuPercent <= 100 && p0.memMb > 0 && p0.maxRamMb === 2048 && p0.lagWarnings === 0, J(p0));
  check('TPS and tick time arrive from the hidden `tick query` (Minecraft 1.21.4 has it)', await waitFor('window.__perf.some((p) => p.tps !== null)', 25000));
  const pt = await page.ev('window.__perf.filter((p) => p.tps !== null).pop()');
  check('2.8 ms per tick is a perfect 20 TPS', pt.mspt === 2.8 && pt.tps === 20, J(pt));
  const lg = await logs();
  check('the query and its answer never reach the console', !/Average time per tick|Target tick rate|The game is running normally|Percentiles/.test(lg) && !/Unknown command: tick query/.test(lg), lg.slice(-400));
  await page.ev(`vp.server.command('say [12:00:09] [Server thread/WARN]: Can\\'t keep up! Is the server overloaded? Running 2345ms or 46 ticks behind')`);
  check('a "can\'t keep up" warning is counted and still shown in the console', await waitFor('window.__perf.some((p) => p.lagWarnings === 1)', 5000) && /Can't keep up/.test(await logs()));
  await page.ev(`vp.server.command('say <Steve> Average time per tick: 99 ms')`);
  await sleep(600);
  check('a player typing the same words is not taken for an answer, and is shown', (await logs()).includes('<Steve> Average time per tick: 99 ms') && (await page.ev('window.__perf[window.__perf.length - 1].mspt')) === 2.8);

  // ── A stop the person asked for is not a crash ───────────────────────────
  await stopAndWait();
  await sleep(500);
  check('stopping the server from the app gives no explanation', (await page.ev('window.__diag.length')) === 0, J(await page.ev('window.__diag')));
  const nPerf = await page.ev('window.__perf.length');
  await sleep(2600);
  check('and the samples stop with the server', (await page.ev('window.__perf.length')) === nPerf);

  // ── A restart forgets the last run ───────────────────────────────────────
  await page.ev('window.__perf.length = 0');
  check('starting again works', await startAndWait(id));
  check('the lag count starts from zero again', await waitFor('window.__perf.length > 0', 8000) && (await page.ev('window.__perf[0].lagWarnings')) === 0 && (await page.ev('window.__perf[0].tps')) === null);

  // ── A crash is explained ─────────────────────────────────────────────────
  await page.ev(`vp.server.command('say [12:00:10] [Server thread/ERROR]: **** FAILED TO BIND TO PORT!')`);
  await sleep(300);
  await page.ev(`vp.server.command('crash')`);
  check('a crash is explained, naming the port', await waitFor('window.__diag.length === 1', 8000));
  let d = await page.ev('window.__diag[0]');
  check('with the profile, the right reason, plain words and a fix the screen can offer', d.profileId === id && d.items.length === 1 && d.items[0].id === 'port-in-use' && /port 25581/.test(d.items[0].detail) && d.items[0].fix.action === 'settings' && /FAILED TO BIND/.test(d.items[0].evidence), J(d));

  // ── Nothing recognised, and Hinglish ─────────────────────────────────────
  await page.ev('window.__diag.length = 0');
  check('the server starts again', await startAndWait(id));
  await page.ev('vp.setLanguage("hinglish")');
  await page.ev(`vp.server.command('crash')`);
  check('a crash with nothing recognised gets the general explanation', await waitFor('window.__diag.length === 1', 8000));
  d = await page.ev('window.__diag[0]');
  check('only the new run\'s lines were read (no port complaint), and it has a fix to open the folder', d.items.length === 1 && d.items[0].id === 'crashed' && d.items[0].fix.action === 'folder', J(d));
  check('and its words follow the Hinglish setting', d.items[0].title === 'Server crash ho gaya' && d.items[0].fix.label === 'Server folder kholo', J(d));

  // ── A clean exit the app did not ask for ─────────────────────────────────
  await page.ev('window.__diag.length = 0');
  check('the server starts once more', await startAndWait(id));
  await page.ev(`vp.server.command('stop')`);
  await waitFor("window.__status === 'stopped'", 10000);
  await sleep(500);
  check('a clean exit (code 0) that nothing explains gives no explanation', (await page.ev('window.__diag.length')) === 0, J(await page.ev('window.__diag')));
} finally {
  page.close(); kill(app); kill(accounts); mc.close();
  if (originalProfiles !== null) fs.writeFileSync(profilesFile, originalProfiles); else fs.rmSync(profilesFile, { force: true });
  fs.rmSync(testRoot, { recursive: true, force: true });
}
process.exit(done());

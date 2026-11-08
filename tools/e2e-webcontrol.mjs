// End to end through the real Tauri window: web control (testers only) against tools/fake-accounts.mjs.
//   node tools/e2e-webcontrol.mjs <debug-exe> <data-dir> <folder-with-stand-in-java.exe>
// Phase A: started normally, web control does not exist (nothing shown, nothing sent, switching it on is refused).
// Phase B: started with VOXELPORT_WEB_CONTROL=1, a friend's Start / Restart / Stop / Kick and a refused command run
// against the real server code, the report carries the cleaned console, a poll held longer than 15 s is not given up,
// invite links work, a missing Supporter+ perk is reported, and signing out ends the loop.
// Only the processes this script starts are ended, by PID. Development builds only (uses debug-only env switches).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';

const [exe, dataDir, javaDir] = process.argv.slice(2);
const ACCOUNTS = 8799, CDP = 9333;
const { check, done } = reporter();
const A = `http://127.0.0.1:${ACCOUNTS}`;
const get = async (p) => (await fetch(A + p)).json();
const post = async (p, body) => (await fetch(A + p, { method: 'POST', body: JSON.stringify(body) })).json();
const until = async (what, fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); } return null; };
const baseEnv = { PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: A, VOXELPORT_NO_BROWSER: '1' };

// A clean identity; keep the seeded server list. Put back the preferences file as it was afterwards.
for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json']) fs.rmSync(path.join(dataDir, f), { force: true });
const prefsFile = path.join(dataDir, 'preferences.json');
const prefsBefore = fs.existsSync(prefsFile) ? fs.readFileSync(prefsFile) : null;
if (prefsBefore) { const p = JSON.parse(prefsBefore.toString()); delete p.webControl; fs.writeFileSync(prefsFile, JSON.stringify(p)); }

const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
await sleep(600);
let app, page;
try {
  // ── Phase A: a normal start ──
  app = launch(exe, { env: baseEnv, cdpPort: CDP }); page = await connect(CDP);
  let r = await page.ev('vp.discordSignIn()');
  check('A: sign in works', r.ok === true && r.state.allowed === true, JSON.stringify(r));
  let s = await page.ev('vp.webControlGet()');
  check('A: web control says it is not available', s.available === false && s.enabled === false && s.profiles.length === 0, JSON.stringify(s));
  r = await page.ev("vp.webControlSet({ enabled: true, profileId: 'dev-test-1' })");
  check('A: switching it on is refused', r.ok === false && /not switched on/.test(r.error), JSON.stringify(r));
  r = await page.ev('vp.webControlInviteCreate({ days: 7 })');
  check('A: invite links are refused too', r.ok === false && /not switched on/.test(r.error), JSON.stringify(r));
  await sleep(2500);
  check('A: the library card stays hidden', await page.ev("document.getElementById('webControlCard').classList.contains('hidden')") === true);
  check('A: nothing was sent to the accounts service', (await get('/__control/state')).polls.started === 0 && (await get('/__log')).log.every((l) => !l.includes('/api/app/control')));
  page.close(); kill(app); await sleep(1500);

  // ── Phase B: web control on ──
  app = launch(exe, { env: { ...baseEnv, VOXELPORT_WEB_CONTROL: '1' }, cdpPort: CDP }); page = await connect(CDP); await sleep(1500);
  s = await page.ev('vp.webControlGet()');
  check('B: available, signed in and allowed, a server list to choose from', s.available === true && s.allowed === true && s.enabled === false && s.profiles.some((p) => p.id === 'dev-test-1'), JSON.stringify(s));
  check('B: the library card shows', await until('card', async () => (await page.ev("document.getElementById('webControlCard').classList.contains('hidden')")) === false, 5000) !== null);
  await get('/__control/set?watching=1&hold=300&perk=1');
  r = await page.ev("vp.webControlSet({ enabled: true, profileId: 'no-such-server' })");
  check('B: a server that does not exist cannot be chosen', r.enabled === false && r.profileId === null, JSON.stringify(r));
  r = await page.ev("vp.webControlSet({ enabled: true, profileId: 'dev-test-1' })");
  check('B: switched on for the chosen server', r.enabled === true && r.profileId === 'dev-test-1', JSON.stringify(r));
  const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  check('B: the choice is saved next to the other preferences', prefs.webControl && prefs.webControl.enabled === true && prefs.webControl.profileId === 'dev-test-1');
  check('B: the app starts polling with its 12-character id', (await until('poll', async () => { const st = await get('/__control/state'); return st.polls.started > 0 && st.vps.length === 1; }, 8000)) !== null, JSON.stringify(await get('/__control/state')));

  // Start
  await post('/__control/enqueue', { action: 'start' });
  const startResult = await until('start result', async () => (await get('/__control/state')).results.find((x) => x.message === 'Starting'), 15000);
  check('B: a friend\'s Start is run and its result is sent back', !!startResult && startResult.ok === true, JSON.stringify(startResult));
  check('B: the server really comes online', (await until('online', async () => (await page.ev('vp.server.state()')).serverStatus === 'online', 20000)) !== null);
  const rep = await until('report', async () => { const st = await get('/__control/state'); return st.report && st.report.status === 'online' ? st.report : null; }, 15000);
  check('B: the report says online and carries console lines', !!rep && Array.isArray(rep.lines) && rep.lines.length > 0, JSON.stringify(rep));
  check('B: no address or computer user name in the report', !!rep && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(rep.lines.join('\n')) && !/Users[\\/]Trazverse/i.test(rep.lines.join('\n')), rep && rep.lines.join('\n').slice(0, 300));

  // Refused and failing commands
  await post('/__control/enqueue', { action: 'op', arg: 'Steve' });
  await post('/__control/enqueue', { action: 'kick', arg: 'Nobody' });
  await post('/__control/enqueue', { action: 'start' });
  const refused = await until('refusals', async () => { const x = (await get('/__control/state')).results; return x.find((y) => y.message === 'Not allowed') && x.find((y) => y.message === 'That player is not online.') && x.find((y) => y.message === 'The server is already running.') ? x : null; }, 10000);
  check('B: an unknown action, a kick of someone not online and a second Start are refused with reasons', !!refused && refused.filter((y) => y.ok === false).length >= 3, JSON.stringify(refused));

  // Restart
  await get('/__control/reset');
  await post('/__control/enqueue', { action: 'restart' });
  const restarted = await until('restart result', async () => (await get('/__control/state')).results.find((x) => x.message === 'Restarting' || x.ok === false), 40000);
  check('B: a friend\'s Restart stops and starts the same server', !!restarted && restarted.ok === true, JSON.stringify(restarted));
  check('B: and the server is online again', (await until('online again', async () => (await page.ev('vp.server.state()')).serverStatus === 'online', 30000)) !== null);

  // Stop
  await get('/__control/reset');
  await post('/__control/enqueue', { action: 'stop' });
  const stopped = await until('stop result', async () => (await get('/__control/state')).results.find((x) => x.message === 'Stopping' || x.ok === false), 15000);
  check('B: a friend\'s Stop is run', !!stopped && stopped.ok === true, JSON.stringify(stopped));
  check('B: the server stops', (await until('stopped', async () => (await page.ev('vp.server.state()')).serverStatus === 'stopped', 20000)) !== null);
  await post('/__control/enqueue', { action: 'stop' });
  check('B: a Stop with nothing running is refused', (await until('stop refused', async () => (await get('/__control/state')).results.find((x) => x.message === 'The server is not running.'), 10000)) !== null);

  // Invite links
  r = await page.ev("vp.webControlInviteCreate({ days: 7, label: 'friends' })");
  check('B: an invite link is made', r.ok === true && /^https:\/\/web\.voxelport\.in\/j\//.test(r.url), JSON.stringify(r));
  r = await page.ev('vp.webControlInvites()');
  check('B: and listed', r.ok === true && r.invites.length === 1 && r.invites[0].label === 'friends', JSON.stringify(r));
  const id = r.invites[0].id;
  r = await page.ev(`vp.webControlInviteRemove(${id})`);
  check('B: and removed', r.ok === true && (await page.ev('vp.webControlInvites()')).invites.length === 0, JSON.stringify(r));
  r = await page.ev('vp.webControlInviteRemove(-5)');
  check('B: a bad link number is refused', r.ok === false, JSON.stringify(r));

  // The poll the service holds for a long time (the real one holds 25 s): the app must not give up at 15 s.
  await get('/__control/set?hold=20000');
  await sleep(2500); // the poll in flight ends and the next one starts, held for 20 s
  const a = (await get('/__control/state')).polls;
  await sleep(16000); // 18 s into that poll: past the 15 s a shorter limit would have given up at
  const b = (await get('/__control/state')).polls;
  check('B: a poll held for 20 s is not given up (no retry at 15 s)', a.started >= 1 && b.started === a.started, JSON.stringify({ a, b }));
  await until('held poll ends', async () => (await get('/__control/state')).polls.finished > b.finished, 8000);
  await get('/__control/set?hold=300');

  // No Supporter+ perk
  await get('/__control/set?perk=0');
  const noPerk = await until('perk false', async () => { const g = await page.ev('vp.webControlGet()'); return g.perk === false ? g : null; }, 40000);
  check('B: the app learns that web control is a Supporter+ perk and says so', !!noPerk, JSON.stringify(await page.ev('vp.webControlGet()')));
  r = await page.ev('vp.webControlInviteCreate({ days: 7 })');
  check('B: a link is refused with the perk message', r.ok === false && /Supporter\+ perk/.test(r.error), JSON.stringify(r));
  await get('/__control/set?perk=1');

  // Switching it off, and signing out, end the loop
  r = await page.ev("vp.webControlSet({ enabled: false, profileId: 'dev-test-1' })");
  check('B: switching it off stops the loop', r.enabled === false && (await until('not running', async () => (await page.ev('vp.webControlGet()')).running === false, 40000)) !== null, JSON.stringify(r));
  await page.ev("vp.webControlSet({ enabled: true, profileId: 'dev-test-1' })");
  await until('running again', async () => (await page.ev('vp.webControlGet()')).running === true, 8000);
  await page.ev('vp.discordSignOut()');
  await sleep(2000);
  const before = (await get('/__control/state')).polls.started;
  await sleep(4000);
  check('B: signing out ends it (nothing more is asked)', (await get('/__control/state')).polls.started === before);
  check('B: and the app shows it as not running', (await page.ev('vp.webControlGet()')).running === false);
} finally {
  try { page && page.close(); } catch {}
  if (app) kill(app);
  kill(accounts);
  if (prefsBefore) fs.writeFileSync(prefsFile, prefsBefore);
}
process.exit(done());

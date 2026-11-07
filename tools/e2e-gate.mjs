// End to end through the real Tauri window: the Discord gate, sign-in (PKCE against tools/fake-accounts.mjs),
// start refused then allowed, address backup, sign-out, and the session surviving a restart.
//   node tools/e2e-gate.mjs <debug-exe> <data-dir> <path-to-folder-with-stand-in-java.exe>
// Only the processes this script starts are ended, by PID. Development builds only (uses debug-only env switches).
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [exe, dataDir, javaDir] = process.argv.slice(2);
const ACCOUNTS = 8799, CDP = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };

const kill = (child) => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

// Start from a clean identity (only the files the gate creates), keep the seeded server list.
for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json']) fs.rmSync(path.join(dataDir, f), { force: true });
for (const f of fs.readdirSync(dataDir)) if (f.startsWith('device-token.unreadable-')) fs.rmSync(path.join(dataDir, f), { force: true });

const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
await sleep(600);

function launch() {
  const env = { ...process.env, PATH: `${javaDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` };
  return spawn(exe, [], { stdio: 'ignore', env });
}
async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json`, { signal: AbortSignal.timeout(500) })).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0; const waiting = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
        const send = (method, params = {}) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
        const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: `(async()=>(${expr}))()`, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result.result.value; };
        for (let j = 0; j < 50; j++) { if (await ev("typeof window.vp === 'object'") === true) return { ev, close: () => ws.close() }; await sleep(100); }
      }
    } catch {}
    await sleep(150);
  }
  throw new Error('window never became ready');
}
const accountsLog = async () => (await fetch(`http://127.0.0.1:${ACCOUNTS}/__log`)).json();

let app = launch();
let page = await connect();
try {
  let s = await page.ev('vp.discordState()');
  check('a fresh install starts blocked and asked to sign in', s.allowed === false && s.mustSignIn === true && s.reason === 'signed_out' && s.newInstall === true, JSON.stringify(s));

  let r = await page.ev("vp.server.start('dev-test-1')");
  check('starting a server is refused with the Discord message', r.ok === false && /Join the VoxelPort Discord/.test(r.error), JSON.stringify(r));

  const info = await page.ev('vp.info()');
  check('app info shows a masked token and a 12-character VoxelPort ID, never the raw token', /^••••••••.{4}$/.test(info.maskedToken) && /^[0-9a-f]{12}$/.test(info.supporterID) && !JSON.stringify(info).includes('vp_') && info.tokenEncryptedAtRest === true, JSON.stringify(info));

  r = await page.ev('vp.discordSignIn()');
  check('Continue with Discord completes through the loopback callback with PKCE', r.ok === true && r.member === true && r.discordName === 'E2E Player' && r.state.allowed === true, JSON.stringify(r));

  s = await page.ev('vp.discordState()');
  check('state now allowed, with name, rank, plan and invite', s.allowed && s.discordName === 'E2E Player' && s.rank === 'free' && s.planName === 'Free' && /discord\.gg\//.test(s.inviteUrl) && s.reachable, JSON.stringify(s));

  const tokenFile = fs.readFileSync(path.join(dataDir, 'device-token.json'), 'utf8');
  const sessionFile = fs.readFileSync(path.join(dataDir, 'app-session.json'), 'utf8');
  check('device token and session are encrypted on disk (no plain text)', /"enc"/.test(tokenFile) && !/vp_/.test(tokenFile) && /"enc"/.test(sessionFile) && !/fake-session/.test(sessionFile), tokenFile.slice(0, 80) + ' | ' + sessionFile.slice(0, 80));

  r = await page.ev("vp.server.start('dev-test-1')");
  check('a signed-in member can start the server', r.ok === true, JSON.stringify(r));
  await sleep(2000);
  check('the server comes online', (await page.ev('vp.server.state()')).serverStatus === 'online');
  await page.ev('vp.server.stop()');
  await sleep(2500);
  check('and stops cleanly', (await page.ev('vp.server.state()')).serverStatus === 'stopped');

  r = await page.ev("vp.identitySave('short')");
  check('a short passphrase gets the Electron message', r.ok === false && r.error === 'Use at least 12 characters.', JSON.stringify(r));
  r = await page.ev("vp.identitySave('correct horse battery staple')");
  check('the address backup saves', r.ok === true && /Backed up/.test(r.message), JSON.stringify(r));
  s = await page.ev('vp.discordState()');
  check('state shows the backup as this PC\'s own, id last 4 only', s.backup && s.backup.thisPc === true && s.backup.id.length === 4, JSON.stringify(s.backup));
  r = await page.ev("vp.identityRestore('wrong passphrase here')");
  check('a wrong passphrase does not restore', r.ok === false && /doesn't open the backup/.test(r.error), JSON.stringify(r));
  const supporterBefore = (await page.ev('vp.info()')).supporterID;
  r = await page.ev("vp.identityRestore('correct horse battery staple')");
  check('the right passphrase restores (same address here) and keeps the identity', r.ok === true && (await page.ev('vp.info()')).supporterID === supporterBefore, JSON.stringify(r));
  r = await page.ev('vp.identityDelete()');
  check('the backup can be deleted', r.ok === true && (await page.ev('vp.discordState()')).backup === null, JSON.stringify(r));

  // The session survives a restart.
  page.close(); kill(app); await sleep(1500);
  app = launch(); page = await connect(); await sleep(1500);
  s = await page.ev('vp.discordState()');
  check('after a restart the saved session still lets this member in', s.allowed === true && s.discordName === 'E2E Player', JSON.stringify(s));

  // Not in the server: blocked with the invite.
  await fetch(`http://127.0.0.1:${ACCOUNTS}/__member?v=0`);
  s = await page.ev('vp.discordRecheck()');
  check('when the Discord server no longer has the member, the gate blocks and keeps the invite', s.allowed === false && s.reason === 'not_in_server' && /discord\.gg\//.test(s.inviteUrl), JSON.stringify(s));
  r = await page.ev("vp.server.start('dev-test-1')");
  check('and starting is refused again', r.ok === false && /Join the VoxelPort Discord/.test(r.error), JSON.stringify(r));
  await fetch(`http://127.0.0.1:${ACCOUNTS}/__member?v=1`);

  s = await page.ev('vp.discordSignOut()');
  check('sign out clears the account and blocks again', s.allowed === false && s.reason === 'signed_out' && s.discordName === null && !fs.existsSync(path.join(dataDir, 'app-session.json')), JSON.stringify(s));
  r = await page.ev("vp.setLanguage('hinglish').then(() => vp.server.start('dev-test-1'))");
  check('the refusal follows the language setting', /Pehle VoxelPort Discord/.test(r.error), JSON.stringify(r));
} finally {
  page.close(); kill(app); kill(accounts);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

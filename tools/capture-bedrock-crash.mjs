// Captures two more showcase sequences the reel needs beyond capture-showcase.mjs: the Bedrock toggle turning
// on, and the "Why it stopped" crash card. Same pattern (CDP screenshots against the e2e fakes, no Java download
// for the server itself needed since the fake MC process stands in for it).
//   node tools/capture-bedrock-crash.mjs <debug-exe> <data-dir> <test-root> <out-dir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startFakeMc } from './fake-mc.mjs';
import { startFakeRelay } from './fake-relay.mjs';
import { sleep, launch, connect, kill } from './e2e-lib.mjs';

const [exe, dataDir, testRoot, outDir] = process.argv.slice(2);
if (!dataDir.includes('in.voxelport.app.dev') || !testRoot.includes('vp-tauri-test')) throw new Error('refusing non-dev folders');
const ACCOUNTS = 8799, MC = 8797, SERVER_PORT = 25598;
const bedrockDir = path.join(outDir, 'frames-bedrock');
const crashDir = path.join(outDir, 'frames-crash');
for (const d of [bedrockDir, crashDir]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json', 'custom-address.json', 'preferences.json', 'bedrock-endpoints.json']) fs.rmSync(path.join(dataDir, f), { force: true });
const profilesFile = path.join(dataDir, 'server-profiles.json');
const original = fs.existsSync(profilesFile) ? fs.readFileSync(profilesFile, 'utf8') : null;
fs.writeFileSync(profilesFile, JSON.stringify({ version: 2, servers: [] }));

const accounts = spawn('node', [path.join(import.meta.dirname, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const mc = await startFakeMc(MC);
const relay = await startFakeRelay();
const local = net.createServer((s) => s.on('data', (b) => s.write(b)));
await new Promise((r) => local.listen(SERVER_PORT, '127.0.0.1', r));
await sleep(600);

const app = launch(exe, { env: {
  VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1',
  VOXELPORT_MC_API: mc.base, VOXELPORT_MODRINTH_API: `${mc.base}/v2`, VOXELPORT_GEYSER_API: `${mc.base}/geyser`, VOXELPORT_RELAY_URL: relay.url,
}, cdpPort: 9356 });
const page = await connect(9356);

const targets = await (await fetch('http://127.0.0.1:9356/json')).json();
const target = targets.find((t) => t.type === 'page');
const CDP = await (async () => {
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  let id = 0; const waiting = new Map();
  sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; waiting.set(n, res); sock.send(JSON.stringify({ id: n, method, params })); });
  return { send, close: () => sock.close() };
})();

let n = 0, dir = bedrockDir;
const shot = async () => {
  const r = await CDP.send('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) fs.writeFileSync(path.join(dir, `frame-${String(n++).padStart(4, '0')}.png`), Buffer.from(r.data, 'base64'));
};
const dwell = async (count, gap = 120) => { for (let i = 0; i < count; i++) { await shot(); await sleep(gap); } };

try {
  await page.ev("(window.__st = '', vp.on('server:status', (x) => window.__st = x), true)");
  await page.ev("vp.discordSignIn()");
  await page.ev("window.refreshLibrary && window.refreshLibrary()"); await page.ev("window.showScreen('screen-library')");
  await sleep(700);
  const inst = await page.ev(`vp.server.install({ name: 'Survival SMP', type: 'paper', version: '1.21.4', port: ${SERVER_PORT}, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(path.join(testRoot, 'cap-bedrock'))}, templateId: 'survival' })`);
  const id = inst.profile?.id;
  await page.ev("window.refreshLibrary()"); await page.ev(`window.openManagementScreen(${JSON.stringify(id)})`);
  await sleep(600);

  // ── Sequence 1: the Bedrock toggle turning on (settings screen) ──
  n = 0; dir = bedrockDir;
  await page.ev("window.openSettingsScreen && window.openSettingsScreen(" + JSON.stringify(id) + ")");
  await sleep(500);
  await page.ev("document.getElementById('setBedrock')?.scrollIntoView({ block: 'center' })");
  await sleep(300); await dwell(8); // settings open, toggle off, in view
  // Click the real checkbox (not the backend call directly): that is what actually drives the UI's checked state
  // and status text, the same as a person clicking it.
  await page.ev("document.getElementById('setBedrock')?.click()");
  await sleep(300);
  await page.ev("document.getElementById('setBedrock')?.scrollIntoView({ block: 'center' })");
  for (let i = 0; i < 60; i++) { await shot(); const msg = await page.ev("document.getElementById('setBedrockMsg')?.textContent || ''").catch(() => ''); if (/^On —/.test(msg)) break; await sleep(300); }
  await dwell(14); // hold on the finished "On — Bedrock players join..." state, checkbox visibly checked
  console.log('BEDROCK FRAMES', n);

  // ── Sequence 2: the crash card ──
  n = 0; dir = crashDir;
  await page.ev("window.showScreen('screen-console')");
  await sleep(300);
  await page.ev(`vp.server.start(${JSON.stringify(id)})`);
  for (let i = 0; i < 120; i++) { await shot(); if ((await page.ev('window.__st')) === 'online') break; await sleep(250); }
  await sleep(400); await dwell(6); // briefly online
  await page.ev("vp.server.command('crash')");
  let crashed = false;
  for (let i = 0; i < 60; i++) { await shot(); const st = await page.ev('document.getElementById("diagnosis") && !document.getElementById("diagnosis").classList.contains("hidden")').catch(() => false); if (st) { crashed = true; break; } await sleep(200); }
  await dwell(20); // hold on the "Why it stopped" card
  console.log('CRASH FRAMES', n, 'crashed', crashed);
} catch (e) {
  console.log('ERROR', String(e));
} finally {
  CDP.close(); page.close(); kill(app);
  if (original) fs.writeFileSync(profilesFile, original);
  accounts.kill(); mc.close?.(); relay.stop?.(); local.close();
  await sleep(500);
}

// Captures a showcase GIF of the REAL desktop app, driven over CDP against the e2e fakes (no Java download).
//   node tools/capture-showcase.mjs <debug-exe> <data-dir> <test-root> <out-dir>
// Writes frame-####.png into <out-dir>/frames and leaves ffmpeg assembly to a shell step.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startFakeMc } from './fake-mc.mjs';
import { startFakeRelay } from './fake-relay.mjs';
import { sleep, launch, connect, kill } from './e2e-lib.mjs';

const [exe, dataDir, testRoot, outDir, javaDir] = process.argv.slice(2);
if (!dataDir.includes('in.voxelport.app.dev') || !testRoot.includes('vp-tauri-test')) throw new Error('refusing non-dev folders');
const ACCOUNTS = 8799, MC = 8797, SERVER_PORT = 25599;
const framesDir = path.join(outDir, 'frames');
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

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
  PATH: `${javaDir};${process.env.PATH}`,
  VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1',
  VOXELPORT_MC_API: mc.base, VOXELPORT_MODRINTH_API: `${mc.base}/v2`, VOXELPORT_RELAY_URL: relay.url,
}, cdpPort: 9355 });
const page = await connect(9355);

// Raw CDP for Page.captureScreenshot: reopen a second ws to the same page target.
const targets = await (await fetch('http://127.0.0.1:9355/json')).json();
const target = targets.find((t) => t.type === 'page');
const CDP = await (async () => {
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  let id = 0; const waiting = new Map();
  sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; waiting.set(n, res); sock.send(JSON.stringify({ id: n, method, params })); });
  return { send, close: () => sock.close() };
})();

let n = 0;
const shot = async () => {
  const r = await CDP.send('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) fs.writeFileSync(path.join(framesDir, `frame-${String(n++).padStart(4, '0')}.png`), Buffer.from(r.data, 'base64'));
};
// Snap `count` frames `gap` ms apart (a held shot / dwell).
const dwell = async (count, gap = 120) => { for (let i = 0; i < count; i++) { await shot(); await sleep(gap); } };

try {
  await page.ev("(window.__st = '', window.__pub = null, vp.on('server:status', (x) => window.__st = x), vp.on('tunnel:assigned', (a) => window.__pub = a), true)");
  await page.ev('vp.discordSignIn()');
  await page.ev("(window.__st='', window.__pub=null, vp.on('server:status',x=>window.__st=x), vp.on('tunnel:assigned',a=>window.__pub=a), true)");
  await page.ev("window.refreshLibrary && window.refreshLibrary()"); await page.ev("window.showScreen('screen-library')");
  await sleep(900); await dwell(12);                 // 1) empty home
  const dir = path.join(testRoot, 'cap-server');
  const inst = await page.ev(`vp.server.install({ name: 'Survival SMP', type: 'paper', version: '1.21.4', port: ${SERVER_PORT}, minRamMb: 1024, maxRamMb: 2048, serverDir: ${JSON.stringify(dir)}, templateId: 'survival' })`);
  const id = inst.profile?.id;
  await page.ev("window.refreshLibrary()"); await page.ev("window.showScreen('screen-library')");
  await sleep(700); await dwell(12);                 // 2) server card on home
  await page.ev("window.showScreen('screen-console')"); await page.ev(`window.openManagementScreen(${JSON.stringify(id)})`);
  await sleep(800); await dwell(10);                 // 3) manage screen (stopped)
  await page.ev(`vp.server.start(${JSON.stringify(id)})`);
  let online=false; for(let i=0;i<120;i++){ await shot(); if((await page.ev('window.__st'))==='online'){online=true;break;} await sleep(250);}
  await page.ev("window.showScreen('screen-console'); window.refreshManagedProfile && window.refreshManagedProfile()");
  await dwell(14);                                   // 4) online
  let pub=null;
  if(online){
    pub=await page.ev(`vp.server.makePublic(${JSON.stringify(id)})`);
    for(let i=0;i<50;i++){ await shot(); if(await page.ev('window.__pub')) break; await sleep(200);}
    await page.ev("window.showScreen('screen-console'); window.refreshManagedProfile && window.refreshManagedProfile()");
    await sleep(500);
    await dwell(30);                                 // 5) public address held
  }
    console.log('FRAMES', n, 'install', inst.ok, 'online', online, 'public', JSON.stringify(pub).slice(0, 140));
} catch (e) {
  console.log('ERROR', String(e));
} finally {
  CDP.close(); page.close(); kill(app);
  if (original) fs.writeFileSync(profilesFile, original);
  accounts.kill(); mc.stop?.(); relay.stop?.(); local.close();
  await sleep(500);
}

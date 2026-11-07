// Idle RAM, idle CPU and cold start of a desktop app, measured the same way for Electron and Tauri.
//   node tools/bench.mjs <label> <port> <runs> <exe> [args...]
// The app is started in an isolated profile by the caller (via args/env), left alone for 30 s on its first screen,
// then the whole process tree (the app plus its web view / helpers) is sampled. Only the process it started is killed.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [label, port, runs, exe, ...args] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const tree = (pid) => JSON.parse(execFileSync('powershell', ['-NoProfile', '-File', path.join(here, 'tree.ps1'), '-RootPid', String(pid)], { encoding: 'utf8' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function pageReady() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) })).json();
    const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
    if (!page) return false;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const r = await new Promise((res) => {
      ws.onmessage = (m) => res(JSON.parse(m.data));
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "document.readyState === 'complete' && typeof window.vp === 'object'", returnByValue: true } }));
    });
    ws.close();
    return r.result?.result?.value === true;
  } catch { return false; }
}

const results = [];
for (let i = 0; i < Number(runs); i++) {
  const t0 = performance.now();
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
  delete env.ELECTRON_RUN_AS_NODE; // must be absent, not empty, for Electron to run as an app
  const child = spawn(exe, args, { stdio: 'ignore', env, windowsHide: true });
  let startMs = null;
  while (performance.now() - t0 < 60000) { if (await pageReady()) { startMs = Math.round(performance.now() - t0); break; } await sleep(50); }
  if (startMs === null) { console.log(`${label} run ${i + 1}: page never became ready`); try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} continue; }
  await sleep(30000); // settle on the first screen
  const a = tree(child.pid);
  await sleep(20000);
  const b = tree(child.pid);
  const cpuPct = ((b.cpuSeconds - a.cpuSeconds) / 20) * 100;
  results.push({ startMs, ws: b.workingSetMB, priv: b.privateMB, cpuPct, procs: b.processes, names: b.names });
  console.log(`${label} run ${i + 1}: start ${startMs} ms | RAM working set ${b.workingSetMB} MB, private ${b.privateMB} MB | idle CPU ${cpuPct.toFixed(2)}% of one core | ${b.processes} processes (${b.names})`);
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(3000);
}
if (results.length) {
  console.log(`${label} MEDIAN of ${results.length}: start ${median(results.map((r) => r.startMs))} ms | working set ${median(results.map((r) => r.ws))} MB | private ${median(results.map((r) => r.priv))} MB | idle CPU ${median(results.map((r) => r.cpuPct)).toFixed(2)}%`);
}

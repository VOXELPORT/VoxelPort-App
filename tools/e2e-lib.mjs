// Shared helpers for the end-to-end scripts: launch the debug build with a WebView2 debugging port, drive its page
// through window.vp, and end only the processes the script started (by PID, with their children).
import { spawn, execFileSync } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function reporter() {
  let pass = 0, fail = 0;
  return {
    check(name, ok, detail = '') { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); },
    done() { console.log(`\n${pass} passed, ${fail} failed`); return fail ? 1 : 0; },
  };
}

export const kill = (child) => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

export function launch(exe, { env = {}, cdpPort = 9333 } = {}) {
  const full = { ...process.env, ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` };
  return spawn(exe, [], { stdio: 'ignore', env: full });
}

/** Connects to the app's page and waits for window.vp. `ev(expr)` evaluates an async expression in the page. */
export async function connect(cdpPort = 9333) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(500) })).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0; const waiting = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
        const send = (method, params = {}) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
        const ev = async (expr) => {
          const r = await send('Runtime.evaluate', { expression: `(async()=>(${expr}))()`, awaitPromise: true, returnByValue: true });
          return r.result.exceptionDetails ? { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result.result.value;
        };
        for (let j = 0; j < 50; j++) { if (await ev("typeof window.vp === 'object'") === true) return { ev, close: () => ws.close() }; await sleep(100); }
      }
    } catch {}
    await sleep(150);
  }
  throw new Error('window never became ready');
}

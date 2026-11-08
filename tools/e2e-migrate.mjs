// End to end: the "VoxelPort has moved" update in the old (Electron) app, through its real window, with the REAL new installer.
//   node tools/e2e-migrate.mjs <test-folder inside a vp-tauri-test folder>
//
// What is real: the old app (the development Electron with this folder's code, its real window and main process), the new app's real signed
// installer (from ../VoxelPort-Tauri-Migration/release-out) checked against the real update key, the real silent install, the real new app
// bringing a synthetic old app's data over, and the real removal script. What is stand-in: the update server (a local one serving the real
// installer and its real signature, on 127.0.0.1) and the old app's own install (a folder with a program, a stand-in uninstaller that deletes
// it like the real one does, and shortcuts in a throwaway folder). The old app's data is a synthetic folder made like Electron makes it.
// Nothing of yours is touched: the new app is installed into the test folder with /NS (no shortcuts), the data lives in the test folder
// (APPDATA is pointed there), and the test refuses to run if a VoxelPort of the new kind is already installed here.
//
// Needs the new app's release build first: `node tools/build-release.mjs` in VoxelPort-Tauri-Migration.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sleep, reporter, kill } from '../../VoxelPort-Tauri-Migration/tools/e2e-lib.mjs';
import { ID_A, newToken, makeOldApp, snapshot } from '../../VoxelPort-Tauri-Migration/tools/legacy-fixture.mjs';

const [rootArg] = process.argv.slice(2);
const root = rootArg && path.resolve(rootArg);
const { check, done } = reporter();
if (!root || !root.includes('vp-tauri-test')) throw new Error('usage: node tools/e2e-migrate.mjs <test folder inside a vp-tauri-test folder>');
const appDir = path.resolve(import.meta.dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const releaseOut = path.resolve(appDir, '..', 'VoxelPort-Tauri-Migration', 'release-out');
const real = JSON.parse(fs.readFileSync(path.join(releaseOut, 'latest.json'), 'utf8'));
const entry = real.platforms['windows-x86_64'];
const installerName = path.basename(entry.url);
const installerBytes = fs.readFileSync(path.join(releaseOut, installerName));

const product = 'VoxelPort', identifier = 'in.voxelport.app';
const localAppData = process.env.LOCALAPPDATA;
const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`;
const regQuery = (key) => { try { return execFileSync('reg', ['query', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const defaultDir = path.join(localAppData, product);
const localData = path.join(localAppData, identifier);
// The new app keeps its data in the real Roaming folder whatever APPDATA says (Windows' own answer is used), so that is where its answer file lands.
// APPDATA is only pointed at the test folder so that the new app looks for the *previous* app there, never at a real one.
const newData = path.join(process.env.APPDATA, identifier);
if (fs.existsSync(defaultDir) || fs.existsSync(localData) || fs.existsSync(newData) || regQuery(uninstallKey)) throw new Error('A VoxelPort of the new kind is already installed or has data here: refusing to run (it would be a real person\'s).');

fs.rmSync(root, { recursive: true, force: true });
const dirs = {
  roaming: path.join(root, 'roaming'), installDir: path.join(root, 'new-install'), oldInstall: path.join(root, 'old-install'),
  shortcuts: path.join(root, 'shortcuts'), tmp: path.join(root, 'tmp'), electronData: path.join(root, 'electron-user'),
};
for (const d of [dirs.roaming, dirs.oldInstall, dirs.shortcuts, dirs.tmp]) fs.mkdirSync(d, { recursive: true });
const oldApp = makeOldApp(dirs.roaming, 'voxelport-app', newToken());
const oldBefore = snapshot(oldApp);

// The old app's own install: a program, a name the app recognises as its uninstaller, and a stand-in that removes the program and the desktop
// shortcut by name (as electron-builder's does). The person "had" a desktop shortcut and no Start menu shortcut.
const oldExe = path.join(dirs.oldInstall, 'VoxelPort.exe');
const desktopLink = path.join(dirs.shortcuts, 'Desktop-VoxelPort.lnk');
const startLink = path.join(dirs.shortcuts, 'Start-VoxelPort.lnk');
fs.writeFileSync(oldExe, 'old program');
fs.writeFileSync(path.join(dirs.oldInstall, 'Uninstall VoxelPort.exe'), 'recognised by name only');
fs.writeFileSync(desktopLink, 'a shortcut');
const uninstaller = path.join(dirs.oldInstall, 'standin-uninstall.cmd');
fs.writeFileSync(uninstaller, `@echo off\r\ndel "${oldExe}"\r\ndel "${desktopLink}"\r\ndel "${startLink}"\r\n`);

// The update server: the real manifest and installer, on loopback. `tamper` flips one byte of the installer, as a bad download would.
const serverState = { tamper: false, requests: [] };
let serverPort = 0;
const server = http.createServer((req, res) => {
  serverState.requests.push(req.url);
  if (req.url === '/latest.json') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ version: real.version, platforms: { 'windows-x86_64': { signature: entry.signature, url: `http://127.0.0.1:${serverPort}/${installerName}` } } }));
  } else if (req.url === `/${installerName}`) {
    const body = Buffer.from(installerBytes);
    if (serverState.tamper) body[5000] ^= 1;
    res.setHeader('content-length', String(body.length));
    res.end(body);
  } else { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
serverPort = server.address().port;

const testing = {
  manifestUrl: `http://127.0.0.1:${serverPort}/latest.json`, installDir: dirs.installDir, installerArgs: ['/NS'], newAppDataDir: newData,
  oldExe, uninstaller, tmpDir: dirs.tmp, desktopShortcut: desktopLink, startMenuShortcut: startLink,
};

const env = { ...process.env, APPDATA: dirs.roaming, VOXELPORT_MIGRATE_TEST: JSON.stringify(testing) };
delete env.ELECTRON_RUN_AS_NODE;
const CDP = 9444;
const app = spawn(electronExe, [appDir, `--user-data-dir=${dirs.electronData}`, `--remote-debugging-port=${CDP}`], { env, stdio: 'ignore' });
let appExited = false;
app.once('exit', () => { appExited = true; });

async function connect() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json`, { signal: AbortSignal.timeout(500) })).json();
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
        for (let j = 0; j < 80; j++) { if (await ev("typeof window.vp === 'object' && !!document.getElementById('moveBanner')") === true) return { ev, close: () => ws.close() }; await sleep(150); }
      }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('the old app\'s window never became ready');
}
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150); } return false; };
const stopCopies = () => { try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='voxelport-tauri.exe'" | Where-Object { $_.ExecutablePath -like '${dirs.installDir.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' }); } catch { /* none */ } };

let page = null;
try {
  page = await connect();
  const $ = (id) => `document.getElementById('${id}')`;
  const status = () => page.ev(`${$('movedStatus')}.textContent`);

  // ── what the person sees ──
  check('the banner tells the person VoxelPort has moved', await waitFor(async () => page.ev(`!${$('moveBanner')}.classList.contains('hidden')`)));
  // A fresh profile starts at the Discord sign-in page. The intro must not open behind it; it opens once that page is gone.
  const locked = await page.ev("document.body.classList.contains('discord-locked')");
  check('behind the sign-in page the explaining screen stays out of the way', locked === false || (await page.ev(`!${$('screen-moved')}.classList.contains('active')`)));
  // The app puts the sign-in page back whenever its Discord state is pushed again (which a real sign-in would have changed), and it may also lift it by
  // itself when the accounts service answers, so this records that the screen opened at all, from now on, rather than catching it open at one instant.
  await page.ev(`(() => { window.__movedOpened = false; new MutationObserver(() => { if (${$('screen-moved')}.classList.contains('active')) window.__movedOpened = true; }).observe(${$('screen-moved')}, { attributes: true, attributeFilter: ['class'] }); return true; })()`);
  await sleep(3000); // a person signs in long after the app has started; do not race its start-up
  if (locked) await page.ev("document.body.classList.remove('discord-locked')");
  check('the first time, the screen that explains it opens by itself (as soon as the sign-in page is gone)', await waitFor(async () => page.ev('window.__movedOpened'), 8000), await page.ev('document.body.className + " | active: " + [...document.querySelectorAll(".screen.active")].map((e) => e.id)'));
  const info = await page.ev('vp.migrate.info()');
  check('the app knows this copy can do all of it, and which version it offers', info.available === true && info.mode === 'installed' && info.canInstall === true && info.version === real.version, JSON.stringify(info));
  check('the screen explains what the button does, and the update button is there', await page.ev(`${$('movedHow')}.textContent.includes('genuinely ours') && !${$('movedUpdateBtn')}.classList.contains('hidden') && ${$('movedPageBtn')}.classList.contains('hidden')`));
  await page.ev("(window.__phases = [], vp.on('migrate:progress', (e) => window.__phases.push(e.phase)), true)");

  // ── a bad download: refused before anything is installed or removed ──
  serverState.tamper = true;
  await page.ev(`${$('movedUpdateBtn')}.click()`);
  check('a download that fails its signature check is refused, in words', await waitFor(async () => /could not be verified/.test(await status())), await status());
  check('and the person is told nothing was removed', /untouched/.test(await status()));
  check('nothing was installed, written or removed, and the old program is still there', !fs.existsSync(dirs.installDir) && !fs.existsSync(path.join(dirs.tmp, installerName)) && fs.existsSync(oldExe) && fs.existsSync(desktopLink));
  check('the button is usable again, and the download page is offered', await page.ev(`!${$('movedUpdateBtn')}.disabled && !${$('movedPageBtn')}.classList.contains('hidden')`));

  // ── the real thing ──
  serverState.tamper = false;
  await page.ev(`${$('movedUpdateBtn')}.click()`);
  check('the update runs to the end', await waitFor(async () => /All done/.test(await status()), 180000), await status());
  const phases = await page.ev('window.__phases');
  check('every step was shown, in order', ['checking', 'downloading', 'verifying', 'stopping', 'installing', 'importing', 'removing', 'done'].every((p, i, all) => phases.indexOf(p) >= 0 && (i === 0 || phases.indexOf(p) > phases.indexOf(all[i - 1]))), JSON.stringify([...new Set(phases)]));
  check('the screen says the old app will close', /close in a moment/.test(await status()));

  const newExe = path.join(dirs.installDir, 'voxelport-tauri.exe');
  check('the new VoxelPort is installed where it was told', fs.existsSync(newExe) && fs.existsSync(path.join(dirs.installDir, 'uninstall.exe')));
  const handoff = JSON.parse(fs.readFileSync(path.join(newData, 'legacy-handoff.json'), 'utf8'));
  check('the new app said it brought the data over, and that it took the old VoxelPort ID', handoff.ok === true && handoff.identity === 'imported', JSON.stringify(handoff));
  const profiles = JSON.parse(fs.readFileSync(path.join(newData, 'server-profiles.json'), 'utf8'));
  check('the server list came across, by reference', profiles.servers.some((s) => s.id === ID_A && s.name === 'Old Survival'));
  check('and the backups, byte for byte', fs.readFileSync(path.join(newData, 'backups', ID_A, '2026-01-02_03-04-05_manual.zip'), 'utf8') === 'zip one');
  check('the old app\'s own data folder is exactly as it was (the move never touches it)', snapshot(oldApp) === oldBefore);

  // ── the old app closes itself, then is removed, and the shortcut the person had is put back, pointing at the new app ──
  check('the old app quit by itself', await waitFor(() => appExited, 40000));
  check('then the old program was removed', await waitFor(() => !fs.existsSync(oldExe), 60000));
  check('the shortcut the person had is back, and a shortcut they never had was not invented', await waitFor(() => fs.existsSync(desktopLink), 20000) && !fs.existsSync(startLink));
  const target = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut('${desktopLink.replace(/'/g, "''")}').TargetPath`], { encoding: 'utf8' }).trim();
  check('and it points at the new app', target.toLowerCase() === fs.realpathSync.native(newExe).toLowerCase(), target);
  const log = fs.readFileSync(path.join(dirs.tmp, 'voxelport-remove-old.log'), 'utf8');
  check('the removal script says what it did', /the old program is gone[\s\S]*put back[\s\S]*done/.test(log), log);
} finally {
  if (page) page.close();
  if (!appExited) kill(app);
  await sleep(500);
  stopCopies();
  await sleep(1000);
  const uninstall = path.join(dirs.installDir, 'uninstall.exe');
  if (fs.existsSync(uninstall)) { try { execFileSync(uninstall, ['/S'], { stdio: 'ignore', timeout: 120000 }); } catch { /* checked below */ } }
  await sleep(2500);
  server.close();
}
check('the test removed the new app it installed', !fs.existsSync(path.join(dirs.installDir, 'voxelport-tauri.exe')) && regQuery(uninstallKey) === null);
// What this test made, and only that (checked absent before it began).
fs.rmSync(localData, { recursive: true, force: true });
fs.rmSync(newData, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
process.exit(done());

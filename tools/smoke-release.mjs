// A smoke test of the real installer and the real release build: install silently into a throwaway folder, check what it wrote, start the
// installed app, look at its window, then uninstall and check everything it made is gone.
//   node tools/smoke-release.mjs <installer.exe> <install-folder>
//
// Safe on a PC that already has VoxelPort installed: it installs with /NS (no desktop or Start menu shortcuts, so another VoxelPort's
// shortcuts, which share the name, are never touched), refuses to run if a VoxelPort of this kind is already installed or its data folder
// exists (it would be a real person's), and removes only what it made. The app runs with no test switches (they are compiled out of
// release builds), so it talks to the real services the way a person's copy would: it fetches the accounts service's public status and
// asks GitHub for the update manifest, and nothing else; it never signs in.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';
import { ID_A, newToken, vpIdOf, makeOldApp, snapshot as treeSnapshot } from './legacy-fixture.mjs';

const [installerArg, installDirArg] = process.argv.slice(2);
const installer = installerArg && path.resolve(installerArg);
const installDir = installDirArg && path.resolve(installDirArg); // the installer wants backslashes
const { check, done } = reporter();
if (!installer || !installDir || !installDir.includes('vp-tauri-test')) throw new Error('usage: node tools/smoke-release.mjs <installer.exe> <install-folder inside a vp-tauri-test folder>');
const conf = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const release = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'src-tauri', 'tauri.release.conf.json'), 'utf8'));
const identifier = release.identifier, product = release.productName, version = conf.version;
const appData = path.join(process.env.APPDATA, identifier), localData = path.join(process.env.LOCALAPPDATA, identifier);
const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`;
const regQuery = (key) => { try { return execFileSync('reg', ['query', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const desktop = path.join(os.homedir(), 'Desktop');
const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const snapshot = (dir) => { try { return fs.readdirSync(dir).sort().map((n) => `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`); } catch { return []; } };

const roaming = path.join(path.dirname(installDir), 'smoke-roaming');
const oldToken = newToken();
fs.rmSync(roaming, { recursive: true, force: true });
const oldApp = makeOldApp(roaming, 'voxelport-app', oldToken);
const oldSnapshot = treeSnapshot(oldApp);
const defaultDir = path.join(process.env.LOCALAPPDATA, product);
if (fs.existsSync(defaultDir)) throw new Error(`${defaultDir} exists: refusing to run (an installer that ignored the folder would use it).`);
if (fs.existsSync(appData) || fs.existsSync(localData)) throw new Error(`${identifier} already has data on this PC: refusing to run (it would be a real person's).`);
if (regQuery(uninstallKey)) throw new Error(`${product} of this kind is already installed (${uninstallKey}): refusing to run.`);
fs.rmSync(installDir, { recursive: true, force: true });
const stopCopiesOf = (exe) => { try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='voxelport-tauri.exe'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' }); } catch { /* none running */ } };
// Read through PowerShell as UTF-8: `reg query` prints in the console's code page, which turns a folder named with accented letters into nonsense.
const installedAt = () => {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}' -ErrorAction Stop).InstallLocation`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().replace(/^"|"$/g, '');
  } catch { return ''; }
};
let where = installDir;
const before = { desktop: snapshot(desktop), startMenu: snapshot(startMenu) };

let app = null, page = null;
try {
  // ── Install ──────────────────────────────────────────────────────────────
  // Every process this test starts is told the synthetic APPDATA, the installer too (it starts a copy of the app itself): the release build looks
  // for the previous app there, so none of them can see a real person's old data.
  execFileSync(installer, ['/S', '/NS', `/D=${installDir}`], { stdio: 'ignore', timeout: 120000, windowsVerbatimArguments: true, env: { ...process.env, APPDATA: roaming } });
  where = installedAt() || installDir;
  const exe = path.join(where, 'voxelport-tauri.exe');
  check('the installer installs silently and puts the program and an uninstaller in one folder', fs.existsSync(exe) && fs.existsSync(path.join(where, 'uninstall.exe')), where);
  check('into the folder it was asked for', path.resolve(where).toLowerCase() === installDir.toLowerCase(), `installed at ${where}`);
  await sleep(3000);
  stopCopiesOf(exe); // a silent install starts the app when it finishes: stop that copy (this one only) before the real checks
  await sleep(1500);
  for (const d of [appData, localData]) fs.rmSync(d, { recursive: true, force: true }); // made by that first start
  const reg = regQuery(uninstallKey) || '';
  check('it registers itself for "Apps & features" under its own key, with the right name, version and publisher', new RegExp(`DisplayName\\s+REG_SZ\\s+${product}\\b`).test(reg) && reg.includes(version) && /Publisher\s+REG_SZ\s+VoxelPort/.test(reg), reg.slice(0, 400));
  check('it leaves other VoxelPort installs and their shortcuts exactly as they were', JSON.stringify(snapshot(desktop)) === JSON.stringify(before.desktop) && JSON.stringify(snapshot(startMenu)) === JSON.stringify(before.startMenu));
  check('the installed program is small', fs.statSync(exe).size < 20 * 1024 * 1024, `${(fs.statSync(exe).size / 1048576).toFixed(1)} MB`);

  // ── Run the installed app ────────────────────────────────────────────────
  // The release build looks for the previous app in %APPDATA%oxelport-app. This run points it at a synthetic one (the app is told a different
  // APPDATA, only for the lookup), so no real person's old data is ever read by a test.
  app = launch(exe, { env: { APPDATA: roaming }, cdpPort: 9555 });
  page = await connect(9555);
  const info = await page.ev('vp.info()');
  check('the installed app opens its window and the page can talk to it', info && info.version === version && typeof info.supporterID === 'string' && info.supporterID.length === 12, JSON.stringify(info));
  check('it keeps its data in its own folder, separate from any other VoxelPort', fs.existsSync(appData));
  const versions = await page.ev('vp.versions()');
  check('it reports the release version and no Electron', versions.app === version && /none/.test(versions.electron), JSON.stringify(versions));
  const profiles = await page.ev('vp.server.list()');
  check('it starts with no servers', Array.isArray(profiles) && profiles.length === 0);
  const text = await page.ev('document.title + "|" + (document.body.innerText || "").slice(0, 200)');
  check('the page is the VoxelPort screen, titled VoxelPort', /^VoxelPort\|/.test(text), text);
  const refused = await page.ev('(async () => { try { await window.__TAURI__.core.invoke("ipc", { channel: "nonsense:channel", args: {} }); return "answered"; } catch (e) { return String(e); } })()');
  check('an unknown channel is refused', /Unknown channel/.test(refused), refused);
  const direct = await page.ev('(async () => { try { await window.__TAURI__.core.invoke("plugin:updater|check", {}); return "answered"; } catch (e) { return String(e); } })()');
  check('the page cannot call the updater itself', direct !== 'answered', direct);
  const update = await page.ev('vp.update.check()');
  check('the update check works (against the real GitHub address; with nothing published it reports an error or "up to date", never "unsupported")', update.status !== 'unsupported' && update.reason === undefined, JSON.stringify(update));
  check('and nothing is waiting to be installed', JSON.stringify(await page.ev('vp.update.state()')) === '{"readyToInstall":false}');
  // Bringing the previous app's data over, in the release build, against the synthetic old app.
  const found = await page.ev('vp.legacyImport.detect()');
  check('the release build finds the previous app by itself and counts what is there (no secret on the screen)', found.available === true && found.identity === 'new' && found.vpId === vpIdOf(oldToken) && found.newServers === 1 && found.backupFiles === 2 && !JSON.stringify(found).includes(oldToken), JSON.stringify(found));
  const brought = await page.ev('vp.legacyImport.run()');
  check('the import brings it over', brought.ok === true && brought.identity === 'imported' && brought.files.serversAdded === 1 && brought.files.backupsLinked + brought.files.backupsCopied === 2 && brought.vpId === vpIdOf(oldToken), JSON.stringify(brought));
  check('this PC now has the old VoxelPort ID and the server', (await page.ev('vp.info()')).supporterID === vpIdOf(oldToken) && (await page.ev('vp.server.list()')).some((p) => p.id === ID_A));
  check('and the old app\'s folder is untouched', treeSnapshot(oldApp) === oldSnapshot);
  check('a second copy ends at once (one at a time)', await new Promise((resolve) => { const second = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, APPDATA: roaming } }); const t = setTimeout(() => { kill(second); resolve(false); }, 10000); second.on('exit', () => { clearTimeout(t); resolve(true); }); }));
  page.close(); page = null;
  kill(app); app = null;
  await sleep(1500);
} finally {
  if (page) page.close();
  if (app) kill(app);
  await sleep(500);
  // ── Uninstall ────────────────────────────────────────────────────────────
  stopCopiesOf(path.join(where, 'voxelport-tauri.exe'));
  await sleep(800);
  const uninstaller = path.join(where, 'uninstall.exe');
  if (fs.existsSync(uninstaller)) { try { execFileSync(uninstaller, ['/S'], { stdio: 'ignore', timeout: 120000 }); } catch { /* checked below */ } }
  await sleep(2500); // the uninstaller removes itself a moment after it returns
}
check('uninstalling removes the program and its entry in "Apps & features"', !fs.existsSync(path.join(where, 'voxelport-tauri.exe')) && regQuery(uninstallKey) === null);
check('and leaves other VoxelPort installs and their shortcuts exactly as they were', JSON.stringify(snapshot(desktop)) === JSON.stringify(before.desktop) && JSON.stringify(snapshot(startMenu)) === JSON.stringify(before.startMenu));
check('the person\'s own data is kept by a plain uninstall', fs.existsSync(appData));
// What this test made, and only that (checked absent before it began).
fs.rmSync(appData, { recursive: true, force: true });
fs.rmSync(localData, { recursive: true, force: true });
fs.rmSync(roaming, { recursive: true, force: true });
fs.rmSync(installDir, { recursive: true, force: true });
if (where !== installDir && path.resolve(where).toLowerCase() === defaultDir.toLowerCase()) fs.rmSync(where, { recursive: true, force: true }); // the default folder, which this test checked did not exist
// The installer remembers the last folder it installed to (HKCU\Software\VoxelPort\VoxelPort), and the uninstaller leaves that note behind, so the next
// installer run by hand would offer this test's folder. Remove the note, but only when it still names the folder this test used.
try {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$k = 'HKCU:\\Software\\VoxelPort\\VoxelPort'; if ((Test-Path $k) -and ((Get-Item $k).GetValue('') -eq $env:VP_SMOKE_DIR)) { Remove-Item $k -Recurse -Force; if (-not (Get-ChildItem 'HKCU:\\Software\\VoxelPort' -ErrorAction SilentlyContinue)) { Remove-Item 'HKCU:\\Software\\VoxelPort' -Force } }`], { stdio: 'ignore', env: { ...process.env, VP_SMOKE_DIR: installDir } });
} catch { /* a leftover note is only a cosmetic problem */ }
process.exit(done());

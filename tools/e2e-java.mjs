// End to end through the real Tauri window: Java detection, automatic install, and starting on the installed Java.
//   node tools/e2e-java.mjs <debug-exe> <data-dir> <stand-in-java.exe>
// A stand-in Adoptium serves a real zip whose bin/java.exe is the test stand-in server; the stand-in on the PATH says it
// is Java 8, so a Minecraft 1.21.4 server (needs Java 21) has to install one. Development builds only (debug-only env).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startAdoptium } from './fake-adoptium.mjs';
import { sleep, reporter, kill, launch, connect } from './e2e-lib.mjs';

const [exe, dataDir, standIn] = process.argv.slice(2);
const ACCOUNTS = 8799, ADOPTIUM = 8798;
const { check, done } = reporter();
const here = import.meta.dirname;

if (!dataDir.includes('in.voxelport.app.dev')) throw new Error('refusing to touch a data folder that is not the dev one: ' + dataDir);
for (const f of ['device-token.json', 'discord-gate.json', 'app-session.json']) fs.rmSync(path.join(dataDir, f), { force: true });
fs.rmSync(path.join(dataDir, 'java'), { recursive: true, force: true });

// A PATH folder whose "java" claims to be Java 8.
const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-e2e-java-'));
fs.copyFileSync(standIn, path.join(pathDir, 'java.exe'));
fs.writeFileSync(path.join(pathDir, 'java-major.txt'), '8');

// A second profile that needs Java 25, next to the seeded one (the original file is restored at the end).
const profilesFile = path.join(dataDir, 'server-profiles.json');
const originalProfiles = fs.readFileSync(profilesFile, 'utf8');
const parsed = JSON.parse(originalProfiles);
parsed.servers.push({ ...parsed.servers[0], id: 'dev-test-25', name: 'Needs Java 25', version: '26.1' });
fs.writeFileSync(profilesFile, JSON.stringify(parsed, null, 2));

const accounts = spawn('node', [path.join(here, 'fake-accounts.mjs'), String(ACCOUNTS)], { stdio: 'ignore', windowsHide: true });
const adoptium = await startAdoptium(ADOPTIUM, standIn, { delayMs: 900 });
await sleep(600);

const app = launch(exe, { env: { PATH: `${pathDir};${process.env.PATH}`, VOXELPORT_ACCOUNTS_URL: `http://127.0.0.1:${ACCOUNTS}`, VOXELPORT_NO_BROWSER: '1', VOXELPORT_JAVA_API: `http://127.0.0.1:${ADOPTIUM}/v3/assets/latest` } });
const page = await connect();
try {
  await page.ev("(window.__log = [], window.__progress = [], window.__status = [], vp.on('server:log', (l) => window.__log.push(l)), vp.on('java:progress', (p) => window.__progress.push(p)), vp.on('server:status', (s) => window.__status.push(s)), true)");
  const signIn = await page.ev('vp.discordSignIn()');
  check('signed in through the stand-in accounts service first', signIn.ok === true && signIn.state.allowed === true, JSON.stringify(signIn));

  let v = await page.ev('vp.versions()');
  check('app:versions reports the PATH Java 8 and no managed Java yet', v.systemJava === 8 && Array.isArray(v.managedJava) && v.managedJava.length === 0, JSON.stringify(v));

  let j = await page.ev("vp.java.check('1.21.4')");
  check('java:check says 1.21.4 needs Java 21 and the PC (Java 8) does not satisfy it', j.required === 21 && j.satisfied === false && j.found === true && j.major === 8 && j.managed === false && !('javaPath' in j), JSON.stringify(j));
  j = await page.ev("vp.java.check('1.16.5')");
  check('1.16.5 only needs Java 8, which the PC has', j.required === 8 && j.satisfied === true, JSON.stringify(j));

  // Start a server that needs Java 21: it must install one first, and the screens see "starting" meanwhile.
  const starting = page.ev("vp.server.start('dev-test-1')");
  let sawStarting = false;
  for (let i = 0; i < 25 && !sawStarting; i++) { await sleep(80); const s = await page.ev('vp.server.state()'); sawStarting = s.serverStatus === 'starting' && (await page.ev('window.__log.join("\\n")')).includes('needs Java 21'); }
  check('while Java is fetched the server shows as starting', sawStarting);
  const r = await starting;
  check('the start succeeds after the automatic install', r.ok === true, JSON.stringify(r));
  await sleep(1500);
  check('the server reaches online on the installed Java', (await page.ev('vp.server.state()')).serverStatus === 'online');

  const log = await page.ev('window.__log.join("\\n")');
  check('the console narrates the install', /needs Java 21 \(this PC has Java 8\) — installing it automatically/.test(log) && /Downloading Java 21/.test(log) && /Unpacking Java/.test(log) && /Java 21 ready\./.test(log), log.slice(0, 400));
  check('Java 21 was downloaded exactly once', adoptium.state.downloads === 1, String(adoptium.state.downloads));
  check('java files are under the app data folder', fs.existsSync(path.join(dataDir, 'java', 'temurin-21', 'bin', 'java.exe')) && fs.readFileSync(path.join(dataDir, 'java', 'temurin-21', 'release'), 'utf8').includes('21.0.4'));
  check('no scratch folder is left behind', !fs.readdirSync(path.join(dataDir, 'java')).some((n) => n.startsWith('.install-')));
  v = await page.ev('vp.versions()');
  check('app:versions now lists the managed Java 21', JSON.stringify(v.managedJava) === '[21]' && v.systemJava === 8, JSON.stringify(v));
  j = await page.ev("vp.java.check('1.21.4')");
  check('java:check is now satisfied by the managed Java', j.satisfied === true && j.managed === true && j.major === 21, JSON.stringify(j));

  await page.ev('vp.server.stop()'); await sleep(2500);
  const afterStop = await page.ev('vp.server.state()');
  check('and stops cleanly, with no server left active', afterStop.serverStatus === 'stopped' && afterStop.activeServerProfileId === null, JSON.stringify(afterStop));

  const before = adoptium.state.downloads;
  const r2 = await page.ev("vp.server.start('dev-test-1')");
  await sleep(1500);
  check('a second start reuses the installed Java (no second download)', r2.ok === true && adoptium.state.downloads === before && (await page.ev('vp.server.state()')).serverStatus === 'online');
  await page.ev('vp.server.stop()'); await sleep(2500);

  // Failure: a build whose checksum does not match is refused and nothing is installed.
  adoptium.state.mode.bad = true;
  const bad = await page.ev("vp.java.install('26.1')");
  check('a download with a wrong checksum is refused', bad.ok === false && /SHA-256/.test(bad.error), JSON.stringify(bad));
  check('and nothing was installed or left behind', !fs.existsSync(path.join(dataDir, 'java', 'temurin-25')) && !fs.readdirSync(path.join(dataDir, 'java')).some((n) => n.startsWith('.install-')));
  const failedStart = await page.ev("vp.server.start('dev-test-25')");
  const st = await page.ev('vp.server.state()');
  check('a start that cannot get Java says why and leaves nothing active', failedStart.ok === false && /Couldn't set up Java 25/.test(failedStart.error) && !failedStart.error.includes('..') && st.serverStatus === 'stopped' && st.activeServerProfileId === null, JSON.stringify({ failedStart, st }));

  adoptium.state.mode.bad = false;
  const good = await page.ev("vp.java.install('26.1')");
  check('java:install works when the build is good, and sends progress to the screens', good.ok === true && good.major === 25 && fs.existsSync(path.join(dataDir, 'java', 'temurin-25', 'bin', 'java.exe')) && (await page.ev('window.__progress.map(p => p.stage).join(",")')).includes('download'), JSON.stringify(good));
  v = await page.ev('vp.versions()');
  check('both managed Javas are listed, lowest first', JSON.stringify(v.managedJava) === '[21,25]', JSON.stringify(v));

  // A server that says it needs a newer Java than it runs on is fixed once, automatically.
  await page.ev('window.__log.length = 0');
  await page.ev("vp.server.start('dev-test-1')"); await sleep(1500);
  check('the server is online on Java 21 first', (await page.ev('vp.server.state()')).serverStatus === 'online');
  await page.ev("vp.server.command('needjava 27')");
  let online = false;
  for (let i = 0; i < 80 && !online; i++) { await sleep(250); const s = await page.ev('vp.server.state()'); online = s.serverStatus === 'online' && fs.existsSync(path.join(dataDir, 'java', 'temurin-27', 'bin', 'java.exe')); }
  const log2 = await page.ev('window.__log.join(" | ")');
  check('the server that needs Java 27 is fixed and restarted on its own', online && /This server needs Java 27 — fixing that and restarting/.test(log2) && /Java 27 ready\./.test(log2), log2.slice(-500));
  const saved = JSON.parse(fs.readFileSync(profilesFile, 'utf8')).servers.find((p) => p.id === 'dev-test-1');
  check('the profile remembers the new minimum, and nothing else about it changed', saved.javaMajor === 27 && saved.version === '1.21.4' && saved.name === 'Dev Test Server', JSON.stringify(saved));
  check('the restarted server is the same one, shown as active', (await page.ev('vp.server.state()')).activeServerProfileId === 'dev-test-1');
  await page.ev('vp.server.stop()'); await sleep(2500);
} finally {
  page.close(); kill(app); kill(accounts); adoptium.close();
  fs.writeFileSync(profilesFile, originalProfiles);
  fs.rmSync(path.join(dataDir, 'java'), { recursive: true, force: true }); // the dev folder checked above; the stand-in Javas are not kept
  fs.rmSync(pathDir, { recursive: true, force: true });
}
process.exit(done());

'use strict';

// Writes docs/FEATURE_PARITY.md. The list of channels comes from the pinned Electron preload; what counts as
// "implemented" is read from the match arms in src-tauri/src/ipc.rs, so this file cannot claim a feature the code
// does not have. Stubs (a channel that answers with a fixed placeholder) are marked in STUBS below.
//   node tools/gen-parity.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const channels = [...fs.readFileSync(path.join(root, 'src-tauri', 'src', 'channels.in'), 'utf8').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const ipc = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'ipc.rs'), 'utf8');
// A match arm may list several channels ("a" | "b" => ...): every one of them is answered by that arm.
const arms = new Set([...ipc.matchAll(/^\s+((?:"[A-Za-z:]+"\s*\|?\s*)+)=>/gm)].flatMap((m) => [...m[1].matchAll(/"([A-Za-z:]+)"/g)].map((x) => x[1])));

// Answered, but with a fixed value rather than the real behaviour.
// Ported channels that still have a known gap: shown as Ported, with the gap in the note.
const CAVEATS = {
  'server:makePublic': 'Region choice, relay, players, listing, custom address, Bedrock address and its one restart, and automatic voice chat for Supporter Plus (the plugin is installed by its real Modrinth id, which Electron never managed to do)',
  'tunnel:start': 'The manual tunnel. Relay notices reach the screen, and are said in the game chat for a public server',
  'server:start': 'Real Discord gate, Java resolution and install, automatic restart on a newer Java, Bedrock launch arguments and the Geyser version warning. Not yet: backup-busy check, the "switch to another server" question',
  'server:install': 'Verified jar, files and profile; cracked templates get the login plugin, then offline mode, then skins; Bedrock templates also get Geyser and Floodgate (a failure is a plain warning; the Java server still works)',
  'server:settings:save': 'does not yet update a live public-server-list entry (tunnel not ported)',
  'server:profiles:delete': 'Native confirmation, Recycle Bin, folder safety checks. Does not yet stop a public tunnel (tunnel not ported)',
  'server:chooseFolder': 'native folder picker, not yet tested by hand',
  'modpack:choose': 'native file picker, not yet tested by hand',
  'diagnostics:export': 'native save dialog, not yet tested by hand',
  'app:setLanguage': 'English or Hinglish for the messages the backend writes (refusals, the update question, crash explanations, chat announcements); not every backend message has a Hinglish version yet',
  'update:check': 'The signed-update flow works end to end against a test server. Release builds say "not configured" until a signing key is set (see BUILD_INSTRUCTIONS.md)',
};

const STUBS = {};

// channel prefix or exact name -> [area, Electron module(s)]
const AREAS = [
  [/^(app:|diagnostics:|community:|token:|supporterID:)/, 'App', 'main.js, token.js, diagnostics.js'],
  [/^identity:/, 'Account', 'appAccount.js, identityBackup'],
  [/^discord:/, 'Account', 'appAccount.js, discordGate.js'],
  [/^presence:/, 'Account', 'discordPresence.js'],
  [/^(tunnel:|server:makePublic|name:|region:)/, 'Relay tunnel', 'tunnel.js, regions.js, bedrockEndpoint.js'],
  [/^java:/, 'Java', 'javaInstall.js, javaCheck.js'],
  [/^(server:(types|versions|install|changeVersion|detectExisting|import|chooseFolder|defaultDir))/, 'Server install', 'serverInstall.js, mcVersions.js, jarVersion.js'],
  [/^server:profiles:/, 'Profiles', 'serverProfiles.js'],
  [/^server:(start|stop|restart|command|playerAction|state|runtimeInfo|openFolder)/, 'Server control', 'serverProcess.js, main.js'],
  [/^server:(settings|templates)/, 'Server settings', 'serverSettings.js'],
  [/^server:(bedrock|fix)/, 'Bedrock and repair', 'bedrock.js, crashExplain.js'],
  [/^server:accounts:/, 'Cracked mode', 'accounts.js'],
  [/^backup:/, 'Backups', 'backups.js, backupService.js'],
  [/^files:/, 'Files', 'serverFiles.js'],
  [/^addons:/, 'Plugins and mods', 'addons.js'],
  [/^modpack:/, 'Modpacks', 'modpackImport.js'],
  [/^whitelist:/, 'Friends only', 'whitelist.js'],
  [/^support:/, 'Support', 'support.js'],
  [/^update:/, 'Updates', 'updater.js (electron-updater)'],
  [/^(voice:|system:)/, 'System', 'voiceSetup.js, main.js'],
  [/^legacy:/, "Bringing the previous app's data over", 'new in this build (not in Electron)'],
];

// Channels this build adds on top of the Electron app's (tools/build-ui.js EXTRA_CHANNELS): not part of the parity count.
const ADDED = channels.filter((c) => /^legacy:/.test(c));

const rows = channels.map((c) => {
  const [, area, mod] = AREAS.find(([re]) => re.test(c)) || [null, 'Other', 'main.js'];
  const done = arms.has(c);
  const status = !done ? 'Not ported' : STUBS[c] ? 'Stub' : 'Ported';
  return { c, area, mod, status, note: STUBS[c] || CAVEATS[c] || '' };
});

const count = (s) => rows.filter((r) => !ADDED.includes(r.c) && r.status === s).length;
let md = `# Feature parity: Electron v1.17.1 vs the Tauri build

Generated by \`node tools/gen-parity.js\` from the pinned Electron preload and \`src-tauri/src/ipc.rs\`. Do not edit by hand.

**${channels.length - ADDED.length} channels** the screens can call (the Electron app's own; this build adds ${ADDED.length} more, listed under "new in this build"): **${count('Ported')} ported**, **${count('Stub')} stubs** (answer with a placeholder), **${count('Not ported')} not ported** (answer "Not migrated to the Tauri build yet").

Web control is not part of this migration: it is unreleased, and the base is the released v1.17.1 tag, which has none of it.

## Channels

| Channel | Area | Electron source | Tauri | Note |
|---|---|---|---|---|
`;
for (const r of rows.sort((a, b) => a.area.localeCompare(b.area) || a.c.localeCompare(b.c))) {
  md += `| \`${r.c}\` | ${r.area} | ${r.mod} | ${r.status} | ${r.note} |\n`;
}

md += `
## Electron facilities with no one-line Tauri equivalent

| Electron | Used for | Tauri replacement | Status |
|---|---|---|---|
| \`safeStorage\` | device token and Discord session encrypted at rest | Windows DPAPI (\`CryptProtectData\`) via a small Rust wrapper | **Done** for this build's own files. Reading the Electron app's existing files (a different format) is **not started**, and is needed before this build may share its data folder |
| \`electron-updater\` | signed auto-update from GitHub releases | \`tauri-plugin-updater\` (minisign signatures checked against a key built into the app, signature bound to the version) | **Done and tested end to end**; a release build needs the signing key set and \`latest.json\` published (BUILD_INSTRUCTIONS.md) |
| \`dialog\` (open, save, message) | folder chooser, modpack chooser, report save, confirmations | \`rfd\` (native dialogs) | **Done** |
| \`shell.openExternal / openPath / trashItem\` | open links and folders, delete to the recycle bin | \`ShellExecuteW\` and \`SHFileOperationW\` | **Done** |
| \`clipboard\` | copy token, supporter ID, UPI ID | the Win32 clipboard (Unicode text) | **Done** |
| \`nativeTheme\` | follow the system light/dark setting; window background | window theme APIs plus the page's own \`prefers-color-scheme\` | Not started (the page paints its own theme; the window frame and the saved theme choice are not applied) |
| \`Notification\` | (Electron v1.17.1 does not use it) | n/a | Not needed |
| \`requestSingleInstanceLock\` | one app window | \`tauri-plugin-single-instance\` | **Done** |
| Quit gate (\`before-quit\`) | stop the server before exiting | window close handler in \`main.rs\` | **Done** (tested in core, not on a window close) |
| \`ws\` (WebSocket client) | relay tunnel | \`tokio-tungstenite\` | **Done** |
| \`dgram\` / \`net\` | UDP and TCP forwarding for the tunnel | \`tokio::net\` | **Done** |
| \`yauzl\` / \`yazl\` | zip read and write for backups and modpacks | the \`zip\` crate, with path-traversal checks | **Done** |
| \`https\` downloads | installers, add-ons, support data | the shared download client: allow-listed hosts, checksums, size caps | **Done** |
| Discord Rich Presence (\`net\` to Discord's pipe) | the "Hosting a server" line | a Windows named pipe client | **Done** |
| Microsoft Store package (MSIX) | the live Store listing | none: the Tauri build is distributed as a direct installer only | **Decided: not shipped** (the Store listing stays the Electron app) |
`;
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'FEATURE_PARITY.md'), md);
console.log(`docs/FEATURE_PARITY.md: ${count('Ported')} ported, ${count('Stub')} stub, ${count('Not ported')} not ported of ${channels.length}`);

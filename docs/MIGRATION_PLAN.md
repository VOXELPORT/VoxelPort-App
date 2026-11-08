# Migration plan: VoxelPort desktop, Electron to Tauri v2 + Rust

Status: **all 87 of 87 channels ported; steps 1 to 12 done (installer, signing, release scripts, bringing the previous app's data over); step 13 adds the Bedrock Dedicated Server, which Electron never had. First release candidate: 2.0.0-beta.1 plus those two** (see FEATURE_PARITY.md for the exact, generated count).
The Electron app (`../VoxelPort-App`) is untouched and fully working. Everything here lives in this separate folder
and its own git repository.

## 1. What the existing app is (verified in the code, not assumed)

| Fact | Evidence |
|---|---|
| Base for this migration is the released **v1.17.1** tag, pinned in `reference/electron-v1.17.1/` | `git archive v1.17.1`; the tag has no web control code |
| 8,485 lines of main-process JavaScript in 38 modules, 3,115 lines of renderer JavaScript, 14 languages, 57 test files | `wc -l` on the pinned copy |
| The renderer is plain HTML/CSS/JS with no bundler or framework, talking to the backend only through `window.vp` | `preload.js` |
| `window.vp` is 87 invoke channels and 29 event channels, all generated into the Tauri bridge | `tools/build-ui.js` |
| Main-process dependencies are small: `ws`, `yauzl`, `yazl`, `electron-updater`, plus Node's `fs`, `net`, `dgram`, `https`, `child_process`, `crypto` | `package.json`, `require()` scan |
| The server runs as a child `java` process: fixed argument list, `shell: false`, one managed process at a time | `serverProcess.js` ("only one managed process, ever") |
| **There is no Velocity or BungeeCord support.** The only "proxy" is VoxelPort's own relay tunnel (`tunnel.js`, 688 lines) | zero matches for velocity/bungee/waterfall in `src` |
| **There is no background service.** Quitting stops the server and waits for it (`quitGate.js`) | `quitGate.js`, no detached spawns |
| Server types: Vanilla, Paper, Fabric; Bedrock through Geyser + Floodgate using **NetherNet** with built-in signaling | `mcVersions.js`, `bedrock.js` |
| Distribution: NSIS installer (108.6 MB), portable (108.4 MB), Microsoft Store MSIX (150.6 MB) | `VoxelPort-App/release/` |
| Starting any server first requires the Discord join gate | `startServerProfile` in `main.js` |

Two requests in the original brief do not apply to this codebase, so they are not built: proxy (Velocity/BungeeCord)
management, and a persistent background service. Adding either would be new product work, not migration.

## 2. Decisions

1. **Keep the renderer, replace the backend.** The generated bridge makes every screen run unchanged. Channels that
   are not ported answer with a clear error, so partial progress is safe to run and test.
2. **Rust core without Tauri.** `crates/voxelport-core` has no UI dependency, so its rules (process lifecycle, argument
   validation, log bounds) are tested on their own and could be reused by a command-line tool.
3. **One command, `ipc`, scoped to the main window**, with a channel allow-list generated from the Electron preload.
4. **Pin the reference.** Parity is measured against a frozen copy of v1.17.1, not a moving working tree.
5. **Fail closed on the Discord gate.** `server:start` now runs the real gate (ported in step 3). The earlier development switch `VOXELPORT_DEV_ALLOW_START` is gone.
6. **No data migration yet.** The dev build uses its own identifier (`in.voxelport.app.dev`) and data folder.

## 3. Order of work (largest dependencies first)

Sizes are the Electron module's line count, as a rough guide only.

| Step | Ports | Electron source (lines) | Why this order |
|---|---|---|---|
| 1 done | process manager, Bedrock args, log bounds | serverProcess 180, bedrock args, quitGate 35 | everything else needs it |
| 2 done | bridge, shell, profiles (read), catalog, state events | preload 186, serverProfiles 233 | lets the screens run |
| 3 done | account + Discord gate, token storage (DPAPI), session, address backup | appAccount 198, discordGate 64, token 158, identityBackup | the gate guards `server:start` |
| 4 done | Java detection and install, automatic restart on a newer Java | javaCheck 87, javaInstall 268 | needed to start a real server |
| 5 done | server install, versions, import, profiles (write), delete to the Recycle Bin, change version | serverInstall 303, mcVersions 109, jarVersion 106, serverProfiles, serverRemoval | creating servers (`server:changeVersion` came with step 7, which it needs) |
| 6 done | settings, templates, whitelist, files, accounts (cracked mode), repair, restart | serverSettings 175, whitelist 173, serverFiles 110, accounts 191 | day-to-day management. The cracked template now really installs (login plugin, offline mode, skins) |
| 7 done | backups, restore, schedule, live save, change version | backups 536, backupService 227 | needs zip with traversal checks |
| 8 done | relay tunnel, regions, custom address, Bedrock endpoint, public list entry | tunnel 688, regions 97, bedrockEndpoint 48, relayUrlSafety | the core of the product. Automatic voice-chat setup (`voiceSetup.js`) and the in-game relay announcement (`notice.js`) are left for later |
| 9 done | add-ons, modpacks, Bedrock install, runtime info, crash explain, perf | addons 272, modpackImport 239, bedrock 284, runtimeInfo 98, crashExplain 169, perfMonitor 168 | Modrinth and Geyser downloads, checksums. CPU and memory are read from the operating system directly (no PowerShell process); a chat line can no longer pass for the server's `tick query` answer or its lag warning |
| 10 done | updater, support, presence, notices, diagnostics, voice chat, one-copy lock | updater 120, support 159, discordPresence 158, notice 99, diagnostics 62, voiceSetup 78 | polish and release plumbing. The updater is Tauri's (minisign signature, bound to the version, so a validly signed older release cannot be passed off as a newer one); it says `not-configured` in release builds until a signing key is set. Voice chat now installs its plugin by the real Modrinth id (Electron's install of a missing voice plugin always failed). A player's chat can no longer pass for the relay's or the server's own lines |
| 11 done | installer, signing, release scripts | n/a | the NSIS installer (3.04 MiB, per-user, direct download only, no Microsoft Store build), the update signing key (generated, kept outside the repository), `tools/build-release.mjs`, and `tools/smoke-release.mjs` (18 checks of the real installer). Not done: code signing (needs a certificate) and moving existing Electron data across (below) |
| 12 done | **bringing the previous app's data over** (the Electron-to-Tauri data import) | token 158, appAccount 198 (the file formats), serverProfiles, backups, main.js (preferences, custom address), bedrockEndpoint 48 | a one-time, opt-in banner. Reads Chromium's `os_crypt` format one way (see below) and brings the VoxelPort ID, the server list, its backups and the settings. New: 3 channels the Electron app does not have (`legacy:detect`, `legacy:run`, `legacy:dismiss`), listed apart in FEATURE_PARITY.md |
| 13 done | the Bedrock Dedicated Server as a server type (beyond Electron) | none (new) | see BEDROCK_SERVER.md. Merged into `main` as `b0faebb`; confirmed with a real Bedrock client through the real relay |

The 57 Electron test files are the specification for steps 3 to 10: each module's tests should be ported with it.

## 4. Risks and open questions

- **Microsoft Store: decided not to ship it.** The Tauri build is distributed as a direct installer only (NSIS), not as a Store package.
  The existing Store listing is the Electron app and stays what it is; the Store, not this build, updates it. (Tauri has no MSIX target anyway.)
- **Auto-update.** `electron-updater` and `tauri-plugin-updater` use different manifests and signing keys. Installed
  Electron apps cannot update into Tauri by themselves; a one-time reinstall or a bridge release is needed.
- **Moving from the Electron app: built (step 12).** The release build has its own identity (`in.voxelport.app`), so on its own it starts with a
  **new** device token, and a person's address, custom name and supporter perks are all tied to the *old* one. A banner now offers to bring them over, once, on
  the person's say-so (details below). What it replaces is the old "restore from the Discord address backup" workaround, which still works as the fallback.
- **How the old data is read.** The Electron app stores its device token with `safeStorage`, which on Windows is Chromium's `os_crypt`: an AES-256 key in
  `Local State` (`os_crypt.encrypted_key`, base64 of `"DPAPI"` plus the key protected by Windows DPAPI for the signed-in user, no extra entropy), and the token
  as `"v10"` + a 12-byte nonce + AES-GCM ciphertext and tag. This build stores its own secrets differently (plain DPAPI with a fixed entropy string), so it cannot
  read the old files without a reader for that format: `voxelport_core::legacy_import` (the format and the copying, tested on synthetic data) with
  `ChromiumKeyUnprotect` (the DPAPI half, in `src-tauri/src/secrets.rs`). It only opens; nothing in this build writes that format, and **nothing in the old app's
  folder is ever written, moved or deleted**. Only the same Windows user can open it, which is DPAPI's own rule.
- **What comes over, and what does not.** *Comes:* the device token (so the address, custom name and perks carry over); the server list (the profiles, by
  reference: the server folders themselves stay where they are); each server's backups (hard-linked when the disk allows, so they take no extra space, otherwise
  copied; only files this app made); the region and Discord-presence preferences; the custom-address cache; the Bedrock-address cache. It is additive: whatever the
  new app already has wins, a second run adds only what is missing, and a server whose folder is gone, or whose id is not one this app makes, is left out.
  *Does not come:* the Discord sign-in session (signing in again is one click), the managed Java (fetched again when a server needs it), the old Discord-gate record,
  the theme (this build does not keep one yet).
- **Rules the import keeps.** It runs only when the person presses the button (the banner only counts what is there). It refuses while a public address is running (the
  device token would change under it). The token that is replaced is kept beside the new one (`device-token.unreadable-<time>.json`), so the old state can be recovered by
  hand. The token is opened in memory to show its 12-character VoxelPort ID and to tell whether it differs; it is never shown in full, written elsewhere or sent. If the
  token cannot be opened on this PC (another Windows account made it), the servers and settings still come and the person is told to restore from their Discord backup. A
  **development build finds no old app unless `VOXELPORT_LEGACY_DIR` names a folder**, so tests and development never read a real person's data.
- **The old app's "update" button (the other half).** The Electron app gets a final version with a "VoxelPort has moved" banner and screen and one button (in `VoxelPort-App`:
  `src/main/migrateToTauri.js`, `src/renderer/migrate-ui.js`). The button downloads this app's installer from the update manifest above, checks it (https from this
  project's GitHub release path only, a size cap, and a signature made with the update key, for that file name and that version), installs it silently, starts it with
  **`--migrate-from-electron`**, waits for the answer file **`legacy-handoff.json`** in this app's data folder (`ok`, `identity`, `error`), and only if `ok` is true removes
  the old app (its own uninstaller, after it has quit; shortcuts the old uninstaller removes are put back pointing here). This app, started with the switch, brings the
  data over at once (the same code and the same rules as the banner's button, including "not while a public address runs") and shows what came, once. The Microsoft Store
  copy cannot install another app, so it only points to the download page; a portable copy installs and imports but cannot remove itself. Nothing is offered until the
  manifest is reachable, i.e. until this app is published. Tested for real: `VoxelPort-App/tools/e2e-migrate.mjs`.
- **Not yet verified.** Everything above runs against synthetic old-app folders made the way Electron makes them (a real DPAPI-protected key, a v10 token), in the Rust tests,
  in a real-window test, and in the real installer's smoke test. Not yet run against a **real** Electron install's files, nor against the **Microsoft Store** copy of the
  Electron app (the lookup also tries `%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\voxelport-app`, which is assumed from how Store apps virtualise Roaming).
  Anything the Electron app writes under a newer `os_crypt` scheme than `v10` would be reported as "cannot be opened", never guessed at. Two apps listing the same server folder
  must not run it at once; the confirmation says so.
- **Web view differences.** Electron ships its own Chromium; Tauri uses the system WebView2. The renderer's CSS and
  fonts matched in the screens captured so far, but every screen needs a visual pass.
- **Size.** Measured on the finished backend: the program is 7.63 MiB and the installer 3.04 MiB (PERFORMANCE_COMPARISON.md). Idle memory and start-up are
  **not** better than Electron's: the web view dominates both.
- **Code signing.** No code-signing certificate is configured. The installer shows Windows' "unknown publisher" warning, and none of it should be described as
  a verified publisher. This is separate from the update signature (a key generated for this app, kept outside the repository), which is what keeps updates safe.
- **Port fidelity.** JavaScript regexes, path handling and number types differ from Rust's; each port needs the old
  tests, not just a read-through.
- **Unreleased work.** Web control is excluded on purpose. When it ships in Electron, it becomes its own step.

## 5. Safety rules this workspace follows

- Nothing outside `VoxelPort-Tauri-Migration/` is modified; `VoxelPort-App` is only read.
- Test servers live in `C:\Users\Trazverse\vp-tauri-test`; dev data in `%APPDATA%\in.voxelport.app.dev`.
- The test "server" is a stand-in program, not Minecraft, and no real world is ever touched.
- Processes are only ever ended by the exact PID the test started.
- Nothing is deployed, published or pushed.

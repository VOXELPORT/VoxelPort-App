# Migration plan: VoxelPort desktop, Electron to Tauri v2 + Rust

Status: **started, about 34% of the screens' backend is ported (30 of 87 channels; steps 1 to 5 done, step 5 except `server:changeVersion`)** (see FEATURE_PARITY.md for the exact, generated count).
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
| 5 done* | server install, versions, import, profiles (write), delete to the Recycle Bin | serverInstall 303, mcVersions 109, jarVersion 106, serverProfiles, serverRemoval | creating servers. *`server:changeVersion` waits for backups (step 7), which it must run first |
| 6 | settings, templates, whitelist, files, accounts (cracked mode) | serverSettings 175, whitelist 173, serverFiles 110, accounts 191 | day-to-day management |
| 7 | backups | backups 536, backupService 227 | needs zip with traversal checks |
| 8 | relay tunnel, regions, custom address, Bedrock endpoint | tunnel 688, regions 97, bedrockEndpoint 48 | the core of the product; needs `tokio-tungstenite` and UDP |
| 9 | add-ons, modpacks, Bedrock install, crash explain, perf | addons 272, modpackImport 239, bedrock 284, crashExplain 169, perfMonitor 168 | Modrinth and Geyser downloads, checksums |
| 10 | updater, support, presence, notices, diagnostics | updater 120, support 159, discordPresence 158, notice 99, diagnostics 62 | polish and release plumbing |
| 11 | installer, signing, Store path | n/a | see risks |

The 57 Electron test files are the specification for steps 3 to 10: each module's tests should be ported with it.

## 4. Risks and open questions

- **Microsoft Store.** VoxelPort is live on the Store as an MSIX. Tauri produces NSIS and MSI, not MSIX. Shipping a
  Tauri build there needs a separate packaging step and a decision on whether it replaces the Store build.
- **Auto-update.** `electron-updater` and `tauri-plugin-updater` use different manifests and signing keys. Installed
  Electron apps cannot update into Tauri by themselves; a one-time reinstall or a bridge release is needed.
- **Stored secrets.** The Electron app encrypts the device token and Discord session with `safeStorage`, which on Windows
  is Chromium's `os_crypt` (an AES-GCM key in `Local State`, itself DPAPI-protected), **not** plain DPAPI. The Tauri build
  stores its own with plain DPAPI (`CryptProtectData`, per Windows user, plus a fixed entropy string), so it cannot read
  Electron's files today and vice versa. A one-way reader for the `os_crypt` format (read `Local State`, unprotect the key,
  AES-GCM decrypt the `v10` blob) is needed before the Tauri build may share the Electron app's data folder. Not started;
  the dev build uses its own identity, so no real device token or Discord session is touched.
- **Web view differences.** Electron ships its own Chromium; Tauri uses the system WebView2. The renderer's CSS and
  fonts matched in the screens captured so far, but every screen needs a visual pass.
- **Size will grow.** The 4.4 MB executable has about 11% of the backend. HTTP, zip, WebSocket and TLS support will add
  to it; the figure in PERFORMANCE_COMPARISON.md is not a promise for the finished app.
- **Code signing.** No signing certificate is configured here. Nothing built in this workspace is signed, and none of
  it should be described as a verified publisher.
- **Port fidelity.** JavaScript regexes, path handling and number types differ from Rust's; each port needs the old
  tests, not just a read-through.
- **Unreleased work.** Web control is excluded on purpose. When it ships in Electron, it becomes its own step.

## 5. Safety rules this workspace follows

- Nothing outside `VoxelPort-Tauri-Migration/` is modified; `VoxelPort-App` is only read.
- Test servers live in `C:\Users\Trazverse\vp-tauri-test`; dev data in `%APPDATA%\in.voxelport.app.dev`.
- The test "server" is a stand-in program, not Minecraft, and no real world is ever touched.
- Processes are only ever ended by the exact PID the test started.
- Nothing is deployed, published or pushed.

# Build, run and test

Everything below was run on Windows 11 with Rust 1.99.1 (MSVC), Node 22 and the Tauri CLI 2.12. Commands marked
**untested** have not been run yet.

## Prerequisites

- Rust stable with the `x86_64-pc-windows-msvc` target (`winget install Rustlang.Rustup`, then `rustup default stable`).
- Visual Studio (or Build Tools) with the **Desktop development with C++** workload and a Windows SDK.
- Node 18 or newer (only for the Tauri CLI and the generator scripts).
- The WebView2 runtime (already part of Windows 10/11).

From a fresh checkout: `npm install`.

## Regenerate what is generated

These read the pinned release in `reference/electron-v1.17.1/` and never touch `../VoxelPort-App`:

```
node tools/build-ui.js       # ui/, ui/tauri-bridge.js, src-tauri/src/channels.in
node tools/gen-catalog.js    # src-tauri/src/catalog.json (types, templates, regions)
node tools/gen-parity.js     # docs/FEATURE_PARITY.md
```

## Test

```
cargo test --workspace
```

This runs the Rust core's unit and integration tests (the integration tests start a stand-in server program, not Java)
and the shell's unit tests.

## Run a development build

```
cargo build -p voxelport-tauri
target\debug\voxelport-tauri.exe
```

or `npx tauri dev`. The app's data lives in `%APPDATA%\in.voxelport.app.dev`, separate from the Electron app's.
To see a server in the list, put a `server-profiles.json` there (same format as the Electron app's) with an absolute
`serverDir` that you created for testing.

Starting a server goes through the real Discord gate: a fresh install is blocked until it signs in. Two switches exist
**in development builds only** (they are compiled out of release builds) so the gate can be tested without Discord:

| Variable | Effect |
|---|---|
| `VOXELPORT_ACCOUNTS_URL` | use this accounts service instead of `https://accounts.voxelport.in` |
| `VOXELPORT_NO_BROWSER=1` | the app follows the sign-in URL itself instead of opening a browser tab |
| `VOXELPORT_JAVA_API` | use this Adoptium-style API (plain HTTP on 127.0.0.1 only) instead of the real one |
| `VOXELPORT_MC_API=http://127.0.0.1:<port>` | use a local copy of the Mojang, Paper and Fabric services (plain HTTP on 127.0.0.1 only) |
| `VOXELPORT_MODRINTH_API=http://127.0.0.1:<port>/v2` | use a local copy of Modrinth for the login and skins plugins (plain HTTP on 127.0.0.1 only) |
| `VOXELPORT_TEST_RESTORE=yes\|no` | answer the "restore this backup?" question |
| `VOXELPORT_RELAY_URL=ws://127.0.0.1:<port>` | send every tunnel to a local test relay (it still behaves as the chosen region) |
| `VOXELPORT_TEST_SWITCH=yes\|no` | answer the "switch the tunnel to another server?" question |
| `VOXELPORT_TEST_FOLDER=<path>` | answer the folder picker with this path |
| `VOXELPORT_TEST_REMOVE=cancel\|list\|delete` | answer the delete question |

`tools/fake-accounts.mjs` is a stand-in accounts service that checks PKCE like the real one. `tools/e2e-gate.mjs` starts
it, launches the debug build, and drives the whole gate through the real window (20 checks). To exercise server start
with no Minecraft at all, a stand-in program named `java.exe` goes in a folder passed as the third argument:

```
copy target\debug\vp-fake-server.exe C:\some\test\folder\java.exe
node tools/e2e-gate.mjs "%CD%\target\debug\voxelport-tauri.exe" "%APPDATA%\in.voxelport.app.dev" C:\some\test\folder
```

`tools/e2e-java.mjs` does the same for Java: a stand-in Adoptium (`tools/fake-adoptium.mjs`) serves a real zip whose
`java.exe` is the test stand-in, the stand-in on the PATH claims to be Java 8, and the script checks detection, the
automatic install, narration, the failure paths and the automatic restart on a newer Java (24 checks):

```
node tools/e2e-java.mjs "%CD%\target\debug\voxelport-tauri.exe" "%APPDATA%\in.voxelport.app.dev" "%CD%\target\debug\vp-fake-server.exe"
```

`tools/e2e-install.mjs` covers server types and versions, install, import, edit, run and delete against `tools/fake-mc.mjs` (40 checks):

```
node tools/e2e-install.mjs "%CD%\target\debug\voxelport-tauri.exe" "%APPDATA%\in.voxelport.app.dev" C:\Users\<you>\vp-tauri-test\e2e-install C:\some\test\folder
```

It backs up and restores the dev profile list, and wipes only its own test folder (the path must contain `vp-tauri-test`).
`tools/e2e-config.mjs` covers the Settings screen, friends-only (also against a running server), the file browser, cracked mode,
the EULA fix and restart (37 checks; same arguments as the install script, test folder `...\e2e-config`).

`tools/e2e-backups.mjs` covers backups, restore (asked first, undoable), the live save, the backup at stop, settings, delete and
changing the Minecraft version (36 checks; test folder `...\e2e-backups`). It removes the backups it made.

`tools/e2e-addons.mjs` covers plugins and mods, Bedrock players, the Bedrock template and modpack import against the stand-in Modrinth and GeyserMC (49 checks; same arguments as the install script, test folder `...\e2e-addons`). `tools/e2e-insights.mjs` covers the performance panel and the "why it stopped" explanations (22 checks; test folder `...\e2e-insights`). The stand-in `java.exe` must be a build of `vp-fake-server` that answers `tick query`, so copy `target\debug\vp-fake-server.exe` over it again after a rebuild.

`tools/e2e-tunnel.mjs` covers making a server public through `tools/fake-relay.mjs` (49 checks; test folder `...\e2e-tunnel`). It also needs
port 25590 free on 127.0.0.1 for a stand-in "Minecraft" that echoes.

The six scripts delete only the identity files the gate creates in that data folder (`device-token.json`, `discord-gate.json`,
`app-session.json`) and ends only the processes it started, by PID.

## Release build

```
cargo build --release -p voxelport-tauri     # about 90 s here; target\release\voxelport-tauri.exe
```

The release profile is tuned for size (`opt-level = "s"`, LTO, one codegen unit, `panic = "abort"`, stripped).

## Windows installer (untested)

```
npx tauri build --bundles nsis
```

This is configured for a per-user install (`installMode: currentUser`) with no administrator rights. It has not been run
yet: the build downloads the NSIS tooling, and the result is **unsigned**, so Windows will show an unknown-publisher
warning. A code-signing certificate has to be configured before any build is shared. The installer would use the
development identifier `in.voxelport.app.dev`; changing it to the real one is a release decision, because it decides
whether the Tauri build can see the Electron app's data.

## Benchmarks

```
node tools/bench.mjs "<label>" <debug-port> <runs> <exe> [args...]
```

Starts the app, waits for its page and `window.vp`, lets it sit 30 s, then samples the whole process tree (app plus
web view or helper processes) for memory, and the CPU time used over the next 20 s. It only ends the process it
started. See PERFORMANCE_COMPARISON.md for how the numbers were taken and what they do not show.

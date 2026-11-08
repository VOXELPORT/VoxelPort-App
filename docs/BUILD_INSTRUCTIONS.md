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

`tools/e2e-bedrock-server.mjs` covers the Bedrock Dedicated Server type (see [BEDROCK_SERVER.md](BEDROCK_SERVER.md)): the wizard, a start with no Java on the PATH, players, settings, the allow-list, live and stopped backups, restore, and a datagram through `tools/fake-relay.mjs` (48 checks; test folder `...\e2e-bedrock`). Its last argument is the stand-in server, which it serves inside a fake Mojang archive as `bedrock_server.exe` (the stand-in poses as a Bedrock server when it is named that, and answers UDP when `VP_FAKE_UDP_ECHO` is set):

```
node tools/e2e-bedrock-server.mjs "%CD%\target\debug\voxelport-tauri.exe" "%APPDATA%\in.voxelport.app.dev" C:\Users\<you>\vp-tauri-test\e2e-bedrock "%CD%\target\debug\vp-fake-server.exe"
```

It needs ports 8797 and 8799 free, and removes the backups and the wizard's server folder it made. One more test asks Mojang's real link service which Bedrock server is current (one small request, nothing is downloaded); it is skipped by default: `cargo test -p voxelport-core --test bds -- --ignored`.

`ui/` is built, not edited: `node tools/build-ui.js` copies the pinned Electron renderer and then applies `ui-extra/` (new files) and `tools/ui-patches-bedrock.js` (the few anchored changes the Bedrock type makes). A patch whose anchor is missing stops the build, so a change in the pinned renderer can never turn one into a silent no-op. Rebuild the app (`cargo build`) afterwards: the screens are embedded in it.

The six scripts delete only the identity files the gate creates in that data folder (`device-token.json`, `discord-gate.json`,
`app-session.json`) and ends only the processes it started, by PID.

## Release build and installer

```
node tools/build-release.mjs
```

One command builds the release program (`opt-level = "s"`, LTO, one codegen unit, `panic = "abort"`, stripped; about 2 minutes), makes the NSIS installer
with the real identity from `src-tauri/tauri.release.conf.json` (product name **VoxelPort**, identifier `in.voxelport.app`, publisher VoxelPort, a per-user
install with no administrator rights), signs it for updates, and writes into `release-out/` (git-ignored):

| File | What it is |
|---|---|
| `VoxelPort-Setup.exe` | the installer under a stable name, for the website's download link |
| `VoxelPort_<version>_x64-setup.exe` | the same bytes under the versioned name `latest.json` points at |
| `latest.json` | the update manifest the app reads: version, signature, download address |
| `SHA256SUMS.txt` | checksums of the two installers |

It refuses to build if the version in `Cargo.toml` and `tauri.conf.json` differ, if `UPDATE_PUBLIC_KEY` is empty, or if `UPDATE_PUBLIC_KEY` is not the public half of the
key it is about to sign with (an update signed with the wrong key would be refused by every installed copy). Nothing is uploaded.

The development build keeps its own identity (`in.voxelport.app.dev`, product name "VoxelPort Tauri Dev") so it never touches a person's real data; the release
config only overrides the name, identifier and installer settings. The current version is **2.0.0-beta.1**, chosen to continue above the Electron app's 1.17.1; change it in
`src-tauri/Cargo.toml`, `crates/voxelport-core/Cargo.toml`, `src-tauri/tauri.conf.json` and `package.json` together (the script checks the first and third).

The installer is **not code-signed**: Windows shows an "unknown publisher" warning (SmartScreen) until a code-signing certificate is added. That is separate from the update
signature, which is what keeps updates safe. There is no Microsoft Store build, by decision.

### Testing the installer

```
node tools/smoke-release.mjs release-out\VoxelPort_<version>_x64-setup.exe C:\Users\<you>\vp-tauri-test\smoke-install
```

Installs silently with `/NS` (no shortcuts, so another VoxelPort's desktop and Start menu shortcuts, which share the name, are never touched), checks what it wrote, starts the
installed app with no test switches, checks its window, the version, its separate data folder, that the page cannot call the updater or an unknown channel, the one-copy
lock and the update check, then uninstalls and checks everything it made is gone and that other VoxelPort installs are unchanged (18 checks). It refuses to run if this kind
of VoxelPort is already installed or its data folder exists, and removes only what it made. The app does reach the real accounts service (public status) and GitHub (the
update manifest), as a person's copy would; it never signs in.

**Do not run a VoxelPort installer by hand on a PC that has the Electron app without `/NS`:** it would replace that app's desktop shortcut (same name). It installs to
`%LOCALAPPDATA%\VoxelPort` (the Electron app uses `%LOCALAPPDATA%\Programs\VoxelPort`) with its own uninstall entry, so the two can sit side by side, with separate data.

## Benchmarks

```
node tools/bench.mjs "<label>" <debug-port> <runs> <exe> [args...]
```

Starts the app, waits for its page and `window.vp`, lets it sit 30 s, then samples the whole process tree (app plus
web view or helper processes) for memory, and the CPU time used over the next 20 s. It only ends the process it
started. See PERFORMANCE_COMPARISON.md for how the numbers were taken and what they do not show.

## Support, presence, voice chat, the error report and updates, end to end

`tools/e2e-app.mjs` covers the one-copy lock, the Support screen, the copy buttons, Discord presence (against a stand-in Discord on a real named pipe), automatic voice chat and the error report (44 checks; same arguments as the install script, test folder `...\e2e-app`). It needs ports 8795 (stand-in website), 8797 and 8799 free on 127.0.0.1. The real clipboard, browser and Discord are not touched: development builds write the clipboard to a file (`VOXELPORT_TEST_CLIPBOARD_FILE`), skip opening a browser (`VOXELPORT_NO_BROWSER`) and refuse the real Discord (`VOXELPORT_DISCORD_PIPE`: unset means none, `system` means the real one, anything else is a pipe name to use).

`tools/e2e-update.mjs` covers updating the app (25 checks) with one more argument, the stand-in installer:

```
node tools/e2e-update.mjs "%CD%\target\debug\voxelport-tauri.exe" "%APPDATA%\in.voxelport.app.dev" C:\Users\<you>\vp-tauri-test\e2e-update C:\some\test\folder "%CD%\target\debug\vp-fake-installer.exe"
```

It makes throwaway signing keys with the Tauri CLI, signs the stand-in installer, serves it on port 8793, and deletes the keys afterwards. The stand-in server (`vp-fake-server`) writes the file named by `VP_FAKE_STOP_MARK` when it is told to stop, which is how the script proves the server stopped before the installer started.

### Releasing an update

The signing key exists: it was generated on 2026-11-08 into `%USERPROFILE%\.voxelport-update-signing\` (`update.key`, `update.key.password`, `update.key.pub`), readable only by this
Windows account, and its public half is `UPDATE_PUBLIC_KEY` in `src-tauri/src/updatesetup.rs`. **Back that folder up somewhere safe** (not the repository): whoever holds the private key
can ship code to every installed copy, and **losing it means every installed copy has to be reinstalled by hand** (the app only accepts updates signed with it). If it is ever
replaced, `UPDATE_PUBLIC_KEY` must change in the same release that people still on the old key can receive.

To publish a version:

1. Set the version (see above), run `node tools/build-release.mjs` and `node tools/smoke-release.mjs ...`.
2. Create a GitHub release tagged `v<version>` in the repository named in `UPDATE_ENDPOINT` (`src-tauri/src/updatesetup.rs`; `VOXELPORT/VoxelPort-App` by default) and attach
   `latest.json`, `VoxelPort_<version>_x64-setup.exe` and `VoxelPort-Setup.exe`. The app reads `releases/latest/download/latest.json`, and GitHub's "latest" **skips
   pre-releases**: a release marked "pre-release" is not offered as an update.
3. That repository's latest release is also what the Electron app's updater reads (`latest.yml`); a release without it shows the Electron app nothing, which is harmless but means
   Electron copies are not moved to this build by an update. They need a one-time reinstall (their data does not carry over automatically; see MIGRATION_PLAN.md).

The signature is bound to the version (`--app-version`, done by the script) and the app refuses one that is not.

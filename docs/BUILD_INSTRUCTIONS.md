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

Starting a server is refused unless `VOXELPORT_DEV_ALLOW_START=1` is set (the Discord gate is not ported yet). To
exercise the whole start/console/stop flow with no Minecraft at all, put the test stand-in first on the PATH under the
name `java.exe`:

```
copy target\debug\vp-fake-server.exe C:\some\test\folder\java.exe
set PATH=C:\some\test\folder;%PATH%
set VOXELPORT_DEV_ALLOW_START=1
target\debug\voxelport-tauri.exe
```

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

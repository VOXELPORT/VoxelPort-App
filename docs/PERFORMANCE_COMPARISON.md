# Performance comparison: Electron v1.17.1 vs the Tauri build

All numbers below were measured on one machine (Windows 11, 32 GB RAM) on 2026-11-07 with `tools/bench.mjs`.
Nothing here is estimated. Read the limitations before quoting any of it.

## Headline

| Metric | Electron v1.17.1 | Tauri (release) | Result |
|---|---|---|---|
| Idle RAM, whole process tree, working set (median of 3) | 343.6 MB | 371.5 MB | **Tauri is not lower** (8% higher) |
| Idle RAM, private bytes (median of 3) | 191.3 MB | 204.8 MB | **Tauri is not lower** (7% higher) |
| Idle CPU over 20 s, % of one core (median of 3) | 0.00% | 0.07% | both effectively zero |
| Cold start to page ready, ms (median of 3) | 290 | 392 | **Tauri is not faster** here |
| Installer on disk | 108.6 MB (`VoxelPort-Setup.exe`) | **not built yet** | n/a |
| Main executable | `VoxelPort.exe` is part of a 365 MB unpacked app | **4.43 MB** at the first benchmark, **6.08 MB** after the account/gate, Java, server and management ports added HTTPS, TLS, crypto, zip and a native dialog library (`voxelport-tauri.exe`) | **Tauri is far smaller** |
| App on disk, unpacked | 365 MB (`win-unpacked`) | 4.43 MB, plus the system WebView2 runtime that Windows already has | **Tauri is far smaller** |

**What this says.** The one clear win is size on disk: the executable is about 4.4 MB because Tauri uses the Windows web
view instead of shipping its own Chromium. Idle memory, idle CPU and start-up were **not** improved in this
measurement: both apps show the same screen through a Chromium-based web view, and that web view dominates memory. The
brief's goal of "significantly lower RAM" is not demonstrated by this workspace.

## Per-run data

```
Tauri(release) run 1: start 566 ms | working set 375.7 MB, private 204.9 MB | idle CPU 0.00% | 7 processes (voxelport-tauri x1, msedgewebview2 x6)
Tauri(release) run 2: start 391 ms | working set 367.3 MB, private 199.9 MB | idle CPU 0.07% | 7 processes
Tauri(release) run 3: start 392 ms | working set 371.5 MB, private 204.8 MB | idle CPU 0.39% | 7 processes

Electron(v1.17.1 dev-run) run 1: start 537 ms | working set 364.1 MB, private 227.7 MB | idle CPU 0.00% | 4 processes (electron x4)
Electron(v1.17.1 dev-run) run 2: start 290 ms | working set 337.9 MB, private 185.9 MB | idle CPU 0.00% | 4 processes
Electron(v1.17.1 dev-run) run 3: start 279 ms | working set 343.6 MB, private 191.3 MB | idle CPU 0.00% | 4 processes
```

Run 1 of each is a cold start (first launch after the profile was created); runs 2 and 3 are warm.

## Method

- `tools/bench.mjs` starts the app, polls the web view's debugging port until `document.readyState` is `complete`
  and `window.vp` exists (that time is "start"), waits 30 s, then sums `WorkingSet64` and `PrivateMemorySize64` over the app
  process and every descendant (`tools/tree.ps1`). It reads cumulative CPU time, waits 20 s, reads it again, and reports
  the difference as a share of one core. It ends only the process it started.
- Tauri: `target\release\voxelport-tauri.exe`, isolated data folder `in.voxelport.app.dev`.
- Electron: the stock `electron.exe` from the project's `node_modules`, running the pinned release source from
  `reference/electron-v1.17.1` with a throwaway `--user-data-dir`, so none of the real app's data, token or Discord
  session was involved.

## Limitations (these matter)

1. **The Tauri build has about 55% of the backend by channel count.** The ports so far grew the executable from 4.43 MB to
   6.08 MB (HTTPS client, TLS, AES/PBKDF2, zip, native dialogs). The WebSocket tunnel and the updater will add more. The memory and start-up
   rows above were measured **before** that port and have not been re-measured.
2. **Different first screens.** The Tauri run shows the server list. The Electron run, with an empty profile and no
   Discord sign-in, shows whatever its first screen is (probably the join gate). Different DOMs, so memory is
   comparable but not identical content.
3. **Electron was run unpackaged** (dev run of the same runtime), not as the installed `VoxelPort.exe`. The runtime is the
   same Electron, but an installed build could differ slightly.
4. **Working set double counts shared pages** between processes (Chromium and WebView2 share a lot), so the private
   bytes row is the fairer one. Neither is what Task Manager's "Memory" column shows exactly.
5. **Three runs each**, one machine, one afternoon. Differences of under about 10% are inside the noise here, which
   includes the memory and start-up rows.
6. **WebView2 is shared.** It is a system component other apps (and Edge) also use; its disk size is not counted
   against Tauri above, and a machine without it would need it installed.
7. **No Java process is included.** Only VoxelPort's own overhead is measured, as asked.
8. **Not measured yet:** installer size (the NSIS installer has not been built), UI responsiveness under a large
   console, memory with a running server, and behaviour over hours.

## Where a real RAM saving could still come from (not yet tried)

The Tauri process tree shows 6 web view processes against Electron's 4. Reducing that (web view launch options,
fewer renderer/utility processes, GPU settings) is an experiment worth running, as is replacing a heavy front end with a
lighter one. Neither has been tried or measured, so no saving is claimed.

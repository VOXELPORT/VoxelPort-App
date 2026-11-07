# Architecture

```
 window (WebView2)                       Rust (one process)
 ┌──────────────────────┐  invoke "ipc"  ┌─────────────────────────────────────────────┐
 │ ui/  released        │ ─────────────► │ src-tauri   ipc.rs   channel allow-list     │
 │ renderer, unchanged  │ ◄───────────── │             main.rs  events, quit gate      │
 │ + tauri-bridge.js    │  emit events   │             profiles.rs, catalog.rs, sys.rs │
 │   (window.vp)        │                └───────────────┬─────────────────────────────┘
 └──────────────────────┘                                │ plain Rust calls
                                         ┌───────────────▼─────────────────────────────┐
                                         │ crates/voxelport-core (no Tauri, no UI)     │
                                         │   server_process.rs  lifecycle, stdin, stop │
                                         │   bedrock.rs         Geyser JVM arguments   │
                                         │   log_buffer.rs      bounded console buffer │
                                         └───────────────┬─────────────────────────────┘
                                                         │ spawn, fixed argv, no shell
                                                  java -jar server.jar nogui
```

## The contract with the screens

`ui/tauri-bridge.js` is **generated** from the Electron preload by `tools/build-ui.js`. It defines the same `window.vp`
the screens already use. Calls become `invoke('ipc', { channel, args })`; events are Tauri events with the same names.
The Rust command checks the channel against `channels.in` (also generated) and dispatches. An unported channel returns
`Not migrated to the Tauri build yet: <channel>` as a rejected promise, which is how Electron reports a failed call too.

## The process manager (`server_process.rs`)

- **Command**: built by `build_command` from a validated `StartConfig`: absolute server folder, `java` or an absolute
  path to a file named `java`/`java.exe`, a plain `*.jar` name, RAM between 256 MB and 128 GB. Fixed argument list;
  nothing passes through a shell. Refusals are logged and set the status to `crashed`, as in Electron.
- **Output**: stdout and stderr are read a line at a time with a 64 KiB cap per line (the rest of an over-long line
  is dropped and the line is marked). Lines go into a bounded buffer (5,000 lines, 4 KiB each) for a reopened console,
  and to the UI through a bounded backlog (10,000 lines); beyond that, live log events are dropped and counted, never
  queued. A flood of output cannot grow memory and cannot block the server.
- **Control events** (status, players, exit) are never dropped.
- **Input**: command text has control characters stripped (so an embedded newline cannot start a second command),
  is cut to 512 characters, and is written with a 5 s timeout. Player buttons accept only kick/op/deop/ban/pardon and
  a name that looks like a Minecraft name.
- **Stop**: `stop` on the console, then a grace period (default 20 s), then a kill. A stop that had to kill ends as
  "stopped", not "crashed". The kill is requested from one supervising task that owns the child, so there is no
  shared handle to race.
- **No orphans**: the child is started with `kill_on_drop`; the window's close handler asks the server to stop and waits
  up to 30 s before exiting.
- **Join/leave tracking** parses the whole message after the log prefix, so chat text cannot pose as the server.
- **One server at a time**, like Electron. Starting a second returns `AlreadyRunning`.

## Security posture

- The page may call one backend command, `ipc` (an app manifest in `build.rs` plus a capability for the `main`
  window), and listen for events. No filesystem, shell, HTTP or dialog plugin is enabled yet.
- Content-Security-Policy stays as strict as the Electron page's, plus `connect-src ipc:` for the backend channel.
- Server profiles are validated on load with the same rules as Electron; a corrupt or hand-edited entry is dropped.
- Not yet done: download allow-lists and checksums, zip extraction path checks, DPAPI storage. Each is planned with its
  module in MIGRATION_PLAN.md.

## Not built, on purpose

No background service (the Electron app has none) and no proxy management (it does not exist in the product).

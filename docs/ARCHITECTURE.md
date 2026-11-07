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

## Java (`java.rs`, `src-tauri/src/javasetup.rs`)

- **Which Java**: the same table as Electron (26.x needs 25, 1.20.5 needs 21, 1.18 needs 17, 1.17 needs 16, older 8). A
  profile can raise it (`javaMajor`). The app prefers a Java it installed itself (exact major, then the closest newer),
  then `java` on the PATH, and runs `java -version` (with a 15 s limit) to see what a candidate really is.
- **Install**: Eclipse Temurin into `<data>/java/temurin-<major>/`, no administrator rights. The build and its SHA-256 come from
  the Adoptium API; every request and every redirect hop must be HTTPS to `api.adoptium.net`, `github.com` or GitHub's
  release-asset hosts; the archive is capped at 400 MB and the download must not stall for 30 s; the checksum must match.
- **Unpacking** is done in Rust, not by a system tool: every entry must stay inside the target folder (no `..`, absolute
  path or drive letter), links are refused, and entry count and unpacked size are capped. Work happens in a scratch folder
  that is removed whether or not the install worked; the finished folder is moved into place in one step.
- **Start**: `server:start` resolves Java first. If none is new enough the screens see "starting", the console narrates the
  download, and a failure says why and leaves no server active. One install at a time; a second request waits and then
  finds the first one's result.
- **Newer Java at run time**: the server's own output is scanned for "needs Java N" (and for `UnsupportedClassVersionError`). If a
  server dies because of that, the profile remembers the new minimum (only that field of that entry is rewritten) and the
  server starts once more; if it still fails, the app says so rather than looping.
- Windows only so far: the Adoptium archive for Windows is a zip. Linux/macOS `.tar.gz` is not handled.

## The account and the Discord gate (`account.rs`, `gate.rs`, `identity.rs`)

- **Gate** (`gate.rs`): a pure function from "existing install?, session?, config, last status, last good answer, now" to
  allowed / must sign in / banner / reason. Grace is judged on the server's clock plus elapsed time that never goes
  negative, so winding the PC clock back does not extend it. When the service cannot be reached the last good answer
  holds for 7 days.
- **Sign-in** (`account.rs`): PKCE. A random verifier stays in memory; the challenge goes to the browser. The app listens on
  a loopback port (`127.0.0.1:0`), accepts only `GET /` carrying a well-formed 43-character code or a short error word,
  answers everything else 404, and closes the port as soon as it has an answer, a timeout (10 minutes) or a cancel. A
  second click joins the sign-in already open. The exchange never follows a redirect.
- **Secrets** (`identity.rs`, `secrets.rs`): the device token and the app session are encrypted with Windows DPAPI. A token
  file that exists but cannot be read is never overwritten: a temporary token is used, a copy is kept, and the original
  comes back when the store works again. The raw token never goes to the page (only a masked hint and a 12-character id).
- **Address backup**: PBKDF2-SHA256 (600,000 rounds) + AES-256-GCM, byte-compatible with the Electron and Android apps
  (a fixed test vector generated by Node decrypts here, and the same salt and IV reproduce the same blob).
- **Page-facing glue** (`src-tauri/src/discord.rs`): builds `discord:state`, re-checks every 15 minutes and when the window
  regains focus (at most once a minute), opens only exact `https://discord.gg/<code>` invites.

## Security posture

- The page may call one backend command, `ipc` (an app manifest in `build.rs` plus a capability for the `main`
  window), and listen for events. No filesystem, shell, HTTP or dialog plugin is enabled; the Rust side does its own HTTPS (ureq with rustls) to the accounts service only.
- Content-Security-Policy stays as strict as the Electron page's, plus `connect-src ipc:` for the backend channel.
- Server profiles are validated on load with the same rules as Electron; a corrupt or hand-edited entry is dropped.
- Not yet done: download allow-lists and checksums, zip extraction path checks, reading Electron's `os_crypt` secrets. Each is
  planned with its module in MIGRATION_PLAN.md.

## Not built, on purpose

No background service (the Electron app has none) and no proxy management (it does not exist in the product).

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

## The tunnel (`tunnel.rs`, `regions.rs`, `relay_url.rs`, `bedrock_endpoint.rs`, `src-tauri/src/tunnelsetup.rs`)

- **Protocol** (`tunnel.rs`): the host protocol the Fabric mod speaks. Register with the device token (asking for protocol v2), get a public port
(and a Bedrock port if asked), then bridge each player the relay announces to the local server. After a `port` frame carrying `"bin": 1`,
payloads travel as binary frames (kind, 16 raw id bytes, payload); otherwise as base64 in JSON, so an older relay works unchanged.
- **The relay is untrusted input.** Every frame is validated before anything acts on it; a frame over 4 MiB drops the connection; the number of local
sockets is capped at 256; each player has a budget of 8 MiB waiting to be written locally; Bedrock signalling is only accepted if the relay
assigned a separate Bedrock port (an old relay can never route it to Java); a binary frame without v2 agreement, a short one or an unknown
kind is ignored and logged at most every 30 s.
- **How it runs**: one task owns the connection. Each player and each UDP session is its own task and talks to it over channels, and the
sending half has its own writer task, so reading relay frames is never blocked. Local servers are read only while the relay keeps up (a 4 MiB
byte budget) and a connection with no progress for 30 s is dropped and reconnected, which bounds memory.
- **Candidates and reconnecting**: relay addresses are tried in order (a candidate that cannot be reached is skipped at once); after a drop the
preferred one is tried first again; backoff 1 s doubling to 15 s; `stop` is idempotent and `stopped` is said exactly once, even if the tunnel was
still waiting to reconnect. A tunnel is "live" from start until stopped, even while connecting.
- **Regions** (`regions.rs`): India (direct port, then Cloudflare) and Europe. An explicit choice wins; on Auto a custom address pins the tunnel to the
region that owns it; otherwise the fastest measured (all measured in parallel), India if none answers. **Relay safety** (`relay_url.rs`): `wss://`
always, `ws://` only to loopback/private/link-local address literals (a name like `fcevil.example` is never private).
- **Shell** (`tunnelsetup.rs`): one tunnel at a time. Switching target asks first (in the backend); an old tunnel finishing late cannot clear a newer
one's state; the tunnel stops when the server it bridges to exits; custom address and region preference are saved in the data folder;
the public list entry is sent after every registration and refreshed when settings change or players come and go (at most every 5 s).
- **Bedrock address**: the relay assigns the Bedrock port only at make-public, after Geyser already started. The address is remembered per server
and device (the token is hashed into the key, never written), and the server is restarted once so Geyser advertises it. Unlike Electron, the
tunnel **stays up** during that restart (Electron stopped it because its server exited, contradicting its own "players reconnect automatically" message).

## Backups (`backups.rs`, `src-tauri/src/backupservice.rs`)

- **A backup** is one zip: the world folders (`level-name`, `_nether`, `_the_end`), `server.jar`, and the player lists, plus `voxelport-backup.json`
saying what it is. `session.lock`, plugins and logs are never included, links are never followed. The file is written as
`<name>.zip.partial`, reopened and checked, and only then renamed, so a half-written backup can never pass for a good one. Names carry the
computer's **local** time (as the Electron app's do); the shell installs a Windows time-zone clock so `createdAt` is the real moment.
- **Restore** first saves what is there now as a `before-restore` backup (if that fails, nothing is touched), unpacks into a temporary
folder, checks it, then swaps folders over. If any step fails, the old folders and player lists are put back. The copy made first holds
*every* folder the swap will move, including another world's if `level-name` has changed since.
- **Traps**: a backup may only restore the folders of its own world (never `plugins` or any server folder, whatever its metadata says, even one
claiming to be a before-restore copy); names with `..`, a drive letter, a stream `:`, a backslash or an absolute path are refused; symbolic
links are refused; more than a million entries is refused. All of this is checked **before** the live world is touched.
- **Service** (shell): one job per server at a time; a running server is sent `save-off`, then `save-all flush`, and the copy starts when it says
"Saved the game" (or after 60 s, with a note), and `save-on` is always sent afterwards. Restore is refused while the server runs and is
always asked first, in the backend. Schedule: every minute while online, if due and a player was on since the last backup; a clean stop makes
one last backup (not when the app is closing, not if one was made in the last 2 minutes). Retention: keep the newest N automatic ones, a 5 GB
budget (never below two), three before-restore copies, manual ones never removed.
- **Change version** takes a manual backup first (and is refused if that cannot be made, e.g. a server that never created a world), downloads the
new jar beside the old one, verifies its version, and only then swaps it in. Restoring a backup that carried a jar also puts the profile's type
and version back and forgets any Java minimum learned for the other jar.

## Managing a server (`settings.rs`, `whitelist.rs`, `server_files.rs`, `cracked.rs`, `addon_registry.rs`)

- **Settings**: a table of the twelve `server.properties` keys the screen may change, each with a validator. Anything else is refused, and
`online-mode`, `enable-rcon`, `rcon.password` and `enable-command-block` are deliberately not in it. Values are escaped (backslash, non-ASCII
as `\uXXXX`, control characters dropped) so a value cannot start another line. Only the changed keys of the file are rewritten.
- **Friends-only**: usernames are 3 to 16 of letters, digits, underscore; the list is the server's own `whitelist.json`. A running server is
also sent the `whitelist ...` commands (collected during the call and sent after it, so nothing waits on the server while a file is being
edited); a stopped one is just edited and needs a restart.
- **Files**: the page sends a path relative to the server folder. It must contain no `..`, drive letter, NUL or `:` (which also blocks
Windows alternate data streams), and the real path of the deepest part that exists must stay inside the real folder, so a junction or
symlink cannot lead out. Only existing plain-text files of a fixed set of types are read or replaced; logs are read-only; `.json` must
parse; nothing can be created.
- **Cracked mode** is the one confirmed way to change `online-mode`, and it touches only that key and `enforce-secure-profile`. Setting a
server up for it installs the login plugin (AuthMe, checksum-verified from Modrinth) **first**, switches offline mode on only once the
plugin is really on disk, then adds skins. If the login plugin cannot be had the server stays on normal accounts and says so.
- `addon_registry.rs` is the record of plugins VoxelPort itself installed, so the Plugins screen lists them and Remove only touches those.

## Downloads (`net.rs`)

Everything that fetches a program or archive (Java, server jars, plugins, mods, Geyser and Floodgate, modpack mods) goes through one `Fetcher`: HTTPS only, every
request and every redirect hop checked against a host allow-list (a domain rule matches the domain and its subdomains, not
look-alikes), a size cap, a stall cut-off, a checksum check (SHA-1, SHA-256 or SHA-512) and a write to a temporary file that only
replaces the destination once the download is complete and verified. Java and the server jars share it, so one set of tests
covers both.

## Plugins, mods, modpacks and Bedrock (`addons.rs`, `modpack.rs`, `bedrock_install.rs`, `runtime_info.rs`, `src-tauri/src/addonsetup.rs`)

- **Add-ons** come from Modrinth: Paper takes plugins, Fabric mods, Vanilla neither. A search is one page of twenty hits; a hit with a malformed project
  id is dropped and an icon address is only kept if it is Modrinth's own image host (the page may not load anything from the internet, so the
  backend fetches icons itself as small `data:` images, only from that host). Installing resolves the newest release for the server's loader and
  Minecraft version, brings the libraries it requires first (two levels deep; one already in the folder is recognised by its SHA-512 fingerprint
  and not downloaded twice), and downloads each jar through the shared `Fetcher` against Modrinth's SHA-512. Jar names must be plain `.jar`
  names. A file VoxelPort did not put there is never overwritten; a running server gets new files but no replacements; Remove only deletes what
  `voxelport-addons.json` lists, and not the login plugin while cracked mode is on.
- **Modpacks**: a `.mrpack` is read without extracting anything (the manifest is size-limited and strictly validated). Only files under `mods/` and
  `config/` are considered, a single path that could leave the folder refuses the whole pack, only Modrinth https addresses are downloaded from,
  each with its SHA-512, client-only files are skipped and reported, Forge/NeoForge packs are refused with their own code, Quilt packs install on
  Fabric. The pack's own config (`overrides`, then `server-overrides`) is copied in with size and count caps and the same path checks. A folder the
  import created is removed again if the import fails, so a retry is not blocked by a half-made server.
- **Bedrock**: Geyser (the build Modrinth lists for the server's Minecraft version, so a server is never handed a Geyser for another version) and
  Floodgate (GeyserMC's latest, SHA-256; for Fabric, Floodgate and Fabric API from Modrinth) are resolved **before** anything is written. The jars it
  put there are recorded in `voxelport-bedrock.json`; replacing or removing only ever touches those (an old install with no list is recognised by the
  exact Geyser/Floodgate names, not look-alikes), and Fabric API stays when Bedrock is turned off. Turning it on for a public server reconnects the
  tunnel so it asks for UDP. A start on a Minecraft version no Geyser supports logs a warning and goes ahead (Java players are unaffected).
- **What is installed** (`server:runtimeInfo`, the add-ons screen's "other" list) is read from the disk: the Minecraft version from the jar, and each
  plugin's or mod's own name and version from `plugin.yml` / `fabric.mod.json` inside its jar (the file name is only a fallback).

## The performance panel and "why it stopped" (`perf.rs`, `crash_explain.rs`, `src-tauri/src/insights.rs`)

- CPU and memory of the server process are read from the operating system every two seconds (Windows: process times and working set; Linux:
  `/proc`), not from a helper process as Electron did. TPS comes from the vanilla `tick query` command on Minecraft 1.20.3 and newer, asked every ten
  seconds; its four lines are kept out of the console, and a server that never answers three times in a row is left alone. Only the **server's own
  message** counts (after the `[time] [thread/LEVEL]:` front, matched from its start), so a player typing the same words in chat is neither hidden
  nor taken for an answer, and cannot inflate the lag-warning count either (Electron matched anywhere in the line).
- When a server exits, the last 200 console lines are read against eleven rules, most specific first (port in use, too much RAM, out of memory, EULA,
  a mod for another Minecraft version, a missing mod dependency, a Mixin failure, a broken jar, a locked world, no permission, a failed plugin), with a
  general "it crashed" reading only when nothing else matched and the exit was not clean. The wording is also in Hinglish. Nothing is explained for a
  stop the person (or a restart) asked for, or for an exit that is about to be fixed by restarting on a newer Java.

## Servers (`mc_versions.rs`, `server_install.rs`, `profiles.rs`, `removal.rs`)

- **Versions and jars**: Vanilla (Mojang manifest, SHA-1), Paper (Fill API: newest *stable* build, SHA-256; the version list keeps
the service's order, newest group first) and Fabric (stable loader and installer; no published hash). Only official domains
(`mojang.com`, `minecraft.net`, `papermc.io`, `fabricmc.net`, `geysermc.org`, `modrinth.com`).
- **Install**: refuses a folder that already holds a server before any network call; downloads and verifies the jar; reads the
real Minecraft version out of the jar and refuses a mismatch (a Fabric launcher jar has none and is accepted for Fabric only);
writes `eula.txt` and a `server.properties` whose port is a plain integer and whose template settings can never override
`online-mode`, `server-port`, `enable-rcon` or `enable-command-block`. A folder the install created is removed again if it fails.
- **Profiles** live in core (`profiles.rs`). Entries that fail validation and fields this build does not know are left in the
file on every write, and a store that cannot be parsed is copied aside before a new one starts (Electron overwrote it).
- **Delete** asks in the backend (the page cannot skip the question). Files go to the Recycle Bin only if the folder is clearly
the server's own: not a drive root or top-level folder, not home/Desktop/Documents/Downloads/AppData/temp or anything holding
one, not shared with or inside another saved server, and it must look like a server. Otherwise only the list entry is removed.
- Template extras that need later modules (Bedrock/Geyser, the cracked-server login plugin) are **not** installed; the install
succeeds and says so, and the server keeps normal Minecraft accounts (never a half-set-up offline mode).

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
- Downloads go through one allow-listed, checksummed, size-capped client, and every zip is read with path checks (done). Not yet done: reading
  Electron's `os_crypt` secrets (planned with its module in MIGRATION_PLAN.md).

## Not built, on purpose

No background service (the Electron app has none) and no proxy management (it does not exist in the product).

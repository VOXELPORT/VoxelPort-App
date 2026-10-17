# Developing VoxelPort

Everything technical about the desktop app: how it's built, how it's laid out,
and how to run, test and package it. For the trust/security model, see
[SECURITY.md](SECURITY.md).

## Architecture

```
VoxelPort Installation
│
├── ONE DEVICE TOKEN (generated locally, encrypted at rest — see SECURITY.md)
│
├── Server Profile A ─┐
├── Server Profile B  ├─ any number of saved profiles
├── Server Profile C ─┘
│
├── ONE ACTIVE MANAGED SERVER PROCESS (whichever profile you started)
│
└── ONE ACTIVE VOXELPORT TUNNEL
        │
        ▼
play.voxelport.in:<port>
```

Starting a different profile while one is already running, or making a
different profile public while another is already public, asks for
confirmation before switching — VoxelPort never silently stops or replaces
either without telling you. "Tunnel my own server" (manual mode) shares the
same single tunnel and device token; it doesn't require a saved profile.

## How it works

The app implements the VoxelPort host protocol (see `../relay/README.md`): it
connects to `wss://direct.voxelport.in:26499`, falling back to
`wss://relay.voxelport.in` via Cloudflare after 5 s if the direct port is
blocked; players use `play.voxelport.in`. It registers with a device token
generated on first run, receives a public port, and bridges each vanilla player
connection to your local server.

`src/main/regions.js` supports several relay regions and a Region setting
(Auto / per-region, saved in `preferences.json`); the app currently ships a
single region (India), so the Region picker stays hidden. Re-adding a region
there brings the picker back automatically.

```
app/
  src/main/      Electron main process
    main.js            window + IPC + single-server/single-tunnel enforcement
    tunnel.js          relay client (ws + net) — the protocol, with backpressure
                        and per-message validation
    serverProcess.js   spawns and manages the java process, parses console output
    serverProfiles.js  multi-server profile store + one-time migration
    serverInstall.js   downloads the server jar (atomic, checksummed, host-
                        allowlisted), writes eula.txt/server.properties,
                        detects an existing server for import
    token.js           device token generation, safeStorage-encrypted at rest
    mcVersions.js      Vanilla/Paper/Fabric version + download resolution
    javaCheck.js       detects installed Java, compares against what's needed,
                        reads "needs Java N" errors from server logs
    javaInstall.js     downloads Eclipse Temurin (Adoptium, checksum-verified)
    serverSettings.js  editable server.properties keys + validation, server templates
    bedrock.js         one-click Geyser + Floodgate (GeyserMC / Modrinth, checksum-verified)
    perfMonitor.js     CPU/RAM sampling of the server process, TPS from `tick query`
    crashExplain.js    plain-English reasons (and fixes) for why a server stopped
    updater.js         GitHub-based auto-update (Windows installer only)
    ipcSenders.js      central IPC sender validation
    relayUrlSafety.js  validates custom relay URLs (real IP literals only)
    externalLinkSafety.js  allowlist for shell.openExternal
    preload.js         safe contextBridge API — no raw device token exposed
  src/renderer/  UI (comic × Minecraft theme) — server library → wizard/import → management
```

## Develop

```bash
npm install
npm run dev
```

Point at a local relay for testing by expanding **Advanced → Relay URL** and
entering e.g. `ws://127.0.0.1:8099`.

## Test

```bash
npm test
npm audit
```

Tests that download from a local mock server need `VOXELPORT_DEV_DOWNLOADS=1`
(the test files set it themselves). The app only accepts loopback or private
addresses for a download when that variable is set, so it must never be set in a
real run.

## Relay protocol v2 (binary data frames)

The tunnel (`src/main/tunnel.js`) asks the relay for binary data frames by sending `"bin": 1` in `register`. Only if the
relay's `port` frame also says `"bin": 1` do both sides switch; an older relay never sets it, so the app is safe against
any relay. In v2, TCP and UDP payloads are *binary* WebSocket messages:

```
byte 0        kind    0x01 = TCP data, 0x02 = UDP datagram
bytes 1..16   connection (or UDP session) id as 16 raw bytes (the relay's 32-character hex id; keep maps keyed by the hex string)
bytes 17..    payload
```

Everything else (`connect`, `close`, `ping`, `pong`, `udp_close`, names, listing, errors, notices) stays JSON text in both
modes, and JSON `data` / `udp` frames are accepted in either mode. Binary frames are validated like JSON ones (`parseBinaryFrame`):
shorter than 17 bytes, an unknown kind, an unknown TCP connection, or a UDP payload over the cap is dropped (logged at most
once every 30 s); a TCP payload over the frame cap ends that player. A connection id that is not 32 hex characters stays on
JSON. In v2 a UDP session's first datagram carries no source address, which this app never used.

The Android app and the (discontinued) Fabric mod still speak JSON only; the relay serves them as before. To adopt v2 they
need the same three things: send `bin: 1`, check `bin: 1` in `port`, and use the frame layout above. The relay side is
documented in the relay repository's README ("Protocol v2").

## Things that are easy to get wrong

- **A tunnel is live until it says `stopped`.** `Tunnel.isLive()` is true from
  `start()` until the `stopped` event, including while it is connecting or
  waiting to reconnect. `running` only means registered and online. Use
  `isLive()` for "does a tunnel exist?" and wait for `stopped` before making
  another one: two tunnels with one device token fight each other.
- **The device token file is never overwritten when it can't be read.** See
  `src/main/token.js` and the token section of SECURITY.md.
- **Bedrock (Geyser/Floodgate) files.** `voxelport-bedrock.json` in the server
  folder lists the exact jars VoxelPort installed; only those are replaced or
  removed. A server from an older version, with no list, is matched by the exact
  Geyser/Floodgate file names (`LEGACY_JAR` in `src/main/bedrock.js`), which must
  not match look-alikes such as `GeyserSkinManager-Spigot.jar`.
- **Reading the server's output.** Use `stripLogPrefix` (exported from
  `serverProcess.js`) and match the whole message: chat lines are
  `<name> text`, so a player can type almost anything after the prefix.
- **Quitting.** `before-quit` (`src/main/quitGate.js`) holds the quit until a
  running server has stopped; `update:install` does the same before
  `quitAndInstall`. Anything that exits the app with `process.exit` or
  `app.exit` skips that.
- **Writing files.** Use `atomicWriteFileSync` (`src/main/atomicWrite.js`) for
  anything the person would be upset to find half written.

## Package

```bash
npm run dist        # current OS
npm run dist:win    # Windows .exe (nsis + portable)
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux tar.gz
```

Output lands in `release/`.

## Releases

Pushing a `v*` tag runs [.github/workflows/release.yml](.github/workflows/release.yml),
which builds the Windows installer, portable `.exe` and Linux `tar.gz`, publishes
them to a GitHub Release, and attaches `SHA256SUMS.txt`. The Microsoft Store
package is built locally with `npx electron-builder --win appx`.

### Auto-update

The installed Windows build (`VoxelPort-Setup.exe`) checks
GitHub for new releases in the background and, once a new version has
finished downloading and its checksum has been verified, shows an in-app
banner — installing it is always your choice, never silent or forced, and
it won't interrupt a running server or public tunnel without asking first.
The portable `.exe` and the Linux build don't auto-update (there's no fixed
install location to safely replace); update those manually from this page.
See [SECURITY.md](SECURITY.md) for exactly what this does and doesn't
guarantee.

The Microsoft Store build never runs the in-app updater — the Store delivers its updates.

### Code signing

earlier versions of this README claimed
the Windows builds were signed via SignPath. This repo's release workflow
does not currently perform any signing step, and no evidence of a working
SignPath integration was found during a security review — so that claim has
been removed rather than left unverified. If a SignPath (or other) signing
integration is set up externally (e.g. via SignPath's GitHub App/webhook
outside this repo's workflow file), please restore this note with the actual
mechanism documented. Until then, assume the published `.exe` files are
**unsigned** and rely on the SHA256 checksums above to verify integrity.

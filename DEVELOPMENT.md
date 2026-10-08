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
play.voxelport.in:<assigned-port>
```

Starting a different profile while one is already running, or making a
different profile public while another is already public, asks for
confirmation before switching — VoxelPort never silently stops or replaces
either without telling you. "Tunnel my own server" (manual mode) shares the
same single tunnel and device token; it doesn't require a saved profile.

## How it works

The app implements the VoxelPort host protocol (see
`../relay/README.md`): it connects to `wss://direct.voxelport.in:26499` (falling back to
`wss://relay.voxelport.in` via Cloudflare after 5 s), registers with a
device token generated on first run, receives a public port, and bridges each
vanilla player connection to your local server.

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

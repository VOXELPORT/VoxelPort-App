# VoxelPort Desktop App

Host **any** local Minecraft server over the internet — no port forwarding, no
mod, no Discord, no signup. The app opens an outbound tunnel to the VoxelPort
relay and gives you a public `play.voxelport.in:<port>` address to share.

Don't have a server yet? The app can install and manage multiple local
Minecraft servers for you — pick Vanilla, Paper, or Fabric and a version, and
it downloads, configures, and launches it, with a live console, a RAM slider
(auto-recommended from your PC's specs), and a folder picker so the server
files can live on any drive. You can also import a server you already have
installed elsewhere without reinstalling anything.

You can save as many server profiles as you like, but VoxelPort only ever
runs **one managed Minecraft server process** and keeps **one public
VoxelPort tunnel** active at a time, under a single device identity — see
"Architecture" below. Vanilla players never need any VoxelPort software.

For the full trust/security model, see [SECURITY.md](SECURITY.md).

## Download

Grab the latest build from the [**Releases**](https://github.com/VOXELPORT/VoxelPort-App/releases/latest) page:

| Platform | File |
|---|---|
| Windows (installer) | [`VoxelPort-Setup.exe`](https://github.com/VOXELPORT/VoxelPort-App/releases/latest/download/VoxelPort-Setup.exe) |
| Windows (portable) | [`VoxelPort-Portable.exe`](https://github.com/VOXELPORT/VoxelPort-App/releases/latest/download/VoxelPort-Portable.exe) |
| Linux | [`VoxelPort-Linux.tar.gz`](https://github.com/VOXELPORT/VoxelPort-App/releases/latest/download/VoxelPort-Linux.tar.gz) |

Prefer to host straight from Minecraft instead? Use the
[VoxelPort Fabric mod](https://github.com/VOXELPORT/VoxelPort).

Each release publishes a `SHA256SUMS.txt` alongside the binaries — verify a
download with `sha256sum -c SHA256SUMS.txt` (or `Get-FileHash` on Windows)
before running it.

**A note on Windows code signing:** earlier versions of this README claimed
the Windows builds were signed via SignPath. This repo's release workflow
does not currently perform any signing step, and no evidence of a working
SignPath integration was found during a security review — so that claim has
been removed rather than left unverified. If a SignPath (or other) signing
integration is set up externally (e.g. via SignPath's GitHub App/webhook
outside this repo's workflow file), please restore this note with the actual
mechanism documented. Until then, assume the published `.exe` files are
**unsigned** and rely on the SHA256 checksums above to verify integrity.

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

The app implements the same host protocol as the Fabric mod (see
`../relay/README.md`): it connects to `wss://relay.voxelport.in`, registers with a
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
    javaCheck.js       detects installed Java, compares against what's needed
    ipcSenders.js      central IPC sender validation
    relayUrlSafety.js  validates custom relay URLs (real IP literals only)
    externalLinkSafety.js  allowlist for shell.openExternal
    preload.js         safe contextBridge API — no raw device token exposed
  src/renderer/  UI (dark + mint theme) — server library → wizard/import → management
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

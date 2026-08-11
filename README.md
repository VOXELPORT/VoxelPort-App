# VoxelPort Desktop App

Host **any** local Minecraft server over the internet — no port forwarding, no
mod, no Discord, no signup. The app opens an outbound tunnel to the VoxelPort
relay and gives you a public `play.voxelport.in:<port>` address to share.

Don't have a server yet? The app can also install and run one for you —
pick Vanilla, Paper, or Fabric and a version, and it downloads, configures,
and launches it, with a live console, a RAM slider (auto-recommended from
your PC's specs), and a folder picker so the server files can live on any
drive. It then tunnels that server the same way as above.

## Download

Grab the latest build from the [**Releases**](https://github.com/VOXELPORT/VoxelPort-App/releases/latest) page:

| Platform | File |
|---|---|
| Windows (installer) | [`VoxelPort-Setup.exe`](https://github.com/VOXELPORT/VoxelPort-App/releases/latest/download/VoxelPort-Setup.exe) |
| Windows (portable) | [`VoxelPort-Portable.exe`](https://github.com/VOXELPORT/VoxelPort-App/releases/latest/download/VoxelPort-Portable.exe) |
| Linux | [`VoxelPort-Linux.tar.gz`](https://github.com/VOXELPORT/VoxelPort-App/releases/latest/download/VoxelPort-Linux.tar.gz) |

Prefer to host straight from Minecraft instead? Use the
[VoxelPort Fabric mod](https://github.com/VOXELPORT/VoxelPort).

Windows builds are code-signed for free courtesy of
[SignPath.io](https://signpath.io), certificate by the
[SignPath Foundation](https://signpath.org).

## How it works

The app implements the same host protocol as the Fabric mod (see
`../relay/README.md`): it connects to `wss://relay.voxelport.in`, registers with a
device token generated on first run, receives a public port, and bridges each
vanilla player connection to your local server (default `127.0.0.1:25565`).

```
app/
  src/main/      Electron main process
    main.js          window + IPC
    tunnel.js        relay client (ws + net) — the protocol
    token.js         auto-generated device token, persisted in userData
    preload.js       safe contextBridge API
    mcVersions.js    Vanilla/Paper/Fabric version + download resolution
    javaCheck.js     detects installed Java, compares against what's needed
    serverInstall.js downloads the server jar, writes eula.txt/server.properties
    serverProcess.js spawns and manages the java process, parses console output
    serverConfig.js  persists the installed server's settings
  src/renderer/  UI (dark + mint theme) — mode select → install wizard → console
```

## Develop

```bash
npm install
npm run dev
```

Point at a local relay for testing by expanding **Advanced → Relay URL** and
entering e.g. `ws://127.0.0.1:8099`.

## Package

```bash
npm run dist        # current OS
npm run dist:win    # Windows .exe (nsis + portable)
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux AppImage
```

Output lands in `release/`.

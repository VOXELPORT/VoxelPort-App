# Security

This document describes what the VoxelPort desktop app actually protects
against, what it doesn't, and what it can see. It's written to be accurate,
not reassuring.

For the relay's own trust model (what a relay operator can see, TLS
guarantees, abuse model), see [`../relay/SECURITY.md`](../relay/SECURITY.md)
— this file only covers the app itself.

## Device bearer token model

VoxelPort identifies this installation to the relay with a single,
locally-generated `vp_…` device token — not an account, not tied to any
identity. **Possession of the token is sufficient to reconnect as this
installation's tunnel identity.** There's no password, no second factor, and
no way to revoke a leaked token from the app itself (the relay is
accountless — see its SECURITY.md).

- One token per VoxelPort installation, ever — never one per server profile.
  Multiple saved server profiles share the same tunnel identity.
- The raw token is never sent to the renderer process and never appears in
  the DOM. `app:info` returns only a masked form (`••••••••Ab4x`) for
  display. Copying the real token goes straight from the main process to the
  OS clipboard via a dedicated, privileged IPC call — the renderer never
  holds the plaintext value at any point.
- The raw token is never logged.

### Storage (safeStorage)

The token is encrypted at rest using Electron's `safeStorage` API when the
OS-backed secret store it wraps is available (Windows DPAPI, macOS
Keychain, or libsecret on Linux). This is genuinely OS-enforced encryption,
not an app-level obfuscation — an attacker without access to your OS user
account cannot decrypt it.

**Honest fallback:** if `safeStorage.isEncryptionAvailable()` is false (some
minimal Linux setups without a running keyring daemon are the realistic
case), the token is stored in plaintext, exactly as every version of this
app before this security pass already did. The app still works correctly in
that case — this is a reduced-protection fallback, not a failure — but it
means anyone with filesystem access to your user profile on such a machine
can read the token directly. An existing plaintext token is opportunistically
migrated to encrypted storage the next time `safeStorage` becomes available,
without ever generating a new token (your tunnel identity never changes as a
side effect of this).

## Relay connection

- The app only ever connects to `wss://` (TLS) by default. A custom
  `ws://` relay URL is only accepted for loopback/private-network addresses
  (`127.0.0.1`, `10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`,
  `169.254.0.0/16`, real IPv6 loopback/unique-local/link-local literals, or
  `localhost`) — a DNS name merely starting with digits or characters that
  resemble a private IP prefix is **not** treated as private; only genuine
  IP literals are (`net.isIP()`-checked, not a string prefix match).
- Relay frames are treated as untrusted input: every field (`type`, `conn`,
  `port`, `data`) is validated before anything acts on it, base64 payload
  size is bounded, malformed frames are ignored rather than crashing the
  app, and a malicious/misbehaving relay cannot make the app open unbounded
  local sockets (a fixed cap on simultaneous local player connections is
  enforced client-side too, independent of the relay's own limit).
- Traffic in both directions is bounded: a slow local Minecraft server can't
  make the app's memory grow without limit (a bounded pending-write budget
  disconnects a stuck local connection instead), and a congested relay
  connection pauses local reads rather than queueing an unbounded amount of
  outbound data.

## What the relay (and its operator) can see

Same as documented in `../relay/SECURITY.md`: the relay is a real in-the-loop
proxy for gameplay traffic. `wss://` protects the control channel (device
token, registration) between this app and the relay, but **does not**
provide end-to-end encryption of Minecraft gameplay traffic between a player
and your server — the relay is always an unencrypted midpoint for that
traffic, by design, the same as it would be for a directly-exposed vanilla
server. If you don't trust a given relay's operator, don't use it — the
relay is open source specifically so you can self-host your own.

## Server jar downloads

Installing a Vanilla/Paper/Fabric server:

- Only ever downloads from `https://` and an explicit allowlist of official
  hosts (`mojang.com`, `minecraft.net`, `papermc.io`, `fabricmc.net`, and
  their subdomains) — confirmed against real, actually-resolved download
  URLs, not guessed. A redirect to any other host, or a downgrade to plain
  `http://`, is rejected.
- Downloads to a temporary file and only replaces an existing `server.jar`
  via an atomic rename once the download has fully completed and passed
  checksum verification (Vanilla: SHA-1, Paper: SHA-256, both published by
  the respective project; Fabric's assembled server-jar endpoint doesn't
  publish one, so that path installs unverified — this is a real, documented
  gap, not an oversight). A failed or tampered download can't corrupt an
  existing install.
- Downloads are bounded in size and have connect/inactivity timeouts — a
  stalled or infinite response can't hang the installer or fill your disk.

Importing an existing server never downloads, overwrites, or reinstalls
anything — it only records a profile pointing at the folder you choose.
Editing a managed setting (like the port) on an imported server updates only
that specific line in `server.properties`, preserving every other custom
setting you already had.

## Auto-update

The installed Windows build checks for new versions via `electron-updater`,
scoped entirely to this app's own GitHub repository:

- The update feed URL (`api.github.com`, this specific `owner/repo`) is
  fixed at build time in `package.json`'s `build.publish` config — it is
  **not** something a running instance of the app, or anything reachable
  from the renderer, can redirect elsewhere.
- Before ever applying an update, `electron-updater` verifies the
  downloaded installer's SHA-512 checksum against the value published in
  `latest.yml` on the GitHub release, both fetched over HTTPS. This is real
  integrity verification — a corrupted or tampered download is rejected,
  not just trusted.
- **What this does not give you**, stated honestly rather than implied:
  since the app is not currently code-signed (see "A note on Windows code
  signing" in the README), there is no Authenticode publisher-identity
  check on top of the checksum. Checksum verification confirms the
  downloaded bytes match what GitHub actually served for this release; it
  does not by itself prove who built them. That gap closes once real code
  signing is in place.
- Downloading a new version happens automatically in the background, but
  **applying** it (quitting and relaunching into the new version) always
  requires an explicit click in the app — never silent, never forced — and
  if a managed server is running or the tunnel is public, you're asked to
  confirm before either gets interrupted.
- The portable `.exe` and the Linux build intentionally do not auto-update
  — there's no single fixed install location for `electron-updater` to
  safely replace in-place the way it can for the installed Windows build.

## Electron security model

- `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` —
  the renderer has no Node.js access at all; it can only call the explicit,
  narrow set of functions exposed via `contextBridge` in `preload.js`.
- `webSecurity` stays enabled; `allowRunningInsecureContent` is `false`.
- Every privileged `ipcMain` handler validates that the calling frame is
  actually the app's own main window top frame before doing anything —
  this is defense-in-depth against a compromised/renavigated renderer, not
  a scenario this app expects to occur in normal use.
- `will-navigate` is blocked entirely — the renderer can never navigate away
  from the packaged local UI. `window.open()`/`target="_blank"` never
  creates a new VoxelPort-preload-capable window; it's deny-only, and an
  approved link instead opens in your default browser via
  `shell.openExternal`, and only after that URL is checked against an
  explicit `https://` + domain allowlist (`voxelport.in`, `github.com`,
  `minecraft.net`, `adoptium.net`). `file:`, `javascript:`, `data:`, `ftp:`,
  and unapproved domains are all rejected before ever reaching
  `shell.openExternal`.

## Public tunnel risks

Making a server public exposes it to the same risks any Minecraft server
exposed to the internet has — see `../relay/SECURITY.md`'s abuse model
(scanning, malicious clients, connection floods). VoxelPort's per-IP/
per-tunnel limits on the relay reduce some of this, but a determined,
distributed attacker can still probe or flood a public tunnel's assigned
port, same as it could a directly-exposed server. Normal Minecraft-server
hardening (whitelist, ops, anti-cheat) remains your responsibility as the
host, not something the relay or this app referees.

## Reporting a vulnerability

Please do not open a public GitHub issue for a security vulnerability in
this app. Report it the same way described in
[`../relay/SECURITY.md`](../relay/SECURITY.md#reporting-a-vulnerability),
including the affected component (app), reproduction steps, and the
realistic impact you believe it has.

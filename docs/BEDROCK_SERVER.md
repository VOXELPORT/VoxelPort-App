# The Bedrock Dedicated Server type

A new server type, **Bedrock Server**: Mojang's own `bedrock_server.exe`, run without Java, so that only Bedrock players (phones, consoles,
Minecraft for Windows) join it. The Electron app never had this. It is not the Geyser option (`bedrock.rs`, "Let Bedrock players join"),
which puts Bedrock players into a *Java* server; the two are separate and a server is one or the other.

Added on the branch `feat/bedrock-server`, on top of 2.0.0-beta.1.

## What a person sees

* **New server** → the type grid has *Bedrock Server*. Its one version is whatever Mojang names as current. Step 2 has no Java row and no
  memory row, the port starts at 19132 (UDP), and the terms checkbox names the Minecraft EULA and Microsoft's privacy statement (Mojang asks for
  both when you download the server).
* **Start** needs no Java: no Java check, no install, no Geyser, no voice plugin. Players show by gamertag (spaces allowed). The player
  buttons are *Kick*, *Op* and *Deop* (the Bedrock server has no ban command; its way of keeping people out is the allow-list).
* **Make public** uses the relay's one public port for both halves of a Bedrock connection (see "How players connect" below). The screen shows that
  **Server** and **Port** for Bedrock's *Play → Servers → Add Server*, and nothing else: no Java address, no second port, no custom name box. The
  invite message says the same. The first time a server is made public it restarts once by itself so it can be told that address; after that it never has to.
* **Friends only** warns when the allow-list is on but empty, because that keeps everyone out, the host included (this was found the hard way).
* **Settings**: the Bedrock server's own settings (name in the server list, game mode, difficulty, players, allow-list, cheats, what new players
  may do, view and simulation distance, seed) and the port. The groups that only a Java server has (Minecraft version, Geyser, player
  accounts, the public list, voice chat, memory) are hidden.
* **Friends only** is the server's **allow-list** (`allowlist.json` and `allow-list`), by gamertag.
* **Backups** save the world in `worlds/<level-name>` plus `allowlist.json` and `permissions.json`, while the server runs or stopped, and
  restore it the way Java backups restore (asked first, the current world saved first, undone if it fails half way).
* **Import** recognises a folder with `bedrock_server.exe` as a Bedrock server.

## Where it comes from

Mojang's download service (`net-secondary.web.minecraft-services.net/api/v1.0/download/links`) names the current Windows archive;
it is fetched from `www.minecraft.net`. Those two are the only hosts allowed, and every redirect hop is checked again. There is **no
checksum**: Mojang publishes none. What protects the download is HTTPS to those hosts, a size cap (400 MB; the real one is about 50 MB), and
the archive checks before anything is written: no path may leave the server folder (`..`, absolute, drive letter, backslash), no link is kept, no
file may already exist, and `bedrock_server.exe` must be in the archive's top folder. A failed install removes what it made (the whole folder if
it created it). Only the *current* release is offered, because Mojang lists no others and a Bedrock client must match the server.

**A lesson from the first real run:** that host's CDN never answers a request whose user-agent carries a bot-style `(+https://...)` tag (the
connection opens, then nothing comes back until the client gives up). The app's usual user-agent has such a tag, so the Bedrock download uses its own
plain `VoxelPort-App/<version>` (`bds::USER_AGENT`, with a test that keeps it plain), which is answered at once. The stand-in services could not
have shown this; only the real host did.

## How players connect (what the real server taught us)

The real server (1.26) does **not** work as a plain UDP server. Its own documentation (`bedrock_server_how_to.html`, shipped in the archive) says it uses
the **NetherNet** transport by default: a client first opens a **TCP** connection to `server-port` for an HTTP signalling handshake, then the two negotiate a
**UDP** connection that carries the game. (The older RakNet transport still exists as `transport=raknet`, but the server itself warns that players cannot
connect without NetherNet.) Two consequences:

* The relay's single public port carries both halves: the TCP signalling is forwarded to the server's local port like any connection, and the UDP goes
  through the relay's plain-UDP mode on the same port number.
* The server must be **told the public address**, or it hands clients its own PC's address and the UDP link can never form. Its documented setting is
  `server-udp-ports=<public IP>:<public port>:<local port>`. The app writes it at every start from the address remembered the last time the server was
  public (the relay's host name is turned into an IP address first), and the first time it restarts the server once, as soon as the relay names the port
  (the same trick the Geyser option uses). A server that has never been public is simply told its local port.

My first design assumed plain UDP (RakNet) and "Low ping" showed up in the game while joining failed; only the server's own documentation, read from the
installed copy, showed why. **A real Bedrock client joined through the real relay after this change** (with the allow-list off).

## How it runs

`ServerProcess::start_bedrock` runs `bedrock_server.exe` from the server folder, with no arguments and the folder as its working directory (a
plain file named exactly that is required; a link or a folder is refused). The console is read by Bedrock's own rules (`bds.rs`):
the `[2026-11-08 12:00:00:123 INFO]` front is removed, "Server started." means online, and `Player connected: <name>, xuid: <id>` /
`Player disconnected: ...` are the player lines, matched against the whole message (a name cannot fake the server saying them).
Console buttons and the allow-list send commands with the name in quotes, after the name has been checked.

**Backups of a running server** use the server's own procedure: `save hold`, then `save query` every two seconds (up to a minute) until it says
"Data saved. Files are now ready to be copied.", then the files are zipped, **each cut to the length the server reported** (so a file that grew
meanwhile is not half-copied), then `save resume`. If the server never says ready, or its answer cannot be read, the files are copied whole from
disk and the console says so. A backup is the same zip as a Java one with `"layout": "bedrock"` in its metadata, so the list, schedule, retention
and screens are shared. A Java backup and a Bedrock backup are never mixed up: each refuses the other, and a Bedrock backup may hold nothing but its
world(s), the two config files and its metadata.

## What it does not do (yet), on purpose

* **No update or version change.** Changing the version says plainly that it is not built. To move to a newer server, install a new Bedrock
  server and restore this one's backup into it.
* **No public server-list entry.** The list shows a Java address; a Bedrock server has none, so it is never listed (the toggle is hidden).
* **No custom name** (`name.voxelport.in`): names point at the Java port, and Bedrock needs a port anyway.
* No voice chat, no add-ons screen, no TPS (that is a Java number), no "why it stopped" explanations (they read Java output).
* One public port, not two. A Java server with Geyser asks the relay for a *separate* permanent Bedrock port; a Bedrock Dedicated Server uses the
  relay's ordinary public port (TCP) with the relay's plain-UDP mode on the same number, so the one address is the one to share.

## What is tested, and what is not

**By hand, on the real thing (the owner, 2026-11-08):** the real archive downloaded and installed; the real `bedrock_server.exe` started and printed the
lines the app reads (`Server started.` and the rest, seen in the console); and a real Bedrock client **joined through the real relay** on one port.

Tested automatically on the stand-in server (`vp-fake-server`, which poses as `bedrock_server.exe`) and local stand-ins for Mojang's service and the relay:
the download and install (every refusal), the start with no Java on the PATH, player lines, buttons, settings, the allow-list, live and stopped
backups with the reported lengths, restore and its refusals, the restart-once and the `server-udp-ports` line, a datagram going out through the relay and
the server's answer coming back, and the screens, driven through the real window (`tools/e2e-bedrock-server.mjs`). Mojang's real link service is
asked by an ignored test and answers with the current release.

**Not yet confirmed on the real server**: the `Player connected: <name>, xuid: <id>` / `Player disconnected` lines (the player list depends on them), the
three `save` answers a live backup waits for (`Saving...`, `Data saved. Files are now ready to be copied.` followed by `<file>:<bytes>, ...`,
`Changes to the world are resumed.`), and the *Kick/Op* and allow-list commands. Each has a safe fallback: players are simply not listed; a backup copies
whole files; a command that is not understood prints the server's own "unknown command".

## Windows notes (nothing here is changed by the app)

* The first start usually shows Windows Firewall's prompt for `bedrock_server.exe`. Allowing it is what lets players on the same network
  reach it; players through the relay do not need it.
* Minecraft for Windows on **the same PC** cannot join a server on `127.0.0.1` unless Windows is told to allow it (a loopback exemption for
  the Minecraft app, set with `CheckNetIsolation`). That is a Windows setting this app does not touch. Joining through the public address from the
  same PC, or from another device, does not need it.
* `bedrock_server.exe` needs the Microsoft Visual C++ runtime that most PCs already have. If it exits at once, that is the first thing to check.

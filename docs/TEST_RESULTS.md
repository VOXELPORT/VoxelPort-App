# Test results

Run on 2026-11-07 with `cargo test --workspace` (Rust 1.99.1, Windows 11). **85 tests, 85 passed, 0 failed**, plus a
20-check end-to-end run of the Discord gate through the real window (below). The process-manager integration tests
were also run three times in a row earlier to check for flakiness; all passed each time.

## Automated (Rust)

| Suite | Tests | What it covers |
|---|---|---|
| `voxelport-core` unit (process, Bedrock, log buffer) | 11 | Bedrock/NetherNet arguments (local, public, IPv6, bad ports and hosts); bounded log buffer (newest lines kept, cut on a character boundary); chat cannot fake a join; fixed argument list with only JVM options before `-jar`; refusal of relative folders, wrong Java names, odd jar names, bad RAM |
| `voxelport-core` integration (`tests/process.rs`, a stand-in server, no Java) | 12 | start then online on the "Done" line; graceful stop ending "stopped" with exit 0; a server that ignores `stop` is killed after the grace period and still counts as a stop; unexpected exit is a crash with its code; joins and leaves tracked in order and reset on exit; chat cannot fake a join; newline cannot smuggle a second command and the player buttons are validated; 200,000 lines of output stay bounded and the stop still completes; one 3 MB line is cut, not buffered; only one server at a time and restart after exit; a missing program is reported as a crash with a message; a refused start says why |
| `voxelport-tauri` unit | 10 | profile validation (valid, broken, optional fields, corrupt or missing store); RAM recommendation steps equal Electron's; memory read; catalog snapshot shape; only exact discord.gg invites open; backup error wording; DPAPI round trip (rejects a foreign blob) |

| `voxelport-core` unit: gate (`gate.rs`) | 12 | ported from Electron's `discordGate.test.js`: new/existing installs, grace by server time, clock set back, 7-day offline hold, rejected session, signed-out never rescued by fail-open, install record kept once |
| `voxelport-core` unit: token and backup (`identity.rs`) | 21 | ported from `token.test.js`, `identityBackup.test.js`: first run, plaintext to encrypted without changing the value, locked store never overwrites the file and comes back, no pile-up of copies, masking, the **fixed vector shared with Electron and Android**, NFC passphrases, wrong passphrase/changed blob/wrong address/odd shapes refused, passphrase rules |
| `voxelport-core` integration (`tests/account.rs`, scripted accounts service on a real socket, fake browser) | 19 | ported from `appAccount*.test.js`: sign-in with PKCE and encrypted session, second click reuses the sign-in, timeout/cancel close the port, stray requests ignored, non-member and link error pass through, refused exchange saves nothing, status refresh and outage, rejected session clears everything, config without a session, sign-out, plan/rank remembered, backup save/restore/delete and every error answer |

## Manual end-to-end, through the real window

The Tauri window was driven over the web view's debugging port, with a stand-in program named `java.exe` first on the PATH
and the debug-only account switches (see BUILD_INSTRUCTIONS.md). No Minecraft and no real world was involved.

| Check | Result |
|---|---|
| Page loads with no console errors; server list shows the seeded profile | pass |
| Clicking **Start** in the library: status goes Starting, Online; console shows the server's "Done" line | pass |
| Typing a command in the console box and **Send**: the player count rises to 1 | pass |
| Library after a page reload: "1 server, 1 running", Online (state kept in Rust) | pass |
| `playerAction('kick', 'Bob')` accepted; `playerAction('rm -rf', 'Bob')` rejected | pass |
| **Manage** then **Stop**: stopping, then stopped, exit code 0 | pass |
| A corrupt `server-profiles.json` is treated as "no servers" (found by accident when a test file lost its backslashes) | pass |
| Unported channels reject with "Not migrated to the Tauri build yet: ..." | pass |

## End-to-end: the Discord gate (`tools/e2e-gate.mjs`, 20 checks, 20 passed)

Real debug window, a stand-in accounts service that verifies PKCE, a stand-in program as `java.exe`. Covers: fresh install
blocked and asked to sign in; start refused with the Discord message; masked token and 12-character id only; **Continue
with Discord** through the loopback callback; allowed state with name, rank, plan and invite; token and session encrypted
on disk; a signed-in member starts, reaches online, and stops; short passphrase message; backup saved (this PC's own, last 4
only), wrong passphrase refused, right passphrase restores, delete; the session surviving an app restart; the gate
re-blocking when the Discord server no longer has the member; sign-out clearing the account; refusal text following the
Hinglish setting.

## Not tested

- Closing the window while a server runs (the quit handler is written; the stop-and-wait logic is covered by the core
  tests, but a real window close was not exercised).
- A real Minecraft server, real Java, Bedrock/Geyser startup.
- Server installation, backups and restore, add-ons, the relay tunnel: **not ported**, so not testable.
- The real accounts service and a real Discord sign-in (the stand-in is used; a real run needs the user's own Discord).
- Reading Electron's `safeStorage` files (different format, see MIGRATION_PLAN.md risks).
- `token:copy` and `supporterID:copy` (clipboard) are not ported yet.
- Concurrent managed processes: the product runs one server at a time, so this was not built.
- Crash recovery across an app restart and persistent services: the product has neither.
- The installer, installation behaviour, updates: **not built yet**.
- The Electron test suite (57 files) has not been ported; those tests are the specification for the remaining modules.

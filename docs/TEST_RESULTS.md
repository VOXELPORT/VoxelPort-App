# Test results

Run on 2026-11-07 with `cargo test --workspace` (Rust 1.99.1, Windows 11). **30 tests, 30 passed, 0 failed.** The core
integration tests were also run three times in a row to check for flakiness; all passed each time.

## Automated (Rust)

| Suite | Tests | What it covers |
|---|---|---|
| `voxelport-core` unit | 11 | Bedrock/NetherNet arguments (local, public, IPv6, bad ports and hosts); bounded log buffer (newest lines kept, cut on a character boundary); chat cannot fake a join; fixed argument list with only JVM options before `-jar`; refusal of relative folders, wrong Java names, odd jar names, bad RAM |
| `voxelport-core` integration (`tests/process.rs`, a stand-in server, no Java) | 12 | start then online on the "Done" line; graceful stop ending "stopped" with exit 0; a server that ignores `stop` is killed after the grace period and still counts as a stop; unexpected exit is a crash with its code; joins and leaves tracked in order and reset on exit; chat cannot fake a join; newline cannot smuggle a second command and the player buttons are validated; 200,000 lines of output stay bounded and the stop still completes; one 3 MB line is cut, not buffered; only one server at a time and restart after exit; a missing program is reported as a crash with a message; a refused start says why |
| `voxelport-tauri` unit | 7 | profile validation (valid, broken, optional fields, corrupt or missing store); RAM recommendation steps equal Electron's; memory read; catalog snapshot shape |

## Manual end-to-end, through the real window

The Tauri window was driven over the web view's debugging port, with a stand-in program named `java.exe` first on the PATH
and `VOXELPORT_DEV_ALLOW_START=1`. No Minecraft and no real world was involved.

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
| Starting is refused without `VOXELPORT_DEV_ALLOW_START=1` | pass (checked in code and by the error text; the gate path was not run as a separate test) |

## Not tested

- Closing the window while a server runs (the quit handler is written; the stop-and-wait logic is covered by the core
  tests, but a real window close was not exercised).
- A real Minecraft server, real Java, Bedrock/Geyser startup.
- Server installation, backups and restore, add-ons, the relay tunnel, accounts: **not ported**, so not testable.
- Concurrent managed processes: the product runs one server at a time, so this was not built.
- Crash recovery across an app restart and persistent services: the product has neither.
- The installer, installation behaviour, updates: **not built yet**.
- The Electron test suite (57 files) has not been ported; those tests are the specification for the remaining modules.

# Desktop: auto-sleep with wake-on-join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the desktop app stop a profile's server when nobody has played for a while, keep the tunnel (and public address) alive while asleep, and start the server again when the relay reports someone tried to join.

**Architecture:** A `SleepSettings` struct in `voxelport-core`, stored per-profile exactly like `BackupSettings`. A `SleepSchedule` (new, in `voxelport-core`) ticks on a `tokio::time::interval`, watches `ServerProcess::online_names()`/`status()`, and calls a stop callback once idle long enough. Two new outgoing `Tunnel` methods (`mark_asleep`/`mark_awake`) send the relay's new `asleep`/`awake` messages; a new `TunnelEvent::WakeRequested` fires when the relay's `wake` message arrives. `main.rs`'s `AppState` wires `SleepSchedule`'s stop callback to call `tunnel.mark_asleep()` then the existing stop path, and wires `TunnelEvent::WakeRequested` to a rate-limited restart.

**Tech Stack:** Rust, Tokio, the existing `voxelport-core`/`src-tauri` split; tests with `cargo test` in `voxelport-core` (pure logic, no Tauri runtime needed) for everything except the final app-level wiring, which is verified by hand (no UI test harness exists in this repo for Tauri screens, matching how every other screen in this app has shipped).

**Spec:** `../../relay/docs/superpowers/specs/2026-11-27-auto-sleep-wake-design.md` (cross-repo; this plan implements its desktop-app half once the relay plan at `../../relay/docs/superpowers/plans/2026-11-27-relay-sleep-wake.md` has shipped the `asleep`/`awake`/`wake` messages this plan sends and receives)

## Global Constraints

- `SleepSettings` mirrors `BackupSettings`'s exact shape and conventions (a `(bool, i64, i64)`-style `DEFAULTS`/range tuple, `to_json`/parse-from-profile/validate functions) — see `backups.rs` lines 31-33, 136-178 for the pattern to copy.
- Default: off, 20-minute idle. Range for the idle minutes: reuse `INTERVAL_RANGE`-style bounds but call it `IDLE_RANGE = (5, 360)` (5 min to 6 hours) — wider top end than backups' interval since "how long before sleeping" has different sensible limits than "how often to back up."
- `Tunnel::mark_asleep`/`mark_awake` are plain `send_cmd(Cmd::Send(json!({"type": "..."})))` calls, matching `claim_name`/`release_name` exactly (`tunnel.rs` lines 307-312) — no new `Cmd` variant needed.
- The relay's `wake` message carries no fields beyond `"type"`; `is_valid_relay_message`'s fallback `_ => true` already accepts any unknown-but-unvalidated type, so `"wake"` needs no new validation arm unless the plan wants one for documentation's sake (Task 2 adds one for clarity, matching how every other known type gets an explicit arm even when it would pass by default).
- Starting the server from the wake handler must discard `Err(StartError::AlreadyRunning)` silently (never surface it to the UI as a failure) — this is the resolved race from the design doc's Review Focus #1, not a new guard.
- Re-asserting sleep state after every registration (the `"port"` message handler) follows the exact precedent already in `tunnel.rs` lines 619-622 (re-sending `listing` after every `"port"`).

## Review Focus

- A `SleepSchedule` tick must read `ServerProcess::online_names()` fresh every tick, not cache it — a player joining mid-sleep-countdown must reset the idle timer the same tick it's observed, exactly like Android's `SleepSchedule.tick()` test `a player joining resets the idle clock, and leaving starts it again`.
- `mark_asleep()` must be sent before `ServerProcess::stop()` is called, not after — if the app crashes between the two, the relay is left correctly believing the tunnel is asleep (matching reality: the server really is about to stop) rather than the reverse case where a crash leaves the relay thinking a server is awake when it is actually stopped and unreachable.
- The wake handler's rate limit (one `start()` attempt per 60 seconds per sleep cycle, per the design doc) must reset when the server successfully reaches `Status::Online` or when the owner manually starts it — not tied to wall-clock time alone, so a server that wakes, plays for a while, and sleeps again gets a fresh rate-limit window next time, rather than inheriting a stale timer from hours earlier.
- Turning the auto-sleep setting off while the server is already asleep must not itself start the server (design doc's Review Focus #5) — the setting only gates whether `SleepSchedule` puts the server to sleep *again* in the future.
- A `WakeRequested` event arriving while `SleepSchedule`'s own settings say auto-sleep is now *off* (the owner disabled it between sleeping and the wake arriving) must still wake the server — a player is actually waiting; the setting is about whether to sleep, not about whether to answer a real knock at the door.

---

### Task 1: `SleepSettings` — per-profile idle-sleep settings

**Files:**
- Modify: `crates/voxelport-core/src/backups.rs` is NOT touched; create a new module instead.
- Create: `crates/voxelport-core/src/sleep.rs`
- Modify: `crates/voxelport-core/src/lib.rs` (add `pub mod sleep;`)
- Test: inline `#[cfg(test)]` module in `sleep.rs`, matching how `backups.rs` and `server_process.rs` structure their own tests (check either file's bottom for the exact `mod tests` convention before writing).

**Interfaces:**
- Produces: `SleepSettings { auto: bool, idle_min: i64 }`, `SleepSettings::to_json(self) -> Value`, `sleep_settings(profile: &Value) -> SleepSettings`, `validate_sleep_settings(input: &Value) -> Result<serde_json::Map<String, Value>, String>`, `pub const DEFAULTS: (bool, i64) = (false, 20);`, `pub const IDLE_RANGE: (i64, i64) = (5, 360);` — all in `sleep.rs`, same names/shapes as `backups.rs`'s equivalents so Task 4's `src-tauri` wiring reads identically to `backupservice.rs::set_settings`.
- Consumes: nothing new (reads a profile `Value` the same way `backup_settings` does).

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_are_off_and_twenty_minutes() {
        let s = sleep_settings(&json!({}));
        assert_eq!(s, SleepSettings { auto: false, idle_min: 20 });
    }

    #[test]
    fn stored_settings_are_used_and_out_of_range_falls_back() {
        let s = sleep_settings(&json!({ "sleep": { "auto": true, "idleMin": 30 } }));
        assert_eq!(s, SleepSettings { auto: true, idle_min: 30 });
        let s = sleep_settings(&json!({ "sleep": { "auto": "yes", "idleMin": 1 } }));
        assert_eq!(s, SleepSettings { auto: false, idle_min: 20 });
    }

    #[test]
    fn to_json_round_trips_through_sleep_settings() {
        let s = SleepSettings { auto: true, idle_min: 10 };
        let back = sleep_settings(&json!({ "sleep": s.to_json() }));
        assert_eq!(back, s);
    }

    #[test]
    fn validate_rejects_non_bool_auto_and_out_of_range_idle() {
        assert!(validate_sleep_settings(&json!({ "auto": "nope" })).is_err());
        assert!(validate_sleep_settings(&json!({ "idleMin": 1 })).is_err());
        assert!(validate_sleep_settings(&json!({ "idleMin": 999 })).is_err());
    }

    #[test]
    fn validate_only_returns_fields_that_were_present() {
        let out = validate_sleep_settings(&json!({ "auto": true })).unwrap();
        assert!(out.contains_key("auto") && !out.contains_key("idleMin"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p voxelport-core sleep::`
Expected: FAIL to compile — `sleep` module does not exist.

- [ ] **Step 3: Implement `sleep.rs`**

Copy `backups.rs`'s `BackupSettings`/`backup_settings`/`validate_backup_settings` shape exactly (lines 136-178), renaming `interval_min`/`intervalMin`/`"Minutes between backups"` to `idle_min`/`idleMin`/`"Minutes idle before sleeping"`, dropping the `keep` field entirely (sleep has only two settings), and using `DEFAULTS`/`IDLE_RANGE` as named above. Store under the profile key `"sleep"` (so `sleep_settings` reads `&profile["sleep"]`), matching how `backup_settings` reads `&profile["backups"]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p voxelport-core sleep::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/voxelport-core/src/sleep.rs crates/voxelport-core/src/lib.rs
git commit -m "Add per-profile auto-sleep settings"
```

---

### Task 2: Relay protocol — `mark_asleep`/`mark_awake`/`WakeRequested`

**Files:**
- Modify: `crates/voxelport-core/src/tunnel.rs`
- Test: inline in `tunnel.rs` (check its existing `#[cfg(test)]` module, referenced by the `ok(json!({...}))` calls seen near line 1012, for the exact test harness already in this file — likely a fake-relay or direct `is_valid_relay_message`/message-dispatch unit test, not a full session integration test; follow whatever pattern is already there rather than inventing a new one).

**Interfaces:**
- Produces: `Tunnel::mark_asleep(&self)`, `Tunnel::mark_awake(&self)` (both `pub fn`, same shape as `claim_name`/`release_name`); `TunnelEvent::WakeRequested` (new variant).
- Consumes: Task 1's module not needed here — this task is pure protocol plumbing, independent of settings.

- [ ] **Step 1: Write the failing tests**

First read how `tunnel.rs`'s existing tests near line 1012 (the `ok(json!(...))` calls) are structured — they appear to call `is_valid_relay_message` directly without a live session. Write tests in that same style:

```rust
#[test]
fn wake_message_is_a_known_valid_type() {
    assert!(is_valid_relay_message(&json!({ "type": "wake" })));
}
```

If `tunnel.rs` also has session-level tests that dispatch a message through `Session::on_message` and assert on the emitted `TunnelEvent` (check for a test harness around `on_message` before assuming one doesn't exist — the file is 1052 lines and may have more below what was read), add an equivalent test there asserting a `"wake"` message produces `TunnelEvent::WakeRequested`. If no such harness exists for any other message type, matching the file's own precedent means testing only through `is_valid_relay_message` here, and relying on Task 4's app-level manual verification (plus Task 5's cross-app integration test) for the end-to-end dispatch — ledger this choice either way rather than inventing a new test harness class for one message type.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p voxelport-core tunnel::`
Expected: FAIL — `wake` is not an explicit arm, so it currently falls through `_ => true` and technically already "passes" `is_valid_relay_message`; if so, this specific test may already be green. If it is already green, note that in the ledger as a pre-existing pass, not a bug, and move straight to the `WakeRequested` dispatch test (which will fail: the variant and the `match ty` arm do not exist).

- [ ] **Step 3: Implement**

In `TunnelEvent` (line ~147): add `WakeRequested,` as a new variant (no fields).

In `Tunnel`'s `impl` block, next to `claim_name`/`release_name` (line ~307): add
```rust
pub fn mark_asleep(&self) {
    self.send_cmd(Cmd::Send(json!({ "type": "asleep" })));
}

pub fn mark_awake(&self) {
    self.send_cmd(Cmd::Send(json!({ "type": "awake" })));
}
```

In `is_valid_relay_message`'s `match ty` (line ~123): add `"wake" => true,` as an explicit arm (documents it as a known type even though the fallback already accepted it — matches every other known type having its own arm).

In `Session::on_message`'s `match ty` (line ~594, next to `"name_error"`/`"listing_error"`): add `"wake" => self.emit(TunnelEvent::WakeRequested),`.

Also implement the design's reconnect re-assertion: in the `"port"` arm (line ~595-623, right after the existing `listing` re-send block), the `Session` needs to know the app's current "should I be asleep" state to resend it. Since `Session` does not currently hold that, add a field to `StartParams` (line ~167): `pub sleep_asleep_at_start: Arc<std::sync::atomic::AtomicBool>` — a shared flag the app sets whenever it calls `mark_asleep`/`mark_awake` locally (Task 4 wires the actual setting), read once in the `"port"` handler right after the `listing` re-send: `if self.p.sleep_asleep_at_start.load(Ordering::SeqCst) { self.send_json(&json!({ "type": "asleep" })); }`. This keeps the re-assertion inside the existing reconnect path (every `"port"` message is the result of a fresh `register`, reconnect included) without `Tunnel` needing a new public getter that duplicates state already tracked at the app level.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p voxelport-core tunnel::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/voxelport-core/src/tunnel.rs
git commit -m "Add mark_asleep/mark_awake and a WakeRequested event to the tunnel client"
```

---

### Task 3: `SleepSchedule` — the idle timer

**Files:**
- Create: add to `crates/voxelport-core/src/sleep.rs` (same file as Task 1 — it is the natural home for both the settings and the schedule that uses them, matching how `backups.rs` holds both `BackupSettings` and the backup-worthiness logic together)
- Test: same inline `#[cfg(test)]` module as Task 1.

**Interfaces:**
- Consumes: `ServerProcess::online_names() -> Vec<String>`, `ServerProcess::status() -> Status` (both already exist, `server_process.rs`), `SleepSettings` (Task 1).
- Produces: `SleepSchedule::new(settings: impl Fn() -> SleepSettings + Send + Sync + 'static, stop: impl Fn() + Send + Sync + 'static) -> SleepSchedule`, `SleepSchedule::tick(&mut self, online: &[String], ready: bool, now_ms: i64)`, `SleepSchedule::start(self, server: ServerProcess, interval: Duration)` (spawns the `tokio::time::interval` loop; kept separate from `tick` so `tick` itself stays a plain, synchronously-testable function exactly like Android's `SleepSchedule.tick()`).

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn does_nothing_while_turned_off() {
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: false, idle_min: 10 }, move || { s2.fetch_add(1, std::sync::atomic::Ordering::SeqCst); });
    sched.tick(&[], true, 0);
    sched.tick(&[], true, 60 * 60_000);
    assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn sleeps_once_idle_for_the_setting_counting_from_readiness() {
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: true, idle_min: 10 }, move || { s2.fetch_add(1, std::sync::atomic::Ordering::SeqCst); });
    sched.tick(&[], true, 1_000_000); // readiness noticed: idle clock starts here
    sched.tick(&[], true, 1_000_000 + 9 * 60_000);
    assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0);
    sched.tick(&[], true, 1_000_000 + 11 * 60_000);
    assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn a_player_resets_the_idle_clock_and_leaving_starts_it_again() {
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: true, idle_min: 10 }, move || { s2.fetch_add(1, std::sync::atomic::Ordering::SeqCst); });
    sched.tick(&[], true, 0);
    sched.tick(&["Steve".to_string()], true, 8 * 60_000);
    sched.tick(&["Steve".to_string()], true, 17 * 60_000);
    assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0, "someone is still on");
    sched.tick(&[], true, 18 * 60_000); // left: idle clock restarts from here
    sched.tick(&[], true, 27 * 60_000);
    assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0, "not idle long enough since the leave");
    sched.tick(&[], true, 29 * 60_000);
    assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn only_sleeps_once_per_readiness_never_stopping_twice_in_a_row() {
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: true, idle_min: 10 }, move || { s2.fetch_add(1, std::sync::atomic::Ordering::SeqCst); });
    sched.tick(&[], true, 0);
    sched.tick(&[], true, 11 * 60_000);
    sched.tick(&[], true, 12 * 60_000);
    sched.tick(&[], true, 13 * 60_000);
    assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn does_nothing_before_the_server_is_ready() {
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: true, idle_min: 10 }, move || { s2.fetch_add(1, std::sync::atomic::Ordering::SeqCst); });
    sched.tick(&[], false, 0);
    sched.tick(&[], false, 60 * 60_000);
    assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0);
}
```

(These mirror Android's `SleepScheduleTest` one-for-one, including the test names' intent — see `VoxelPort-Android/app/src/test/java/com/voxelport/android/SleepTest.kt`'s `SleepScheduleTest` class for the exact behavior being pinned, translated from "console log text + file-based ready check" to "an explicit `online` slice + `ready` bool", since the Rust side already has structured player names and status via `ServerProcess` rather than needing to parse a log file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p voxelport-core sleep::`
Expected: FAIL to compile — `SleepSchedule` does not exist.

- [ ] **Step 3: Implement `SleepSchedule`**

```rust
pub struct SleepSchedule<S, F> {
    settings: S,
    stop: F,
    last_occupied_ms: Option<i64>,
    asleep: bool,
}

impl<S: Fn() -> SleepSettings, F: Fn()> SleepSchedule<S, F> {
    pub fn new(settings: S, stop: F) -> Self {
        Self { settings, stop, last_occupied_ms: None, asleep: false }
    }

    pub fn tick(&mut self, online: &[String], ready: bool, now_ms: i64) {
        if !ready || self.asleep {
            return;
        }
        let last = *self.last_occupied_ms.get_or_insert(now_ms);
        if !online.is_empty() {
            self.last_occupied_ms = Some(now_ms);
            return;
        }
        let settings = (self.settings)();
        if settings.auto && now_ms - last >= settings.idle_min * 60_000 {
            self.asleep = true;
            (self.stop)();
        }
    }

    /// Call once the server is confirmed running again (manual start or a successful wake), so the next sleep cycle starts fresh.
    pub fn reset(&mut self) {
        self.asleep = false;
        self.last_occupied_ms = None;
    }
}
```

Match this against the five tests above exactly; adjust only if a test's expected numbers disagree with this sketch (the sketch is a starting point, the tests are the spec).

A separate `start(self, server: ServerProcess, events: &mut EventReceiver, interval: Duration)` async method (or a free function taking the same pieces) spawns a `tokio::time::interval(interval)` loop calling `tick(&server.online_names(), server.status() != Status::Stopped, now_ms())` — this part is wired for real in Task 4, not unit-tested here (it is a thin loop around the already-tested `tick`, matching how Android's `SleepSchedule.start()` thread is not itself unit-tested, only `tick()` is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p voxelport-core sleep::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/voxelport-core/src/sleep.rs
git commit -m "Add SleepSchedule: the idle timer that decides when to sleep"
```

---

### Task 4: App wiring — sleep on idle, wake on join, Settings UI

**Files:**
- Modify: `src-tauri/src/main.rs` (spawn the schedule; `AppState` needs a way to reach the active profile's `SleepSchedule`/settings and the active `Tunnel`)
- Modify: `src-tauri/src/tunnelsetup.rs` (wherever `TunnelEvent`s are consumed today — find the existing match over `TunnelEvent` the app already has, next to `Assigned`/`Players`/etc., and add `WakeRequested`)
- Modify: `src-tauri/src/backupservice.rs` or a new `sleepservice.rs` (a `get_settings`/`set_settings` pair mirroring `backupservice.rs::set_settings` exactly, using Task 1's `sleep_settings`/`validate_sleep_settings`)
- Modify: whichever frontend settings screen/page already renders the backup-settings panel (find it by searching the webview source for `backups.*settings` or the `set_settings`/`get_settings` Tauri command names) and add an "Auto-sleep" panel next to it, matching Android's wording/choices (10/20/30/60 min).
- Test: this task is app-level Tauri wiring with no existing test harness for screens or `main.rs` wiring in this repo (confirmed by Task 2's note that no session-level test harness was found either) — verified by manual run per the Completion Contract below, not `cargo test`. The settings validate/parse logic itself is already fully covered by Task 1's tests; this task adds no new pure logic worth a unit test beyond what Tasks 1 and 3 already cover.

**Interfaces:**
- Consumes: Task 1 (`SleepSettings`, `sleep_settings`, `validate_sleep_settings`), Task 2 (`Tunnel::mark_asleep`/`mark_awake`, `TunnelEvent::WakeRequested`), Task 3 (`SleepSchedule`).

- [ ] **Step 1: Find the existing `TunnelEvent` consumer**

Read `src-tauri/src/tunnelsetup.rs` in full to find where `TunnelEvent::Players`/`Assigned`/etc. are already matched and acted on (likely a spawned task reading from the `UnboundedReceiver<TunnelEvent>` returned by `Tunnel::new()`, given `main.rs` line 338 shows `let (tunnel, rx) = Tunnel::new();`). This is the one place `WakeRequested` needs a new arm.

- [ ] **Step 2: Wire sleeping**

Spawn one `SleepSchedule` per active profile's server/tunnel pair (wherever the app already pairs a `ServerProcess` with its `Tunnel` for a profile — likely the same place `tunnelsetup.rs` or `serverconfig`-equivalent code starts a server). Its `stop` callback: call `tunnel.mark_asleep()` first, then the exact same stop path the manual "Stop" button already calls (find and reuse it — do not duplicate the stop logic, per the design's anti-goal against parallel code paths).

- [ ] **Step 3: Wire waking**

In the `TunnelEvent::WakeRequested` arm found in Step 1: call the server's start function (the same one the "Start" button calls) and discard `Err(StartError::AlreadyRunning)` without surfacing it as a failure (per Global Constraints). Rate-limit: track the last wake-triggered start attempt's timestamp (a simple `Mutex<Option<Instant>>` or `AtomicI64` alongside wherever the `SleepSchedule` instance itself lives) and skip starting again if less than 60 seconds have passed since the last attempt from this cycle; reset that timestamp whenever `Status::Online` is reached or a manual Start happens (per Review Focus). Once the server reaches `Status::Online` after this start, call `tunnel.mark_awake()` and `sleep_schedule.reset()`.

- [ ] **Step 4: Settings UI**

Add a `get_settings`/`set_settings` Tauri command pair (or extend the existing backup one's module) exposing Task 1's `sleep_settings`/`validate_sleep_settings`/`to_json`, and a small panel in the frontend mirroring Android's exact copy: a toggle "Stop when nobody is playing", and a 10/20/30/60-minute choice shown only when on, with the same explanatory line Android uses ("Saves battery... it does not start itself back up when a friend tries to join." — **note this line must now be corrected for desktop, since desktop DOES wake on join**: use "Saves power on a PC nobody is using. A friend trying to join wakes it back up automatically." instead).

- [ ] **Step 5: Completion check (manual, no automated test exists for this layer)**

Run the app (`cargo tauri dev` or the repo's existing dev-run command), with a real or test Minecraft server profile:
1. Turn on auto-sleep at the shortest idle (5 min, if settings UI allows the range's minimum, else temporarily lower `IDLE_RANGE`'s minimum for this manual check only, reverting before commit).
2. Start the server, let it go idle, confirm it stops itself after the set time and the tunnel/address stays listed as online in the app (not torn down).
3. From a second machine or a Minecraft client, attempt to join the public address while asleep; confirm a disconnect message appears (the relay's wake-up text) and the server starts itself.
4. Confirm `mark_awake` happens (join succeeds on a retry once the server is `Online`).
Record the outcome of this manual check in the plan's ledger; do not mark the task complete without having actually run it once against a real relay (the one the relay plan deployed its build to, or a local relay instance).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/tunnelsetup.rs src-tauri/src/backupservice.rs
git commit -m "Wire auto-sleep and wake-on-join into the app, with a Settings panel"
```
(adjust the file list to whatever Steps 1-4 actually touched, including the frontend file)

---

### Task 5: Cross-repo verification

**Files:** none (verification only)

- [ ] **Step 1: Build the relay from the Task-1-through-2 commits of the relay plan (already shipped, per this plan's dependency note) and run it locally or point at the deployed build.**
- [ ] **Step 2: Run the manual check from Task 4 Step 5 against that real relay**, confirming the full loop: idle → sleep → tunnel stays up → player join attempt → disconnect message → wake → server starts → `mark_awake` → retry succeeds.
- [ ] **Step 3: Record the result in the plan's ledger.** If anything in the loop breaks, use systematic-debugging against whichever side (relay or app) is at fault — do not patch around it with a workaround in the other repo.

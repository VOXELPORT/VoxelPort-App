//! Web control, the app's side. The accounts service holds the buttons friends press; this asks it for them (a long
//! poll, because this PC cannot be reached from the internet), runs only the four allowed actions through the same
//! code as the app's own buttons, and sends back a cleaned picture of the server so the web page can show it.
//!
//! Nothing here knows about windows or the Tauri shell: the shell hands in a [`Link`] (how to reach the accounts
//! service) and an [`Actions`] (what the four buttons do), which keeps the rules testable on their own.
//!
//! One thing differs from the Electron app on purpose: the service holds a poll open for up to 25 seconds, so the
//! poll request here waits [`POLL_TIMEOUT`] (35 s). Electron's 15 s limit would end an idle poll as an "error" every time.

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::account::ApiReply;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub const ACTIONS: [&str; 4] = ["start", "stop", "restart", "kick"];
const MAX_LINES: usize = 100;
const MAX_LINE: usize = 200;
const MAX_PLAYERS: usize = 100;
const REPORT_WATCHED: Duration = Duration::from_secs(5);
const REPORT_IDLE: Duration = Duration::from_secs(30);
/// The service holds a poll open for up to 25 s; this must be longer.
pub const POLL_TIMEOUT: Duration = Duration::from_secs(35);
pub const REPORT_TIMEOUT: Duration = Duration::from_secs(15);
const PERK_OFF_WAIT: Duration = Duration::from_secs(30);
const MIN_POLL_GAP: Duration = Duration::from_secs(1);
const REMEMBERED_COMMANDS: usize = 500;

/// A Minecraft account name: what a kick may name.
pub fn is_player_name(s: &str) -> bool {
    (1..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

struct Patterns {
    ipv4: Regex,
    ipv6_full: Regex,
    ipv6_short: Regex,
    ffff: Regex,
    win_user: Regex,
    unix_user: Regex,
    token: Regex,
    hex_run: Regex,
    long_run: Regex,
    ansi: Regex,
    control: Regex,
    uuid: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        ipv4: Regex::new(r"/?\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b").unwrap(),
        ipv6_full: Regex::new(r"\[?\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b\]?(?::\d{1,5})?").unwrap(),
        // Only addresses written with "::" are matched, so times such as 12:07:00 are left alone. Rust's regex has no
        // look-ahead, so the character after the address is checked by hand (see `scrub_short_ipv6`).
        ipv6_short: Regex::new(r"(\[?(?:[A-Fa-f0-9]{1,4}:){0,6}:(?::?[A-Fa-f0-9]{1,4}){0,6})(\]?(?::\d{1,5})?)").unwrap(),
        ffff: Regex::new(r"(?i)::ffff:\[ip\]").unwrap(),
        // The computer's user name shows up in file paths; friends have no need to see it.
        win_user: Regex::new(r"(?i)([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s]+").unwrap(),
        unix_user: Regex::new(r"(/(?:home|Users)/)[^/\s]+").unwrap(),
        token: Regex::new(r"\bvp_[A-Za-z0-9_-]{6,}").unwrap(),
        hex_run: Regex::new(r"\b[A-Fa-f0-9]{24,}\b").unwrap(),
        long_run: Regex::new(r"[A-Za-z0-9+/_-]{32,}={0,2}").unwrap(),
        ansi: Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap(),
        control: Regex::new(r"[\x00-\x08\x0b-\x1f\x7f]").unwrap(),
        uuid: Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap(),
    })
}

fn scrub_short_ipv6(s: &str, p: &Patterns) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    for caps in p.ipv6_short.captures_iter(s) {
        let whole = caps.get(0).unwrap();
        let addr = caps.get(1).unwrap();
        let after = s[addr.end()..].chars().next();
        let boundary = after.map_or(true, |c| c.is_whitespace() || matches!(c, ']' | '/' | ',' | ';' | ')'));
        if addr.as_str().contains("::") && boundary {
            out.push_str(&s[last..whole.start()]);
            out.push_str("[ip]");
            last = whole.end();
        }
    }
    out.push_str(&s[last..]);
    out
}

fn cut_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// What may leave this PC: no addresses, no secrets, at most 100 short lines (the newest).
pub fn clean_lines(lines: &[String]) -> Vec<String> {
    let p = patterns();
    let start = lines.len().saturating_sub(MAX_LINES);
    lines[start..]
        .iter()
        .map(|line| {
            let s = p.ansi.replace_all(line, "");
            let s = p.control.replace_all(&s, "");
            let s = p.win_user.replace_all(&s, "${1}[user]");
            let s = p.unix_user.replace_all(&s, "${1}[user]");
            let s = p.ipv4.replace_all(&s, "[ip]");
            let s = p.ffff.replace_all(&s, "[ip]");
            let s = p.ipv6_full.replace_all(&s, "[ip]");
            let s = scrub_short_ipv6(&s, p);
            let s = p.token.replace_all(&s, "[secret]");
            let s = p.hex_run.replace_all(&s, "[secret]");
            let s = p.long_run.replace_all(&s, |c: &regex::Captures| if p.uuid.is_match(&c[0]) { c[0].to_string() } else { "[secret]".to_string() });
            cut_chars(&s, MAX_LINE)
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub id: i64,
    pub action: String,
    pub arg: Option<String>,
}

/// A command from the service, or `None` if it is anything other than one of the four allowed actions.
pub fn parse_command(raw: &Value) -> Option<Command> {
    let id = raw.get("id")?.as_i64().filter(|i| *i > 0)?;
    let action = raw.get("action")?.as_str().filter(|a| ACTIONS.contains(a))?;
    if action != "kick" {
        return Some(Command { id, action: action.to_string(), arg: None });
    }
    let name = raw.get("arg")?.as_str().filter(|n| is_player_name(n))?;
    Some(Command { id, action: "kick".into(), arg: Some(name.to_string()) })
}

/// Waits after the 1st, 2nd, 3rd... error in a row: 2 s doubling up to a minute.
pub fn backoff(errors: u32) -> Duration {
    let n = errors.max(1) - 1;
    Duration::from_millis((2000u64.saturating_mul(1u64 << n.min(10))).min(60_000))
}

/// The answer of one of the four actions.
pub struct Outcome {
    pub ok: bool,
    /// The message when it worked, the error when it did not.
    pub message: String,
}

impl Outcome {
    pub fn ok(message: &str) -> Self {
        Self { ok: true, message: message.into() }
    }
    pub fn err(message: &str) -> Self {
        Self { ok: false, message: message.into() }
    }
}

/// What the web page may be shown about the server.
#[derive(Default)]
pub struct Report {
    /// One of online, starting, stopping, stopped, crashed.
    pub status: String,
    pub players: Vec<String>,
    pub lines: Vec<String>,
}

pub trait Link: Send + Sync {
    /// A signed-in call to the accounts service. `status` 0 = unreachable, 401 = the session is gone.
    fn request(&self, method: &'static str, path: String, body: Option<Value>, timeout: Duration) -> BoxFut<'_, ApiReply>;
}

pub trait Actions: Send + Sync {
    fn run<'a>(&'a self, action: &'a str, arg: Option<&'a str>) -> BoxFut<'a, Outcome>;
    fn report(&self) -> Report;
    /// False when nobody is signed in or the account is not in the Discord server.
    fn is_allowed(&self) -> bool;
    /// The 12-character id the service knows this PC by; empty when there is none yet.
    fn vp_id(&self) -> String;
    fn on_event(&self, action: &str, arg: Option<&str>, ok: bool);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Ok,
    Error,
    Blocked,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Snapshot {
    pub running: bool,
    pub watching: bool,
    /// False once the service says the owner is not Supporter+ (web control is a Supporter+ perk).
    pub perk: Option<bool>,
    pub last_ok_ms: Option<i64>,
}

#[derive(Default)]
struct State {
    watching: bool,
    perk: Option<bool>,
    last_ok_ms: Option<i64>,
    executed: HashSet<i64>,
    order: VecDeque<i64>,
}

pub struct RemoteControl {
    link: Arc<dyn Link>,
    actions: Arc<dyn Actions>,
    stopped: AtomicBool,
    wake: Notify,
    state: Mutex<State>,
    now_ms: fn() -> i64,
}

fn system_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl RemoteControl {
    pub fn new(link: Arc<dyn Link>, actions: Arc<dyn Actions>) -> Arc<Self> {
        // Running from the start: a `stop()` that comes before `run()` gets going must still win (a second `sync` could otherwise be revived by it).
        Arc::new(Self { link, actions, stopped: AtomicBool::new(false), wake: Notify::new(), state: Mutex::new(State::default()), now_ms: system_now })
    }

    pub fn snapshot(&self) -> Snapshot {
        let s = self.state.lock().unwrap();
        Snapshot { running: !self.stopped.load(Ordering::SeqCst), watching: s.watching, perk: s.perk, last_ok_ms: s.last_ok_ms }
    }

    fn gate(&self) -> bool {
        self.stopped.load(Ordering::SeqCst) || !self.actions.is_allowed() || self.actions.vp_id().is_empty()
    }

    async fn send(&self, method: &'static str, path: String, body: Option<Value>, timeout: Duration) -> ApiReply {
        self.link.request(method, path, body, timeout).await
    }

    async fn run_command(&self, cmd: &Command) {
        {
            let mut s = self.state.lock().unwrap();
            if !s.executed.insert(cmd.id) {
                return;
            }
            s.order.push_back(cmd.id);
            if s.order.len() > REMEMBERED_COMMANDS {
                if let Some(old) = s.order.pop_front() {
                    s.executed.remove(&old);
                }
            }
        }
        let outcome = self.actions.run(&cmd.action, cmd.arg.as_deref()).await;
        let message = cut_chars(&outcome.message, 200);
        let message = if message.is_empty() { (if outcome.ok { "Done" } else { "Failed" }).to_string() } else { message };
        let body = json!({ "vp": self.actions.vp_id(), "id": cmd.id, "ok": outcome.ok, "message": message });
        self.send("POST", "/api/app/control/result".into(), Some(body), REPORT_TIMEOUT).await;
        self.actions.on_event(&cmd.action, cmd.arg.as_deref(), outcome.ok);
    }

    /// One long poll.
    pub async fn poll_once(&self) -> Step {
        if self.gate() {
            return Step::Blocked;
        }
        let vp = self.actions.vp_id();
        let res = self.send("GET", format!("/api/app/control/poll?vp={}", url_encode(&vp)), None, POLL_TIMEOUT).await;
        if res.status == 401 {
            return Step::Blocked;
        }
        if !res.ok {
            return Step::Error;
        }
        {
            let mut s = self.state.lock().unwrap();
            s.last_ok_ms = Some((self.now_ms)());
            if let Some(w) = res.json["watching"].as_bool() {
                s.watching = w;
            }
            if let Some(p) = res.json["perk"].as_bool() {
                s.perk = Some(p);
            }
        }
        if let Some(list) = res.json["commands"].as_array() {
            for raw in list {
                if self.gate() {
                    return Step::Blocked;
                }
                match parse_command(raw) {
                    Some(cmd) => self.run_command(&cmd).await,
                    None => {
                        if let Some(id) = raw.get("id").and_then(Value::as_i64).filter(|i| *i > 0) {
                            let body = json!({ "vp": self.actions.vp_id(), "id": id, "ok": false, "message": "Not allowed" });
                            self.send("POST", "/api/app/control/result".into(), Some(body), REPORT_TIMEOUT).await;
                        }
                    }
                }
            }
        }
        Step::Ok
    }

    /// One report of the server's state.
    pub async fn report_once(&self) -> Step {
        if self.gate() {
            return Step::Blocked;
        }
        let r = self.actions.report();
        let players: Vec<&String> = r.players.iter().filter(|p| is_player_name(p)).take(MAX_PLAYERS).collect();
        let body = json!({ "vp": self.actions.vp_id(), "status": r.status, "players": players, "lines": clean_lines(&r.lines) });
        let res = self.send("POST", "/api/app/control/report".into(), Some(body), REPORT_TIMEOUT).await;
        if res.status == 401 {
            return Step::Blocked;
        }
        if !res.ok {
            return Step::Error;
        }
        let mut s = self.state.lock().unwrap();
        s.last_ok_ms = Some((self.now_ms)());
        if let Some(w) = res.json["watching"].as_bool() {
            s.watching = w;
        }
        Step::Ok
    }

    /// Sleeps, unless `stop()` wakes it early.
    async fn sleep(&self, d: Duration) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(d) => {}
            _ = self.wake.notified() => {}
        }
    }

    async fn poll_loop(&self) {
        let mut errors = 0u32;
        while !self.stopped.load(Ordering::SeqCst) {
            let began = tokio::time::Instant::now();
            match self.poll_once().await {
                Step::Blocked => {
                    self.stop();
                    return;
                }
                Step::Ok => {
                    errors = 0;
                    if self.state.lock().unwrap().perk == Some(false) {
                        self.sleep(PERK_OFF_WAIT).await;
                    } else if began.elapsed() < MIN_POLL_GAP {
                        self.sleep(MIN_POLL_GAP).await;
                    }
                }
                Step::Error => {
                    errors += 1;
                    self.sleep(backoff(errors)).await;
                }
            }
        }
    }

    async fn report_loop(&self) {
        let mut errors = 0u32;
        while !self.stopped.load(Ordering::SeqCst) {
            match self.report_once().await {
                Step::Blocked => {
                    self.stop();
                    return;
                }
                Step::Ok => {
                    errors = 0;
                    let wait = if self.state.lock().unwrap().watching { REPORT_WATCHED } else { REPORT_IDLE };
                    self.sleep(wait).await;
                }
                Step::Error => {
                    errors += 1;
                    self.sleep(backoff(errors)).await;
                }
            }
        }
    }

    /// Runs both loops until `stop()` (or until the account is no longer allowed).
    pub async fn run(self: Arc<Self>) {
        tokio::join!(self.poll_loop(), self.report_loop());
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }
}

fn url_encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn console_lines_lose_addresses_tokens_and_secrets_but_keep_times_and_uuids() {
        let out = clean_lines(&lines(&[
            "Steve[/1.2.3.4:5555] logged in with entity id 12 at (1.0, 64.0, 1.0)",
            "Player connected from 203.0.113.9",
            "Alex[/[2001:db8::1]:5555] logged in",
            "peer 2001:0db8:0000:0000:0000:ff00:0042:8329 joined",
            "mapped ::ffff:198.51.100.7 seen",
            "token vp_abcdefghijklmnop was used",
            "key 0123456789abcdef0123456789abcdef0123 found",
            "[12:07:00] [Server thread/INFO]: Done (3.2s)!",
            "UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5",
        ]));
        assert_eq!(out[0], "Steve[[ip]] logged in with entity id 12 at (1.0, 64.0, 1.0)");
        assert!(out[1].contains("[ip]") && !out[1].contains("203.0"));
        assert!(!out[2].contains("2001") && !out[2].contains("db8"), "{}", out[2]);
        assert!(!out[3].contains("ff00") && !out[3].contains("8329"), "{}", out[3]);
        assert!(!out[4].contains("198.51") && !out[4].contains("ffff"), "{}", out[4]);
        assert!(!out[5].contains("abcdefghijklmnop"));
        assert!(!out[6].contains("0123456789abcdef0123"));
        assert_eq!(out[7], "[12:07:00] [Server thread/INFO]: Done (3.2s)!");
        assert!(out[8].contains("069a79f4-44e9-4726-a5be-fca90e38aaf5"));
    }

    #[test]
    fn at_most_100_lines_of_200_characters_leave_the_pc_and_colour_codes_and_control_characters_are_dropped() {
        let many: Vec<String> = (0..150).map(|i| format!("{i}:{}", "x".repeat(500))).collect();
        let out = clean_lines(&many);
        assert_eq!(out.len(), 100);
        assert!(out.iter().all(|l| l.chars().count() <= 200));
        assert!(out[99].starts_with("149:"), "the newest lines are kept");
        assert_eq!(clean_lines(&lines(&["\u{1b}[31mred\u{1b}[0m\u{7} text"])).join(""), "red text");
    }

    #[test]
    fn the_owners_computer_user_name_in_file_paths_never_reaches_friends() {
        let out = clean_lines(&lines(&[
            r"Loading from C:\Users\Trazverse\AppData\Roaming\VoxelPort\servers\smp",
            "at /home/alice/servers/smp/plugins/x.jar",
            "at /Users/bob/Library/Application Support/VoxelPort",
        ]));
        let all = out.join("\n");
        assert!(!all.contains("Trazverse") && !all.contains("alice") && !all.contains("bob"), "{all}");
        assert!(out[0].contains(r"C:\Users\[user]\AppData"), "{}", out[0]);
    }

    #[test]
    fn only_the_four_allowed_actions_pass_and_a_kick_needs_a_plain_player_name() {
        assert_eq!(parse_command(&json!({ "id": 5, "action": "start" })), Some(Command { id: 5, action: "start".into(), arg: None }));
        assert_eq!(parse_command(&json!({ "id": 6, "action": "kick", "arg": "Steve_1" })), Some(Command { id: 6, action: "kick".into(), arg: Some("Steve_1".into()) }));
        let long = "a".repeat(17);
        let bad = [
            json!({ "id": 1, "action": "kick", "arg": "a b" }),
            json!({ "id": 1, "action": "kick", "arg": "x\ny" }),
            json!({ "id": 1, "action": "kick", "arg": "a;stop" }),
            json!({ "id": 1, "action": "kick", "arg": long }),
            json!({ "id": 1, "action": "kick" }),
            json!({ "id": 1, "action": "op", "arg": "Steve" }),
            json!({ "id": 1, "action": "say hi" }),
            json!({ "action": "start" }),
            json!({ "id": "x", "action": "start" }),
            json!({ "id": -1, "action": "start" }),
            json!(null),
            json!("start"),
        ];
        for b in bad {
            assert_eq!(parse_command(&b), None, "{b}");
        }
    }

    #[test]
    fn error_backoff_doubles_from_2_seconds_up_to_a_minute() {
        let got: Vec<u64> = [1, 2, 3, 4, 5, 6, 7, 20, 200].iter().map(|n| backoff(*n).as_millis() as u64).collect();
        assert_eq!(got, vec![2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
    }

    // ─── the loop, against stand-ins ────────────────────────────────────────

    struct FakeLink {
        calls: StdMutex<Vec<(String, String, Option<Value>, Duration)>>,
        commands: StdMutex<Vec<Value>>,
        perk: Option<bool>,
        poll_status: u16,
    }

    impl FakeLink {
        fn new(commands: Vec<Value>) -> Arc<Self> {
            Arc::new(Self { calls: StdMutex::new(vec![]), commands: StdMutex::new(commands), perk: None, poll_status: 200 })
        }
        fn paths(&self, prefix: &str) -> Vec<(String, Option<Value>)> {
            self.calls.lock().unwrap().iter().filter(|c| c.1.starts_with(prefix)).map(|c| (c.1.clone(), c.2.clone())).collect()
        }
    }

    impl Link for FakeLink {
        fn request(&self, method: &'static str, path: String, body: Option<Value>, timeout: Duration) -> BoxFut<'_, ApiReply> {
            Box::pin(async move {
                self.calls.lock().unwrap().push((method.to_string(), path.clone(), body, timeout));
                if path.starts_with("/api/app/control/poll") {
                    if self.poll_status != 200 {
                        return ApiReply { ok: false, status: self.poll_status, json: json!({}) };
                    }
                    let c: Vec<Value> = std::mem::take(&mut *self.commands.lock().unwrap());
                    let mut j = json!({ "commands": c, "watching": false });
                    if let Some(p) = self.perk {
                        j["perk"] = json!(p);
                    }
                    return ApiReply { ok: true, status: 200, json: j };
                }
                ApiReply { ok: true, status: 200, json: json!({ "ok": true, "watching": true }) }
            })
        }
    }

    struct FakeActions {
        ran: StdMutex<Vec<String>>,
        events: StdMutex<Vec<(String, Option<String>, bool)>>,
        allowed: AtomicBool,
    }

    impl FakeActions {
        fn new(allowed: bool) -> Arc<Self> {
            Arc::new(Self { ran: StdMutex::new(vec![]), events: StdMutex::new(vec![]), allowed: AtomicBool::new(allowed) })
        }
    }

    impl Actions for FakeActions {
        fn run<'a>(&'a self, action: &'a str, arg: Option<&'a str>) -> BoxFut<'a, Outcome> {
            Box::pin(async move {
                self.ran.lock().unwrap().push(match arg {
                    Some(a) => format!("{action} {a}"),
                    None => action.to_string(),
                });
                if action == "restart" {
                    Outcome::err("Not running")
                } else {
                    Outcome::ok("Starting")
                }
            })
        }
        fn report(&self) -> Report {
            Report { status: "online".into(), players: vec!["Steve".into(), "bad name".into()], lines: lines(&["Steve[/9.9.9.9:1] joined"]) }
        }
        fn is_allowed(&self) -> bool {
            self.allowed.load(Ordering::SeqCst)
        }
        fn vp_id(&self) -> String {
            "vp_test".into()
        }
        fn on_event(&self, action: &str, arg: Option<&str>, ok: bool) {
            self.events.lock().unwrap().push((action.into(), arg.map(String::from), ok));
        }
    }

    #[tokio::test]
    async fn a_command_is_run_once_and_its_result_is_sent_even_if_the_service_hands_it_out_twice() {
        let link = FakeLink::new(vec![json!({ "id": 7, "action": "start" }), json!({ "id": 8, "action": "kick", "arg": "Steve" }), json!({ "id": 7, "action": "start" })]);
        let actions = FakeActions::new(true);
        let rc = RemoteControl::new(link.clone(), actions.clone());
        rc.stopped.store(false, Ordering::SeqCst);
        assert_eq!(rc.poll_once().await, Step::Ok);
        assert_eq!(*actions.ran.lock().unwrap(), vec!["start".to_string(), "kick Steve".to_string()]);
        let results: Vec<(i64, bool)> = link.paths("/api/app/control/result").iter().map(|(_, b)| (b.as_ref().unwrap()["id"].as_i64().unwrap(), b.as_ref().unwrap()["ok"].as_bool().unwrap())).collect();
        assert_eq!(results, vec![(7, true), (8, true)]);
        assert_eq!(actions.events.lock().unwrap()[0], ("start".to_string(), None, true));
    }

    #[tokio::test]
    async fn an_unknown_or_malformed_action_is_refused_with_a_failed_result_and_never_runs() {
        let link = FakeLink::new(vec![json!({ "id": 9, "action": "op", "arg": "Steve" }), json!({ "id": 10, "action": "kick", "arg": "a b" })]);
        let actions = FakeActions::new(true);
        let rc = RemoteControl::new(link.clone(), actions.clone());
        rc.stopped.store(false, Ordering::SeqCst);
        rc.poll_once().await;
        assert!(actions.ran.lock().unwrap().is_empty());
        let results: Vec<(i64, bool)> = link.paths("/api/app/control/result").iter().map(|(_, b)| (b.as_ref().unwrap()["id"].as_i64().unwrap(), b.as_ref().unwrap()["ok"].as_bool().unwrap())).collect();
        assert_eq!(results, vec![(9, false), (10, false)]);
    }

    #[tokio::test]
    async fn a_failing_action_reports_the_failure_instead_of_stopping_the_loop() {
        let link = FakeLink::new(vec![json!({ "id": 11, "action": "restart" })]);
        let rc = RemoteControl::new(link.clone(), FakeActions::new(true));
        rc.stopped.store(false, Ordering::SeqCst);
        assert_eq!(rc.poll_once().await, Step::Ok);
        let sent = link.paths("/api/app/control/result")[0].1.clone().unwrap();
        assert_eq!((sent["ok"].as_bool().unwrap(), sent["message"].as_str().unwrap()), (false, "Not running"));
    }

    #[tokio::test]
    async fn the_report_is_cleaned_and_tells_the_loop_whether_anyone_is_watching() {
        let link = FakeLink::new(vec![]);
        let rc = RemoteControl::new(link.clone(), FakeActions::new(true));
        rc.stopped.store(false, Ordering::SeqCst);
        assert_eq!(rc.report_once().await, Step::Ok);
        let body = link.paths("/api/app/control/report")[0].1.clone().unwrap();
        assert_eq!(body["vp"], "vp_test");
        assert_eq!(body["status"], "online");
        assert_eq!(body["players"], json!(["Steve"]), "a name that is not a plain player name is dropped");
        assert_eq!(body["lines"], json!(["Steve[[ip]] joined"]));
        assert!(rc.snapshot().watching);
    }

    #[tokio::test]
    async fn when_the_account_is_no_longer_allowed_nothing_is_sent_or_obeyed() {
        let link = FakeLink::new(vec![json!({ "id": 1, "action": "start" })]);
        let actions = FakeActions::new(false);
        let rc = RemoteControl::new(link.clone(), actions.clone());
        rc.stopped.store(false, Ordering::SeqCst);
        assert_eq!(rc.poll_once().await, Step::Blocked);
        assert_eq!(rc.report_once().await, Step::Blocked);
        assert!(link.calls.lock().unwrap().is_empty());
        assert!(actions.ran.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_rejected_session_blocks_and_a_server_error_asks_for_a_retry() {
        let mut l = FakeLink { calls: StdMutex::new(vec![]), commands: StdMutex::new(vec![]), perk: None, poll_status: 401 };
        let rc = RemoteControl::new(Arc::new(FakeLink { calls: StdMutex::new(vec![]), commands: StdMutex::new(vec![]), perk: None, poll_status: 401 }), FakeActions::new(true));
        rc.stopped.store(false, Ordering::SeqCst);
        assert_eq!(rc.poll_once().await, Step::Blocked);
        l.poll_status = 500;
        let rc = RemoteControl::new(Arc::new(l), FakeActions::new(true));
        rc.stopped.store(false, Ordering::SeqCst);
        assert_eq!(rc.poll_once().await, Step::Error);
    }

    #[tokio::test]
    async fn the_poll_waits_longer_than_the_service_holds_it_open() {
        let link = FakeLink::new(vec![]);
        let rc = RemoteControl::new(link.clone(), FakeActions::new(true));
        rc.stopped.store(false, Ordering::SeqCst);
        rc.poll_once().await;
        let timeout = link.calls.lock().unwrap()[0].3;
        assert!(timeout > Duration::from_secs(25), "the service holds a poll for up to 25 s, got {timeout:?}");
    }

    #[tokio::test]
    async fn the_loop_learns_from_the_poll_when_web_control_is_not_available_to_this_account() {
        let link = Arc::new(FakeLink { calls: StdMutex::new(vec![]), commands: StdMutex::new(vec![]), perk: Some(false), poll_status: 200 });
        let rc = RemoteControl::new(link, FakeActions::new(true));
        rc.stopped.store(false, Ordering::SeqCst);
        assert_eq!(rc.snapshot().perk, None);
        rc.poll_once().await;
        assert_eq!(rc.snapshot().perk, Some(false));
    }

    #[tokio::test(start_paused = true)]
    async fn run_keeps_polling_until_stopped_and_backs_off_after_errors() {
        let link = Arc::new(FakeLink { calls: StdMutex::new(vec![]), commands: StdMutex::new(vec![]), perk: None, poll_status: 500 });
        let rc = RemoteControl::new(link.clone(), FakeActions::new(true));
        let runner = tokio::spawn(rc.clone().run());
        tokio::time::sleep(Duration::from_secs(40)).await;
        // Polls at 0 s, 2 s, 6 s, 14 s and 30 s: the gaps double.
        let polls = link.paths("/api/app/control/poll").len();
        assert_eq!(polls, 5, "polls after 40 s of constant errors");
        rc.stop();
        runner.await.unwrap();
        assert!(!rc.snapshot().running);
    }

    #[tokio::test(start_paused = true)]
    async fn run_stops_by_itself_once_the_account_is_no_longer_allowed() {
        let link = FakeLink::new(vec![]);
        let actions = FakeActions::new(true);
        let rc = RemoteControl::new(link.clone(), actions.clone());
        let runner = tokio::spawn(rc.clone().run());
        tokio::time::sleep(Duration::from_secs(2)).await;
        actions.allowed.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(40)).await;
        runner.await.unwrap();
        assert!(!rc.snapshot().running);
        let before = link.calls.lock().unwrap().len();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(link.calls.lock().unwrap().len(), before, "nothing more is sent");
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_that_comes_before_the_loop_has_started_still_wins() {
        // The shell may replace a loop that was spawned a moment ago and has not run yet; that loop must not come back to life.
        let link = FakeLink::new(vec![]);
        let rc = RemoteControl::new(link.clone(), FakeActions::new(true));
        assert!(rc.snapshot().running, "a new loop counts as running from the start");
        rc.stop();
        assert!(!rc.snapshot().running);
        tokio::time::timeout(Duration::from_secs(5), rc.clone().run()).await.expect("run returns at once");
        assert!(link.calls.lock().unwrap().is_empty(), "a stopped loop sends nothing");
        assert!(!rc.snapshot().running);
    }
}

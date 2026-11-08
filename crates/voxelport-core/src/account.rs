//! The app's side of "Continue with Discord", ported from `appAccount.js`.
//!
//! The browser does the Discord sign-in on the accounts service and is sent back to a loopback port on this
//! machine with a one-time code. The code is only useful together with the PKCE verifier, which never leaves this
//! process, and is traded for a revocable app session. The session is stored with OS-backed encryption when that
//! exists, like the device token, and is never handed to the page.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Notify};

use crate::fsutil::atomic_write;
use crate::gate::{Config, LastGood, MemberStatus, StatusError};
use crate::identity::{decrypt_token, encrypt_token, passphrase_problem, short_id, SecretBox, ITERATIONS};

/// A first-time Discord user may have to make an account and verify an email, so this matches the 10 minutes the server allows.
pub const DEFAULT_SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const RETURN_PAGE: &str = "<!doctype html><meta charset=\"utf-8\"><title>VoxelPort</title><body style=\"font-family:system-ui;text-align:center;margin-top:20vh\"><h2>You can return to VoxelPort now.</h2><p>You may close this tab.</p>";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub type OpenExternal = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0))
}

pub struct AccountOptions {
    pub base_url: String,
    pub user_data_dir: PathBuf,
    pub secrets: Arc<dyn SecretBox>,
    pub open_external: OpenExternal,
    pub device_token: String,
    pub now: Clock,
    pub sign_in_timeout: Duration,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Standing {
    pub plan_id: String,
    pub plan_name: String,
    pub rank: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BackupInfo {
    pub vp_id: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub session: bool,
    pub config: Option<Config>,
    pub status: Option<MemberStatus>,
    pub status_error: Option<StatusError>,
    pub last_good: Option<LastGood>,
    pub discord_name: Option<String>,
    pub standing: Option<Standing>,
    pub identity_backup: Option<BackupInfo>,
}

#[derive(Default)]
struct State {
    session: Option<String>,
    config: Option<Config>,
    status: Option<MemberStatus>,
    status_error: Option<StatusError>,
    last_good: Option<LastGood>,
    discord_name: Option<String>,
    standing: Option<Standing>,
    identity_backup: Option<BackupInfo>,
}

struct FlowHandle {
    cancel: Arc<Notify>,
    done: watch::Receiver<Option<Value>>,
}

struct Inner {
    base_url: String,
    file: PathBuf,
    secrets: Arc<dyn SecretBox>,
    open_external: OpenExternal,
    device_token: Mutex<String>,
    now: Clock,
    sign_in_timeout: Duration,
    state: Mutex<State>,
    flow: Mutex<Option<FlowHandle>>,
}

#[derive(Clone)]
pub struct AppAccount {
    inner: Arc<Inner>,
}

/// What a signed-in call to the accounts service answered.
pub struct ApiReply {
    pub ok: bool,
    pub status: u16,
    pub json: Value,
}

struct Reply {
    ok: bool,
    status: u16,
    json: Value,
}

enum Outcome {
    Code(String),
    Error(String),
}

fn fail(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

fn is_code(s: &str) -> bool {
    s.len() == 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_error_code(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

fn first_param<'a>(query: &'a str, key: &str) -> &'a str {
    query.split('&').find_map(|kv| kv.strip_prefix(key).and_then(|r| r.strip_prefix('='))).unwrap_or("")
}

impl AppAccount {
    pub fn new(o: AccountOptions) -> Self {
        let inner = Arc::new(Inner {
            base_url: o.base_url.trim_end_matches('/').to_string(),
            file: o.user_data_dir.join("app-session.json"),
            secrets: o.secrets,
            open_external: o.open_external,
            device_token: Mutex::new(o.device_token),
            now: o.now,
            sign_in_timeout: o.sign_in_timeout,
            state: Mutex::new(State::default()),
            flow: Mutex::new(None),
        });
        inner.load();
        Self { inner }
    }

    pub fn snapshot(&self) -> Snapshot {
        let s = self.inner.state.lock().unwrap();
        Snapshot {
            session: s.session.is_some(),
            config: s.config.clone(),
            status: s.status.clone(),
            status_error: s.status_error,
            last_good: s.last_good.clone(),
            discord_name: s.discord_name.clone(),
            standing: s.standing.clone(),
            identity_backup: s.identity_backup.clone(),
        }
    }

    /// After a restore this install has a different device token; the next sign-in and every backup must use that one.
    pub fn set_device_token(&self, token: &str) {
        *self.inner.device_token.lock().unwrap() = token.to_string();
    }

    /// Starts "Continue with Discord", or joins the sign-in already open (a second click opens no second tab).
    pub async fn sign_in(&self) -> Value {
        let mut rx = {
            let mut g = self.inner.flow.lock().unwrap();
            if let Some(f) = g.as_ref() {
                f.done.clone()
            } else {
                let cancel = Arc::new(Notify::new());
                let (tx, rx) = watch::channel(None);
                *g = Some(FlowHandle { cancel: cancel.clone(), done: rx.clone() });
                let inner = self.inner.clone();
                tokio::spawn(async move {
                    let result = inner.clone().run_flow(cancel).await;
                    *inner.flow.lock().unwrap() = None;
                    let _ = tx.send(Some(result));
                });
                rx
            }
        };
        loop {
            if let Some(v) = rx.borrow().clone() {
                return v;
            }
            if rx.changed().await.is_err() {
                return fail("browser");
            }
        }
    }

    pub fn cancel_sign_in(&self) {
        if let Some(f) = self.inner.flow.lock().unwrap().as_ref() {
            f.cancel.notify_one();
        }
    }

    pub async fn refresh_status(&self) {
        let session = match self.inner.state.lock().unwrap().session.clone() {
            Some(s) => s,
            None => return,
        };
        match self.inner.call("GET", "/api/app/status", None, Some(&session)).await {
            Err(()) => self.inner.state.lock().unwrap().status_error = Some(StatusError::Unreachable),
            // The server no longer knows this session (signed out elsewhere, or the account was removed).
            Ok(r) if r.status == 401 => {
                self.inner.forget_account();
                self.inner.state.lock().unwrap().status_error = Some(StatusError::Unauthorized);
            }
            Ok(r) if !r.ok => self.inner.state.lock().unwrap().status_error = Some(StatusError::Unreachable),
            Ok(r) => {
                let now = (self.inner.now)();
                {
                    let mut s = self.inner.state.lock().unwrap();
                    let member = r.json["member"].as_bool().unwrap_or(false);
                    s.status = Some(MemberStatus { member, reason: r.json["reason"].as_str().map(str::to_string) });
                    s.status_error = None;
                    s.last_good = Some(LastGood { member, at: now });
                    if let Some(n) = r.json["discordName"].as_str().filter(|n| !n.is_empty()) {
                        s.discord_name = Some(n.to_string());
                    }
                    read_standing(&mut s, &r.json);
                    read_backup(&mut s, &r.json);
                    read_config(&mut s, &r.json, now);
                }
                let _ = self.inner.save();
            }
        }
    }

    pub async fn refresh_config(&self) -> Option<Config> {
        if let Ok(r) = self.inner.call("GET", "/api/app/config", None, None).await {
            if r.ok {
                let now = (self.inner.now)();
                read_config(&mut self.inner.state.lock().unwrap(), &r.json, now);
            }
        }
        self.inner.state.lock().unwrap().config.clone()
    }

    /// A signed-in call for the rest of the app (web control). `status` 0 means the service could not be reached; 401 means
    /// the account no longer knows this session, which is then forgotten on this PC. A redirect counts as unreachable.
    pub async fn request(&self, method: &'static str, path: &str, body: Option<Value>, timeout: Duration) -> ApiReply {
        let Some(session) = self.inner.state.lock().unwrap().session.clone() else { return ApiReply { ok: false, status: 401, json: json!({}) } };
        match self.inner.call_timed(method, path, body, Some(&session), timeout).await {
            Err(()) => ApiReply { ok: false, status: 0, json: json!({}) },
            Ok(r) => {
                if r.status == 401 {
                    self.inner.forget_account();
                }
                ApiReply { ok: r.ok, status: r.status, json: r.json }
            }
        }
    }

    pub async fn sign_out(&self) {
        let session = self.inner.state.lock().unwrap().session.clone();
        self.inner.forget_account();
        if let Some(s) = session {
            let _ = self.inner.call("POST", "/api/app/signout", Some(json!({})), Some(&s)).await;
        }
    }

    // ─── Address backup ─────────────────────────────────────────────────────
    // The passphrase and the device token only ever meet in this process: the account gets the encrypted blob. Every
    // answer is { ok: true, ... } or { ok: false, error } with error one of "signed_out", "unauthorized" (the account
    // no longer knows this session: it is forgotten, like any other call), "too_short", "too_simple", "not_found",
    // "wrong_passphrase" or "failed".

    async fn backup_call(&self, method: &'static str, body: Option<Value>) -> Result<Reply, &'static str> {
        let session = self.inner.state.lock().unwrap().session.clone().ok_or("signed_out")?;
        let r = self.inner.call(method, "/api/app/identity", body, Some(&session)).await.map_err(|_| "failed")?;
        if r.status == 401 {
            self.inner.forget_account();
            self.inner.state.lock().unwrap().status_error = Some(StatusError::Unauthorized);
            return Err("unauthorized");
        }
        Ok(r)
    }

    pub async fn save_backup(&self, passphrase: &str) -> Value {
        if let Some(problem) = passphrase_problem(passphrase) {
            return fail(problem);
        }
        let token = self.inner.device_token.lock().unwrap().clone();
        let vp_id = short_id(&token);
        let pass = passphrase.to_string();
        let blob = match tokio::task::spawn_blocking(move || encrypt_token(&token, &pass, None, None, ITERATIONS)).await {
            Ok(b) => b,
            Err(_) => return fail("failed"),
        };
        let r = match self.backup_call("PUT", Some(json!({ "vpId": vp_id, "blob": blob }))).await {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        if !r.ok {
            return fail("failed");
        }
        let updated_at = r.json["updatedAt"].as_i64().filter(|n| *n != 0).unwrap_or_else(|| (self.inner.now)());
        self.inner.state.lock().unwrap().identity_backup = Some(BackupInfo { vp_id, updated_at });
        json!({ "ok": true })
    }

    /// Opens the backup and hands back the device token it holds: the caller puts it in place and never shows it.
    pub async fn restore_backup(&self, passphrase: &str) -> Value {
        let r = match self.backup_call("GET", None).await {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        if r.status == 404 {
            self.inner.state.lock().unwrap().identity_backup = None;
            return fail("not_found");
        }
        let vp_id = match (r.ok, r.json["vpId"].as_str()) {
            (true, Some(id)) => id.to_string(),
            _ => return fail("failed"),
        };
        self.inner.state.lock().unwrap().identity_backup = Some(BackupInfo { vp_id: vp_id.clone(), updated_at: r.json["updatedAt"].as_i64().unwrap_or(0) });
        let (blob, pass, id) = (r.json["blob"].clone(), passphrase.to_string(), vp_id);
        match tokio::task::spawn_blocking(move || decrypt_token(&blob, &pass, &id)).await {
            Ok(Some(token)) => json!({ "ok": true, "token": token }),
            _ => fail("wrong_passphrase"),
        }
    }

    pub async fn delete_backup(&self) -> Value {
        match self.backup_call("DELETE", None).await {
            Err(e) => fail(e),
            Ok(r) if !r.ok => fail("failed"),
            Ok(_) => {
                self.inner.state.lock().unwrap().identity_backup = None;
                json!({ "ok": true })
            }
        }
    }
}

fn read_standing(s: &mut State, j: &Value) {
    if let (Some(id), Some(rank)) = (j["plan"]["id"].as_str(), j["rank"].as_str()) {
        s.standing = Some(Standing { plan_id: id.to_string(), plan_name: j["plan"]["name"].as_str().unwrap_or("").to_string(), rank: rank.to_string() });
    }
}

/// The address backup the account holds (who it is for and when), as the exchange and status answers report it.
fn read_backup(s: &mut State, j: &Value) {
    if let Some(b) = j.get("identityBackup") {
        s.identity_backup = b["vpId"].as_str().map(|id| BackupInfo { vp_id: id.to_string(), updated_at: b["updatedAt"].as_i64().unwrap_or(0) });
    }
}

fn read_config(s: &mut State, j: &Value, now: i64) {
    s.config = Some(Config {
        grace_until: j["graceUntil"].as_i64(),
        server_now: j["serverNow"].as_i64().unwrap_or(now),
        at: now,
        invite_url: j["inviteUrl"].as_str().map(str::to_string),
    });
}

impl Inner {
    fn load(&self) {
        let Ok(text) = fs::read_to_string(&self.file) else { return };
        let Ok(record) = serde_json::from_str::<Value>(&text) else { return };
        let mut s = self.state.lock().unwrap();
        let encrypted = record["enc"].as_str().filter(|e| !e.is_empty()).filter(|_| self.secrets.available());
        if let Some(enc) = encrypted {
            s.session = B64_STD.decode(enc).ok().and_then(|c| self.secrets.decrypt(&c));
        } else if let Some(plain) = record["session"].as_str() {
            s.session = Some(plain.to_string());
        }
        if let Some(member) = record["lastGood"]["member"].as_bool() {
            s.last_good = Some(LastGood { member, at: record["lastGood"]["at"].as_i64().unwrap_or(0) });
        }
        if let Some(n) = record["discordName"].as_str() {
            s.discord_name = Some(n.to_string());
        }
        read_standing(&mut s, &json!({ "plan": record["standing"]["plan"], "rank": record["standing"]["rank"] }));
    }

    fn save(&self) -> std::io::Result<()> {
        let s = self.state.lock().unwrap();
        let Some(session) = s.session.clone() else { return Ok(()) };
        let mut record = serde_json::Map::new();
        match self.secrets.available().then(|| self.secrets.encrypt(&session)).flatten() {
            Some(enc) => record.insert("enc".into(), json!(B64_STD.encode(enc))),
            None => record.insert("session".into(), json!(session)),
        };
        record.insert("lastGood".into(), s.last_good.as_ref().map(|g| json!({ "member": g.member, "at": g.at })).unwrap_or(Value::Null));
        record.insert("discordName".into(), json!(s.discord_name));
        record.insert("standing".into(), s.standing.as_ref().map(|g| json!({ "plan": { "id": g.plan_id, "name": g.plan_name }, "rank": g.rank })).unwrap_or(Value::Null));
        drop(s);
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        atomic_write(&self.file, Value::Object(record).to_string().as_bytes())
    }

    /// Forgets the signed-in account on this machine: nothing it showed (name, rank) may be left on screen.
    fn forget_account(&self) {
        {
            let mut s = self.state.lock().unwrap();
            let config = s.config.take(); // the public config is not part of the account
            *s = State { config, ..State::default() };
        }
        let _ = fs::remove_file(&self.file);
    }

    async fn call(&self, method: &'static str, path: &str, body: Option<Value>, session: Option<&str>) -> Result<Reply, ()> {
        self.call_timed(method, path, body, session, REQUEST_TIMEOUT).await
    }

    async fn call_timed(&self, method: &'static str, path: &str, body: Option<Value>, session: Option<&str>, timeout: Duration) -> Result<Reply, ()> {
        let url = format!("{}{}", self.base_url, path);
        let auth = session.map(|s| format!("Bearer {s}"));
        tokio::task::spawn_blocking(move || {
            let agent = ureq::AgentBuilder::new().redirects(0).timeout(timeout).build();
            let mut req = agent.request(method, &url).set("content-type", "application/json");
            if let Some(a) = &auth {
                req = req.set("authorization", a);
            }
            let outcome = match &body {
                Some(b) => req.send_string(&b.to_string()),
                None => req.call(),
            };
            let resp = match outcome {
                Ok(r) => r,
                Err(ureq::Error::Status(_, r)) => r,
                Err(_) => return Err(()),
            };
            let status = resp.status();
            // A redirect is an error here (Electron used redirect: "error"): a session must never follow a redirect.
            if (300..400).contains(&status) {
                return Err(());
            }
            let json = resp.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
            Ok(Reply { ok: (200..300).contains(&status), status, json })
        })
        .await
        .map_err(|_| ())?
    }

    async fn run_flow(self: Arc<Self>, cancel: Arc<Notify>) -> Value {
        let mut raw = [0u8; 32];
        getrandom::getrandom(&mut raw).expect("random source");
        let verifier = B64.encode(raw);
        let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));

        let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(_) => return fail("browser"),
        };
        let Ok(addr) = listener.local_addr() else { return fail("browser") };
        let url = format!("{}/api/auth/discord/start?app=1&challenge={challenge}&port={}", self.base_url, addr.port());
        if !(self.open_external)(&url) {
            return fail("browser");
        }

        let (tx, mut rx) = mpsc::unbounded_channel::<Outcome>();
        let deadline = tokio::time::Instant::now() + self.sign_in_timeout;
        let outcome = loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        tokio::spawn(handle_connection(stream, tx.clone()));
                    }
                }
                Some(o) = rx.recv() => break o,
                _ = cancel.notified() => break Outcome::Error("cancelled".into()),
                _ = tokio::time::sleep_until(deadline) => break Outcome::Error("timeout".into()),
            }
        };
        drop(listener); // the loopback port is closed before anything else happens
        let code = match outcome {
            Outcome::Error(e) => return fail(&e),
            Outcome::Code(c) => c,
        };

        let device_token = self.device_token.lock().unwrap().clone();
        let body = json!({ "code": code, "verifier": verifier, "deviceToken": device_token });
        let r = match self.call("POST", "/api/app/exchange", Some(body), None).await {
            Ok(r) => r,
            Err(()) => return fail("unreachable"),
        };
        if !r.ok {
            let msg = r.json["error"].as_str().filter(|e| !e.is_empty()).map(str::to_string).unwrap_or_else(|| format!("Sign-in failed ({}).", r.status));
            return fail(&msg);
        }
        let j = r.json;
        let Some(session) = j["session"].as_str() else { return fail("unreachable") };
        let now = (self.now)();
        let member = j["member"].as_bool().unwrap_or(false);
        let reason = j["reason"].as_str().filter(|r| !r.is_empty()).map(str::to_string);
        let discord_name = j["discordName"].as_str().filter(|n| !n.is_empty()).map(str::to_string);
        {
            let mut s = self.state.lock().unwrap();
            s.session = Some(session.to_string());
            s.discord_name = discord_name.clone();
            s.status = Some(MemberStatus { member, reason: reason.clone() });
            s.status_error = None;
            s.last_good = Some(LastGood { member, at: now });
            read_standing(&mut s, &j);
            read_backup(&mut s, &j);
            read_config(&mut s, &j, now);
        }
        let _ = self.save(); // signed in for this run even if it cannot be remembered
        let mut out = json!({ "ok": true, "member": member, "reason": reason, "discordName": discord_name });
        if let Some(e) = j["linkError"].as_str() {
            out["linkError"] = json!(e);
        }
        out
    }
}

/// Answers one request on the loopback port. Only `GET /` with a well-formed code or error is taken; anything else
/// (a favicon, a scanner, a wrong path) gets a 404 and is ignored.
async fn handle_connection(mut stream: TcpStream, tx: mpsc::UnboundedSender<Outcome>) {
    let mut buf = Vec::with_capacity(1024);
    let read = async {
        let mut chunk = [0u8; 1024];
        while buf.len() < 8192 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    };
    if tokio::time::timeout(Duration::from_secs(2), read).await.is_err() {
        return;
    }
    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.lines().next().unwrap_or("").split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let (path, query) = target.split_once('?').unwrap_or((target, ""));

    let mut outcome = None;
    if method == "GET" && path == "/" {
        let (code, failure) = (first_param(query, "code"), first_param(query, "error"));
        if is_code(code) {
            outcome = Some(Outcome::Code(code.to_string()));
        } else if is_error_code(failure) {
            outcome = Some(Outcome::Error(failure.to_string()));
        }
    }
    let response = if outcome.is_some() {
        format!("HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{RETURN_PAGE}", RETURN_PAGE.len())
    } else {
        "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string()
    };
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    if let Some(o) = outcome {
        let _ = tx.send(o);
    }
}

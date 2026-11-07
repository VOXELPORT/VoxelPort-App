//! The account module against a scripted accounts service on a real local socket, with a fake "browser" that follows
//! the sign-in URL back to the app's loopback port. Ported from Electron's appAccount*.test.js.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use voxelport_core::account::{AccountOptions, AppAccount};
use voxelport_core::identity::{decrypt_token, encrypt_token, short_id, SecretBox};

const DEVICE: &str = "vp_appaccounttest_1234567890";
const OTHER: &str = "vp_someotherdevicetoken_0987654321";
const PASS: &str = "correct horse battery staple";
const SESSION: &str = "session-token-abcdefghijklmnopqrstuvwxyz0123456789";

/// Reversible and visibly not plaintext, like the Electron tests' stand-in.
struct Reverse;
impl SecretBox for Reverse {
    fn available(&self) -> bool { true }
    fn encrypt(&self, p: &str) -> Option<Vec<u8>> { Some(format!("enc:{}", p.chars().rev().collect::<String>()).into_bytes()) }
    fn decrypt(&self, c: &[u8]) -> Option<String> { Some(String::from_utf8(c.to_vec()).ok()?.strip_prefix("enc:")?.chars().rev().collect()) }
}

#[derive(Clone, Debug)]
struct Call {
    method: String,
    path: String,
    auth: Option<String>,
    body: Value,
}
type Handler = Box<dyn Fn(&Call) -> (u16, Value) + Send + Sync>;

struct Server {
    port: u16,
    calls: Arc<Mutex<Vec<Call>>>,
    stop: Arc<AtomicBool>,
}

impl Server {
    fn start(handler: Handler) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (c2, s2) = (calls.clone(), stop.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut s) = conn else { continue };
                let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                let mut data = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head_end, content_len) = loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break (0, 0);
                    }
                    data.extend_from_slice(&chunk[..n]);
                    if let Some(p) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&data[..p]).to_lowercase();
                        let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0usize);
                        break (p + 4, len);
                    }
                };
                if head_end == 0 {
                    continue;
                }
                while data.len() < head_end + content_len {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&data[..head_end]).to_string();
                let mut first = head.lines().next().unwrap_or("").split(' ');
                let (method, path) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
                let auth = head.lines().find_map(|l| l.to_lowercase().starts_with("authorization:").then(|| l[14..].trim().to_string()));
                let body = serde_json::from_slice(&data[head_end..]).unwrap_or(Value::Null);
                let call = Call { method, path, auth, body };
                c2.lock().unwrap().push(call.clone());
                let (status, json) = handler(&call);
                let text = json.to_string();
                let _ = write!(s, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
            }
        });
        Server { port, calls, stop }
    }
    fn url(&self) -> String { format!("http://127.0.0.1:{}", self.port) }
    fn calls(&self, path: &str) -> Vec<Call> { self.calls.lock().unwrap().iter().filter(|c| c.path == path).cloned().collect() }
    fn close(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port)); // wakes the accept loop so it exits and frees the port
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn member_reply() -> Value {
    json!({ "session": SESSION, "member": true, "reason": null, "discordName": "Player", "plan": { "id": "free", "name": "Free" }, "rank": "free", "graceUntil": null, "serverNow": 5000, "inviteUrl": "https://discord.gg/x" })
}

fn accounts(exchange_status: u16, exchange: Value, reject: bool) -> Server {
    Server::start(Box::new(move |c| match c.path.as_str() {
        "/api/app/exchange" => (exchange_status, exchange.clone()),
        "/api/app/status" => {
            if c.auth.as_deref() == Some(&format!("Bearer {SESSION}")) && !reject {
                (200, json!({ "member": true, "reason": null, "discordName": "Player", "plan": { "id": "plus", "name": "Plus" }, "rank": "supporter_plus", "graceUntil": null, "serverNow": 9000 }))
            } else {
                (401, json!({ "error": "Sign in again." }))
            }
        }
        "/api/app/config" => (200, json!({ "graceUntil": 123456, "serverNow": 7000, "inviteUrl": "https://discord.gg/x" })),
        "/api/app/signout" => (200, json!({ "ok": true })),
        _ => (404, json!({})),
    }))
}

fn http_get(port: u16, target: &str) -> u16 {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else { return 0 };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = write!(s, "GET {target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0)
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_millis(300)).is_ok()
}

/// A browser that opens the sign-in URL, then follows `steps` back to the app's loopback port.
struct Browser {
    opened: Arc<Mutex<Vec<String>>>,
    port: Arc<Mutex<Option<u16>>>,
}
fn browser(steps: Vec<String>) -> (Browser, Arc<dyn Fn(&str) -> bool + Send + Sync>) {
    let opened = Arc::new(Mutex::new(Vec::new()));
    let port = Arc::new(Mutex::new(None));
    let (o2, p2) = (opened.clone(), port.clone());
    let open = Arc::new(move |url: &str| {
        o2.lock().unwrap().push(url.to_string());
        let (path, query) = url.split_once('?').unwrap();
        assert!(path.ends_with("/api/auth/discord/start"), "{path}");
        let get = |k: &str| query.split('&').find_map(|kv| kv.strip_prefix(k).and_then(|r| r.strip_prefix('='))).unwrap().to_string();
        assert_eq!(get("app"), "1");
        let challenge = get("challenge");
        assert!(challenge.len() == 43 && challenge.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        let p: u16 = get("port").parse().unwrap();
        *p2.lock().unwrap() = Some(p);
        let steps = steps.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            for s in steps {
                http_get(p, &s);
            }
        });
        true
    });
    (Browser { opened, port }, open)
}

fn code(c: char) -> String { format!("/?code={}", c.to_string().repeat(43)) }

struct Rig {
    account: AppAccount,
    dir: tempfile::TempDir,
    browser: Browser,
}
fn make(base_url: &str, steps: Vec<String>, timeout: Duration) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let (b, open) = browser(steps);
    let account = new_account(base_url, dir.path(), open, timeout);
    Rig { account, dir, browser: b }
}
fn new_account(base_url: &str, dir: &Path, open: Arc<dyn Fn(&str) -> bool + Send + Sync>, timeout: Duration) -> AppAccount {
    AppAccount::new(AccountOptions {
        base_url: base_url.into(),
        user_data_dir: dir.into(),
        secrets: Arc::new(Reverse),
        open_external: open,
        device_token: DEVICE.into(),
        now: Arc::new(|| 1000),
        sign_in_timeout: timeout,
    })
}
const LONG: Duration = Duration::from_secs(5);

#[tokio::test]
async fn sign_in_saves_an_encrypted_session_and_never_writes_a_secret_in_plain_text() {
    let svc = accounts(200, member_reply(), false);
    let rig = make(&svc.url(), vec![code('c')], LONG);
    let r = rig.account.sign_in().await;
    assert_eq!((r["ok"].clone(), r["member"].clone(), r["discordName"].clone()), (json!(true), json!(true), json!("Player")));
    let ex = &svc.calls("/api/app/exchange")[0];
    assert_eq!(ex.body["deviceToken"], DEVICE);
    assert_eq!(ex.body["code"], "c".repeat(43));
    let verifier = ex.body["verifier"].as_str().unwrap();
    assert!(verifier.len() == 43 && verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
    let saved = fs::read_to_string(rig.dir.path().join("app-session.json")).unwrap();
    assert!(!saved.contains("session-token") && !saved.contains(DEVICE), "{saved}");
    let snap = rig.account.snapshot();
    assert!(snap.session && snap.status.unwrap().member && snap.last_good.unwrap().member);
    svc.close();
}

#[tokio::test]
async fn a_second_click_while_a_sign_in_is_open_reuses_it() {
    let svc = accounts(200, member_reply(), false);
    let rig = make(&svc.url(), vec![code('c')], LONG);
    let (a, b) = tokio::join!(rig.account.sign_in(), rig.account.sign_in());
    assert_eq!(rig.browser.opened.lock().unwrap().len(), 1, "one listener, one browser tab");
    assert_eq!((a["ok"].clone(), b["ok"].clone()), (json!(true), json!(true)));
    assert_eq!(svc.calls("/api/app/exchange").len(), 1);
    svc.close();
}

#[tokio::test]
async fn no_callback_times_out_cancel_stops_it_and_the_port_is_closed_afterwards() {
    let svc = accounts(200, member_reply(), false);
    let rig = make(&svc.url(), vec![], Duration::from_millis(300));
    assert_eq!(rig.account.sign_in().await, json!({ "ok": false, "error": "timeout" }));
    let port = rig.browser.port.lock().unwrap().unwrap();
    assert!(!port_open(port));

    let rig2 = make(&svc.url(), vec![], LONG);
    let pending = tokio::spawn({ let a = rig2.account.clone(); async move { a.sign_in().await } });
    tokio::time::sleep(Duration::from_millis(150)).await;
    rig2.account.cancel_sign_in();
    assert_eq!(pending.await.unwrap(), json!({ "ok": false, "error": "cancelled" }));
    assert!(!port_open(rig2.browser.port.lock().unwrap().unwrap()));
    svc.close();
}

#[tokio::test]
async fn stray_requests_to_the_loopback_port_are_ignored_until_the_real_code_arrives() {
    let svc = accounts(200, member_reply(), false);
    let steps = vec!["/favicon.ico".into(), "/?code=".into(), "/?code=short".into(), format!("/other?code={}", "c".repeat(43)), code('d')];
    let rig = make(&svc.url(), steps, LONG);
    assert_eq!(rig.account.sign_in().await["ok"], true);
    let calls = svc.calls("/api/app/exchange");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].body["code"], "d".repeat(43));
    svc.close();
}

#[tokio::test]
async fn a_non_member_and_a_link_problem_pass_through_without_failing_the_sign_in() {
    let mut reply = member_reply();
    reply["member"] = json!(false);
    reply["reason"] = json!("not_in_server");
    reply["linkError"] = json!("That VoxelPort ID is already linked to an account.");
    let svc = accounts(200, reply, false);
    let rig = make(&svc.url(), vec![code('c')], LONG);
    let r = rig.account.sign_in().await;
    assert_eq!((r["ok"].clone(), r["member"].clone(), r["reason"].clone(), r["linkError"].clone()), (json!(true), json!(false), json!("not_in_server"), json!("That VoxelPort ID is already linked to an account.")));
    let snap = rig.account.snapshot();
    assert!(!snap.status.unwrap().member && !snap.last_good.unwrap().member);
    svc.close();
}

#[tokio::test]
async fn a_refused_exchange_reports_the_problem_and_saves_no_session() {
    let svc = accounts(400, json!({ "error": "Sign-in expired. Please try again." }), false);
    let rig = make(&svc.url(), vec![code('c')], LONG);
    assert_eq!(rig.account.sign_in().await, json!({ "ok": false, "error": "Sign-in expired. Please try again." }));
    assert!(!rig.dir.path().join("app-session.json").exists());
    svc.close();
}

#[tokio::test]
async fn status_refresh_keeps_the_last_good_answer_across_runs_and_an_outage() {
    let svc = accounts(200, member_reply(), false);
    let rig = make(&svc.url(), vec![code('c')], LONG);
    rig.account.sign_in().await;
    rig.account.refresh_status().await;
    let s = rig.account.snapshot();
    assert!(s.status_error.is_none() && s.status.unwrap().member);

    // A new run of the app loads the saved session from disk.
    let (_b, open) = browser(vec![]);
    let again = new_account(&svc.url(), rig.dir.path(), open, LONG);
    assert!(again.snapshot().session && again.snapshot().last_good.unwrap().member);
    svc.close();
    again.refresh_status().await;
    let s = again.snapshot();
    assert_eq!(s.status_error.map(|e| e.as_str()), Some("unreachable"));
    assert!(s.last_good.unwrap().member);
}

#[tokio::test]
async fn a_rejected_session_clears_the_name_rank_and_saved_session() {
    let svc = accounts(200, member_reply(), true);
    let rig = make(&svc.url(), vec![code('c')], LONG);
    rig.account.sign_in().await;
    assert_eq!(rig.account.snapshot().discord_name.as_deref(), Some("Player"));
    assert!(rig.account.snapshot().standing.is_some());
    rig.account.refresh_status().await;
    let s = rig.account.snapshot();
    assert_eq!(s.status_error.map(|e| e.as_str()), Some("unauthorized"));
    assert!(!s.session && s.discord_name.is_none() && s.standing.is_none() && s.status.is_none() && s.last_good.is_none());
    assert!(!rig.dir.path().join("app-session.json").exists());
    svc.close();
}

#[tokio::test]
async fn config_needs_no_session_and_sign_out_clears_the_session() {
    let svc = accounts(200, member_reply(), false);
    let rig = make(&svc.url(), vec![code('c')], LONG);
    let c = rig.account.refresh_config().await.unwrap();
    assert_eq!((c.grace_until, c.server_now, c.at, c.invite_url.as_deref()), (Some(123456), 7000, 1000, Some("https://discord.gg/x")));
    assert!(!rig.account.snapshot().session);
    rig.account.sign_in().await;
    rig.account.sign_out().await;
    assert_eq!(svc.calls("/api/app/signout").len(), 1);
    assert!(!rig.dir.path().join("app-session.json").exists());
    assert!(!rig.account.snapshot().session);
    svc.close();
}

#[tokio::test]
async fn the_browser_returning_with_an_error_ends_the_sign_in_at_once() {
    let svc = accounts(200, member_reply(), false);
    let rig = make(&svc.url(), vec!["/?error=signin_failed".into()], LONG);
    let started = Instant::now();
    assert_eq!(rig.account.sign_in().await, json!({ "ok": false, "error": "signin_failed" }));
    assert!(started.elapsed() < Duration::from_secs(2), "did not wait for the timeout");
    assert!(svc.calls("/api/app/exchange").is_empty());
    assert!(!port_open(rig.browser.port.lock().unwrap().unwrap()));
    svc.close();
}

#[tokio::test]
async fn a_browser_that_cannot_be_opened_is_reported() {
    let svc = accounts(200, member_reply(), false);
    let dir = tempfile::tempdir().unwrap();
    let account = new_account(&svc.url(), dir.path(), Arc::new(|_| false), LONG);
    assert_eq!(account.sign_in().await, json!({ "ok": false, "error": "browser" }));
    svc.close();
}

#[tokio::test]
async fn plan_and_rank_are_kept_refreshed_and_remembered_across_runs() {
    let svc = accounts(200, member_reply(), false);
    let rig = make(&svc.url(), vec![code('c')], LONG);
    assert!(rig.account.snapshot().standing.is_none());
    rig.account.sign_in().await;
    let s = rig.account.snapshot().standing.unwrap();
    assert_eq!((s.plan_id.as_str(), s.plan_name.as_str(), s.rank.as_str()), ("free", "Free", "free"));
    rig.account.refresh_status().await;
    assert_eq!(rig.account.snapshot().standing.unwrap().rank, "supporter_plus");
    let (_b, open) = browser(vec![]);
    let again = new_account(&svc.url(), rig.dir.path(), open, LONG);
    assert_eq!(again.snapshot().standing.unwrap().rank, "supporter_plus");
    again.sign_out().await;
    assert!(again.snapshot().standing.is_none());
    svc.close();
}

// ─── Address backup ─────────────────────────────────────────────────────────

struct Store {
    row: Arc<Mutex<Option<Value>>>,
}
fn backup_rig(status_override: Option<u16>) -> (Server, Store, AppAccount, tempfile::TempDir) {
    let row: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
    let r2 = row.clone();
    let svc = Server::start(Box::new(move |c| {
        if c.path != "/api/app/identity" { return (404, json!({})); }
        if let Some(s) = status_override { return (s, json!({ "error": "Sign in again." })); }
        if c.auth.as_deref() != Some(&format!("Bearer {SESSION}")) { return (401, json!({ "error": "Sign in again." })); }
        match c.method.as_str() {
            "PUT" => { *r2.lock().unwrap() = Some(json!({ "vpId": c.body["vpId"], "blob": c.body["blob"], "updatedAt": 5000 })); (200, json!({ "ok": true, "updatedAt": 5000 })) }
            "GET" => match r2.lock().unwrap().clone() { Some(v) => (200, v), None => (404, json!({ "error": "There is no address backup for this account." })) },
            "DELETE" => { *r2.lock().unwrap() = None; (200, json!({ "ok": true })) }
            _ => (405, json!({})),
        }
    }));
    let dir = tempfile::tempdir().unwrap();
    // Already signed in: a plaintext session record, as the Electron test writes.
    fs::write(dir.path().join("app-session.json"), json!({ "session": SESSION, "lastGood": { "member": true, "at": 1 }, "discordName": "Player" }).to_string()).unwrap();
    struct Plain;
    impl SecretBox for Plain {
        fn available(&self) -> bool { false }
        fn encrypt(&self, _: &str) -> Option<Vec<u8>> { None }
        fn decrypt(&self, _: &[u8]) -> Option<String> { None }
    }
    let account = AppAccount::new(AccountOptions { base_url: svc.url(), user_data_dir: dir.path().into(), secrets: Arc::new(Plain), open_external: Arc::new(|_| true), device_token: DEVICE.into(), now: Arc::new(|| 1000), sign_in_timeout: LONG });
    (svc, Store { row }, account, dir)
}

#[tokio::test]
async fn save_sends_only_the_encrypted_blob_filed_under_this_address() {
    let (svc, _store, account, _dir) = backup_rig(None);
    assert_eq!(account.save_backup(PASS).await, json!({ "ok": true }));
    let put = svc.calls("/api/app/identity").into_iter().find(|c| c.method == "PUT").unwrap();
    assert_eq!(put.body["vpId"], short_id(DEVICE));
    assert_eq!(put.auth.as_deref(), Some(format!("Bearer {SESSION}").as_str()));
    let text = put.body.to_string();
    assert!(!text.contains(DEVICE) && !text.contains(PASS));
    assert_eq!(decrypt_token(&put.body["blob"], PASS, put.body["vpId"].as_str().unwrap()).as_deref(), Some(DEVICE));
    let info = account.snapshot().identity_backup.unwrap();
    assert_eq!((info.vp_id, info.updated_at), (short_id(DEVICE), 5000));
    svc.close();
}

#[tokio::test]
async fn a_weak_passphrase_is_refused_before_anything_is_sent() {
    let (svc, _s, account, _d) = backup_rig(None);
    assert_eq!(account.save_backup("short").await, json!({ "ok": false, "error": "too_short" }));
    assert_eq!(account.save_backup("aaaaaaaaaaaaaaaa").await, json!({ "ok": false, "error": "too_simple" }));
    assert!(svc.calls("/api/app/identity").is_empty());
    svc.close();
}

#[tokio::test]
async fn restore_returns_the_token_backed_up_from_another_device() {
    let (svc, store, account, _d) = backup_rig(None);
    *store.row.lock().unwrap() = Some(json!({ "vpId": short_id(OTHER), "blob": encrypt_token(OTHER, PASS, None, None, 200_000), "updatedAt": 7000 }));
    assert_eq!(account.restore_backup(PASS).await, json!({ "ok": true, "token": OTHER }));
    let info = account.snapshot().identity_backup.unwrap();
    assert_eq!((info.vp_id, info.updated_at), (short_id(OTHER), 7000));
    svc.close();
}

#[tokio::test]
async fn a_wrong_passphrase_or_a_misfiled_backup_returns_no_token() {
    let (svc, store, account, _d) = backup_rig(None);
    *store.row.lock().unwrap() = Some(json!({ "vpId": short_id(OTHER), "blob": encrypt_token(OTHER, PASS, None, None, 200_000), "updatedAt": 7000 }));
    assert_eq!(account.restore_backup("not the passphrase").await, json!({ "ok": false, "error": "wrong_passphrase" }));
    *store.row.lock().unwrap() = Some(json!({ "vpId": "000000000000", "blob": encrypt_token(OTHER, PASS, None, None, 200_000), "updatedAt": 7000 }));
    assert_eq!(account.restore_backup(PASS).await, json!({ "ok": false, "error": "wrong_passphrase" }));
    svc.close();
}

#[tokio::test]
async fn no_backup_answers_not_found_and_delete_removes_one() {
    let (svc, store, account, _d) = backup_rig(None);
    assert_eq!(account.restore_backup(PASS).await, json!({ "ok": false, "error": "not_found" }));
    assert!(account.snapshot().identity_backup.is_none());
    account.save_backup(PASS).await;
    assert!(store.row.lock().unwrap().is_some());
    assert_eq!(account.delete_backup().await, json!({ "ok": true }));
    assert!(store.row.lock().unwrap().is_none());
    assert!(account.snapshot().identity_backup.is_none());
    svc.close();
}

#[tokio::test]
async fn a_rejected_session_forgets_the_account_for_every_backup_call() {
    for which in 0..3 {
        let (svc, _s, account, dir) = backup_rig(Some(401));
        let r = match which {
            0 => account.save_backup(PASS).await,
            1 => account.restore_backup(PASS).await,
            _ => account.delete_backup().await,
        };
        assert_eq!(r, json!({ "ok": false, "error": "unauthorized" }));
        assert!(!account.snapshot().session);
        assert!(!dir.path().join("app-session.json").exists());
        svc.close();
    }
}

#[tokio::test]
async fn signed_out_and_unreachable_are_their_own_answers() {
    let dir = tempfile::tempdir().unwrap();
    let account = new_account("http://127.0.0.1:1", dir.path(), Arc::new(|_| true), LONG);
    assert_eq!(account.restore_backup(PASS).await, json!({ "ok": false, "error": "signed_out" }));
    let (svc, _s, account, _d) = backup_rig(None);
    svc.close();
    assert_eq!(account.delete_backup().await, json!({ "ok": false, "error": "failed" }));
}

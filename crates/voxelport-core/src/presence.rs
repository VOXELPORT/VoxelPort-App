//! Discord "Rich Presence": a line under the person's name in Discord ("Hosting a Paper 1.21.4 server · 3 players online"). Ported from
//! `discordPresence.js`.
//!
//! It talks only to the Discord app running on the same computer, over its local pipe: nothing goes to the internet from here, and the
//! server's name and address are never sent. It needs a Discord application id (a free "application" made at discord.com/developers);
//! without one it does nothing and the screens hide the option.
//!
//! One background task owns the connection while it is switched on: it looks for Discord's pipe (numbers 0 to 9), says hello, answers
//! pings, shows what is running, and looks again every 30 seconds when Discord is not there or goes away. A "close" from Discord (for
//! example an application id it does not know) ends it until the option is switched off and on again.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;
use tokio::task::JoinHandle;

const OP_HANDSHAKE: i32 = 0;
const OP_FRAME: i32 = 1;
const OP_CLOSE: i32 = 2;
const OP_PING: i32 = 3;
const OP_PONG: i32 = 4;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const RETRY: Duration = Duration::from_secs(30);
const PIPES: u32 = 10;

/// One Discord frame: an 8-byte header (operation, length; both little-endian) and a JSON body.
pub fn encode(op: i32, payload: &Value) -> Vec<u8> {
    let body = payload.to_string().into_bytes();
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as i32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// Cuts a stream of bytes into frames; keeps what is not a whole frame yet. A length that cannot be right ends the conversation (a
/// `CLOSE` frame is reported); a body that is not JSON is reported as `None`.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<(i32, Option<Value>)> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while self.buf.len() >= 8 {
            let op = i32::from_le_bytes(self.buf[0..4].try_into().unwrap());
            let len = i32::from_le_bytes(self.buf[4..8].try_into().unwrap());
            if len < 0 || len as usize > MAX_FRAME_BYTES {
                self.buf.clear();
                out.push((OP_CLOSE, None));
                return out;
            }
            let len = len as usize;
            if self.buf.len() < 8 + len {
                break;
            }
            let data = serde_json::from_slice(&self.buf[8..8 + len]).ok(); // an unreadable frame is ignored
            self.buf.drain(..8 + len);
            out.push((op, data));
        }
        out
    }
}

/// Where Discord listens, for pipe number `n`.
pub fn pipe_path(n: u32) -> String {
    if cfg!(windows) {
        return format!(r"\\?\pipe\discord-ipc-{n}");
    }
    let base = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty())).unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned());
    std::path::Path::new(&base).join(format!("discord-ipc-{n}")).to_string_lossy().into_owned()
}

/// What is running: the type and version of the server, and how many players are on it.
#[derive(Clone, Debug, PartialEq)]
pub struct PresenceInfo {
    pub server_type: String,
    pub version: String,
    pub players: usize,
}

/// What shows in Discord. `started_at` is Unix seconds.
pub fn build_activity(info: &PresenceInfo, started_at: u64) -> Value {
    let kind = match info.server_type.as_str() {
        "paper" => "Paper",
        "fabric" => "Fabric",
        "vanilla" => "Vanilla",
        _ => "Minecraft",
    };
    let players = info.players.min(9999);
    let version: String = info.version.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '+' | ' ')).take(20).collect();
    let details: String = format!("Hosting a {kind}{} server", if version.is_empty() { String::new() } else { format!(" {version}") }).chars().take(128).collect();
    json!({
        "details": details,
        "state": if players == 1 { "1 player online".to_string() } else { format!("{players} players online") },
        "timestamps": { "start": started_at },
        "instance": false,
    })
}

pub trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}
pub type Stream = Box<dyn AsyncStream>;
/// Opens Discord's pipe number `n`.
pub type Connector = Arc<dyn Fn(u32) -> Pin<Box<dyn Future<Output = std::io::Result<Stream>> + Send>> + Send + Sync>;

/// The real thing: Discord's own pipe (Windows named pipe, or the socket in the runtime folder elsewhere).
pub fn system_connector() -> Connector {
    Arc::new(|n| {
        Box::pin(async move {
            #[cfg(windows)]
            {
                let client = tokio::net::windows::named_pipe::ClientOptions::new().open(pipe_path(n))?;
                Ok(Box::new(client) as Stream)
            }
            #[cfg(unix)]
            {
                let sock = tokio::net::UnixStream::connect(pipe_path(n)).await?;
                Ok(Box::new(sock) as Stream)
            }
            #[cfg(not(any(windows, unix)))]
            {
                let _ = n;
                Err(std::io::Error::other("no Discord pipe on this platform"))
            }
        })
    })
}

/// Discord's pipe under another name (`<prefix>-<n>`), for testing the real pipe code against a stand-in Discord. Windows only.
#[cfg(windows)]
pub fn pipe_connector(prefix: String) -> Connector {
    Arc::new(move |n| {
        let name = format!("{prefix}-{n}");
        Box::pin(async move { Ok(Box::new(tokio::net::windows::named_pipe::ClientOptions::new().open(name)?) as Stream) })
    })
}

type Shown = Option<(PresenceInfo, u64)>;

enum End {
    /// Discord ended the conversation (or the option was switched off): do not come back by itself.
    Closed,
    /// The connection went away: look again later.
    Lost,
}

async fn push(stream: &mut Stream, pid: u32, nonce: &mut u64, shown: &Shown) -> bool {
    *nonce += 1;
    let activity = shown.as_ref().map_or(Value::Null, |(info, at)| build_activity(info, *at));
    stream.write_all(&encode(OP_FRAME, &json!({ "cmd": "SET_ACTIVITY", "args": { "pid": pid, "activity": activity }, "nonce": nonce.to_string() }))).await.is_ok()
}

async fn session(mut stream: Stream, client_id: &str, pid: u32, nonce: &mut u64, enabled: &mut watch::Receiver<bool>, info: &mut watch::Receiver<Shown>) -> End {
    if stream.write_all(&encode(OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id }))).await.is_err() {
        return End::Lost;
    }
    let (mut decoder, mut ready, mut buf) = (Decoder::default(), false, [0u8; 4096]);
    loop {
        tokio::select! {
            n = stream.read(&mut buf) => {
                let n = match n { Ok(0) | Err(_) => return End::Lost, Ok(n) => n };
                for (op, data) in decoder.feed(&buf[..n]) {
                    match op {
                        OP_PING => { if stream.write_all(&encode(OP_PONG, &data.unwrap_or_else(|| json!({})))).await.is_err() { return End::Lost; } }
                        OP_CLOSE => return End::Closed,
                        OP_FRAME if data.as_ref().is_some_and(|d| d["evt"] == "READY") => {
                            ready = true;
                            let shown = info.borrow().clone();
                            if !push(&mut stream, pid, nonce, &shown).await { return End::Lost; }
                        }
                        _ => {}
                    }
                }
            }
            changed = info.changed() => {
                if changed.is_err() { return End::Closed; }
                if ready {
                    let shown = info.borrow_and_update().clone();
                    if !push(&mut stream, pid, nonce, &shown).await { return End::Lost; }
                }
            }
            changed = enabled.changed() => {
                if changed.is_err() || !*enabled.borrow() {
                    if ready { let _ = push(&mut stream, pid, nonce, &None).await; } // take the line down before leaving
                    return End::Closed;
                }
            }
        }
    }
}

async fn run(client_id: String, pid: u32, connector: Connector, mut enabled: watch::Receiver<bool>, mut info: watch::Receiver<Shown>) {
    let mut nonce = 0u64;
    while *enabled.borrow() {
        let mut stream = None;
        for n in 0..PIPES {
            if let Ok(s) = connector(n).await {
                stream = Some(s);
                break;
            }
        }
        if let Some(s) = stream {
            if let End::Closed = session(s, &client_id, pid, &mut nonce, &mut enabled, &mut info).await {
                return;
            }
        }
        // Discord is not running, or it went away: look again later (sooner if the option is switched off meanwhile).
        tokio::select! {
            _ = tokio::time::sleep(RETRY) => {}
            _ = enabled.changed() => {}
        }
    }
}

/// The presence line. Cheap to hold; the connection only exists while it is switched on.
pub struct Presence {
    client_id: String,
    pid: u32,
    connector: Connector,
    enabled: watch::Sender<bool>,
    info: watch::Sender<Shown>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Presence {
    pub fn new(client_id: &str, connector: Connector, pid: u32) -> Self {
        let valid = (15..=25).contains(&client_id.len()) && client_id.bytes().all(|b| b.is_ascii_digit());
        Self { client_id: if valid { client_id.to_string() } else { String::new() }, pid, connector, enabled: watch::channel(false).0, info: watch::channel(None).0, task: Mutex::new(None) }
    }

    /// False when there is no application id: the screen then hides the option altogether.
    pub fn available(&self) -> bool {
        !self.client_id.is_empty()
    }

    /// Switches it on or off. Must be called inside a tokio runtime. Turning it off takes the line down first.
    pub fn set_enabled(&self, on: bool) {
        let on = on && self.available();
        self.enabled.send_replace(on);
        let mut task = self.task.lock().unwrap();
        if on && task.as_ref().map_or(true, JoinHandle::is_finished) {
            let (enabled, info) = (self.enabled.subscribe(), self.info.subscribe());
            *task = Some(tokio::spawn(run(self.client_id.clone(), self.pid, self.connector.clone(), enabled, info)));
        }
    }

    /// The running server, or `None` when none runs. Only changes what is sent when it really changed.
    pub fn update(&self, info: Option<PresenceInfo>) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.info.send_if_modified(|shown| {
            let next: Shown = info.map(|i| {
                let started = shown.as_ref().map_or(now, |(_, at)| *at);
                (i, started)
            });
            if *shown == next {
                return false;
            }
            *shown = next;
            true
        });
    }

    /// The app is closing: take the line down and wait a moment for that to go out.
    pub async fn shutdown(&self) {
        self.enabled.send_replace(false);
        let task = self.task.lock().unwrap().take();
        if let Some(t) = task {
            let _ = tokio::time::timeout(Duration::from_secs(1), t).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use tokio::io::DuplexStream;

    const ID: &str = "1506829006794657902";

    fn info(players: usize) -> PresenceInfo {
        PresenceInfo { server_type: "paper".into(), version: "1.21.4".into(), players }
    }

    #[test]
    fn a_frame_is_eight_bytes_of_header_then_json_and_is_cut_out_of_any_stream() {
        let bytes = encode(OP_FRAME, &json!({ "a": 1 }));
        assert_eq!(&bytes[..8], &[1, 0, 0, 0, 7, 0, 0, 0]);
        assert_eq!(&bytes[8..], br#"{"a":1}"#);
        let mut d = Decoder::default();
        let two = [encode(OP_PING, &json!({ "n": 1 })), encode(OP_FRAME, &json!({ "evt": "READY" }))].concat();
        let mut got = Vec::new();
        for chunk in two.chunks(3) {
            got.extend(d.feed(chunk)); // arriving in tiny pieces
        }
        assert_eq!(got, vec![(OP_PING, Some(json!({ "n": 1 }))), (OP_FRAME, Some(json!({ "evt": "READY" })))]);
    }

    #[test]
    fn a_length_that_cannot_be_right_ends_the_conversation_and_a_body_that_is_not_json_is_ignored() {
        let mut d = Decoder::default();
        let mut huge = vec![1, 0, 0, 0];
        huge.extend_from_slice(&(70_000i32).to_le_bytes());
        assert_eq!(d.feed(&huge), vec![(OP_CLOSE, None)]);
        let mut negative = vec![1, 0, 0, 0];
        negative.extend_from_slice(&(-5i32).to_le_bytes());
        assert_eq!(d.feed(&negative), vec![(OP_CLOSE, None)]);
        let mut junk = vec![1, 0, 0, 0, 4, 0, 0, 0];
        junk.extend_from_slice(b"nope");
        assert_eq!(d.feed(&junk), vec![(OP_FRAME, None)], "an unreadable frame is ignored, not fatal");
        assert!(d.feed(&[1, 0, 0]).is_empty(), "half a header waits");
    }

    #[test]
    fn what_shows_in_discord_names_the_type_version_and_players_and_nothing_private() {
        let a = build_activity(&info(3), 1_700_000_000);
        assert_eq!(a, json!({ "details": "Hosting a Paper 1.21.4 server", "state": "3 players online", "timestamps": { "start": 1_700_000_000u64 }, "instance": false }));
        assert_eq!(build_activity(&info(1), 0)["state"], "1 player online");
        assert_eq!(build_activity(&info(0), 0)["state"], "0 players online");
        assert_eq!(build_activity(&info(1_000_000), 0)["state"], "9999 players online");
        let odd = build_activity(&PresenceInfo { server_type: "forge".into(), version: "1.20<script>.1 \u{1F600}".into(), players: 2 }, 0);
        assert_eq!(odd["details"], "Hosting a Minecraft 1.20script.1  server");
        assert_eq!(build_activity(&PresenceInfo { server_type: "fabric".into(), version: String::new(), players: 0 }, 0)["details"], "Hosting a Fabric server");
        assert_eq!(build_activity(&PresenceInfo { server_type: "vanilla".into(), version: "x".repeat(50), players: 0 }, 0)["details"].as_str().unwrap().len(), "Hosting a Vanilla ".len() + 20 + " server".len());
    }

    #[test]
    fn it_needs_a_real_application_id_and_looks_for_discord_where_discord_listens() {
        let none: Connector = Arc::new(|_| Box::pin(async { Err(std::io::Error::other("no")) }));
        for bad in ["", "abc", "123", "12345678901234x", &"1".repeat(26)] {
            assert!(!Presence::new(bad, none.clone(), 1).available(), "{bad:?}");
        }
        assert!(Presence::new(ID, none, 1).available());
        if cfg!(windows) {
            assert_eq!(pipe_path(3), r"\\?\pipe\discord-ipc-3");
        } else {
            assert!(pipe_path(3).ends_with("discord-ipc-3"));
        }
    }

    /// A stand-in for Discord: the connector hands out the app's end of each queued conversation for pipe 0, and refuses the rest.
    fn discord(count: usize) -> (Connector, Vec<DuplexStream>, Arc<Mutex<u32>>) {
        let mut theirs = Vec::new();
        let mut mine = VecDeque::new();
        for _ in 0..count {
            let (a, b) = tokio::io::duplex(64 * 1024);
            mine.push_back(a);
            theirs.push(b);
        }
        let queue = Arc::new(Mutex::new(mine));
        let attempts = Arc::new(Mutex::new(0u32));
        let a2 = attempts.clone();
        let connector: Connector = Arc::new(move |n| {
            let (queue, attempts) = (queue.clone(), a2.clone());
            Box::pin(async move {
                *attempts.lock().unwrap() += 1;
                match (n, queue.lock().unwrap().pop_front()) {
                    (0, Some(s)) => Ok(Box::new(s) as Stream),
                    (0, None) => Err(std::io::Error::other("discord is gone")),
                    _ => Err(std::io::Error::other("no such pipe")),
                }
            })
        });
        (connector, theirs, attempts)
    }

    async fn read_frame(s: &mut DuplexStream) -> (i32, Value) {
        let mut head = [0u8; 8];
        tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut head)).await.expect("a frame in time").expect("a header");
        let len = i32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
        let mut body = vec![0u8; len];
        s.read_exact(&mut body).await.unwrap();
        (i32::from_le_bytes(head[0..4].try_into().unwrap()), serde_json::from_slice(&body).unwrap())
    }

    async fn say(s: &mut DuplexStream, op: i32, v: Value) {
        s.write_all(&encode(op, &v)).await.unwrap();
    }

    #[tokio::test]
    async fn it_says_hello_follows_the_server_answers_pings_and_takes_the_line_down_when_switched_off() {
        let (connector, mut theirs, _) = discord(1);
        let mut d = theirs.remove(0);
        let p = Presence::new(ID, connector, 4242);
        p.set_enabled(true);
        let (op, hello) = read_frame(&mut d).await;
        assert_eq!((op, hello), (OP_HANDSHAKE, json!({ "v": 1, "client_id": ID })));
        say(&mut d, OP_FRAME, json!({ "evt": "READY", "cmd": "DISPATCH" })).await;
        let (_, first) = read_frame(&mut d).await;
        assert_eq!(first["cmd"], "SET_ACTIVITY");
        assert_eq!(first["args"], json!({ "pid": 4242, "activity": null }), "nothing runs yet");
        assert_eq!(first["nonce"], "1");

        p.update(Some(info(3)));
        let (_, shown) = read_frame(&mut d).await;
        assert_eq!(shown["args"]["activity"]["details"], "Hosting a Paper 1.21.4 server");
        assert_eq!(shown["args"]["activity"]["state"], "3 players online");
        assert_eq!(shown["nonce"], "2");
        let started = shown["args"]["activity"]["timestamps"]["start"].as_u64().unwrap();
        assert!(started > 1_700_000_000);

        p.update(Some(info(4)));
        let (_, more) = read_frame(&mut d).await;
        assert_eq!(more["args"]["activity"]["state"], "4 players online");
        assert_eq!(more["args"]["activity"]["timestamps"]["start"], started, "the clock keeps running while the same server runs");

        say(&mut d, OP_PING, json!({ "n": 7 })).await;
        assert_eq!(read_frame(&mut d).await, (OP_PONG, json!({ "n": 7 })));

        p.update(Some(info(4)));
        p.update(None);
        let (_, gone) = read_frame(&mut d).await;
        assert_eq!(gone["args"]["activity"], Value::Null, "an unchanged value sends nothing; stopping the server clears the line");

        p.set_enabled(false);
        let (_, off) = read_frame(&mut d).await;
        assert_eq!(off["args"]["activity"], Value::Null);
        let mut rest = Vec::new();
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), d.read_to_end(&mut rest)).await.unwrap().unwrap(), 0, "and the connection is closed");
    }

    #[tokio::test(start_paused = true)]
    async fn when_discord_closes_the_conversation_it_does_not_come_back_by_itself() {
        let (connector, mut theirs, attempts) = discord(2);
        let mut d = theirs.remove(0);
        let p = Presence::new(ID, connector, 1);
        p.set_enabled(true);
        read_frame(&mut d).await;
        say(&mut d, OP_CLOSE, json!({ "code": 4000, "message": "Invalid Client ID" })).await;
        tokio::time::sleep(Duration::from_secs(300)).await;
        assert_eq!(*attempts.lock().unwrap(), 1, "no second try");
    }

    #[tokio::test(start_paused = true)]
    async fn when_the_connection_drops_it_looks_again_after_thirty_seconds_and_says_hello_again() {
        let (connector, mut theirs, attempts) = discord(2);
        let (mut first, mut second) = (theirs.remove(0), theirs.remove(0));
        let p = Presence::new(ID, connector, 1);
        p.update(Some(info(2)));
        p.set_enabled(true);
        read_frame(&mut first).await;
        say(&mut first, OP_FRAME, json!({ "evt": "READY" })).await;
        read_frame(&mut first).await;
        drop(first);
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert_eq!(*attempts.lock().unwrap(), 1, "not before thirty seconds");
        tokio::time::sleep(Duration::from_secs(15)).await;
        assert_eq!(*attempts.lock().unwrap(), 2);
        assert_eq!(read_frame(&mut second).await.0, OP_HANDSHAKE);
        say(&mut second, OP_FRAME, json!({ "evt": "READY" })).await;
        let (_, again) = read_frame(&mut second).await;
        assert_eq!(again["args"]["activity"]["state"], "2 players online", "what is running is shown again on the new connection");
    }

    #[tokio::test(start_paused = true)]
    async fn with_no_discord_running_every_pipe_is_tried_then_it_waits_and_tries_again() {
        let (connector, _theirs, attempts) = discord(0);
        let p = Presence::new(ID, connector, 1);
        p.set_enabled(true);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(*attempts.lock().unwrap(), 10, "pipes 0 to 9");
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert_eq!(*attempts.lock().unwrap(), 20);
        p.set_enabled(false);
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert_eq!(*attempts.lock().unwrap(), 20, "switched off: it stops looking");
    }

    #[tokio::test(start_paused = true)]
    async fn a_nonsense_frame_from_discord_ends_it_and_a_disabled_one_never_connects() {
        let (connector, mut theirs, attempts) = discord(1);
        let mut d = theirs.remove(0);
        let p = Presence::new(ID, connector.clone(), 1);
        p.set_enabled(false);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(*attempts.lock().unwrap(), 0, "off means off");
        p.set_enabled(true);
        read_frame(&mut d).await;
        let mut bad = vec![1, 0, 0, 0];
        bad.extend_from_slice(&(1_000_000i32).to_le_bytes());
        d.write_all(&bad).await.unwrap();
        tokio::time::sleep(Duration::from_secs(300)).await;
        assert_eq!(*attempts.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn without_an_application_id_switching_on_does_nothing() {
        let (connector, _theirs, attempts) = discord(1);
        let p = Presence::new("", connector, 1);
        p.set_enabled(true);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(*attempts.lock().unwrap(), 0);
        p.shutdown().await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn over_a_real_windows_named_pipe_the_hello_arrives_and_the_line_is_set() {
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = format!(r"\\.\pipe\vp-test-ipc-{}", std::process::id());
        let server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
        let connector: Connector = {
            let name = name.clone();
            Arc::new(move |n| {
                let name = name.clone();
                Box::pin(async move {
                    if n != 0 {
                        return Err(std::io::Error::other("no such pipe"));
                    }
                    Ok(Box::new(tokio::net::windows::named_pipe::ClientOptions::new().open(&name)?) as Stream)
                })
            })
        };
        let p = Presence::new(ID, connector, 99);
        p.update(Some(info(1)));
        p.set_enabled(true);
        server.connect().await.unwrap();
        let mut server = server;
        let mut dec = Decoder::default();
        let mut buf = [0u8; 4096];
        let mut frames = Vec::new();
        let n = tokio::time::timeout(Duration::from_secs(5), server.read(&mut buf)).await.unwrap().unwrap();
        frames.extend(dec.feed(&buf[..n]));
        assert_eq!(frames[0], (OP_HANDSHAKE, Some(json!({ "v": 1, "client_id": ID }))));
        server.write_all(&encode(OP_FRAME, &json!({ "evt": "READY" }))).await.unwrap();
        while frames.len() < 2 {
            let n = tokio::time::timeout(Duration::from_secs(5), server.read(&mut buf)).await.unwrap().unwrap();
            frames.extend(dec.feed(&buf[..n]));
        }
        assert_eq!(frames[1].1.as_ref().unwrap()["args"]["activity"]["state"], "1 player online");
        p.shutdown().await;
    }
}

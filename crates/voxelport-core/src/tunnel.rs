//! The VoxelPort host protocol: the same contract the Fabric mod speaks (see the relay's README). Ported from `tunnel.js`.
//!
//! The tunnel opens a WebSocket to the relay, registers with the device token, receives a public port, and bridges every player the
//! relay announces to the local Minecraft server (TCP), and every Bedrock/voice datagram to the local UDP port. The relay is untrusted
//! input: every frame is validated before anything acts on it, a malicious relay cannot make the app open unlimited local sockets, and
//! memory per player and per tunnel is bounded.
//!
//! How it runs: one task owns the connection (the "actor"). Each player has a small task that talks to the local server; each UDP
//! session has one; a writer task owns the socket's sending half. They talk to the actor through channels, so nothing blocks the reading
//! of relay frames. Local servers are read only while the relay connection is keeping up (a byte budget), so a slow relay slows the
//! players instead of growing memory, and a connection that makes no progress for 30 seconds is dropped and reconnected.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

/// Matches the relay's own maximum WebSocket message, so a legitimate maximum-size frame is never rejected.
pub const MAX_WS_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
/// A base64 `data` field this long could never decode to a legitimate frame within the limit above.
const MAX_B64_DATA_CHARS: usize = (MAX_WS_MESSAGE_BYTES * 4).div_ceil(3) + 1024;
const MAX_CONN_ID_LEN: usize = 128;
/// A misbehaving relay must not make VoxelPort open unlimited local sockets. Matches the relay's own per-tunnel player cap.
pub const MAX_LOCAL_PLAYERS: usize = 256;
/// Handshake time for a relay address that has a fallback behind it, so a network that silently drops the direct port does not stall hosting.
const FALLBACK_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Bytes handed to a local socket that has not finished flushing them yet, per player. Once exceeded the player is disconnected cleanly.
const MAX_PLAYER_PENDING_WRITE_BYTES: usize = 8 * 1024 * 1024;
/// Bytes waiting to go to the relay before the local servers are no longer read (and the longest the relay may make no progress).
const OUTBOUND_HIGH_WATERMARK: usize = 4 * 1024 * 1024;
const WS_STALL_TIMEOUT: Duration = Duration::from_secs(30);
const LOCAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub const FRAME_TCP: u8 = 0x01;
pub const FRAME_UDP: u8 = 0x02;
pub const FRAME_VOICE_UDP: u8 = 0x03;
pub const FRAME_HEADER_LEN: usize = 17;
const BAD_FRAME_LOG_EVERY: Duration = Duration::from_secs(30);

const MAX_UDP_SESSIONS: usize = 256;
const MAX_UDP_DATAGRAM: usize = 2048;
const MAX_UDP_B64_CHARS: usize = (MAX_UDP_DATAGRAM * 4).div_ceil(3) + 4;
const UDP_SESSION_IDLE: Duration = Duration::from_secs(60);

// ─── Frames ─────────────────────────────────────────────────────────────────

pub struct Frame<'a> {
    pub kind: u8,
    /// The 32-character hex connection id.
    pub conn: String,
    pub payload: &'a [u8],
}

/// Splits a binary relay frame (kind, 16 raw id bytes, payload), or None when it cannot be one: shorter than its header, or a kind this
/// version does not know. What the connection id refers to is checked by the caller.
pub fn parse_binary_frame(buf: &[u8]) -> Option<Frame<'_>> {
    if buf.len() < FRAME_HEADER_LEN || !matches!(buf[0], FRAME_TCP | FRAME_UDP | FRAME_VOICE_UDP) {
        return None;
    }
    Some(Frame { kind: buf[0], conn: buf[1..FRAME_HEADER_LEN].iter().map(|b| format!("{b:02x}")).collect(), payload: &buf[FRAME_HEADER_LEN..] })
}

pub fn build_binary_frame(kind: u8, raw: &[u8; 16], payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
    f.push(kind);
    f.extend_from_slice(raw);
    f.extend_from_slice(payload);
    f
}

/// The 16 raw bytes of a 32-character lowercase hex connection id; any other id stays on JSON frames.
fn hex_conn_id(conn: &str) -> Option<[u8; 16]> {
    if conn.len() != 32 || !conn.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&conn[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn int_of(v: &Value) -> Option<i64> {
    v.as_f64().filter(|f| f.fract() == 0.0 && f.is_finite()).map(|f| f as i64)
}

fn port_ok(v: &Value) -> bool {
    int_of(v).is_some_and(|p| (1..=65535).contains(&p))
}

fn conn_ok(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= MAX_CONN_ID_LEN)
}

fn opt<'a>(m: &'a Value, k: &str) -> Option<&'a Value> {
    m.get(k)
}

fn opt_str_max(m: &Value, k: &str, max: usize) -> bool {
    opt(m, k).map_or(true, |v| v.as_str().is_some_and(|s| s.len() <= max))
}

/// Validates an incoming relay frame before anything acts on it. Unknown types are left to the caller's `match` (which safely ignores
/// them); every known type gets its fields checked here.
pub fn is_valid_relay_message(msg: &Value) -> bool {
    let Some(ty) = msg.get("type").and_then(Value::as_str) else { return false };
    if let Some(r) = opt(msg, "rank") {
        if !r.as_str().is_some_and(|r| matches!(r, "free" | "supporter" | "supporter_plus")) {
            return false;
        }
    }
    match ty {
        "port" => {
            let port = &msg["port"];
            let bedrock = opt(msg, "bedrock_port").map_or(true, |b| port_ok(b) && b != port && opt(msg, "voice_port").map_or(true, |v| b != v));
            port_ok(port) && bedrock && opt(msg, "voice_port").map_or(true, port_ok) && opt(msg, "bin").map_or(true, |b| int_of(b).is_some())
        }
        "connect" => conn_ok(&msg["conn"]) && opt(msg, "bedrock").map_or(true, Value::is_boolean) && opt_str_max(msg, "ip", 64),
        "data" => conn_ok(&msg["conn"]) && msg["data"].as_str().is_some_and(|d| d.len() <= MAX_B64_DATA_CHARS),
        "close" | "udp_close" | "voice_udp_close" => conn_ok(&msg["conn"]),
        "error" | "name_error" | "listing_error" | "udp_error" | "voice_error" => opt_str_max(msg, "message", 500),
        "udp" | "voice_udp" => conn_ok(&msg["conn"]) && msg["data"].as_str().is_some_and(|d| d.len() <= MAX_UDP_B64_CHARS) && opt_str_max(msg, "ip", 64),
        "name" => {
            let name_ok = opt(msg, "name").map_or(true, |n| n.as_str().is_some_and(|s| s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')));
            name_ok && opt_str_max(msg, "address", 253)
        }
        // An announcement from the relay's operator. The text is shown, never acted on.
        "notice" => opt_str_max(msg, "message", 300) && opt(msg, "seconds").map_or(true, |s| int_of(s).is_some_and(|n| (0..=172_800).contains(&n))),
        _ => true,
    }
}

// ─── Events, commands and the handle ────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum TunnelEvent {
    Status(&'static str),
    Log(String),
    Error(String),
    /// The public port; the Bedrock public port when the relay gave one.
    Assigned { port: u16, bedrock_port: Option<u16> },
    Players(usize),
    Ping(u64),
    Rank(Option<String>),
    VoiceAssigned(Option<u16>),
    Name { name: String, address: String },
    NameError(String),
    ListingError(String),
    UdpError(String),
    VoiceError(String),
    Notice { message: String, seconds: u64 },
    Stopped,
}

#[derive(Clone, Debug, Default)]
pub struct StartParams {
    /// Ordered candidates, preferred first. A candidate that cannot be reached at all is skipped at once; after any drop of an
    /// established connection the preferred one is tried again first.
    pub relay_urls: Vec<String>,
    pub token: String,
    pub local_port: u16,
    pub udp_port: Option<u16>,
    pub bedrock_port: Option<u16>,
    pub voice_port: Option<u16>,
    pub voice_auto: bool,
    /// "desktop/1.7.0": goes into the relay's log so a support question can be answered.
    pub client: Option<String>,
}

enum Cmd {
    Stop,
    Send(Value),
}

struct Inner {
    cmd: Mutex<Option<UnboundedSender<Cmd>>>,
    ev: UnboundedSender<TunnelEvent>,
    /// From start() until 'stopped': connecting, online and reconnecting all count.
    live: AtomicBool,
    /// Registered with the relay and online.
    running: AtomicBool,
    bin: AtomicBool,
    manual_stop: AtomicBool,
    bedrock_public: AtomicU32,
    voice_public: AtomicU32,
    players: AtomicUsize,
    udp_sessions: AtomicUsize,
    listing: Mutex<Option<Value>>,
    rank: Mutex<Option<String>>,
    relay_url: Mutex<String>,
    udp_port: Mutex<Option<u16>>,
}

#[derive(Clone)]
pub struct Tunnel(Arc<Inner>);

impl Tunnel {
    /// A tunnel that has not started. Listen on the receiver, then call [`Tunnel::start`].
    pub fn new() -> (Tunnel, UnboundedReceiver<TunnelEvent>) {
        let (ev, rx) = unbounded_channel();
        let inner = Inner {
            cmd: Mutex::new(None),
            ev,
            live: AtomicBool::new(false),
            running: AtomicBool::new(false),
            bin: AtomicBool::new(false),
            manual_stop: AtomicBool::new(false),
            bedrock_public: AtomicU32::new(0),
            voice_public: AtomicU32::new(0),
            players: AtomicUsize::new(0),
            udp_sessions: AtomicUsize::new(0),
            listing: Mutex::new(None),
            rank: Mutex::new(None),
            relay_url: Mutex::new(String::new()),
            udp_port: Mutex::new(None),
        };
        (Tunnel(Arc::new(inner)), rx)
    }

    /// Whether two handles are the same tunnel (a replaced tunnel finishing late must not be mistaken for the current one).
    pub fn same(&self, other: &Tunnel) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// True from start() until 'stopped': a tunnel that is still connecting or reconnecting exists, even though it is not online.
    pub fn is_live(&self) -> bool {
        self.0.live.load(Ordering::SeqCst)
    }
    /// Registered with the relay and online.
    pub fn is_running(&self) -> bool {
        self.0.running.load(Ordering::SeqCst)
    }
    /// Protocol v2 (binary frames) is on for the current connection.
    pub fn is_binary(&self) -> bool {
        self.0.bin.load(Ordering::SeqCst)
    }
    pub fn bedrock_public_port(&self) -> Option<u16> {
        Some(self.0.bedrock_public.load(Ordering::SeqCst) as u16).filter(|p| *p != 0)
    }
    pub fn voice_public_port(&self) -> Option<u16> {
        Some(self.0.voice_public.load(Ordering::SeqCst) as u16).filter(|p| *p != 0)
    }
    pub fn udp_port(&self) -> Option<u16> {
        *self.0.udp_port.lock().unwrap()
    }
    pub fn rank(&self) -> Option<String> {
        self.0.rank.lock().unwrap().clone()
    }
    pub fn relay_url(&self) -> String {
        self.0.relay_url.lock().unwrap().clone()
    }
    /// Players on the Java side (Bedrock signalling is not counted).
    pub fn player_count(&self) -> usize {
        self.0.players.load(Ordering::SeqCst)
    }
    pub fn udp_session_count(&self) -> usize {
        self.0.udp_sessions.load(Ordering::SeqCst)
    }

    fn emit(&self, e: TunnelEvent) {
        let _ = self.0.ev.send(e);
    }

    /// The end of this tunnel's life: said once, whichever way it got here.
    fn finish(&self) {
        if !self.0.live.swap(false, Ordering::SeqCst) {
            return;
        }
        self.0.running.store(false, Ordering::SeqCst);
        self.emit(TunnelEvent::Status("stopped"));
        self.emit(TunnelEvent::Stopped);
    }

    pub fn start(&self, p: StartParams) {
        let urls = if p.relay_urls.is_empty() { vec![String::new()] } else { p.relay_urls.clone() };
        for u in &urls {
            let ok = url::Url::parse(u).is_ok_and(|x| matches!(x.scheme(), "ws" | "wss") && x.host_str().is_some());
            if !ok {
                self.emit(TunnelEvent::Error(format!("Bad relay URL: {u}")));
                self.0.live.store(true, Ordering::SeqCst);
                self.finish(); // nothing will ever connect: do not stay "live" with no socket
                return;
            }
        }
        self.0.live.store(true, Ordering::SeqCst);
        self.0.manual_stop.store(false, Ordering::SeqCst);
        *self.0.udp_port.lock().unwrap() = p.udp_port;
        *self.0.rank.lock().unwrap() = None;
        let (tx, rx) = unbounded_channel();
        *self.0.cmd.lock().unwrap() = Some(tx);
        let me = self.clone();
        tokio::spawn(async move { me.run(StartParams { relay_urls: urls, ..p }, rx).await });
    }

    /// Asks the relay for the custom address `name` (answered by `Name` or `NameError`).
    pub fn claim_name(&self, name: &str) {
        self.send_cmd(Cmd::Send(json!({ "type": "claim_name", "name": name.trim().to_lowercase() })));
    }

    pub fn release_name(&self) {
        self.send_cmd(Cmd::Send(json!({ "type": "release_name" })));
    }

    /// Publishes (or, with None, withdraws) this server's public-list entry. Sent again after every registration.
    pub fn set_listing(&self, listing: Option<Value>) {
        *self.0.listing.lock().unwrap() = listing.clone();
        if self.is_running() {
            self.send_cmd(Cmd::Send(match listing {
                Some(l) => json!({ "type": "listing", "listing": l }),
                None => json!({ "type": "listing" }),
            }));
        }
    }

    pub fn stop(&self) {
        if !self.is_live() || self.0.manual_stop.swap(true, Ordering::SeqCst) {
            return; // never started, or already stopping: one 'stopped' per life
        }
        self.send_cmd(Cmd::Stop);
    }

    fn send_cmd(&self, c: Cmd) {
        if let Some(tx) = self.0.cmd.lock().unwrap().as_ref() {
            let _ = tx.send(c);
        }
    }

    // ─── The connection loop ────────────────────────────────────────────────

    async fn run(self, p: StartParams, mut cmd_rx: UnboundedReceiver<Cmd>) {
        let mut url_index = 0usize;
        let mut reconnect_delay = Duration::from_secs(1);
        loop {
            let relay = p.relay_urls[url_index].clone();
            *self.0.relay_url.lock().unwrap() = relay.clone();
            let has_fallback = url_index + 1 < p.relay_urls.len();
            self.emit(TunnelEvent::Status("connecting"));
            self.emit(TunnelEvent::Log(format!("Connecting to {relay}…")));

            let url = format!("{}/ws", relay.trim_end_matches('/'));
            let config = WebSocketConfig::default().max_message_size(Some(MAX_WS_MESSAGE_BYTES)).max_frame_size(Some(MAX_WS_MESSAGE_BYTES));
            let handshake = if has_fallback { FALLBACK_HANDSHAKE_TIMEOUT } else { HANDSHAKE_TIMEOUT };
            let connect = tokio::time::timeout(handshake, tokio_tungstenite::connect_async_with_config(url, Some(config), false));
            tokio::pin!(connect);
            let connected = loop {
                tokio::select! {
                    r = &mut connect => break r,
                    c = cmd_rx.recv() => match c {
                        Some(Cmd::Stop) | None => { self.finish(); return; }
                        Some(Cmd::Send(_)) => {}
                    },
                }
            };
            let mut opened = false;
            if let Ok(Ok((ws, _))) = connected {
                opened = true;
                if self.session(ws, &p, &mut cmd_rx, &mut reconnect_delay).await == SessionEnd::Stopped {
                    self.finish();
                    return;
                }
            } else if let Ok(Err(e)) = &connected {
                self.emit(TunnelEvent::Log(format!("Socket error: {e}")));
            }
            if self.0.manual_stop.load(Ordering::SeqCst) {
                self.finish();
                return;
            }
            self.0.running.store(false, Ordering::SeqCst);
            self.0.bedrock_public.store(0, Ordering::SeqCst);
            // Never reached this candidate: move straight on to the next one.
            if !opened && has_fallback {
                url_index += 1;
                self.emit(TunnelEvent::Log(format!("Could not reach {relay}, trying {}…", p.relay_urls[url_index])));
                continue;
            }
            // The next attempt starts from the preferred candidate again.
            url_index = 0;
            self.emit(TunnelEvent::Status("reconnecting"));
            self.emit(TunnelEvent::Log(format!("Disconnected. Reconnecting in {}s…", reconnect_delay.as_secs_f64().round() as u64)));
            let wait = tokio::time::sleep(reconnect_delay);
            tokio::pin!(wait);
            loop {
                tokio::select! {
                    () = &mut wait => break,
                    c = cmd_rx.recv() => if matches!(c, Some(Cmd::Stop) | None) { self.finish(); return; },
                }
            }
            reconnect_delay = (reconnect_delay * 2).min(Duration::from_secs(15));
        }
    }
}

#[derive(PartialEq)]
enum SessionEnd {
    Stopped,
    Dropped,
}

// Messages from the per-player and per-session tasks to the actor.
enum Internal {
    PlayerData { conn: String, gen: u64, data: Vec<u8> },
    PlayerClosed { conn: String, gen: u64 },
    UdpData { conn: String, voice: bool, gen: u64, data: Vec<u8> },
    UdpClosed { conn: String, voice: bool, gen: u64 },
    WriterFailed,
}

enum Out {
    Msg(Message, usize),
    Close,
}

struct Player {
    gen: u64,
    tx: UnboundedSender<Vec<u8>>,
    pending: Arc<AtomicUsize>,
    raw: Option<[u8; 16]>,
    bedrock: bool,
    task: tokio::task::AbortHandle,
}

struct UdpSession {
    gen: u64,
    tx: UnboundedSender<Vec<u8>>,
    raw: Option<[u8; 16]>,
    task: tokio::task::AbortHandle,
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

struct Session<'a> {
    t: &'a Tunnel,
    p: &'a StartParams,
    out: UnboundedSender<Out>,
    internal: UnboundedSender<Internal>,
    outbound: Arc<AtomicUsize>,
    players: HashMap<String, Player>,
    udp: HashMap<String, UdpSession>,
    voice: HashMap<String, UdpSession>,
    gen: u64,
    bad_frame_logged: Option<Instant>,
    last_ping: Option<Instant>,
    pinging: bool,
}

impl Tunnel {
    async fn session(&self, ws: Ws, p: &StartParams, cmd_rx: &mut UnboundedReceiver<Cmd>, reconnect_delay: &mut Duration) -> SessionEnd {
        let (sink, mut stream) = ws.split();
        let (out_tx, out_rx) = unbounded_channel::<Out>();
        let (int_tx, mut int_rx) = unbounded_channel::<Internal>();
        let outbound = Arc::new(AtomicUsize::new(0));
        let writer = tokio::spawn(writer_task(sink, out_rx, outbound.clone(), int_tx.clone()));
        let mut s = Session { t: self, p, out: out_tx, internal: int_tx, outbound, players: HashMap::new(), udp: HashMap::new(), voice: HashMap::new(), gen: 0, bad_frame_logged: None, last_ping: None, pinging: false };

        self.emit(TunnelEvent::Log("Connected. Registering…".into()));
        self.0.bin.store(false, Ordering::SeqCst); // decided again by every port frame
        let mut reg = json!({ "type": "register", "token": p.token, "bin": 1 });
        if let Some(c) = &p.client {
            reg["client"] = json!(c);
        }
        if p.udp_port.is_some() {
            reg["udp"] = json!(true);
        }
        if p.bedrock_port.is_some() {
            reg["bedrock"] = json!(true);
        }
        if p.voice_port.is_some() {
            reg[if p.voice_auto { "voice_auto" } else { "voice" }] = json!(true);
        }
        s.send_json(&reg);

        let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(15), Duration::from_secs(15));
        let end = loop {
            tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(t))) => { if s.on_message(t.as_str(), reconnect_delay) { break SessionEnd::Dropped; } }
                    Some(Ok(Message::Binary(b))) => s.on_binary(&b),
                    Some(Ok(Message::Ping(d))) => { let _ = s.out.send(Out::Msg(Message::Pong(d), 0)); }
                    Some(Ok(Message::Close(_))) | None => break SessionEnd::Dropped,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => { self.emit(TunnelEvent::Log(format!("Socket error: {e}"))); break SessionEnd::Dropped; }
                },
                i = int_rx.recv() => match i {
                    Some(i) => { if s.on_internal(i) { break SessionEnd::Dropped; } }
                    None => break SessionEnd::Dropped,
                },
                c = cmd_rx.recv() => match c {
                    Some(Cmd::Stop) | None => break SessionEnd::Stopped,
                    Some(Cmd::Send(v)) => s.send_json(&v),
                },
                _ = ping.tick(), if s.pinging => { s.last_ping = Some(Instant::now()); s.send_json(&json!({ "type": "ping" })); }
            }
        };

        s.teardown_players();
        s.teardown_udp();
        self.0.running.store(false, Ordering::SeqCst);
        self.0.bedrock_public.store(0, Ordering::SeqCst);
        let _ = s.out.send(Out::Close);
        drop(s);
        if end == SessionEnd::Stopped {
            let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
        } else {
            writer.abort();
        }
        end
    }
}

/// Owns the sending half. A send that makes no progress for 30 seconds ends the session (the relay path is stuck).
async fn writer_task<S>(mut sink: S, mut rx: UnboundedReceiver<Out>, outbound: Arc<AtomicUsize>, to_actor: UnboundedSender<Internal>)
where
    S: futures_util::Sink<Message> + Unpin,
{
    while let Some(o) = rx.recv().await {
        match o {
            Out::Msg(m, weight) => {
                let sent = tokio::time::timeout(WS_STALL_TIMEOUT, sink.send(m)).await;
                if weight > 0 {
                    outbound.fetch_sub(weight, Ordering::SeqCst);
                }
                if !matches!(sent, Ok(Ok(()))) {
                    let _ = to_actor.send(Internal::WriterFailed);
                    return;
                }
            }
            Out::Close => {
                let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
                return;
            }
        }
    }
}

impl Session<'_> {
    fn emit(&self, e: TunnelEvent) {
        self.t.emit(e);
    }

    fn log(&self, line: impl Into<String>) {
        self.emit(TunnelEvent::Log(line.into()));
    }

    fn send_json(&self, v: &Value) {
        let _ = self.out.send(Out::Msg(Message::Text(v.to_string().into()), 0));
    }

    fn send_binary(&self, frame: Vec<u8>, weight: usize) {
        self.outbound.fetch_add(weight, Ordering::SeqCst);
        let _ = self.out.send(Out::Msg(Message::Binary(frame.into()), weight));
    }

    fn bin(&self) -> bool {
        self.t.0.bin.load(Ordering::SeqCst)
    }

    fn note_bad_frame(&mut self, reason: &str) {
        let now = Instant::now();
        if self.bad_frame_logged.is_some_and(|t| now.duration_since(t) < BAD_FRAME_LOG_EVERY) {
            return;
        }
        self.bad_frame_logged = Some(now);
        self.log(format!("Ignored a binary frame from the relay ({reason}); more are not logged for {}s.", BAD_FRAME_LOG_EVERY.as_secs()));
    }

    fn emit_player_count(&self) {
        let n = self.players.values().filter(|p| !p.bedrock).count();
        self.t.0.players.store(n, Ordering::SeqCst);
        self.emit(TunnelEvent::Players(n));
    }

    /// One text frame from the relay. Returns true when the session should end (the relay asked us to reconnect).
    fn on_message(&mut self, raw: &str, reconnect_delay: &mut Duration) -> bool {
        let Ok(msg) = serde_json::from_str::<Value>(raw) else { return false };
        if !is_valid_relay_message(&msg) {
            self.log(format!("Ignored malformed relay frame (type={}).", msg.get("type").and_then(Value::as_str).unwrap_or("undefined")));
            return false;
        }
        let ty = msg["type"].as_str().unwrap_or("");
        let str_of = |k: &str| msg.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        match ty {
            "port" => {
                let inner = &self.t.0;
                inner.running.store(true, Ordering::SeqCst);
                inner.bin.store(msg["bin"].as_i64() == Some(1), Ordering::SeqCst); // only the relay saying so turns it on
                *reconnect_delay = Duration::from_secs(1);
                let bedrock_public = if self.p.bedrock_port.is_some() { msg["bedrock_port"].as_u64().map(|p| p as u16) } else { None };
                inner.bedrock_public.store(u32::from(bedrock_public.unwrap_or(0)), Ordering::SeqCst);
                let port = msg["port"].as_u64().unwrap_or(0) as u16;
                self.emit(TunnelEvent::Status("online"));
                self.emit(TunnelEvent::Assigned { port, bedrock_port: bedrock_public });
                let voice_public = if self.p.voice_port.is_some() { msg["voice_port"].as_u64().map(|p| p as u16) } else { None };
                inner.voice_public.store(u32::from(voice_public.unwrap_or(0)), Ordering::SeqCst);
                let rank = str_of("rank");
                *inner.rank.lock().unwrap() = rank.clone();
                self.emit(TunnelEvent::Rank(rank));
                self.emit(TunnelEvent::VoiceAssigned(voice_public));
                if self.p.voice_port.is_some() && !self.p.voice_auto && voice_public.is_none() {
                    self.log("Voice chat is unavailable on this relay or requires Supporter Plus.");
                }
                self.log(format!("Tunnel is live on public port {port}."));
                if self.p.bedrock_port.is_some() && bedrock_public.is_none() {
                    self.emit(TunnelEvent::UdpError("Bedrock needs an updated relay with a separate TCP and UDP port. Java is still available.".into()));
                }
                self.pinging = true;
                let listing = inner.listing.lock().unwrap().clone();
                if let Some(l) = listing {
                    self.send_json(&json!({ "type": "listing", "listing": l }));
                }
            }
            "name" => self.emit(TunnelEvent::Name { name: str_of("name").unwrap_or_default(), address: str_of("address").unwrap_or_default() }),
            "name_error" => self.emit(TunnelEvent::NameError(str_of("message").unwrap_or_else(|| "Could not set that address.".into()))),
            "listing_error" => self.emit(TunnelEvent::ListingError(str_of("message").unwrap_or_else(|| "Could not list this server.".into()))),
            "notice" => self.emit(TunnelEvent::Notice { message: str_of("message").unwrap_or_default(), seconds: msg["seconds"].as_u64().unwrap_or(0) }),
            "udp_error" => {
                self.t.0.bedrock_public.store(0, Ordering::SeqCst);
                let m = str_of("message").unwrap_or_else(|| "Bedrock forwarding is unavailable.".into());
                self.emit(TunnelEvent::UdpError(m.clone()));
                self.log(format!("Relay: {m}"));
            }
            "voice_error" => {
                let m = str_of("message").unwrap_or_else(|| "Voice chat forwarding is unavailable.".into());
                self.emit(TunnelEvent::VoiceError(m.clone()));
                self.log(format!("Relay: {m}"));
            }
            "udp" | "voice_udp" => {
                if let Ok(data) = B64.decode(msg["data"].as_str().unwrap_or("")) {
                    self.receive_udp(msg["conn"].as_str().unwrap_or(""), &data, ty == "voice_udp");
                }
            }
            "udp_close" => self.close_udp(msg["conn"].as_str().unwrap_or(""), false, false),
            "voice_udp_close" => self.close_udp(msg["conn"].as_str().unwrap_or(""), false, true),
            "error" => {
                let m = str_of("message").unwrap_or_else(|| "relay rejected the connection".into());
                self.emit(TunnelEvent::Error(m));
                self.log(format!("Relay error: {}", str_of("message").unwrap_or_else(|| "unknown".into())));
            }
            "connect" => {
                let conn = msg["conn"].as_str().unwrap_or("").to_string();
                let bedrock = msg["bedrock"] == true;
                if bedrock && (self.p.bedrock_port.is_none() || self.t.bedrock_public_port().is_none()) {
                    self.send_json(&json!({ "type": "close", "conn": conn }));
                    return false;
                }
                if self.players.contains_key(&conn) {
                    self.log("Ignored duplicate connect for an already-open connection."); // never silently replace or leak the existing socket
                    return false;
                }
                if self.players.len() >= MAX_LOCAL_PLAYERS {
                    self.log(format!("Rejected a new player — local connection cap ({MAX_LOCAL_PLAYERS}) reached."));
                    self.send_json(&json!({ "type": "close", "conn": conn }));
                    return false;
                }
                self.open_player(conn, msg.get("ip").and_then(Value::as_str).map(str::to_string), bedrock);
            }
            "data" => {
                let conn = msg["conn"].as_str().unwrap_or("").to_string();
                if !self.players.contains_key(&conn) {
                    return false; // an unknown or already-closed id creates no state
                }
                // Malformed base64 is ignored (the connection survives one bad frame).
                let Ok(decoded) = B64.decode(msg["data"].as_str().unwrap_or("")) else { return false };
                // Dropping a chunk would leave a hole in the player's stream, so an oversized one ends that player instead.
                if decoded.len() > MAX_WS_MESSAGE_BYTES {
                    self.log("A frame from the relay was larger than allowed — disconnecting that player.");
                    self.close_player(&conn, true);
                    return false;
                }
                self.write_to_player(&conn, decoded);
            }
            "close" => self.close_player(msg["conn"].as_str().unwrap_or(""), false),
            "pong" => {
                if let Some(t) = self.last_ping {
                    self.emit(TunnelEvent::Ping(t.elapsed().as_millis() as u64));
                }
                if let Some(rank) = str_of("rank") {
                    let previous = self.t.rank();
                    if previous.as_deref() != Some(rank.as_str()) {
                        *self.t.0.rank.lock().unwrap() = Some(rank.clone());
                        self.emit(TunnelEvent::Rank(Some(rank.clone())));
                        // Re-register once on an entitlement change, to allocate or release voice safely.
                        if self.p.voice_auto && self.p.voice_port.is_some() && (previous.as_deref() == Some("supporter_plus") || rank == "supporter_plus") {
                            return true;
                        }
                    }
                }
            }
            _ => {}
        }
        false
    }

    /// A binary frame from the relay: validated, then handled like the JSON data/udp frame it replaces.
    fn on_binary(&mut self, data: &[u8]) {
        if !self.bin() {
            self.note_bad_frame("the relay sent a binary frame without agreeing to protocol v2");
            return;
        }
        let Some(frame) = parse_binary_frame(data) else {
            self.note_bad_frame("too short, or an unknown kind");
            return;
        };
        if frame.payload.is_empty() {
            return;
        }
        if frame.kind == FRAME_TCP {
            if !self.players.contains_key(&frame.conn) {
                self.note_bad_frame("it names a connection that does not exist");
                return;
            }
            if frame.payload.len() > MAX_WS_MESSAGE_BYTES {
                self.log("A frame from the relay was larger than allowed — disconnecting that player.");
                self.close_player(&frame.conn, true);
                return;
            }
            self.write_to_player(&frame.conn, frame.payload.to_vec());
            return;
        }
        // UDP: the first datagram of a session names an id nobody has seen yet, exactly as the JSON udp frame does.
        self.receive_udp(&frame.conn, frame.payload, frame.kind == FRAME_VOICE_UDP);
    }

    fn on_internal(&mut self, i: Internal) -> bool {
        match i {
            Internal::WriterFailed => {
                self.log("Relay connection is stalled or broken.");
                return true;
            }
            Internal::PlayerData { conn, gen, data } => {
                if self.players.get(&conn).is_some_and(|p| p.gen == gen) {
                    let raw = self.players[&conn].raw;
                    let n = data.len();
                    match (self.bin(), raw) {
                        (true, Some(raw)) => self.send_binary(build_binary_frame(FRAME_TCP, &raw, &data), n),
                        _ => {
                            self.outbound.fetch_add(n, Ordering::SeqCst);
                            let _ = self.out.send(Out::Msg(Message::Text(json!({ "type": "data", "conn": conn, "data": B64.encode(&data) }).to_string().into()), n));
                        }
                    }
                } else {
                    // The player is gone: the bytes that were counted when they were read are released.
                    self.outbound.fetch_sub(data.len().min(self.outbound.load(Ordering::SeqCst)), Ordering::SeqCst);
                }
            }
            Internal::PlayerClosed { conn, gen } => {
                if self.players.get(&conn).is_some_and(|p| p.gen == gen) {
                    self.close_player(&conn, true);
                }
            }
            Internal::UdpData { conn, voice, gen, data } => {
                let map = if voice { &self.voice } else { &self.udp };
                if let Some(s) = map.get(&conn).filter(|s| s.gen == gen) {
                    let kind = if voice { FRAME_VOICE_UDP } else { FRAME_UDP };
                    match (self.bin(), s.raw) {
                        (true, Some(raw)) => self.send_binary(build_binary_frame(kind, &raw, &data), 0),
                        _ => self.send_json(&json!({ "type": if voice { "voice_udp" } else { "udp" }, "conn": conn, "data": B64.encode(&data) })),
                    }
                }
            }
            Internal::UdpClosed { conn, voice, gen } => {
                let map = if voice { &self.voice } else { &self.udp };
                if map.get(&conn).is_some_and(|s| s.gen == gen) {
                    self.close_udp(&conn, true, voice);
                }
            }
        }
        false
    }

    // ─── Players (TCP) ──────────────────────────────────────────────────────

    fn open_player(&mut self, conn: String, ip: Option<String>, bedrock: bool) {
        self.gen += 1;
        let gen = self.gen;
        let port = if bedrock { self.p.bedrock_port } else { Some(self.p.local_port) }.unwrap_or(self.p.local_port);
        let (tx, rx) = unbounded_channel::<Vec<u8>>();
        let pending = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(player_task(conn.clone(), gen, port, self.internal.clone(), rx, pending.clone(), self.outbound.clone(), self.t.0.ev.clone()));
        self.players.insert(conn.clone(), Player { gen, tx, pending, raw: hex_conn_id(&conn), bedrock, task: task.abort_handle() });
        self.emit_player_count();
        self.log(format!("{} connected{} → 127.0.0.1:{port}", if bedrock { "Bedrock signaling" } else { "Player" }, ip.map(|i| format!(" from {i}")).unwrap_or_default()));
    }

    /// Relay -> local server, with a bounded per-player pending-write budget.
    fn write_to_player(&mut self, conn: &str, chunk: Vec<u8>) {
        let Some(p) = self.players.get(conn) else { return };
        if p.pending.load(Ordering::SeqCst) + chunk.len() > MAX_PLAYER_PENDING_WRITE_BYTES {
            self.log("A player's local connection could not keep up — disconnecting it.");
            self.close_player(conn, true);
            return;
        }
        p.pending.fetch_add(chunk.len(), Ordering::SeqCst);
        let _ = p.tx.send(chunk);
    }

    fn close_player(&mut self, conn: &str, notify_relay: bool) {
        let Some(p) = self.players.remove(conn) else { return };
        p.task.abort();
        if notify_relay {
            self.send_json(&json!({ "type": "close", "conn": conn }));
        }
        self.emit_player_count();
    }

    fn teardown_players(&mut self) {
        for (_, p) in self.players.drain() {
            p.task.abort();
        }
        self.t.0.players.store(0, Ordering::SeqCst);
        self.emit(TunnelEvent::Players(0));
    }

    // ─── UDP (Bedrock and voice) ────────────────────────────────────────────

    fn receive_udp(&mut self, conn: &str, data: &[u8], voice: bool) {
        let port = if voice { self.p.voice_port } else { self.p.udp_port };
        let Some(port) = port else { return };
        if (voice && self.t.voice_public_port().is_none()) || (!voice && self.p.bedrock_port.is_some() && self.t.bedrock_public_port().is_none()) || data.is_empty() || data.len() > MAX_UDP_DATAGRAM {
            return;
        }
        let exists = if voice { self.voice.contains_key(conn) } else { self.udp.contains_key(conn) };
        if !exists {
            let count = if voice { self.voice.len() } else { self.udp.len() };
            if count >= MAX_UDP_SESSIONS {
                return;
            }
            self.open_udp(conn.to_string(), voice, port);
        }
        let map = if voice { &self.voice } else { &self.udp };
        if let Some(s) = map.get(conn) {
            let _ = s.tx.send(data.to_vec());
        }
    }

    fn open_udp(&mut self, conn: String, voice: bool, port: u16) {
        self.gen += 1;
        let gen = self.gen;
        let (tx, rx) = unbounded_channel::<Vec<u8>>();
        let task = tokio::spawn(udp_task(conn.clone(), voice, gen, port, self.internal.clone(), rx));
        let s = UdpSession { gen, tx, raw: hex_conn_id(&conn), task: task.abort_handle() };
        if voice { self.voice.insert(conn, s) } else { self.udp.insert(conn, s) };
        self.t.0.udp_sessions.store(self.udp.len() + self.voice.len(), Ordering::SeqCst);
    }

    fn close_udp(&mut self, conn: &str, notify_relay: bool, voice: bool) {
        let removed = if voice { self.voice.remove(conn) } else { self.udp.remove(conn) };
        let Some(s) = removed else { return };
        s.task.abort();
        self.t.0.udp_sessions.store(self.udp.len() + self.voice.len(), Ordering::SeqCst);
        if notify_relay {
            self.send_json(&json!({ "type": if voice { "voice_udp_close" } else { "udp_close" }, "conn": conn }));
        }
    }

    fn teardown_udp(&mut self) {
        for (_, s) in self.udp.drain().chain(self.voice.drain()) {
            s.task.abort();
        }
        self.t.0.udp_sessions.store(0, Ordering::SeqCst);
        self.t.0.voice_public.store(0, Ordering::SeqCst);
        self.emit(TunnelEvent::VoiceAssigned(None));
    }
}

/// One player: connect to the local server, then pass bytes both ways. Local bytes are only read while the relay connection is keeping up.
#[allow(clippy::too_many_arguments)]
async fn player_task(conn: String, gen: u64, port: u16, to_actor: UnboundedSender<Internal>, mut rx: UnboundedReceiver<Vec<u8>>, pending: Arc<AtomicUsize>, outbound: Arc<AtomicUsize>, ev: UnboundedSender<TunnelEvent>) {
    let closed = |to: &UnboundedSender<Internal>| {
        let _ = to.send(Internal::PlayerClosed { conn: conn.clone(), gen });
    };
    let stream = match tokio::time::timeout(LOCAL_CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", port))).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let _ = ev.send(TunnelEvent::Log(format!("Could not reach a local server on 127.0.0.1:{port}: {e}")));
            return closed(&to_actor);
        }
        Err(_) => {
            let _ = ev.send(TunnelEvent::Log(format!("Could not reach a local server on 127.0.0.1:{port}: Local server connect timeout after {}ms", LOCAL_CONNECT_TIMEOUT.as_millis())));
            return closed(&to_actor);
        }
    };
    let _ = stream.set_nodelay(true);
    let (mut rd, mut wr) = stream.into_split();
    let to_actor2 = to_actor.clone();
    let (conn2, pending2) = (conn.clone(), pending.clone());
    let writer = tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let n = chunk.len();
            let ok = wr.write_all(&chunk).await.is_ok();
            pending2.fetch_sub(n, Ordering::SeqCst);
            if !ok {
                break;
            }
        }
        let _ = to_actor2.send(Internal::PlayerClosed { conn: conn2, gen });
    });
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        // Backpressure: while the relay is behind, leave the local server's bytes in its socket.
        let mut waited = Duration::ZERO;
        while outbound.load(Ordering::SeqCst) > OUTBOUND_HIGH_WATERMARK {
            tokio::time::sleep(Duration::from_millis(20)).await;
            waited += Duration::from_millis(20);
            if waited > WS_STALL_TIMEOUT {
                let _ = ev.send(TunnelEvent::Log("Relay connection is stalled — disconnecting paused players.".into()));
                writer.abort();
                return closed(&to_actor);
            }
        }
        match rd.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                outbound.fetch_add(n, Ordering::SeqCst);
                if to_actor.send(Internal::PlayerData { conn: conn.clone(), gen, data: buf[..n].to_vec() }).is_err() {
                    break;
                }
            }
        }
    }
    writer.abort();
    closed(&to_actor);
}

/// One UDP session (a Bedrock client or a voice client): a socket to the local port; replies go back to the relay. Idle sessions end.
async fn udp_task(conn: String, voice: bool, gen: u64, port: u16, to_actor: UnboundedSender<Internal>, mut rx: UnboundedReceiver<Vec<u8>>) {
    let Ok(sock) = UdpSocket::bind("127.0.0.1:0").await else {
        let _ = to_actor.send(Internal::UdpClosed { conn, voice, gen });
        return;
    };
    let mut buf = vec![0u8; 65536];
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(d) => { let _ = sock.send_to(&d, ("127.0.0.1", port)).await; }
                None => return,
            },
            r = sock.recv_from(&mut buf) => match r {
                Ok((n, _)) if n <= MAX_UDP_DATAGRAM => { let _ = to_actor.send(Internal::UdpData { conn: conn.clone(), voice, gen, data: buf[..n].to_vec() }); }
                Ok(_) => {}
                // On Windows a datagram sent to a closed local port makes the next receive fail (connection reset): not a reason to end.
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
                Err(_) => break,
            },
            () = tokio::time::sleep(UDP_SESSION_IDLE) => break,
        }
    }
    let _ = to_actor.send(Internal::UdpClosed { conn, voice, gen });
}

// Keep the unused-import lint honest on builds where the sequence counter is not used.
#[allow(dead_code)]
static _SEQ: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_formed_frames_of_every_known_type_are_accepted() {
        for m in [json!({ "type": "port", "port": 25500 }), json!({ "type": "connect", "conn": "abc123", "ip": "1.2.3.4" }), json!({ "type": "data", "conn": "abc123", "data": "aGVsbG8=" }), json!({ "type": "close", "conn": "abc123" }), json!({ "type": "pong" }), json!({ "type": "error", "message": "bad token" }), json!({ "type": "some-future-type", "anything": "goes" })] {
            assert!(is_valid_relay_message(&m), "{m}");
        }
    }

    #[test]
    fn malformed_and_out_of_range_fields_are_rejected() {
        let long = "x".repeat(200);
        let huge = "x".repeat(10 * 1024 * 1024);
        for m in [Value::Null, json!("not an object"), json!({ "type": "port", "port": 99999 }), json!({ "type": "port", "port": "not a number" }), json!({ "type": "connect", "conn": "" }), json!({ "type": "connect", "conn": long }), json!({ "type": "data", "conn": "abc", "data": 123 }), json!({ "type": "data", "conn": "abc", "data": huge }), json!({ "type": "close", "conn": null }), json!({ "type": "pong", "rank": "king" }), json!({ "type": "pong", "rank": null })] {
            assert!(!is_valid_relay_message(&m), "{}", m.to_string().chars().take(80).collect::<String>());
        }
        assert!(is_valid_relay_message(&json!({ "type": "pong", "rank": "supporter_plus" })));
    }

    #[test]
    fn udp_name_notice_and_bedrock_frames_are_checked() {
        let ok = |m: Value| is_valid_relay_message(&m);
        assert!(ok(json!({ "type": "udp", "conn": "c1", "data": "aGk=", "ip": "1.2.3.4" })));
        assert!(!ok(json!({ "type": "udp", "conn": "c1", "data": "x".repeat(5000) })));
        assert!(!ok(json!({ "type": "udp_close", "conn": "" })));
        assert!(ok(json!({ "type": "name", "name": "steve", "address": "steve.voxelport.in" })) && ok(json!({ "type": "name" })));
        assert!(!ok(json!({ "type": "name", "name": "<script>" })) && !ok(json!({ "type": "name_error", "message": 42 })));
        assert!(ok(json!({ "type": "notice", "message": "ok", "seconds": 60 })) && ok(json!({ "type": "notice" })));
        for bad in [json!({ "type": "notice", "message": 5 }), json!({ "type": "notice", "message": "x".repeat(301) }), json!({ "type": "notice", "message": "ok", "seconds": -1 }), json!({ "type": "notice", "message": "ok", "seconds": 1.5 }), json!({ "type": "notice", "message": "ok", "seconds": 999_999_999 })] {
            assert!(!ok(bad.clone()), "{bad}");
        }
        assert!(!ok(json!({ "type": "port", "port": 26000, "bedrock_port": -1 })));
        assert!(!ok(json!({ "type": "port", "port": 26000, "bedrock_port": 26000 })));
        assert!(!ok(json!({ "type": "port", "port": 26000, "bedrock_port": 26001, "voice_port": 26001 })));
        assert!(ok(json!({ "type": "port", "port": 26000, "bedrock_port": 26001 })));
        assert!(!ok(json!({ "type": "connect", "conn": "abc", "bedrock": "true" })));
        assert!(ok(json!({ "type": "port", "port": 26000 })) && ok(json!({ "type": "port", "port": 26000, "bin": 1 })) && !ok(json!({ "type": "port", "port": 26000, "bin": "yes" })));
    }

    #[test]
    fn binary_frame_layout_and_what_is_refused() {
        let conn = "0123456789abcdef0123456789abcdef";
        let raw = hex_conn_id(conn).unwrap();
        let f = build_binary_frame(FRAME_UDP, &raw, b"abc");
        assert_eq!((f.len(), f[0]), (20, 0x02));
        assert_eq!(&f[1..17], &raw);
        let p = parse_binary_frame(&f).unwrap();
        assert_eq!((p.kind, p.conn.as_str(), p.payload), (FRAME_UDP, conn, &b"abc"[..]));
        assert!(parse_binary_frame(&[0u8; 16]).is_none(), "shorter than the header");
        assert!(parse_binary_frame(&[0u8; 17]).is_none(), "kind 0 is not a kind");
        let mut bad = vec![0x7f];
        bad.extend([0u8; 20]);
        assert!(parse_binary_frame(&bad).is_none());
        let mut empty = vec![FRAME_TCP];
        empty.extend(raw);
        assert!(parse_binary_frame(&empty).unwrap().payload.is_empty(), "an empty payload parses (and is ignored later)");
        assert_eq!((FRAME_TCP, FRAME_HEADER_LEN), (0x01, 17));
    }

    #[test]
    fn only_a_proper_hex_id_has_raw_bytes() {
        assert!(hex_conn_id("0123456789abcdef0123456789abcdef").is_some());
        for bad in ["conn-not-hex", "", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdeg"] {
            assert!(hex_conn_id(bad).is_none(), "{bad}");
        }
    }
}

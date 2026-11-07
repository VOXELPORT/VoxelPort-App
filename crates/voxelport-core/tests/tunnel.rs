//! The tunnel against a fake relay on a real socket, with real local servers (TCP echo, UDP echo). Ported from Electron's
//! `tunnel.test.js` and `bedrock-tunnel.test.js`. Where that suite poked at internals, these tests only watch what crosses the wire and
//! the events the app would see.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;
use voxelport_core::tunnel::*;

type Ws = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;
const TOKEN: &str = "vp_testtoken1234567890";
const WAIT: Duration = Duration::from_secs(8);

fn sha(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}
fn payload(n: usize, seed: u8) -> Vec<u8> {
    let mut x = u32::from(seed) + 12345;
    (0..n).map(|_| { x = x.wrapping_mul(1_103_515_245).wrapping_add(12345); (x >> 16) as u8 }).collect()
}
fn b64(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn unb64(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
fn hex_id(n: u8) -> String {
    format!("{:02x}", n).repeat(16)
}
fn raw_id(hex: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}

/// A local TCP server that echoes, optionally with a prefix, and remembers what it received and how many connections it got.
struct Echo {
    port: u16,
    received: Arc<Mutex<Vec<u8>>>,
    connections: Arc<Mutex<usize>>,
}
async fn echo(prefix: &'static str) -> Echo {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let (received, connections) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(0usize)));
    let (r2, c2) = (received.clone(), connections.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            *c2.lock().unwrap() += 1;
            let r3 = r2.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    r3.lock().unwrap().extend_from_slice(&buf[..n]);
                    let mut reply = prefix.as_bytes().to_vec();
                    reply.extend_from_slice(&buf[..n]);
                    if s.write_all(&reply).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    Echo { port, received, connections }
}

async fn udp_echo(prefix: &'static str) -> u16 {
    let s = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = s.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 4096];
        while let Ok((n, from)) = s.recv_from(&mut buf).await {
            let mut reply = prefix.as_bytes().to_vec();
            reply.extend_from_slice(&buf[..n]);
            let _ = s.send_to(&reply, from).await;
        }
    });
    port
}

/// A fake relay for one tunnel: it listens, the tunnel connects, and the test scripts frames directly.
struct Rig {
    tunnel: Tunnel,
    rx: UnboundedReceiver<TunnelEvent>,
    ws: Ws,
    reg: Value,
    seen: Vec<TunnelEvent>,
    listener: TcpListener,
}

async fn accept(l: &TcpListener) -> Ws {
    let (s, _) = tokio::time::timeout(WAIT, l.accept()).await.expect("the tunnel connected").unwrap();
    tokio_tungstenite::accept_async(s).await.unwrap()
}

impl Rig {
    async fn new(params: impl FnOnce(String) -> StartParams) -> Rig {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let (tunnel, rx) = Tunnel::new();
        tunnel.start(params(url));
        let ws = accept(&listener).await;
        let mut rig = Rig { tunnel, rx, ws, reg: Value::Null, seen: vec![], listener };
        rig.reg = rig.next_json().await;
        assert_eq!(rig.reg["type"], "register");
        rig
    }
    /// A tunnel with the usual parameters (and optional changes).
    async fn standard(local_port: u16, tweak: impl FnOnce(&mut StartParams)) -> Rig {
        Rig::new(move |url| {
            let mut p = StartParams { relay_urls: vec![url], token: TOKEN.into(), local_port, ..Default::default() };
            tweak(&mut p);
            p
        })
        .await
    }
    async fn send(&mut self, v: Value) {
        self.ws.send(Message::Text(v.to_string().into())).await.unwrap();
    }
    async fn send_bin(&mut self, kind: u8, conn: &str, data: &[u8]) {
        self.ws.send(Message::Binary(build_binary_frame(kind, &raw_id(conn), data).into())).await.unwrap();
    }
    async fn next_msg(&mut self) -> Message {
        loop {
            match tokio::time::timeout(WAIT, self.ws.next()).await.expect("a frame from the tunnel").expect("the socket stayed open").unwrap() {
                m @ (Message::Text(_) | Message::Binary(_)) => return m,
                _ => {}
            }
        }
    }
    async fn next_json(&mut self) -> Value {
        match self.next_msg().await {
            Message::Text(t) => serde_json::from_str(t.as_str()).unwrap(),
            other => panic!("expected JSON, got {other:?}"),
        }
    }
    async fn next_json_of(&mut self, ty: &str) -> Value {
        loop {
            match self.next_msg().await {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    if v["type"] == ty {
                        return v;
                    }
                }
                Message::Binary(_) => {}
                _ => {}
            }
        }
    }
    async fn event(&mut self, pred: impl Fn(&TunnelEvent) -> bool) -> TunnelEvent {
        let found = tokio::time::timeout(WAIT, async {
            loop {
                let e = self.rx.recv().await.expect("events kept coming");
                if pred(&e) {
                    return e;
                }
                self.seen.push(e);
            }
        })
        .await;
        found.expect("the event happened")
    }
    /// Sends a port frame and waits for the tunnel to say it is online.
    async fn go_online(&mut self, extra: Value) {
        let mut f = json!({ "type": "port", "port": 26137 });
        for (k, v) in extra.as_object().unwrap() {
            f[k] = v.clone();
        }
        self.send(f).await;
        self.event(|e| matches!(e, TunnelEvent::Assigned { .. })).await;
    }
    fn logs(&mut self) -> Vec<String> {
        while let Ok(e) = self.rx.try_recv() {
            self.seen.push(e);
        }
        self.seen.iter().filter_map(|e| if let TunnelEvent::Log(l) = e { Some(l.clone()) } else { None }).collect()
    }
    async fn pause(&self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
    async fn finish(mut self) {
        self.tunnel.stop();
        self.event(|e| matches!(e, TunnelEvent::Stopped)).await;
    }
}

// ─── The protocol round trip ─────────────────────────────────────────────────

#[tokio::test]
async fn register_port_connect_data_close_ping_pong_with_a_large_payload_verified_by_sha256() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    assert_eq!(r.reg["token"], TOKEN);
    r.go_online(json!({})).await;
    assert!(r.tunnel.is_running());

    let conn = "conn-1234567890abcdef";
    r.send(json!({ "type": "connect", "conn": conn, "ip": "203.0.113.5" })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(1))).await;
    let data = payload(3 * 1024 * 1024, 7);
    for chunk in data.chunks(64 * 1024) {
        r.send(json!({ "type": "data", "conn": conn, "data": b64(chunk) })).await;
    }
    let mut echoed = Vec::new();
    while echoed.len() < data.len() {
        let m = r.next_json_of("data").await;
        assert_eq!(m["conn"], conn);
        echoed.extend(unb64(m["data"].as_str().unwrap()));
    }
    assert_eq!(sha(&echoed[..data.len()]), sha(&data), "bytes must survive the full round trip unmodified and in order");
    assert_eq!(sha(&e.received.lock().unwrap()), sha(&data));

    // ping and pong: the tunnel pings every 15 s; a pong answers whatever ping was last sent, so send one the way the timer would.
    r.send(json!({ "type": "pong" })).await;
    r.pause(50).await;
    r.send(json!({ "type": "close", "conn": conn })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(0))).await;
    assert_eq!(r.tunnel.player_count(), 0);
    r.finish().await;
}

#[tokio::test]
async fn an_unexpected_drop_reconnects_and_a_manual_stop_ends_without_retry() {
    let mut r = Rig::standard(1, |_| {}).await;
    r.go_online(json!({})).await;
    r.ws.close(None).await.unwrap(); // the relay drops us
    r.event(|e| matches!(e, TunnelEvent::Status("reconnecting"))).await;
    assert!(!r.tunnel.is_running());
    assert!(r.tunnel.is_live());
    // It comes back by itself, registers again.
    let mut ws2 = accept(&r.listener).await;
    let again = loop {
        if let Some(Ok(Message::Text(t))) = ws2.next().await {
            break serde_json::from_str::<Value>(t.as_str()).unwrap();
        }
    };
    assert_eq!(again["type"], "register");
    r.tunnel.stop();
    r.event(|e| matches!(e, TunnelEvent::Stopped)).await;
    assert!(!r.tunnel.is_live());
}

#[tokio::test]
async fn players_past_the_local_cap_are_turned_away_cleanly() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({})).await;
    for i in 0..MAX_LOCAL_PLAYERS {
        r.send(json!({ "type": "connect", "conn": format!("filler-{i}") })).await;
    }
    r.event(|ev| matches!(ev, TunnelEvent::Players(n) if *n == MAX_LOCAL_PLAYERS)).await;
    r.send(json!({ "type": "connect", "conn": "one-too-many", "ip": "1.2.3.4" })).await;
    let close = r.next_json_of("close").await;
    assert_eq!(close["conn"], "one-too-many");
    assert_eq!(r.tunnel.player_count(), MAX_LOCAL_PLAYERS);
    assert!(r.logs().iter().any(|l| l.contains("local connection cap")));
    r.finish().await;
}

#[tokio::test]
async fn a_duplicate_connect_does_not_replace_the_open_connection() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({})).await;
    r.send(json!({ "type": "connect", "conn": "dup-conn", "ip": "1.2.3.4" })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(1))).await;
    r.send(json!({ "type": "connect", "conn": "dup-conn", "ip": "5.6.7.8" })).await;
    r.pause(150).await;
    assert_eq!(r.tunnel.player_count(), 1);
    assert_eq!(*e.connections.lock().unwrap(), 1, "only one local socket was ever opened");
    assert!(r.logs().iter().any(|l| l.contains("duplicate connect")));
    r.finish().await;
}

#[tokio::test]
async fn data_and_close_for_an_unknown_connection_create_no_state() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({})).await;
    r.send(json!({ "type": "data", "conn": "never-existed", "data": "aGVsbG8=" })).await;
    r.send(json!({ "type": "close", "conn": "never-existed" })).await;
    r.pause(150).await;
    assert_eq!((r.tunnel.player_count(), *e.connections.lock().unwrap()), (0, 0));
    r.finish().await;
}

#[tokio::test]
async fn malformed_base64_is_survived() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({})).await;
    r.send(json!({ "type": "connect", "conn": "c1", "ip": "1.2.3.4" })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(1))).await;
    r.send(json!({ "type": "data", "conn": "c1", "data": "***not valid base64***" })).await;
    r.pause(150).await;
    assert_eq!(r.tunnel.player_count(), 1, "the connection itself survives one malformed frame");
    assert!(e.received.lock().unwrap().is_empty(), "and nothing was passed to the server");
    r.finish().await;
}

#[tokio::test]
async fn a_player_with_no_local_server_listening_is_cleaned_up_and_the_relay_told() {
    let dead = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let mut r = Rig::standard(dead, |_| {}).await;
    r.go_online(json!({})).await;
    r.send(json!({ "type": "connect", "conn": "no-local-server", "ip": "1.2.3.4" })).await;
    let close = r.next_json_of("close").await;
    assert_eq!(close["conn"], "no-local-server");
    r.event(|ev| matches!(ev, TunnelEvent::Players(0))).await;
    assert_eq!(r.tunnel.player_count(), 0);
    assert!(r.logs().iter().any(|l| l.contains("Could not reach a local server on 127.0.0.1:")));
    r.finish().await;
}

#[tokio::test]
async fn the_next_relay_candidate_is_tried_when_the_preferred_one_is_unreachable() {
    let dead = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let good = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let good_url = format!("ws://127.0.0.1:{}", good.local_addr().unwrap().port());
    let dead_url = format!("ws://127.0.0.1:{dead}");
    let (tunnel, rx) = Tunnel::new();
    tunnel.start(StartParams { relay_urls: vec![dead_url.clone(), good_url.clone()], token: TOKEN.into(), local_port: 1, ..Default::default() });
    let ws = accept(&good).await;
    let mut r = Rig { tunnel, rx, ws, reg: Value::Null, seen: vec![], listener: good };
    assert_eq!(r.next_json().await["type"], "register");
    assert_eq!(r.tunnel.relay_url(), good_url);
    assert!(r.logs().iter().any(|l| l.starts_with(&format!("Could not reach {dead_url}"))), "logs the fallback");
    // Once established, a later drop retries the preferred candidate first.
    r.go_online(json!({})).await;
    r.ws.close(None).await.unwrap();
    r.event(|e| matches!(e, TunnelEvent::Status("reconnecting"))).await;
    r.event(|e| matches!(e, TunnelEvent::Log(l) if l == &format!("Connecting to {dead_url}…"))).await;
    r.tunnel.stop();
    r.event(|e| matches!(e, TunnelEvent::Stopped)).await;
}

// ─── Bedrock (UDP), custom addresses, public listing ─────────────────────────

#[tokio::test]
async fn bedrock_datagrams_are_bridged_to_the_local_udp_port_and_registration_says_udp() {
    let udp = udp_echo("pong:").await;
    let mut r = Rig::standard(1, |p| p.udp_port = Some(udp)).await;
    assert_eq!(r.reg["udp"], true);
    r.go_online(json!({})).await;
    r.send(json!({ "type": "udp", "conn": "sess1", "ip": "9.9.9.9", "data": b64(b"ping") })).await;
    let reply = r.next_json_of("udp").await;
    assert_eq!(reply["conn"], "sess1");
    assert_eq!(unb64(reply["data"].as_str().unwrap()), b"pong:ping");
    assert_eq!(r.tunnel.udp_session_count(), 1);
    r.finish().await;
}

#[tokio::test]
async fn without_a_udp_port_registration_omits_it_and_udp_frames_are_ignored() {
    let mut r = Rig::standard(1, |_| {}).await;
    assert!(r.reg.get("udp").is_none());
    r.send(json!({ "type": "udp", "conn": "sess1", "data": "aGk=" })).await;
    r.pause(150).await;
    assert_eq!(r.tunnel.udp_session_count(), 0);
    r.finish().await;
}

#[tokio::test]
async fn claiming_a_name_sends_claim_name_and_surfaces_name_and_name_error() {
    let mut r = Rig::standard(1, |_| {}).await;
    r.go_online(json!({})).await;
    r.tunnel.claim_name("  Steve ");
    assert_eq!(r.next_json().await, json!({ "type": "claim_name", "name": "steve" }));
    r.send(json!({ "type": "name", "name": "steve", "address": "steve.voxelport.in" })).await;
    assert_eq!(r.event(|e| matches!(e, TunnelEvent::Name { .. })).await, TunnelEvent::Name { name: "steve".into(), address: "steve.voxelport.in".into() });
    r.send(json!({ "type": "name_error", "message": "That name is taken — try another." })).await;
    assert!(matches!(r.event(|e| matches!(e, TunnelEvent::NameError(_))).await, TunnelEvent::NameError(m) if m.contains("taken")));
    r.tunnel.release_name();
    assert_eq!(r.next_json().await, json!({ "type": "release_name" }));
    r.finish().await;
}

#[tokio::test]
async fn a_listing_set_before_going_live_is_sent_after_registration_and_withdrawn_with_none() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let (tunnel, rx) = Tunnel::new();
    tunnel.set_listing(Some(json!({ "title": "Survival SMP", "max_players": 20, "players": 0 })));
    tunnel.start(StartParams { relay_urls: vec![url], token: TOKEN.into(), local_port: 1, ..Default::default() });
    let ws = accept(&listener).await;
    let mut r = Rig { tunnel, rx, ws, reg: Value::Null, seen: vec![], listener };
    assert_eq!(r.next_json().await["type"], "register");
    r.send(json!({ "type": "port", "port": 26137 })).await;
    let listing = r.next_json().await;
    assert_eq!((listing["type"].clone(), listing["listing"]["title"].clone()), (json!("listing"), json!("Survival SMP")));
    r.event(|e| matches!(e, TunnelEvent::Assigned { .. })).await;
    r.tunnel.set_listing(None);
    assert_eq!(r.next_json().await, json!({ "type": "listing" }));
    r.finish().await;
}

#[tokio::test]
async fn registration_names_the_app_and_version_only_when_given() {
    let with = Rig::standard(1, |p| p.client = Some("desktop/1.8.0".into())).await;
    assert_eq!((with.reg["type"].clone(), with.reg["client"].clone()), (json!("register"), json!("desktop/1.8.0")));
    with.finish().await;
    let without = Rig::standard(1, |_| {}).await;
    assert!(without.reg.get("client").is_none());
    without.finish().await;
}

#[tokio::test]
async fn a_notice_reaches_the_app_and_an_empty_one_withdraws_it() {
    let mut r = Rig::standard(1, |_| {}).await;
    r.go_online(json!({})).await;
    r.send(json!({ "type": "notice", "message": "The VoxelPort relay will restart.", "seconds": 600 })).await;
    assert_eq!(r.event(|e| matches!(e, TunnelEvent::Notice { .. })).await, TunnelEvent::Notice { message: "The VoxelPort relay will restart.".into(), seconds: 600 });
    r.send(json!({ "type": "notice" })).await;
    assert_eq!(r.event(|e| matches!(e, TunnelEvent::Notice { .. })).await, TunnelEvent::Notice { message: String::new(), seconds: 0 });
    r.finish().await;
}

#[tokio::test]
async fn the_rank_arrives_with_the_port_frame_and_a_bad_rank_is_ignored() {
    let mut r = Rig::standard(1, |_| {}).await;
    r.go_online(json!({ "rank": "supporter_plus" })).await;
    assert_eq!(r.tunnel.rank().as_deref(), Some("supporter_plus"));
    r.send(json!({ "type": "pong", "rank": "king" })).await;
    r.pause(100).await;
    assert!(r.logs().iter().any(|l| l.contains("Ignored malformed relay frame (type=pong)")));
    assert_eq!(r.tunnel.rank().as_deref(), Some("supporter_plus"));
    r.finish().await;
}

#[tokio::test]
async fn a_malformed_or_unparseable_frame_is_ignored_and_the_tunnel_carries_on() {
    let mut r = Rig::standard(1, |_| {}).await;
    r.go_online(json!({})).await;
    r.ws.send(Message::Text("{ not json".into())).await.unwrap();
    r.send(json!({ "type": "connect", "conn": "" })).await;
    r.send(json!({ "type": "port", "port": 99999 })).await;
    r.pause(150).await;
    assert!(r.tunnel.is_live() && r.tunnel.is_running());
    assert!(r.logs().iter().filter(|l| l.starts_with("Ignored malformed relay frame")).count() >= 2);
    r.finish().await;
}

#[tokio::test]
async fn a_frame_over_the_size_limit_drops_the_connection_and_the_tunnel_reconnects() {
    let mut r = Rig::standard(1, |_| {}).await;
    r.go_online(json!({})).await;
    let huge = "A".repeat(MAX_WS_MESSAGE_BYTES + 10);
    let _ = r.ws.send(Message::Text(json!({ "type": "data", "conn": "x", "data": huge }).to_string().into())).await;
    r.event(|e| matches!(e, TunnelEvent::Status("reconnecting"))).await;
    assert!(r.tunnel.is_live());
    r.tunnel.stop();
    r.event(|e| matches!(e, TunnelEvent::Stopped)).await;
}

// ─── The life of a tunnel ────────────────────────────────────────────────────

fn dead_relay_url() -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    format!("ws://127.0.0.1:{}", l.local_addr().unwrap().port())
}

#[tokio::test]
async fn a_tunnel_is_live_while_connecting_or_reconnecting_and_not_before_start_or_after_stop() {
    let (tunnel, mut rx) = Tunnel::new();
    assert!(!tunnel.is_live(), "before start");
    tunnel.start(StartParams { relay_urls: vec![dead_relay_url()], token: TOKEN.into(), local_port: 25565, ..Default::default() });
    assert!(tunnel.is_live(), "connecting");
    assert!(!tunnel.is_running(), "running still means registered and online");
    loop {
        if matches!(tokio::time::timeout(WAIT, rx.recv()).await.unwrap().unwrap(), TunnelEvent::Status("reconnecting")) {
            break;
        }
    }
    assert!(tunnel.is_live() && !tunnel.is_running(), "waiting to reconnect is still live");
    tunnel.stop();
    loop {
        if matches!(tokio::time::timeout(WAIT, rx.recv()).await.unwrap().unwrap(), TunnelEvent::Stopped) {
            break;
        }
    }
    assert!(!tunnel.is_live(), "after stop");
}

#[tokio::test]
async fn stopping_while_it_waits_to_reconnect_says_stopped_once_and_never_reconnects() {
    let (tunnel, mut rx) = Tunnel::new();
    tunnel.start(StartParams { relay_urls: vec![dead_relay_url()], token: TOKEN.into(), local_port: 25565, ..Default::default() });
    let mut events = Vec::new();
    loop {
        let e = tokio::time::timeout(WAIT, rx.recv()).await.unwrap().unwrap();
        let reconnecting = matches!(e, TunnelEvent::Status("reconnecting"));
        events.push(e);
        if reconnecting {
            break;
        }
    }
    tunnel.stop();
    tunnel.stop(); // a second stop changes nothing
    tokio::time::sleep(Duration::from_millis(1500)).await; // longer than the first backoff (1 s)
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    assert_eq!(events.iter().filter(|e| matches!(e, TunnelEvent::Stopped)).count(), 1);
    assert_eq!(events.iter().filter(|e| matches!(e, TunnelEvent::Status("connecting"))).count(), 1, "only the first attempt: no reconnect after stop");
    assert!(!tunnel.is_live());
}

#[tokio::test]
async fn stopping_a_connected_tunnel_twice_says_stopped_once_and_zero_players_once() {
    let mut r = Rig::standard(25565, |_| {}).await;
    r.go_online(json!({})).await;
    let mut tail = Vec::new();
    r.tunnel.stop();
    r.tunnel.stop();
    r.pause(300).await;
    r.tunnel.stop();
    while let Ok(e) = r.rx.try_recv() {
        tail.push(e);
    }
    let shown: Vec<&TunnelEvent> = tail.iter().filter(|e| matches!(e, TunnelEvent::Players(_) | TunnelEvent::Stopped)).collect();
    assert_eq!(shown, [&TunnelEvent::Players(0), &TunnelEvent::Stopped]);
}

#[tokio::test]
async fn a_bad_relay_address_ends_the_tunnel_instead_of_leaving_it_live_with_no_socket() {
    let (tunnel, mut rx) = Tunnel::new();
    tunnel.start(StartParams { relay_urls: vec!["not a url".into()], token: TOKEN.into(), local_port: 25565, ..Default::default() });
    assert!(!tunnel.is_live());
    let mut stopped = 0;
    let mut errors = 0;
    while let Ok(e) = rx.try_recv() {
        match e {
            TunnelEvent::Stopped => stopped += 1,
            TunnelEvent::Error(_) => errors += 1,
            _ => {}
        }
    }
    assert_eq!((stopped, errors), (1, 1));
}

// ─── Protocol v2: binary data frames ─────────────────────────────────────────

#[tokio::test]
async fn the_tunnel_always_asks_for_protocol_v2_and_only_a_relay_that_agrees_turns_it_on() {
    for v2 in [false, true] {
        let mut r = Rig::standard(1, |_| {}).await;
        assert_eq!(r.reg["bin"], 1);
        r.go_online(if v2 { json!({ "bin": 1 }) } else { json!({}) }).await;
        assert_eq!(r.tunnel.is_binary(), v2, "{}", if v2 { "the relay confirmed it" } else { "an older relay never does" });
        r.finish().await;
    }
}

#[tokio::test]
async fn against_a_relay_that_does_not_confirm_v2_everything_stays_json_and_bytes_arrive_unchanged() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({})).await;
    let conn = hex_id(0xab);
    r.send(json!({ "type": "connect", "conn": conn, "ip": "203.0.113.5" })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(1))).await;
    let data = payload(300 * 1024, 3);
    for chunk in data.chunks(32768) {
        r.send(json!({ "type": "data", "conn": conn, "data": b64(chunk) })).await;
    }
    let mut echoed = Vec::new();
    while echoed.len() < data.len() {
        match r.next_msg().await {
            Message::Text(t) => {
                let m: Value = serde_json::from_str(t.as_str()).unwrap();
                if m["type"] == "data" {
                    echoed.extend(unb64(m["data"].as_str().unwrap()));
                }
            }
            _ => panic!("a legacy relay must never be sent a binary frame"),
        }
    }
    assert_eq!((sha(&e.received.lock().unwrap()), sha(&echoed)), (sha(&data), sha(&data)));
    r.finish().await;
}

#[tokio::test]
async fn against_a_v2_relay_payloads_travel_as_binary_frames_both_ways_and_control_stays_json() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({ "bin": 1 })).await;
    let conn = hex_id(0xcd);
    r.send(json!({ "type": "connect", "conn": conn, "ip": "203.0.113.5" })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(1))).await;
    let data = payload(300 * 1024, 5);
    for chunk in data.chunks(32768) {
        r.send_bin(FRAME_TCP, &conn, chunk).await;
    }
    let mut echoed = Vec::new();
    while echoed.len() < data.len() {
        match r.next_msg().await {
            Message::Binary(b) => {
                let f = parse_binary_frame(&b).unwrap();
                assert_eq!((f.kind, f.conn.as_str()), (FRAME_TCP, conn.as_str()), "the header names the connection");
                echoed.extend_from_slice(f.payload);
            }
            _ => panic!("payload to a v2 relay is binary"),
        }
    }
    assert_eq!((sha(&e.received.lock().unwrap()), sha(&echoed)), (sha(&data), sha(&data)));
    // The close the tunnel sends when the relay says so stays JSON in v2 too; and a JSON data frame is still accepted.
    r.send(json!({ "type": "data", "conn": conn, "data": b64(b"json is fine") })).await;
    let back = loop {
        if let Message::Binary(b) = r.next_msg().await {
            break b;
        }
    };
    assert_eq!(parse_binary_frame(&back).unwrap().payload, b"json is fine", "and the reply goes back the v2 way");
    r.send(json!({ "type": "close", "conn": conn })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(0))).await;
    r.finish().await;
}

#[tokio::test]
async fn malformed_binary_frames_are_ignored_logged_once_and_the_tunnel_carries_on() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({ "bin": 1 })).await;
    let conn = hex_id(0x11);
    r.send(json!({ "type": "connect", "conn": conn })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(1))).await;
    let mut bad: Vec<Vec<u8>> = vec![vec![], vec![FRAME_TCP], [&[FRAME_TCP][..], &[9u8; 5][..]].concat()];
    for kind in [0x7f_u8, 0x00] {
        bad.push(build_binary_frame(kind, &raw_id(&conn), b"unknown kind"));
    }
    bad.push(build_binary_frame(FRAME_TCP, &raw_id(&hex_id(0x99)), b"no such connection"));
    bad.push(build_binary_frame(FRAME_UDP, &raw_id(&conn), b"this tunnel has no UDP port"));
    for f in bad {
        r.ws.send(Message::Binary(f.into())).await.unwrap();
    }
    r.send_bin(FRAME_TCP, &conn, b"still works").await;
    let back = loop {
        if let Message::Binary(b) = r.next_msg().await {
            break b;
        }
    };
    assert_eq!(parse_binary_frame(&back).unwrap().payload, b"still works", "the next good frame is delivered");
    assert_eq!(e.received.lock().unwrap().as_slice(), b"still works", "and nothing else reached the local server");
    assert_eq!(r.logs().iter().filter(|l| l.contains("Ignored a binary frame")).count(), 1, "a flood of bad frames is logged once");
    assert!(r.tunnel.is_live());
    r.finish().await;
}

#[tokio::test]
async fn a_binary_frame_from_a_relay_that_did_not_agree_to_v2_is_ignored() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({})).await;
    let conn = hex_id(0x22);
    r.send(json!({ "type": "connect", "conn": conn })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(1))).await;
    r.send_bin(FRAME_TCP, &conn, b"not agreed").await;
    r.pause(150).await;
    assert!(e.received.lock().unwrap().is_empty());
    r.send(json!({ "type": "data", "conn": conn, "data": b64(b"json") })).await;
    let reply = r.next_json_of("data").await;
    assert_eq!(unb64(reply["data"].as_str().unwrap()), b"json");
    r.finish().await;
}

#[tokio::test]
async fn udp_works_in_both_modes() {
    for v2 in [false, true] {
        let udp = udp_echo("pong:").await;
        let mut r = Rig::standard(1, |p| p.udp_port = Some(udp)).await;
        r.go_online(if v2 { json!({ "bin": 1 }) } else { json!({}) }).await;
        let session = hex_id(0x33);
        if v2 {
            r.send_bin(FRAME_UDP, &session, b"ping").await;
            let b = loop {
                if let Message::Binary(b) = r.next_msg().await {
                    break b;
                }
            };
            let f = parse_binary_frame(&b).unwrap();
            assert_eq!((f.kind, f.conn.as_str(), f.payload), (FRAME_UDP, session.as_str(), &b"pong:ping"[..]));
        } else {
            r.send(json!({ "type": "udp", "conn": session, "ip": "9.9.9.9", "data": b64(b"ping") })).await;
            let reply = r.next_json_of("udp").await;
            assert_eq!((reply["conn"].clone(), unb64(reply["data"].as_str().unwrap())), (json!(session), b"pong:ping".to_vec()));
        }
        r.finish().await;
    }
}

#[tokio::test]
async fn an_oversized_udp_datagram_is_dropped_and_nothing_is_forwarded() {
    let udp = udp_echo("pong:").await;
    let mut r = Rig::standard(1, |p| p.udp_port = Some(udp)).await;
    r.go_online(json!({ "bin": 1 })).await;
    r.send_bin(FRAME_UDP, &hex_id(0x44), &vec![0u8; 2049]).await;
    r.pause(150).await;
    assert_eq!(r.tunnel.udp_session_count(), 0);
    r.finish().await;
}

#[tokio::test]
async fn a_connection_id_that_is_not_32_hex_characters_stays_on_json_even_when_v2_is_on() {
    let e = echo("").await;
    let mut r = Rig::standard(e.port, |_| {}).await;
    r.go_online(json!({ "bin": 1 })).await;
    r.send(json!({ "type": "connect", "conn": "conn-not-hex" })).await;
    r.event(|ev| matches!(ev, TunnelEvent::Players(1))).await;
    r.send(json!({ "type": "data", "conn": "conn-not-hex", "data": b64(b"hi") })).await;
    match r.next_msg().await {
        Message::Text(t) => assert_eq!(serde_json::from_str::<Value>(t.as_str()).unwrap()["type"], "data"),
        _ => panic!("this id has no raw bytes, so it stays on JSON"),
    }
    r.finish().await;
}

#[tokio::test]
async fn java_and_bedrock_tcp_and_udp_are_routed_independently_in_both_modes() {
    for binary in [false, true] {
        let java = echo("java:").await;
        let bedrock = echo("bedrock:").await;
        let udp = UdpSocket::bind(("127.0.0.1", bedrock.port)).await.unwrap();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            while let Ok((n, from)) = udp.recv_from(&mut buf).await {
                let _ = udp.send_to(&buf[..n], from).await;
            }
        });
        let mut r = Rig::standard(java.port, |p| { p.udp_port = Some(bedrock.port); p.bedrock_port = Some(bedrock.port); }).await;
        assert_eq!(r.reg["bedrock"], true);
        r.go_online(if binary { json!({ "bedrock_port": 26002, "bin": 1 }) } else { json!({ "bedrock_port": 26002 }) }).await;
        assert_eq!(r.tunnel.bedrock_public_port(), Some(26002));
        for (id, extra, prefix) in [(hex_id(0x31), json!({}), "java:"), (hex_id(0x32), json!({ "bedrock": true }), "bedrock:")] {
            let mut connect = json!({ "type": "connect", "conn": id });
            for (k, v) in extra.as_object().unwrap() {
                connect[k] = v.clone();
            }
            r.send(connect).await;
            if binary {
                r.send_bin(FRAME_TCP, &id, b"hello").await;
            } else {
                r.send(json!({ "type": "data", "conn": id, "data": b64(b"hello") })).await;
            }
            let payload = match r.next_msg().await {
                Message::Binary(b) => parse_binary_frame(&b).unwrap().payload.to_vec(),
                Message::Text(t) => unb64(serde_json::from_str::<Value>(t.as_str()).unwrap()["data"].as_str().unwrap()),
                _ => unreachable!(),
            };
            assert_eq!(String::from_utf8(payload).unwrap(), format!("{prefix}hello"), "binary={binary}");
            r.send(json!({ "type": "close", "conn": id })).await;
        }
        let session = hex_id(0x33);
        r.send(json!({ "type": "udp", "conn": session, "data": b64(b"datagram") })).await;
        let payload = match r.next_msg().await {
            Message::Binary(b) => parse_binary_frame(&b).unwrap().payload.to_vec(),
            Message::Text(t) => unb64(serde_json::from_str::<Value>(t.as_str()).unwrap()["data"].as_str().unwrap()),
            _ => unreachable!(),
        };
        assert_eq!(payload, b"datagram");
        r.finish().await;
    }
}

#[tokio::test]
async fn an_old_relay_cannot_silently_enable_the_legacy_bedrock_port_for_a_new_client() {
    let java = echo("java:").await;
    let mut r = Rig::standard(java.port, |p| { p.udp_port = Some(19132); p.bedrock_port = Some(19132); }).await;
    r.go_online(json!({})).await; // no bedrock_port in the port frame
    assert_eq!(r.tunnel.bedrock_public_port(), None);
    let warned = r.event(|e| matches!(e, TunnelEvent::UdpError(_))).await;
    assert!(matches!(warned, TunnelEvent::UdpError(m) if m.contains("Bedrock needs an updated relay")), "the host is told Java still works");
    r.send(json!({ "type": "connect", "conn": "bedrock-test", "bedrock": true })).await;
    let close = r.next_json_of("close").await;
    assert_eq!(close["conn"], "bedrock-test");
    r.pause(100).await;
    assert_eq!(*java.connections.lock().unwrap(), 0, "unnegotiated signaling must never reach Java");
    r.finish().await;
}

/// Needs the internet, so it is not part of the normal run: `cargo test -p voxelport-core --test tunnel -- --ignored`.
/// It only opens the secure WebSocket to the production relay and closes it at once. It sends nothing (no registration, no token), so
/// the relay does nothing but accept and drop a connection. What it proves is that this build can do `wss://` at all (TLS and roots).
#[tokio::test]
#[ignore = "touches the real relay: handshake only, nothing is sent"]
async fn the_secure_handshake_with_the_real_relay_works() {
    use tokio_tungstenite::connect_async;
    let (mut ws, response) = tokio::time::timeout(Duration::from_secs(20), connect_async("wss://relay.voxelport.in/ws")).await.expect("answered in time").expect("the TLS handshake and upgrade worked");
    assert_eq!(response.status().as_u16(), 101);
    let _ = ws.close(None).await;
}

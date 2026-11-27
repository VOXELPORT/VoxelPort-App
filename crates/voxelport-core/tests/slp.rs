use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use voxelport_core::slp::players_online;

const WAIT: Duration = Duration::from_millis(800);

fn varint(mut n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut b = (n & 0x7f) as u8;
        n >>= 7;
        if n > 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            return out;
        }
    }
}

fn status_packet(json: &str) -> Vec<u8> {
    let mut body = vec![0u8];
    body.extend(varint(json.len()));
    body.extend(json.as_bytes());
    let mut out = varint(body.len());
    out.extend(body);
    out
}

/// A stand-in server on a free port that reads the request and answers with `chunks`, one write each.
async fn server(chunks: Vec<Vec<u8>>) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut buf = [0u8; 256];
        let _ = s.read(&mut buf).await;
        for c in chunks {
            s.write_all(&c).await.unwrap();
            s.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    });
    port
}

#[tokio::test]
async fn reads_the_player_count_even_in_pieces() {
    // A real reply is large (it can carry an icon) and arrives in several pieces.
    let json = format!(r#"{{"version":{{"name":"Paper 26.3"}},"players":{{"max":20,"online":3}},"favicon":"{}"}}"#, "A".repeat(20_000));
    let packet = status_packet(&json);
    let chunks = packet.chunks(700).map(|c| c.to_vec()).collect();
    // 29 pieces with a pause each: Windows timers make that close to a second, so this one gets longer.
    assert_eq!(players_online(server(chunks).await, Duration::from_secs(10)).await, Some(3));
}

#[tokio::test]
async fn an_empty_server_is_zero_not_unknown() {
    let port = server(vec![status_packet(r#"{"players":{"max":20,"online":0}}"#)]).await;
    assert_eq!(players_online(port, WAIT).await, Some(0));
}

#[tokio::test]
async fn anything_it_cannot_understand_is_unknown() {
    for reply in [
        vec![],
        vec![b"HTTP/1.1 200 OK\r\n\r\n".to_vec()],
        vec![status_packet(r#"{"description":"no players field"}"#)],
        vec![status_packet("not json")],
        vec![varint(50_000_000)], // a length nobody should wait for
    ] {
        assert_eq!(players_online(server(reply).await, WAIT).await, None);
    }
}

#[tokio::test]
async fn nobody_listening_is_unknown() {
    let port = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    assert_eq!(players_online(port, WAIT).await, None);
}

/// Against a real server: start one, then `VOXELPORT_SLP_PORT=<port> cargo test -p voxelport-core --test slp -- --ignored`.
#[tokio::test]
#[ignore]
async fn against_a_real_server() {
    let port: u16 = std::env::var("VOXELPORT_SLP_PORT").expect("VOXELPORT_SLP_PORT").parse().unwrap();
    assert_eq!(players_online(port, Duration::from_secs(3)).await, Some(0));
}

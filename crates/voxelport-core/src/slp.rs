//! A Minecraft server list ping to the server this app runs, to ask how many people are on it. The join and leave
//! lines in the log can be changed or removed by a plugin; this count cannot be lost that way.

use serde_json::Value;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// A reply carries the server's icon, so it can be tens of kilobytes; nothing sensible is near a megabyte.
const MAX_REPLY: usize = 1024 * 1024;

fn push_varint(out: &mut Vec<u8>, mut n: u32) {
    loop {
        let mut b = (n & 0x7f) as u8;
        n >>= 7;
        if n > 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            return;
        }
    }
}

async fn read_varint(s: &mut TcpStream) -> Option<usize> {
    let mut n = 0usize;
    for shift in 0..5 {
        let b = s.read_u8().await.ok()?;
        n |= ((b & 0x7f) as usize) << (7 * shift);
        if b & 0x80 == 0 {
            return Some(n);
        }
    }
    None
}

fn varint_in(data: &[u8], at: &mut usize) -> Option<usize> {
    let mut n = 0usize;
    for shift in 0..5 {
        let b = *data.get(*at)?;
        *at += 1;
        n |= ((b & 0x7f) as usize) << (7 * shift);
        if b & 0x80 == 0 {
            return Some(n);
        }
    }
    None
}

async fn ask(port: u16) -> Option<u64> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    // Handshake (protocol "unknown", next state 1 = status), then the empty status request.
    let host = b"127.0.0.1";
    let mut body = vec![0x00, 0xff, 0xff, 0xff, 0xff, 0x0f, host.len() as u8];
    body.extend_from_slice(host);
    body.extend_from_slice(&port.to_be_bytes());
    body.push(1);
    let mut out = Vec::new();
    push_varint(&mut out, body.len() as u32);
    out.extend(body);
    out.extend_from_slice(&[1, 0]);
    s.write_all(&out).await.ok()?;

    let len = read_varint(&mut s).await.filter(|n| (2..=MAX_REPLY).contains(n))?;
    let mut data = vec![0u8; len];
    s.read_exact(&mut data).await.ok()?;
    let mut at = 0;
    if varint_in(&data, &mut at)? != 0 {
        return None;
    }
    let json_len = varint_in(&data, &mut at)?;
    let json: Value = serde_json::from_slice(data.get(at..at.checked_add(json_len)?)?).ok()?;
    json["players"]["online"].as_u64()
}

/// How many players the server on this PC's `port` says it has. None when it does not answer in time or sensibly.
pub async fn players_online(port: u16, timeout: Duration) -> Option<u64> {
    tokio::time::timeout(timeout, ask(port)).await.ok().flatten()
}

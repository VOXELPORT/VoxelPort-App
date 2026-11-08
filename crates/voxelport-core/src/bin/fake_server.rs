//! A stand-in for a Minecraft server, used only by the tests. It prints the "Done" line a real server prints,
//! then reads console commands:
//!   stop            exit 0 (ignored with --hang)
//!   crash           exit 1
//!   join NAME       print "NAME joined the game"
//!   leave NAME      print "NAME left the game"
//!   flood N         print N lines as fast as it can
//!   long N          print one line of N bytes
//!   say TEXT        print TEXT
//!   anything else   print "Unknown command: <the line>"
//!   needjava N      print the message Paper prints when it needs Java N, then exit 1
//!   tick query      print the four lines the vanilla command prints (a tick time of 2.8 ms); with --no-tick it is an unknown command
//! Run as `bedrock_server.exe` (or with --bedrock) it poses as a Bedrock Dedicated Server instead: the log format, the "Server started."
//! line, "Player connected" lines, `save hold` / `save query` / `save resume`, quoted `kick`/`op`, and a world under `worlds/Bedrock level`
//! in the folder it runs in. With --udp-echo it also answers UDP datagrams on its server-port with "echo:" + the datagram.
//! Run as `java -version` (first argument), it prints a Java banner to stderr and exits 0, like a real Java does.
//! The major comes from a `java-major.txt` next to the executable (default 21; 8 prints the old "1.8.0_351" form), so
//! two copies of this program can pose as different Javas.
use std::io::{BufRead, Write};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("-version") {
        let major: u32 = std::env::current_exe().ok().and_then(|p| std::fs::read_to_string(p.with_file_name("java-major.txt")).ok()).and_then(|t| t.trim().parse().ok()).unwrap_or(21);
        if major == 8 {
            eprintln!("java version \"1.8.0_351\"");
        } else {
            eprintln!("openjdk version \"{major}.0.4\" 2024-07-16");
        }
        return;
    }
    let posing_as_bedrock = std::env::args().any(|a| a == "--bedrock") || std::env::current_exe().ok().and_then(|p| p.file_stem().map(|s| s.to_string_lossy().eq_ignore_ascii_case("bedrock_server"))).unwrap_or(false);
    if posing_as_bedrock {
        return bedrock_main();
    }
    let hang = std::env::args().any(|a| a == "--hang");
    let no_tick = std::env::args().any(|a| a == "--no-tick");
    let out = std::io::stdout();
    let mut out = out.lock();
    let _ = writeln!(out, "[12:00:00] [Server thread/INFO]: Done (0.1s)! For help, type \"help\"");
    let _ = out.flush();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let mut parts = line.splitn(2, ' ');
        let cmd = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match cmd {
            "stop" if !hang => {
                let _ = writeln!(out, "[12:00:01] [Server thread/INFO]: Stopping the server");
                let _ = out.flush();
                // The tests can ask for proof of when it stopped: the file named by VP_FAKE_STOP_MARK is written first.
                if let Ok(mark) = std::env::var("VP_FAKE_STOP_MARK") {
                    let _ = std::fs::write(mark, "stopped\n");
                }
                return;
            }
            "crash" => std::process::exit(1),
            // The commands a backup sends, answered the way a real server answers them.
            "save-all" => { let _ = writeln!(out, "[12:00:07] [Server thread/INFO]: Saved the game"); }
            "save-off" => { let _ = writeln!(out, "[12:00:07] [Server thread/INFO]: Automatic saving is now disabled"); }
            "save-on" => { let _ = writeln!(out, "[12:00:07] [Server thread/INFO]: Automatic saving is now enabled"); }
            "needjava" => {
                let _ = writeln!(out, "[12:00:05] [ServerMain/ERROR]: Minecraft 26.1 and newer requires running the server with Java {rest} or above. For information on how to update Java, see https://docs.papermc.io/misc/java-install");
                let _ = out.flush();
                std::process::exit(1);
            }
            "tick" if rest == "query" && !no_tick => {
                let _ = writeln!(out, "[12:00:08] [Server thread/INFO]: The game is running normally");
                let _ = writeln!(out, "[12:00:08] [Server thread/INFO]: Target tick rate: 20.0 per second.");
                let _ = writeln!(out, "[12:00:08] [Server thread/INFO]: Average time per tick: 2.8 ms (Target: 50.0 ms)");
                let _ = writeln!(out, "[12:00:08] [Server thread/INFO]: Percentiles: P50: 2.1 ms P95: 4.0 ms P99: 5.5 ms, sample: 100");
            }
            "join" => { let _ = writeln!(out, "[12:00:02] [Server thread/INFO]: {rest} joined the game"); }
            "leave" => { let _ = writeln!(out, "[12:00:03] [Server thread/INFO]: {rest} left the game"); }
            "flood" => {
                let n: usize = rest.parse().unwrap_or(0);
                for i in 0..n {
                    let _ = writeln!(out, "[12:00:04] [Server thread/INFO]: spam line {i}");
                }
            }
            "long" => {
                let n: usize = rest.parse().unwrap_or(0);
                let _ = writeln!(out, "{}", "x".repeat(n));
            }
            "say" => { let _ = writeln!(out, "{rest}"); }
            // Like a real server, say so about a command it does not know, so tests can see what was sent to it.
            "" => {}
            _ => { let _ = writeln!(out, "[12:00:06] [Server thread/INFO]: Unknown command: {line}"); }
        }
        let _ = out.flush();
    }
}

fn stamp(out: &mut impl Write, level: &str, text: &str) {
    let _ = writeln!(out, "[2026-11-08 12:00:00:123 {level}] {text}");
    let _ = out.flush();
}

/// The files of the stand-in world, with their real lengths, the way `save query` lists them.
fn world_files() -> Vec<(String, u64)> {
    let level = "Bedrock level";
    ["db/000003.log", "db/CURRENT", "level.dat"].iter().filter_map(|f| std::fs::metadata(format!("worlds/{level}/{f}")).ok().map(|m| (format!("{level}/{f}"), m.len()))).collect()
}

fn bedrock_main() {
    let hang = std::env::args().any(|a| a == "--hang");
    let udp_echo = std::env::args().any(|a| a == "--udp-echo") || std::env::var("VP_FAKE_UDP_ECHO").is_ok();
    // A world appears the first time the server runs, like the real one.
    if !std::path::Path::new("worlds/Bedrock level/level.dat").exists() {
        let _ = std::fs::create_dir_all("worlds/Bedrock level/db");
        let _ = std::fs::write("worlds/Bedrock level/level.dat", b"level data");
        let _ = std::fs::write("worlds/Bedrock level/db/000003.log", b"log of the world");
        let _ = std::fs::write("worlds/Bedrock level/db/CURRENT", b"MANIFEST-000002
");
    }
    if udp_echo {
        let port: u16 = std::fs::read_to_string("server.properties").ok().and_then(|t| t.lines().find_map(|l| l.strip_prefix("server-port=")?.trim().parse().ok())).unwrap_or(19132);
        if let Ok(sock) = std::net::UdpSocket::bind(("127.0.0.1", port)) {
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                while let Ok((n, from)) = sock.recv_from(&mut buf) {
                    let mut reply = b"echo:".to_vec();
                    reply.extend_from_slice(&buf[..n]);
                    let _ = sock.send_to(&reply, from);
                }
            });
        }
    }
    let out = std::io::stdout();
    let mut out = out.lock();
    stamp(&mut out, "INFO", "Starting Server");
    stamp(&mut out, "INFO", "Version: 1.26.63.1");
    stamp(&mut out, "INFO", "Server started.");
    let mut held = false;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_string();
        let mut parts = line.splitn(2, ' ');
        let cmd = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match (cmd, rest) {
            ("stop", _) if !hang => {
                stamp(&mut out, "INFO", "Stopping server...");
                if let Ok(mark) = std::env::var("VP_FAKE_STOP_MARK") {
                    let _ = std::fs::write(mark, "stopped
");
                }
                stamp(&mut out, "INFO", "Quit correctly");
                return;
            }
            ("crash", _) => std::process::exit(1),
            ("save", "hold") => {
                held = true;
                stamp(&mut out, "INFO", "Saving...");
            }
            ("save", "query") => {
                if held {
                    stamp(&mut out, "INFO", "Data saved. Files are now ready to be copied.");
                    let list: Vec<String> = world_files().iter().map(|(f, n)| format!("{f}:{n}")).collect();
                    stamp(&mut out, "INFO", &list.join(", "));
                } else {
                    stamp(&mut out, "INFO", "A previous save has not been completed.");
                }
            }
            ("save", "resume") => {
                held = false;
                stamp(&mut out, "INFO", "Changes to the world are resumed.");
            }
            ("join", name) => stamp(&mut out, "INFO", &format!("Player connected: {name}, xuid: 2535400000001")),
            ("leave", name) => stamp(&mut out, "INFO", &format!("Player disconnected: {name}, xuid: 2535400000001")),
            ("flood", n) => {
                for i in 0..n.parse::<usize>().unwrap_or(0) {
                    stamp(&mut out, "INFO", &format!("spam line {i}"));
                }
            }
            ("say", text) => stamp(&mut out, "INFO", text),
            ("", _) => {}
            // What the real server answers to each, so tests can see exactly what was sent to it.
            ("kick", _) | ("op", _) | ("deop", _) | ("allowlist", _) => stamp(&mut out, "INFO", &format!("Command received: {line}")),
            _ => stamp(&mut out, "INFO", &format!("Unknown command: {cmd}. Please check that the command exists and that you have permission to use it.")),
        }
    }
}

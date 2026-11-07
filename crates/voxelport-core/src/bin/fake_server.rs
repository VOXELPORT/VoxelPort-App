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
    let hang = std::env::args().any(|a| a == "--hang");
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
                return;
            }
            "crash" => std::process::exit(1),
            "needjava" => {
                let _ = writeln!(out, "[12:00:05] [ServerMain/ERROR]: Minecraft 26.1 and newer requires running the server with Java {rest} or above. For information on how to update Java, see https://docs.papermc.io/misc/java-install");
                let _ = out.flush();
                std::process::exit(1);
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

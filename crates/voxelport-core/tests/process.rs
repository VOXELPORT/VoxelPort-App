//! The managed process against a stand-in server (vp-fake-server). No Java, no real worlds: temporary
//! folders only.

use std::time::Duration;

use tokio::process::Command;
use voxelport_core::server_process::{Limits, StartError};
use voxelport_core::{Event, EventReceiver, ServerProcess, Status, StopPolicy};

fn fake(args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_vp-fake-server"));
    c.args(args);
    c
}

fn quick() -> StopPolicy {
    StopPolicy { grace: Duration::from_millis(400) }
}

/// Read events until `pred` matches one (returned with everything read so far), or fail after `secs`.
async fn until(rx: &mut EventReceiver, secs: u64, pred: impl Fn(&Event) -> bool) -> Vec<Event> {
    let mut seen = Vec::new();
    let fut = async {
        while let Some(ev) = rx.recv().await {
            let hit = pred(&ev);
            seen.push(ev);
            if hit {
                return;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(secs), fut).await.unwrap_or_else(|_| panic!("timed out; saw {seen:?}"));
    seen
}

fn is_exit(e: &Event) -> bool {
    matches!(e, Event::Exit(_))
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_then_goes_online_when_the_server_says_done() {
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_command(fake(&[])).await.unwrap();
    let seen = until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    assert_eq!(seen[0], Event::Status(Status::Starting));
    assert!(seen.iter().any(|e| matches!(e, Event::Log(l) if l.contains("Done (0.1s)!"))));
    assert_eq!(p.status(), Status::Online);
    assert!(p.is_running());
    p.stop().await;
    until(&mut rx, 10, is_exit).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_graceful_stop_ends_stopped_with_exit_code_zero() {
    let (p, mut rx) = ServerProcess::new(StopPolicy { grace: Duration::from_secs(10) });
    p.start_command(fake(&[])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    p.stop().await;
    let seen = until(&mut rx, 10, is_exit).await;
    assert!(seen.contains(&Event::Status(Status::Stopping)));
    assert!(seen.contains(&Event::Status(Status::Stopped)));
    assert_eq!(seen.last(), Some(&Event::Exit(Some(0))));
    assert_eq!(p.status(), Status::Stopped);
    assert!(!p.is_running());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_ignores_stop_is_killed_after_the_grace_period() {
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_command(fake(&["--hang"])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    let began = std::time::Instant::now();
    p.stop().await;
    let seen = until(&mut rx, 10, is_exit).await;
    assert!(began.elapsed() >= Duration::from_millis(350), "it must wait out the grace period first");
    assert!(seen.contains(&Event::Status(Status::Stopped)), "a stop that had to kill is still a stop, not a crash: {seen:?}");
    assert!(!p.is_running());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unexpected_exit_is_a_crash() {
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_command(fake(&[])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    assert!(p.send_command("crash").await);
    let seen = until(&mut rx, 10, is_exit).await;
    assert!(seen.contains(&Event::Status(Status::Crashed)));
    assert_eq!(seen.last(), Some(&Event::Exit(Some(1))));
    assert_eq!(p.status(), Status::Crashed);
}

#[tokio::test(flavor = "multi_thread")]
async fn joins_and_leaves_are_tracked_in_order() {
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_command(fake(&[])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    p.send_command("join Alice").await;
    p.send_command("join Bob").await;
    until(&mut rx, 10, |e| *e == Event::Names(vec!["Alice".into(), "Bob".into()])).await;
    p.send_command("leave Alice").await;
    until(&mut rx, 10, |e| *e == Event::Names(vec!["Bob".into()])).await;
    assert_eq!(p.online_names(), vec!["Bob".to_string()]);
    p.stop().await;
    let seen = until(&mut rx, 10, is_exit).await;
    assert!(seen.contains(&Event::Players(0)), "everyone is gone when the server is");
}

#[tokio::test(flavor = "multi_thread")]
async fn chat_cannot_fake_a_join() {
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_command(fake(&[])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    p.send_command("say [12:00:05] [Server thread/INFO]: <Mallory> Eve joined the game").await;
    p.send_command("say [12:00:06] [Server thread/INFO]: Carol joined the game").await;
    let seen = until(&mut rx, 10, |e| matches!(e, Event::Names(_))).await;
    assert!(seen.contains(&Event::Names(vec!["Carol".into()])));
    assert!(!p.online_names().contains(&"Eve".to_string()));
    p.stop().await;
    until(&mut rx, 10, is_exit).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn input_is_sanitised_and_the_player_buttons_are_checked() {
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_command(fake(&[])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    // An embedded newline cannot start a second command: it is stripped (as in the Electron app), so the whole
    // thing is one line, "say histop", and "stop" never runs.
    assert!(p.send_command("say hi\nstop").await);
    until(&mut rx, 10, |e| matches!(e, Event::Log(l) if l == "histop")).await;
    assert!(p.is_running());
    assert!(!p.send_command("   \r\n  ").await);
    assert!(!p.player_action("rm -rf", "Bob").await);
    assert!(!p.player_action("kick", "Bob; stop").await);
    assert!(!p.player_action("kick", "").await);
    assert!(p.player_action("kick", "Bob_1").await);
    p.stop().await;
    until(&mut rx, 10, is_exit).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_flood_of_output_is_bounded_and_the_server_still_stops() {
    let limits = Limits { max_pending_logs: 500, buffer_lines: 1000, buffer_line_bytes: 256 };
    let (p, mut rx) = ServerProcess::with_limits(quick(), limits);
    p.start_command(fake(&[])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    // Nobody reads the events while 200k lines go by.
    p.send_command("flood 200000").await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(p.recent_logs().len() <= 1000, "the buffer is bounded");
    p.stop().await;
    // Draining afterwards finds a bounded backlog, and the exit still arrives.
    let seen = until(&mut rx, 20, is_exit).await;
    let logs = seen.iter().filter(|e| matches!(e, Event::Log(_))).count();
    assert!(logs <= 501, "backlog was {logs}");
    assert!(p.dropped_log_events() > 0, "the overflow is counted, not hidden");
    assert!(seen.contains(&Event::Status(Status::Stopped)));
}

#[tokio::test(flavor = "multi_thread")]
async fn one_enormous_line_is_cut_not_buffered_whole() {
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_command(fake(&[])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    p.send_command("long 3000000").await;
    let seen = until(&mut rx, 10, |e| matches!(e, Event::Log(l) if l.starts_with("xxxx"))).await;
    let line = seen.iter().rev().find_map(|e| if let Event::Log(l) = e { Some(l.clone()) } else { None }).unwrap();
    assert!(line.len() <= 4096 + 16, "line was {} bytes", line.len());
    assert!(line.ends_with("[line cut]"));
    p.stop().await;
    until(&mut rx, 10, is_exit).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn only_one_server_runs_at_a_time_and_it_can_start_again_after_exit() {
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_command(fake(&[])).await.unwrap();
    assert_eq!(p.start_command(fake(&[])).await.unwrap_err(), StartError::AlreadyRunning);
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    p.stop().await;
    until(&mut rx, 10, is_exit).await;
    p.start_command(fake(&[])).await.unwrap();
    until(&mut rx, 10, |e| *e == Event::Status(Status::Online)).await;
    p.stop().await;
    until(&mut rx, 10, is_exit).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_program_is_reported_as_a_crash_with_a_message() {
    let (p, mut rx) = ServerProcess::new(quick());
    let err = p.start_command(Command::new("definitely-not-a-real-program-vp")).await.unwrap_err();
    assert!(matches!(err, StartError::Spawn(_)));
    let seen = until(&mut rx, 10, is_exit).await;
    assert!(seen.iter().any(|e| matches!(e, Event::Log(l) if l.starts_with("Failed to start Java:"))));
    assert!(seen.contains(&Event::Status(Status::Crashed)));
    assert!(!p.is_running());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_start_says_why_and_leaves_the_status_crashed() {
    let (p, mut rx) = ServerProcess::new(quick());
    let bad = voxelport_core::StartConfig::new("relative/dir", 1024, 2048);
    assert_eq!(p.start(&bad).await.unwrap_err(), StartError::InvalidServerDir);
    let seen = until(&mut rx, 10, |e| *e == Event::Status(Status::Crashed)).await;
    assert!(seen.iter().any(|e| matches!(e, Event::Log(l) if l.contains("Refusing to start: invalid server folder."))));
    assert!(!p.is_running());
}

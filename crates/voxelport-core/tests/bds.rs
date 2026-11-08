//! The Bedrock Dedicated Server type against scripted local copies of Mojang's download service and a stand-in server
//! (`vp-fake-server`, which poses as `bedrock_server.exe`). No real Mojang download, no real worlds.

mod common;

use std::fs;
use std::io::Write;
use std::time::Duration;

use serde_json::json;
use voxelport_core::bds::{self, Endpoints, InstallRequest};
use voxelport_core::net::{Fetcher, HostPolicy};
use voxelport_core::server_install::Phase;
use voxelport_core::{Event, EventReceiver, ServerProcess, Status, StopPolicy};

fn fetcher() -> Fetcher {
    let mut policy = HostPolicy::exact(&["127.0.0.1"]);
    policy.https_only = false;
    Fetcher::new(policy, "Bedrock server", "test")
}

/// A zip like Mojang's: the program (here the stand-in), Mojang's default server.properties, and a pack.
fn server_zip() -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buf);
    let opts = zip::write::SimpleFileOptions::default();
    zip.start_file("bedrock_server.exe", opts).unwrap();
    zip.write_all(&fs::read(env!("CARGO_BIN_EXE_vp-fake-server")).unwrap()).unwrap();
    zip.start_file("server.properties", opts).unwrap();
    zip.write_all(b"# Mojang defaults\nserver-name=Dedicated Server\ngamemode=survival\nserver-port=19132\nserver-portv6=19133\nallow-list=false\nonline-mode=true\n").unwrap();
    zip.start_file("behavior_packs/vanilla/manifest.json", opts).unwrap();
    zip.write_all(b"{}").unwrap();
    zip.finish().unwrap();
    buf.into_inner()
}

/// The download service: the link list in the real shape, and the archive at the address it names, on the server's own port.
fn mojang_with_links(zip: Vec<u8>, download_type: &'static str) -> (common::Server, Endpoints) {
    let server = common::Server::start_with(move |port| move |_: &str, target: &str, _: &str| {
        if target == "/api/links" {
            let body = json!({ "result": { "links": [
                { "downloadType": "serverBedrockLinux", "downloadUrl": format!("http://127.0.0.1:{port}/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.63.1.zip") },
                { "downloadType": download_type, "downloadUrl": format!("http://127.0.0.1:{port}/bedrockdedicatedserver/bin-win/bedrock-server-1.26.63.1.zip") },
            ] } });
            (200, body.to_string().into_bytes())
        } else if target == "/bedrockdedicatedserver/bin-win/bedrock-server-1.26.63.1.zip" {
            (200, zip.clone())
        } else {
            (404, Vec::new())
        }
    });
    let ep = Endpoints { links_api: format!("{}/api/links", server.base()) };
    (server, ep)
}

#[test]
fn the_current_windows_release_is_found_and_listed_alone() {
    let (server, ep) = mojang_with_links(server_zip(), "serverBedrockWindows");
    let release = bds::latest_release(&fetcher(), &ep).unwrap();
    assert_eq!(release.version, "1.26.63.1");
    assert!(release.url.ends_with("/bin-win/bedrock-server-1.26.63.1.zip"));
    assert_eq!(bds::list_versions(&fetcher(), &ep).unwrap(), vec!["1.26.63.1".to_string()]);
    server.close();
}

#[test]
fn a_service_with_no_windows_server_or_an_odd_answer_is_a_plain_error() {
    let (server, ep) = mojang_with_links(server_zip(), "serverBedrockSomethingElse");
    assert!(bds::latest_release(&fetcher(), &ep).unwrap_err().contains("no Bedrock server for Windows"));
    server.close();
    let odd = common::Server::start(|_, _, _| (200, b"{\"result\":{}}".to_vec()));
    assert!(bds::latest_release(&fetcher(), &Endpoints { links_api: format!("{}/x", odd.base()) }).unwrap_err().contains("does not understand"));
    odd.close();
    // A download address on a host the policy does not allow is refused before anything is fetched.
    let evil = common::Server::start(|_, _, _| (200, json!({ "result": { "links": [{ "downloadType": "serverBedrockWindows", "downloadUrl": "https://evil.example/bin-win/bedrock-server-1.2.3.zip" }] } }).to_string().into_bytes()));
    assert!(bds::latest_release(&fetcher(), &Endpoints { links_api: format!("{}/x", evil.base()) }).unwrap_err().contains("untrusted host"));
    evil.close();
}

#[test]
fn installing_unpacks_the_server_and_sets_only_the_lines_the_app_owns() {
    let (server, ep) = mojang_with_links(server_zip(), "serverBedrockWindows");
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("bedrock");
    let phases = std::sync::Mutex::new(Vec::new());
    let release = bds::install_server_files(&InstallRequest { dir: &dir, port: 19140, server_name: "  My Pocket Server " }, &fetcher(), &ep, &|p| phases.lock().unwrap().push(match p {
        Phase::Resolving => "resolving",
        Phase::Downloading { .. } => "downloading",
        Phase::Verifying => "verifying",
    }))
    .unwrap();
    assert_eq!(release.version, "1.26.63.1");
    let seen = phases.lock().unwrap().clone();
    assert_eq!((seen.first(), seen.last()), (Some(&"resolving"), Some(&"verifying")));
    assert!(dir.join("bedrock_server.exe").is_file() && dir.join("behavior_packs").join("vanilla").join("manifest.json").is_file());
    assert!(!dir.join(".bedrock-server-download.zip").exists(), "the archive is not kept");
    let props = fs::read_to_string(dir.join("server.properties")).unwrap();
    for line in ["# Mojang defaults", "server-port=19140", "server-portv6=19141", "server-name=My Pocket Server", "gamemode=survival", "allow-list=false", "online-mode=true"] {
        assert!(props.lines().any(|l| l == line), "{line} in {props}");
    }
    assert!(!props.contains("server-port=19132"), "{props}");
    server.close();
}

#[test]
fn an_install_into_a_folder_that_holds_a_server_or_fails_leaves_nothing_behind() {
    let (server, ep) = mojang_with_links(server_zip(), "serverBedrockWindows");
    let root = tempfile::tempdir().unwrap();
    // A folder that already holds a Bedrock server is for Import, never for Install.
    let busy = root.path().join("busy");
    fs::create_dir_all(&busy).unwrap();
    fs::write(busy.join("bedrock_server.exe"), "mine").unwrap();
    let err = bds::install_server_files(&InstallRequest { dir: &busy, port: 19132, server_name: "x" }, &fetcher(), &ep, &|_| {}).unwrap_err();
    assert!(err.contains("already has a Minecraft server"), "{err}");
    assert_eq!(fs::read_to_string(busy.join("bedrock_server.exe")).unwrap(), "mine");
    server.close();

    // A download that is not a Bedrock server: the folder this call made is removed again.
    let mut notzip = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut notzip);
        z.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"hi").unwrap();
        z.finish().unwrap();
    }
    let (bad, bad_ep) = mojang_with_links(notzip.into_inner(), "serverBedrockWindows");
    let made = root.path().join("made");
    let err = bds::install_server_files(&InstallRequest { dir: &made, port: 19132, server_name: "x" }, &fetcher(), &bad_ep, &|_| {}).unwrap_err();
    assert!(err.contains("no bedrock_server.exe"), "{err}");
    assert!(!made.exists(), "the folder it created is gone");
    // The same into a folder that already existed (and is empty): it stays, and is empty again.
    let existing = root.path().join("existing");
    fs::create_dir_all(&existing).unwrap();
    assert!(bds::install_server_files(&InstallRequest { dir: &existing, port: 19132, server_name: "x" }, &fetcher(), &bad_ep, &|_| {}).is_err());
    assert!(existing.is_dir() && fs::read_dir(&existing).unwrap().count() == 0);
    bad.close();
}

// ─── The process ────────────────────────────────────────────────────────────

fn quick() -> StopPolicy {
    StopPolicy { grace: Duration::from_secs(10) }
}

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

/// A server folder whose `bedrock_server.exe` is the stand-in.
fn server_folder() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    fs::copy(env!("CARGO_BIN_EXE_vp-fake-server"), d.path().join("bedrock_server.exe")).unwrap();
    d
}

fn log_has(seen: &[Event], text: &str) -> bool {
    seen.iter().any(|e| matches!(e, Event::Log(l) if l.contains(text)))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bedrock_server_goes_online_on_its_own_ready_line_and_reads_its_own_player_lines() {
    let folder = server_folder();
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_bedrock(folder.path()).await.unwrap();
    let seen = until(&mut rx, 20, |e| *e == Event::Status(Status::Online)).await;
    assert!(log_has(&seen, "Server started."));
    assert!(folder.path().join("worlds").join("Bedrock level").join("level.dat").is_file(), "it ran in its own folder");

    p.send_command("join Steve Smith").await;
    let seen = until(&mut rx, 10, |e| *e == Event::Names(vec!["Steve Smith".into()])).await;
    assert!(seen.contains(&Event::Players(1)));
    assert_eq!(p.online_names(), vec!["Steve Smith".to_string()]);
    p.send_command("leave Steve Smith").await;
    until(&mut rx, 10, |e| *e == Event::Names(vec![])).await;
    assert!(p.online_names().is_empty());

    // A Java-style line is not a Bedrock player.
    p.send_command("say Bob joined the game").await;
    until(&mut rx, 10, |e| matches!(e, Event::Log(l) if l.contains("Bob joined the game"))).await;
    assert!(p.online_names().is_empty());

    p.stop().await;
    let seen = until(&mut rx, 20, |e| matches!(e, Event::Exit(_))).await;
    assert_eq!(seen.last(), Some(&Event::Exit(Some(0))));
    assert_eq!(p.status(), Status::Stopped);
}

#[tokio::test(flavor = "multi_thread")]
async fn console_buttons_send_quoted_names_and_only_the_commands_a_bedrock_server_has() {
    let folder = server_folder();
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_bedrock(folder.path()).await.unwrap();
    until(&mut rx, 20, |e| *e == Event::Status(Status::Online)).await;
    assert!(p.player_action("kick", "Steve Smith").await);
    until(&mut rx, 10, |e| matches!(e, Event::Log(l) if l.contains("Command received: kick \"Steve Smith\""))).await;
    assert!(p.player_action("op", "Alex").await);
    assert!(!p.player_action("ban", "Alex").await, "it has no ban command");
    assert!(!p.player_action("kick", "a\" ; stop").await);
    p.send_command("stop").await;
    until(&mut rx, 20, |e| matches!(e, Event::Exit(_))).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_without_its_program_says_so_and_crashes_cleanly() {
    let empty = tempfile::tempdir().unwrap();
    let (p, mut rx) = ServerProcess::new(quick());
    let err = p.start_bedrock(empty.path()).await.unwrap_err();
    assert!(err.to_string().contains("bedrock_server.exe is missing"), "{err}");
    let seen = until(&mut rx, 5, |e| *e == Event::Status(Status::Crashed)).await;
    assert!(log_has(&seen, "Refusing to start"));
    assert!(!p.is_running());
    // A second start on a good folder works (the failed one left nothing behind).
    let folder = server_folder();
    p.start_bedrock(folder.path()).await.unwrap();
    until(&mut rx, 20, |e| *e == Event::Status(Status::Online)).await;
    p.stop().await;
    until(&mut rx, 20, |e| matches!(e, Event::Exit(_))).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_save_commands_are_answered_in_the_words_the_backup_waits_for() {
    let folder = server_folder();
    let (p, mut rx) = ServerProcess::new(quick());
    p.start_bedrock(folder.path()).await.unwrap();
    until(&mut rx, 20, |e| *e == Event::Status(Status::Online)).await;
    let message_is = |f: fn(&str) -> bool| move |e: &Event| matches!(e, Event::Log(l) if f(&bds::strip_log_prefix(l)));

    // Asked before a hold, it is not ready.
    p.send_command("save query").await;
    until(&mut rx, 10, |e| matches!(e, Event::Log(l) if l.contains("A previous save has not been completed"))).await;
    // Hold, then query: ready, with the files and their lengths as they are on disk.
    p.send_command("save hold").await;
    p.send_command("save query").await;
    let seen = until(&mut rx, 10, message_is(is_files_line)).await;
    assert!(seen.iter().any(message_is(bds::is_save_ready)));
    let Some(Event::Log(list)) = seen.last() else { panic!("{seen:?}") };
    let files = bds::parse_save_files(&bds::strip_log_prefix(list));
    assert_eq!(files.len(), 3);
    for (name, len) in &files {
        assert_eq!(fs::metadata(folder.path().join("worlds").join(name)).unwrap().len(), *len, "{name}");
    }
    p.send_command("save resume").await;
    until(&mut rx, 10, message_is(bds::is_save_resumed)).await;
    p.send_command("stop").await;
    until(&mut rx, 20, |e| matches!(e, Event::Exit(_))).await;
}

fn is_files_line(message: &str) -> bool {
    !bds::parse_save_files(message).is_empty()
}

#[test]
fn a_server_name_with_accents_is_written_as_it_is() {
    let (server, ep) = mojang_with_links(server_zip(), "serverBedrockWindows");
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("accents");
    bds::install_server_files(&InstallRequest { dir: &dir, port: 19132, server_name: "Café Realm 🎮" }, &fetcher(), &ep, &|_| {}).unwrap();
    let props = fs::read_to_string(dir.join("server.properties")).unwrap();
    assert!(props.lines().any(|l| l == "server-name=Café Realm 🎮"), "{props}");
    assert!(!props.contains(r"\u"), "the Bedrock server's file has no Java-style escapes: {props}");
    server.close();
}

/// Asks Mojang's real service which Bedrock server is current (one small request; nothing is downloaded). Run by hand:
/// `cargo test -p voxelport-core --test bds -- --ignored`.
#[test]
#[ignore = "talks to Mojang's real download service"]
fn mojangs_real_service_names_a_current_windows_release() {
    let release = bds::latest_release(&bds::fetcher(), &Endpoints::production()).unwrap();
    println!("current Bedrock server: {} at {}", release.version, release.url);
    assert!(release.url.starts_with("https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-"));
    assert!(release.version.split('.').count() >= 3);
}

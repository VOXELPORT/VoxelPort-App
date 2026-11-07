//! Automatic voice chat: installing the voice plugin when it is missing and pointing it at the relay's public address, against a
//! scripted local Modrinth. Ported from Electron's voice tests; the plugin is asked for by its real project id.

mod common;

use std::cell::Cell;
use std::fs;
use std::sync::{Arc, Mutex};

use common::{fetcher, j, names, query, server_dir, sha512, Server};
use serde_json::{json, Value};
use voxelport_core::cracked::Modrinth;
use voxelport_core::voice::{configure_voice, voice_plan, Plugin, SIMPLE_PROJECT};

const JAR: &[u8] = b"voicechat bytes";

fn modrinth() -> Server {
    let cell = Arc::new(Mutex::new(0u16));
    let c2 = cell.clone();
    let srv = Server::start(move |_, target, _| {
        let port = *c2.lock().unwrap();
        let path = target.split('?').next().unwrap_or("");
        let q = query(target);
        match path {
            p if p == format!("/v2/project/{SIMPLE_PROJECT}/version") => {
                if !q.iter().any(|(k, v)| k == "game_versions" && v.contains("1.21.4")) {
                    return j(json!([]));
                }
                j(json!([{ "version_type": "release", "dependencies": [], "files": [{ "primary": true, "url": format!("http://127.0.0.1:{port}/data/vc.jar"), "filename": "voicechat-bukkit-2.5.jar", "hashes": { "sha512": sha512(JAR) } }] }]))
            }
            "/data/vc.jar" => (200, JAR.to_vec()),
            _ => (404, b"no".to_vec()),
        }
    });
    *cell.lock().unwrap() = srv.port;
    srv
}

fn profile(dir: &std::path::Path, ty: &str) -> Value {
    json!({ "type": ty, "version": "1.21.4", "serverDir": dir.to_string_lossy() })
}

#[test]
fn a_missing_voice_plugin_is_installed_by_its_real_project_id_and_pointed_at_the_relay() {
    let srv = modrinth();
    let (f, d) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let p = profile(d.path(), "paper");
    let plan = voice_plan(&p, None).unwrap().unwrap();
    assert!(!plan.installed);
    let r = configure_voice(&m, &p, &plan, "play.example.in", 30001, false, &|| true).unwrap().unwrap();
    assert_eq!((r.changed, r.plugin, r.port), (true, Plugin::Simple, 24454));
    assert_eq!(names(&d.path().join("plugins")), ["voicechat", "voicechat-bukkit-2.5.jar"]);
    let text = fs::read_to_string(&plan.file).unwrap();
    assert_eq!(text, "bind_address=127.0.0.1\nport=24454\nvoice_host=play.example.in:30001\n");
    assert!(srv.asked().iter().any(|a| a.contains(SIMPLE_PROJECT)), "{:?}", srv.asked());
    assert!(!plan.file.with_extension("properties.voxelport-backup").exists(), "there was nothing to back up");

    // Again, with the plugin now in place: nothing changes.
    let plan2 = voice_plan(&p, None).unwrap().unwrap();
    assert!(plan2.installed);
    let again = configure_voice(&m, &p, &plan2, "play.example.in", 30001, false, &|| true).unwrap().unwrap();
    assert!(!again.changed);
    // A new public port is a change.
    let moved = configure_voice(&m, &p, &plan2, "play.example.in", 30002, false, &|| true).unwrap().unwrap();
    assert!(moved.changed);
    assert!(fs::read_to_string(&plan.file).unwrap().contains("voice_host=play.example.in:30002"));
    srv.close();
}

#[test]
fn the_original_config_is_kept_once_and_later_edits_never_replace_that_copy() {
    let srv = modrinth();
    let (f, d) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let p = profile(d.path(), "paper");
    fs::create_dir_all(d.path().join("plugins").join("voicechat")).unwrap();
    fs::write(d.path().join("plugins").join("voicechat-bukkit-2.4.jar"), "old").unwrap();
    let cfg = d.path().join("plugins").join("voicechat").join("voicechat-server.properties");
    fs::write(&cfg, "port=60606\nmax_voice_distance=48.0\n").unwrap();
    let plan = voice_plan(&p, None).unwrap().unwrap();
    assert!(plan.installed, "an installed plugin is configured, not downloaded again");
    configure_voice(&m, &p, &plan, "play.example.in", 30001, false, &|| true).unwrap();
    configure_voice(&m, &p, &plan, "play.example.in", 30009, false, &|| true).unwrap();
    let backup = d.path().join("plugins").join("voicechat").join("voicechat-server.properties.voxelport-backup");
    assert_eq!(fs::read_to_string(backup).unwrap(), "port=60606\nmax_voice_distance=48.0\n", "the first original, untouched by the second edit");
    let now = fs::read_to_string(&cfg).unwrap();
    assert!(now.contains("max_voice_distance=48.0") && now.contains("port=24454") && now.contains("voice_host=play.example.in:30009"), "{now}");
    assert!(!srv.asked().iter().any(|a| a.contains("/data/")), "nothing was downloaded");
    srv.close();
}

#[test]
fn plasmo_voice_gets_its_two_toml_sections() {
    let srv = modrinth();
    let (f, d) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let p = profile(d.path(), "fabric");
    fs::create_dir_all(d.path().join("mods")).unwrap();
    fs::write(d.path().join("mods").join("plasmovoice-fabric-2.1.jar"), "x").unwrap();
    let plan = voice_plan(&p, Some(24454)).unwrap().unwrap();
    assert_eq!((plan.plugin, plan.port), (Plugin::Plasmo, 24455));
    let r = configure_voice(&m, &p, &plan, "eu.example.in", 30005, true, &|| true).unwrap().unwrap();
    assert!(r.changed);
    let toml = fs::read_to_string(&plan.file).unwrap();
    assert!(toml.contains("[host]\nip = \"127.0.0.1\"\nport = 24455\n") && toml.contains("[host.public]\nip = \"eu.example.in\"\nport = 30005\n"), "{toml}");
    srv.close();
}

#[test]
fn nothing_is_written_when_the_tunnel_moved_on_and_a_bad_address_is_refused() {
    let srv = modrinth();
    let (f, d) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let p = profile(d.path(), "paper");
    let plan = voice_plan(&p, None).unwrap().unwrap();
    assert_eq!(configure_voice(&m, &p, &plan, "play.example.in", 30001, false, &|| false).unwrap(), None);
    assert!(names(d.path()).is_empty(), "stale before starting: nothing at all");

    let calls = Cell::new(0);
    let stale_after_install = || {
        calls.set(calls.get() + 1);
        calls.get() < 2
    };
    assert_eq!(configure_voice(&m, &p, &plan, "play.example.in", 30001, false, &stale_after_install).unwrap(), None);
    assert!(!plan.file.exists(), "stale after the install: the config is not written");

    for (host, port) in [("bad host!", 30001), ("", 30001), ("a/b", 30001), ("play.example.in", 0)] {
        assert_eq!(configure_voice(&m, &p, &plan, host, port, false, &|| true).unwrap_err(), "Invalid voice address from relay.", "{host:?} {port}");
    }
    srv.close();
}

#[test]
fn a_voice_plugin_that_cannot_be_installed_says_why() {
    let srv = modrinth();
    let (f, d) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let mut p = profile(d.path(), "paper");
    p["version"] = json!("1.19");
    let plan = voice_plan(&p, None).unwrap().unwrap();
    let e = configure_voice(&m, &p, &plan, "play.example.in", 30001, false, &|| true).unwrap_err();
    assert_eq!(e, "Simple Voice Chat has no Paper version for Minecraft 1.19.");
    assert!(!plan.file.exists());
    srv.close();
}

//! Plugin and mod search, install (with required libraries), remove, and the modpack import, against a scripted local copy of
//! Modrinth over plain HTTP (the test client allows it; the real one never does). Ported from Electron's addons and
//! modpackImport tests, run against a real socket instead of a fake `fetch`.

mod common;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use common::{fetcher, j, names, nop, query, server_dir, sha512, Server};
use serde_json::{json, Value};
use voxelport_core::addon_registry::installed_addons;
use voxelport_core::addons::{self, InstallRequest};
use voxelport_core::cracked::Modrinth;
use voxelport_core::modpack::{self, Download, Plan};

const MAIN_ID: &str = "AAAAAAAA";
const LIB_ID: &str = "BBBBBBBB";
const MAIN_JAR: &[u8] = b"main plugin bytes";
const LIB_JAR: &[u8] = b"library bytes";

/// A Modrinth with one plugin that requires one library. `lib_hash_known` makes the library's file fingerprint come back from
/// `/version_files` (the person already has it).
fn modrinth(main_hash: String, lib_hash_known: Option<String>) -> Server {
    let cell = Arc::new(Mutex::new(0u16));
    let c2 = cell.clone();
    let srv = Server::start(move |method, target, body| {
        let port = *c2.lock().unwrap();
        let path = target.split('?').next().unwrap_or("");
        let q = query(target);
        let has = |k: &str, v: &str| q.iter().any(|(a, b)| a == k && b.contains(v));
        match (method, path) {
            ("GET", "/v2/search") => {
                let mut hits = vec![
                    json!({ "project_id": MAIN_ID, "slug": "main", "title": "Main", "description": "d", "downloads": 5, "author": "a", "icon_url": "https://cdn.modrinth.com/data/x/icon.png" }),
                    json!({ "project_id": "not-an-id", "title": "Bad id" }),
                    json!({ "project_id": LIB_ID, "slug": "lib", "title": "", "icon_url": "https://evil.example/i.png" }),
                ];
                if has("query", "many") {
                    hits = (0..20).map(|i| json!({ "project_id": format!("{i:08}"), "slug": "s" })).collect();
                }
                j(json!({ "hits": hits }))
            }
            ("GET", p) if p == format!("/v2/project/{MAIN_ID}/version") => {
                if !has("game_versions", "1.21.4") {
                    return j(json!([]));
                }
                j(json!([
                    { "version_type": "beta", "dependencies": [], "files": [{ "primary": true, "url": format!("http://127.0.0.1:{port}/data/beta.jar"), "filename": "Beta.jar", "hashes": { "sha512": "0".repeat(128) } }] },
                    { "version_type": "release",
                      "dependencies": [{ "project_id": LIB_ID, "dependency_type": "required" }, { "project_id": "CCCCCCCC", "dependency_type": "optional" }, { "project_id": "bad", "dependency_type": "required" }],
                      "files": [{ "primary": true, "url": format!("http://127.0.0.1:{port}/data/main.jar"), "filename": "Main-1.0.jar", "hashes": { "sha512": main_hash } }] },
                ]))
            }
            ("GET", p) if p == format!("/v2/project/{LIB_ID}/version") => j(json!([{ "version_type": "release", "dependencies": [{ "project_id": MAIN_ID, "dependency_type": "required" }], "files": [{ "primary": true, "url": format!("http://127.0.0.1:{port}/data/lib.jar"), "filename": "Lib-2.jar", "hashes": { "sha512": sha512(LIB_JAR) } }] }])),
            ("GET", p) if p == format!("/v2/project/{LIB_ID}") => j(json!({ "title": "The Library" })),
            ("POST", "/v2/version_files") => {
                let sent: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                assert_eq!(sent["algorithm"], "sha512");
                match &lib_hash_known {
                    Some(h) if sent["hashes"].as_array().is_some_and(|a| a.iter().any(|x| x == h.as_str())) => j(json!({ h.clone(): { "project_id": LIB_ID } })),
                    _ => j(json!({})),
                }
            }
            ("GET", "/data/main.jar") => (200, MAIN_JAR.to_vec()),
            ("GET", "/data/lib.jar") => (200, LIB_JAR.to_vec()),
            _ => (404, b"no".to_vec()),
        }
    });
    *cell.lock().unwrap() = srv.port;
    srv
}

fn request<'a>(dir: &'a Path, ty: &'a str, running: bool) -> InstallRequest<'a> {
    InstallRequest { server_dir: dir, server_type: ty, version: "1.21.4", project_id: MAIN_ID, title: "Main", icon: "https://cdn.modrinth.com/data/x/icon.png", running }
}

#[test]
fn search_asks_for_the_right_loaders_and_version_and_trusts_nothing_it_gets_back() {
    let srv = modrinth(sha512(MAIN_JAR), None);
    let f = fetcher();
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let res = addons::search(&m, "paper", "1.21.4", "  minimap ", false, 0).unwrap();
    let hits = res["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 2, "the hit with a malformed project id is dropped");
    assert_eq!(hits[0]["icon"], "https://cdn.modrinth.com/data/x/icon.png");
    assert_eq!(hits[1]["icon"], "", "a foreign icon address is dropped");
    assert_eq!(hits[1]["title"], "lib", "an empty title falls back to the slug");
    assert_eq!(res["more"], false);

    let asked = srv.asked();
    let q = query(&asked[0]);
    let get = |k: &str| q.iter().find(|(a, _)| a == k).map(|x| x.1.clone()).unwrap();
    assert_eq!(get("query"), "minimap");
    assert_eq!(get("index"), "relevance");
    assert_eq!(get("facets"), r#"[["project_type:mod","project_type:plugin"],["categories:paper","categories:spigot","categories:bukkit"],["versions:1.21.4"]]"#);

    addons::search(&m, "fabric", "1.21.4", "", true, 40).unwrap();
    let q = query(&srv.asked()[1]);
    let get = |k: &str| q.iter().find(|(a, _)| a == k).map(|x| x.1.clone()).unwrap();
    assert_eq!(get("index"), "downloads", "no query: most downloaded first");
    assert_eq!(get("offset"), "40");
    assert_eq!(get("facets"), r#"[["project_type:mod"],["categories:fabric"]]"#, "any-version leaves the version out");

    addons::search(&m, "paper", "1.21.4", "q", false, -5).unwrap();
    assert_eq!(query(&srv.asked()[2]).iter().find(|(a, _)| a == "offset").unwrap().1, "0", "an out-of-range offset becomes 0");
    assert_eq!(addons::search(&m, "paper", "1.21.4", "many", false, 0).unwrap()["more"], true, "a full page means there may be more");
    assert!(addons::search(&m, "vanilla", "1.21.4", "", false, 0).unwrap_err().contains("Paper or Fabric"));
    srv.close();
}

#[test]
fn installing_brings_the_required_library_first_and_records_both() {
    let srv = modrinth(sha512(MAIN_JAR), None);
    let (f, dir) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let stages = Mutex::new(Vec::new());
    let done = addons::install(&m, &request(dir.path(), "paper", false), &|p| stages.lock().unwrap().push(p["stage"].as_str().unwrap().to_string())).unwrap();
    assert_eq!(done, ["The Library", "Main"], "libraries first, by their real titles");
    assert_eq!(names(&dir.path().join("plugins")), ["Lib-2.jar", "Main-1.0.jar"]);
    assert_eq!(fs::read(dir.path().join("plugins").join("Main-1.0.jar")).unwrap(), MAIN_JAR);
    assert_eq!(stages.lock().unwrap().last().unwrap(), "done");

    let list = installed_addons(dir.path()).unwrap();
    assert_eq!(list.len(), 2);
    let main = list.iter().find(|a| a["id"] == MAIN_ID).unwrap();
    assert_eq!((main["file"].as_str(), main["dir"].as_str(), main["icon"].as_str()), (Some("Main-1.0.jar"), Some("plugins"), Some("https://cdn.modrinth.com/data/x/icon.png")));
    assert!(list.iter().find(|a| a["id"] == LIB_ID).unwrap().get("icon").is_none(), "only the chosen project keeps the icon");
    srv.close();
}

#[test]
fn a_library_the_person_already_has_is_recognised_by_its_fingerprint_and_not_downloaded() {
    let srv = modrinth(sha512(MAIN_JAR), Some(sha512(b"their own copy")));
    let (f, dir) = (fetcher(), server_dir());
    fs::create_dir_all(dir.path().join("plugins")).unwrap();
    fs::write(dir.path().join("plugins").join("my-lib.jar"), b"their own copy").unwrap();
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let done = addons::install(&m, &request(dir.path(), "paper", false), &nop).unwrap();
    assert_eq!(done, ["Main"]);
    assert_eq!(names(&dir.path().join("plugins")), ["Main-1.0.jar", "my-lib.jar"]);
    assert!(!srv.asked().iter().any(|a| a.contains("lib.jar")), "the library was never downloaded");
    srv.close();
}

#[test]
fn a_wrong_checksum_installs_nothing_and_records_nothing() {
    let srv = modrinth("f".repeat(128), None);
    let (f, dir) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let e = addons::install(&m, &request(dir.path(), "paper", false), &nop).unwrap_err();
    assert!(e.message.contains("verification"), "{}", e.message);
    // The library installed fine before the main file failed; it is recorded, the main one is not.
    assert!(!names(&dir.path().join("plugins")).iter().any(|n| n.starts_with("Main") || n.starts_with('.')), "{:?}", names(&dir.path().join("plugins")));
    assert!(installed_addons(dir.path()).unwrap().iter().all(|a| a["id"] != MAIN_ID));
    srv.close();
}

#[test]
fn a_file_the_person_put_there_is_never_overwritten() {
    let srv = modrinth(sha512(MAIN_JAR), None);
    let (f, dir) = (fetcher(), server_dir());
    fs::create_dir_all(dir.path().join("plugins")).unwrap();
    fs::write(dir.path().join("plugins").join("Main-1.0.jar"), b"mine").unwrap();
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let e = addons::install(&m, &request(dir.path(), "paper", false), &nop).unwrap_err();
    assert_eq!((e.code, e.file.as_deref()), (Some("exists"), Some("Main-1.0.jar")));
    assert_eq!(fs::read(dir.path().join("plugins").join("Main-1.0.jar")).unwrap(), b"mine");
    srv.close();
}

#[test]
fn a_running_server_can_get_new_files_but_not_updates() {
    let srv = modrinth(sha512(MAIN_JAR), None);
    let (f, dir) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    addons::install(&m, &request(dir.path(), "paper", true), &nop).unwrap();
    let e = addons::install(&m, &request(dir.path(), "paper", true), &nop).unwrap_err();
    assert!(e.message.contains("Stop the server first"), "{}", e.message);
    // Stopped, the same install is an update and replaces the file.
    addons::install(&m, &request(dir.path(), "paper", false), &nop).unwrap();
    srv.close();
}

#[test]
fn an_update_to_a_new_file_name_removes_the_old_file() {
    let srv = modrinth(sha512(MAIN_JAR), None);
    let (f, dir) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    fs::create_dir_all(dir.path().join("plugins")).unwrap();
    fs::write(dir.path().join("plugins").join("Main-0.9.jar"), b"old").unwrap();
    voxelport_core::addon_registry::register_addon(dir.path(), MAIN_ID, "Main", "Main-0.9.jar", "plugins", "").unwrap();
    addons::install(&m, &request(dir.path(), "paper", false), &nop).unwrap();
    assert_eq!(names(&dir.path().join("plugins")), ["Lib-2.jar", "Main-1.0.jar"]);
    srv.close();
}

#[test]
fn nothing_for_this_minecraft_version_is_said_plainly_and_bad_input_is_refused_before_any_request() {
    let srv = modrinth(sha512(MAIN_JAR), None);
    let (f, dir) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    let mut req = request(dir.path(), "fabric", false);
    req.version = "1.19";
    assert_eq!(addons::install(&m, &req, &nop).unwrap_err().message, "Main has no Fabric version for Minecraft 1.19.");
    let before = srv.asked().len();
    for (ty, id) in [("vanilla", MAIN_ID), ("paper", "short"), ("paper", "../../..")] {
        let mut r = request(dir.path(), ty, false);
        r.project_id = id;
        assert!(addons::install(&m, &r, &nop).is_err());
    }
    assert!(addons::install(&m, &request(Path::new("relative"), "paper", false), &nop).is_err());
    assert_eq!(srv.asked().len(), before, "no request was made for refused input");
    srv.close();
}

#[test]
fn remove_deletes_only_what_voxelport_installed_and_not_while_running() {
    let srv = modrinth(sha512(MAIN_JAR), None);
    let (f, dir) = (fetcher(), server_dir());
    let m = Modrinth { fetcher: &f, api: &srv.api() };
    addons::install(&m, &request(dir.path(), "paper", false), &nop).unwrap();
    fs::write(dir.path().join("plugins").join("Handmade.jar"), b"x").unwrap();

    assert!(addons::remove(dir.path(), MAIN_ID, true).unwrap_err().contains("Stop the server first"));
    assert!(dir.path().join("plugins").join("Main-1.0.jar").exists());
    assert!(addons::remove(dir.path(), "ZZZZZZZZ", false).unwrap_err().contains("not installed by VoxelPort"));
    assert!(addons::remove(dir.path(), "bad", false).is_err());

    addons::remove(dir.path(), MAIN_ID, false).unwrap();
    assert_eq!(names(&dir.path().join("plugins")), ["Handmade.jar", "Lib-2.jar"]);
    assert_eq!(installed_addons(dir.path()).unwrap().iter().map(|a| a["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(), [LIB_ID]);
    srv.close();
}

#[test]
fn icons_are_only_fetched_from_modrinths_image_host() {
    let f = addons::icon_fetcher();
    for bad in ["http://cdn.modrinth.com/x.png", "https://evil.example/x.png", "https://cdn.modrinth.com.evil.example/x.png", "file:///C:/x.png", "", "https://cdn.modrinth.com:8443/x.png"] {
        assert_eq!(addons::fetch_icon(&f, bad), "", "{bad}");
    }
}

// ─── Modpacks ───────────────────────────────────────────────────────────────

fn mrpack(dir: &Path, name: &str, entries: &[(&str, Vec<u8>)]) -> PathBuf {
    let path = dir.join(name);
    let mut w = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for (n, bytes) in entries {
        w.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(bytes).unwrap();
    }
    w.finish().unwrap();
    path
}

fn index(files: Value) -> Vec<u8> {
    json!({ "formatVersion": 1, "game": "minecraft", "name": "Test Pack", "dependencies": { "minecraft": "1.21.4", "fabric-loader": "0.16.9" }, "files": files }).to_string().into_bytes()
}

#[test]
fn a_pack_is_read_without_extracting_anything() {
    let d = tempfile::tempdir().unwrap();
    let files = json!([{ "path": "mods/a.jar", "hashes": { "sha512": "a".repeat(128) }, "downloads": ["https://cdn.modrinth.com/data/a.jar"], "env": { "client": "required", "server": "unsupported" } }, { "path": "mods/b.jar", "hashes": { "sha512": "b".repeat(128) }, "downloads": ["https://cdn.modrinth.com/data/b.jar"] }]);
    let file = mrpack(d.path(), "p.mrpack", &[("overrides/config/x.toml", b"x".to_vec()), ("modrinth.index.json", index(files))]);
    let plan = modpack::read_plan(&file).unwrap();
    assert_eq!((plan.name.as_str(), plan.minecraft.as_str(), plan.downloads.len(), plan.skipped.len()), ("Test Pack", "1.21.4", 1, 1));
    assert_eq!(names(d.path()), ["p.mrpack"], "nothing was extracted");
}

#[test]
fn files_that_are_not_readable_modpacks_are_refused_with_a_clear_code() {
    let d = tempfile::tempdir().unwrap();
    let code = |p: &Path| modpack::read_plan(p).unwrap_err().code;
    assert_eq!(code(&mrpack(d.path(), "noindex.mrpack", &[("other.txt", b"x".to_vec())])), "not-mrpack");
    fs::write(d.path().join("junk.mrpack"), b"this is not a zip").unwrap();
    assert_eq!(code(&d.path().join("junk.mrpack")), "bad-pack");
    assert_eq!(code(&mrpack(d.path(), "badjson.mrpack", &[("modrinth.index.json", b"{ nope".to_vec())])), "bad-pack");
    assert_eq!(code(&mrpack(d.path(), "huge.mrpack", &[("modrinth.index.json", vec![b' '; 2 * 1024 * 1024 + 1])])), "too-big");
    assert_eq!(code(&mrpack(d.path(), "p.zip", &[("modrinth.index.json", index(json!([])))])), "bad-pack", "wrong extension");
    assert_eq!(code(Path::new("relative.mrpack")), "bad-pack");
    assert_eq!(code(&d.path().join("missing.mrpack")), "bad-pack");
}

#[test]
fn mods_are_downloaded_verified_and_the_packs_config_is_copied_inside_the_server_folder() {
    let a: &[u8] = b"mod a bytes";
    let srv = Server::start(move |_, target, _| if target == "/a.jar" { (200, a.to_vec()) } else { (404, b"no".to_vec()) });
    let (f, d) = (fetcher(), tempfile::tempdir().unwrap());
    let file = mrpack(
        d.path(),
        "p.mrpack",
        &[
            ("modrinth.index.json", index(json!([]))),
            ("overrides/config/tuned.toml", b"from overrides".to_vec()),
            ("overrides/config/both.toml", b"overrides".to_vec()),
            ("server-overrides/config/both.toml", b"server wins".to_vec()),
            ("overrides/mods/shipped.jar", b"shipped".to_vec()),
            ("overrides/options.txt", b"client file".to_vec()),
            ("overrides/saves/world/level.dat", b"world".to_vec()),
            ("overrides/config/../../evil.txt", b"escape".to_vec()),
            ("overrides/config/a b (1).toml", b"tame names are fine".to_vec()),
            ("overrides/config/bad;name.toml", b"odd character".to_vec()),
        ],
    );
    let server = d.path().join("server");
    fs::create_dir_all(&server).unwrap();
    let plan = Plan { name: "P".into(), minecraft: "1.21.4".into(), quilt: false, downloads: vec![Download { path: "mods/a.jar".into(), url: format!("{}/a.jar", srv.base()), sha512: sha512(a), bytes: 0 }], skipped: vec![] };
    let stages = Mutex::new(Vec::new());
    let count = modpack::install_mods(&f, &file, &server, &plan, &|p| stages.lock().unwrap().push(p["stage"].as_str().unwrap().to_string())).unwrap();
    assert_eq!(count, 1);
    assert_eq!(*stages.lock().unwrap(), ["download", "config", "done"]);
    assert_eq!(fs::read(server.join("mods").join("a.jar")).unwrap(), a);
    assert_eq!(fs::read(server.join("mods").join("shipped.jar")).unwrap(), b"shipped");
    assert_eq!(fs::read(server.join("config").join("both.toml")).unwrap(), b"server wins");
    assert_eq!(fs::read(server.join("config").join("a b (1).toml")).unwrap(), b"tame names are fine");
    assert_eq!(names(&server), ["config", "mods"], "client files, worlds and escapes are left out");
    assert_eq!(names(&server.join("config")), ["a b (1).toml", "both.toml", "tuned.toml"]);
    assert!(!d.path().join("evil.txt").exists());
    srv.close();
}

#[test]
fn a_mod_with_the_wrong_checksum_stops_the_import_and_leaves_no_file() {
    let srv = Server::start(|_, _, _| (200, b"not the mod".to_vec()));
    let (f, d) = (fetcher(), tempfile::tempdir().unwrap());
    let file = mrpack(d.path(), "p.mrpack", &[("modrinth.index.json", index(json!([])))]);
    let server = d.path().join("server");
    fs::create_dir_all(&server).unwrap();
    let plan = Plan { name: "P".into(), minecraft: "1.21.4".into(), quilt: false, downloads: vec![Download { path: "mods/a.jar".into(), url: format!("{}/a.jar", srv.base()), sha512: "0".repeat(128), bytes: 0 }], skipped: vec![] };
    let e = modpack::install_mods(&f, &file, &server, &plan, &|_| {}).unwrap_err();
    assert_eq!(e.code, "download");
    assert!(e.message.contains("verification"), "{}", e.message);
    assert!(names(&server.join("mods")).is_empty());
    srv.close();
}

#[test]
fn an_override_that_is_far_too_large_stops_the_import() {
    let (f, d) = (fetcher(), tempfile::tempdir().unwrap());
    let file = mrpack(d.path(), "p.mrpack", &[("modrinth.index.json", index(json!([]))), ("overrides/config/big.bin", vec![0u8; 65 * 1024 * 1024])]);
    let server = d.path().join("server");
    fs::create_dir_all(&server).unwrap();
    let plan = Plan { name: String::new(), minecraft: "1.21.4".into(), quilt: false, downloads: vec![], skipped: vec![] };
    assert!(modpack::install_mods(&f, &file, &server, &plan, &|_| {}).is_err());
}

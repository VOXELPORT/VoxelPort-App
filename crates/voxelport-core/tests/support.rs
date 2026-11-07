//! Where the Support screen's words come from: voxelport.in's support.json, cached for twelve hours, falling back to the last good
//! copy and then to the built-in text. Ported from Electron's support tests, run against a real socket instead of a fake `fetch`.

mod common;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use common::{fetcher, j, server_dir, Server};
use serde_json::{json, Value};
use voxelport_core::support::{get_support, load_remote};

fn site(body: Value, status: u16, hits: Arc<AtomicU32>) -> Server {
    Server::start(move |_, _, _| {
        hits.fetch_add(1, Ordering::SeqCst);
        if status == 200 { j(body.clone()) } else { (status, b"no".to_vec()) }
    })
}

fn good() -> Value {
    json!({ "version": 1, "supporter": { "tiers": [{ "name": "Gold", "inr": 150, "perks": ["Shiny"] }] }, "hosts": { "items": [{ "id": "one", "name": "One", "url": "https://one.example/" }] } })
}

fn url(s: &Server) -> String {
    format!("{}/support.json", s.base())
}

#[test]
fn a_fresh_cache_is_used_without_asking_the_website_again_and_a_stale_one_is_refreshed() {
    let (d, hits) = (server_dir(), Arc::new(AtomicU32::new(0)));
    let srv = site(good(), 200, hits.clone());
    let f = fetcher();
    let now = SystemTime::now();
    assert!(load_remote(d.path(), &f, &url(&srv), now, false).is_some());
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert!(d.path().join("support-cache.json").exists());
    load_remote(d.path(), &f, &url(&srv), now + Duration::from_secs(60), false);
    assert_eq!(hits.load(Ordering::SeqCst), 1, "inside twelve hours nothing is fetched");
    load_remote(d.path(), &f, &url(&srv), now + Duration::from_secs(13 * 3600), false);
    assert_eq!(hits.load(Ordering::SeqCst), 2, "after twelve hours it is fetched again");
    load_remote(d.path(), &f, &url(&srv), now, true);
    assert_eq!(hits.load(Ordering::SeqCst), 3, "force skips the cache");
    srv.close();
}

#[test]
fn the_screen_shows_the_validated_words_from_the_site() {
    let (d, hits) = (server_dir(), Arc::new(AtomicU32::new(0)));
    let srv = site(good(), 200, hits);
    let s = get_support(d.path(), "desktop", &fetcher(), &url(&srv), SystemTime::now(), false);
    assert_eq!(s["supporter"]["tiers"][0]["name"], "Gold");
    assert_eq!(s["hosts"]["items"][0]["id"], "one");
    assert_eq!(s["donate"]["upiId"], "trazhub@upi");
    srv.close();
}

#[test]
fn when_the_website_is_down_the_last_good_copy_is_shown_and_with_none_the_built_in_text() {
    let d = server_dir();
    let hits = Arc::new(AtomicU32::new(0));
    let up = site(good(), 200, hits.clone());
    let f = fetcher();
    let now = SystemTime::now();
    load_remote(d.path(), &f, &url(&up), now, false);
    up.close();
    let stale = now + Duration::from_secs(20 * 3600);
    let down = site(json!({}), 500, hits.clone());
    let kept = load_remote(d.path(), &f, &url(&down), stale, false).expect("the last good copy");
    assert_eq!(kept["supporter"]["tiers"][0]["name"], "Gold");
    down.close();

    let empty = server_dir();
    let dead = format!("http://127.0.0.1:1/support.json");
    assert!(load_remote(empty.path(), &f, &dead, now, false).is_none());
    let s = get_support(empty.path(), "desktop", &f, &dead, now, false);
    assert_eq!(s["supporter"]["tiers"][0]["name"], "Supporter", "the built-in tiers");
    assert_eq!(s["hosts"]["items"], json!([]), "no hosting suggestions without the site");
}

#[test]
fn an_answer_in_the_wrong_format_or_too_large_is_ignored_and_never_cached() {
    let f = fetcher();
    for body in [json!({ "version": 2 }), json!([1, 2]), json!("text"), json!({ "version": 1, "pad": "x".repeat(70_000) })] {
        let (d, hits) = (server_dir(), Arc::new(AtomicU32::new(0)));
        let srv = site(body.clone(), 200, hits);
        assert!(load_remote(d.path(), &f, &url(&srv), SystemTime::now(), false).is_none(), "{}", body.to_string().chars().take(40).collect::<String>());
        assert!(!d.path().join("support-cache.json").exists());
        srv.close();
    }
}

#[test]
fn a_damaged_cache_file_is_ignored() {
    let (d, hits) = (server_dir(), Arc::new(AtomicU32::new(0)));
    std::fs::write(d.path().join("support-cache.json"), "{ nope").unwrap();
    let srv = site(good(), 200, hits.clone());
    assert!(load_remote(d.path(), &fetcher(), &url(&srv), SystemTime::now(), false).is_some());
    assert_eq!(hits.load(Ordering::SeqCst), 1, "the damaged cache was not trusted");
    srv.close();
}

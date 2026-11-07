//! The "Support VoxelPort" screen: tipping, supporter perks, and paid-hosting suggestions. Ported from `support.js`.
//!
//! The donation target (UPI ID, GitHub Sponsors) is fixed in this file, so a changed website can never redirect anyone's tip. The
//! wording, supporter perks and hosting links come from `https://voxelport.in/support.json` (so they can change without an app
//! update); everything read from it is validated here, and hosting links are only ever opened by id from the validated list, never
//! from a URL the page supplies.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use crate::atomic_write;
use crate::net::{Fetcher, HostPolicy};

pub const SUPPORT_URL: &str = "https://voxelport.in/support.json";
const CACHE_FILE: &str = "support-cache.json";
const CACHE_MAX_AGE: Duration = Duration::from_secs(12 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_JSON_BYTES: u64 = 64 * 1024;
const MAX_HOSTS: usize = 6;
const MAX_TIERS: usize = 4;
const MAX_PERKS: usize = 8;

pub const UPI_ID: &str = "trazhub@upi";
pub const UPI_LINK: &str = "upi://pay?pa=trazhub@upi&pn=VoxelPort&cu=INR&tn=Support%20VoxelPort";
pub const SPONSORS_URL: &str = "https://github.com/sponsors/trazhub";
pub const PAGE_URL: &str = "https://voxelport.in/#support";
pub const PERKS_URL: &str = "https://voxelport.in/#supporters";
pub const CONTACT: &str = "traz@voxelport.in";

const DEFAULT_DISCLOSURE: &str = "Some of these are affiliate links: VoxelPort may earn a commission if you sign up, at no extra cost to you. VoxelPort itself stays free either way.";

/// What shows when voxelport.in can't be reached and nothing is cached.
fn default_supporter() -> Value {
    json!({
        "intro": "VoxelPort stays free for everyone. If you want to chip in, supporters get a few extras as a thank-you.",
        "tiers": [
            { "name": "Supporter", "inr": 99, "perks": ["★ Supporter badge on the server list, and your server pinned to the top", "Your custom address never expires from disuse"] },
            { "name": "Supporter+", "inr": 299, "perks": ["Everything in Supporter", "A short address of 1–2 characters, like vp.voxelport.in"] },
        ],
        "how": format!("Tip by UPI, then email {CONTACT} with your UPI reference number and your server's address. It's switched on by hand, usually within a day or two."),
        "fine": "Perks are a thank-you for a donation, not a purchase, and last as long as VoxelPort runs.",
    })
}

/// Plain text: control characters and angle brackets removed, whitespace collapsed, cut to `max` characters.
pub fn clean_text(value: &Value, max: usize) -> String {
    let Some(s) = value.as_str() else { return String::new() };
    let spaced: String = s.chars().map(|c| if (c as u32) <= 0x1f || c == '\u{7f}' || c == '<' || c == '>' { ' ' } else { c }).collect();
    let collapsed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max { collapsed.chars().take(max).collect::<String>().trim().to_string() } else { collapsed }
}

/// A hosting link is https to a real domain: no credentials, no port, no IP address, no localhost.
pub fn is_safe_host_url(value: &Value) -> bool {
    let Some(s) = value.as_str().filter(|s| s.len() <= 500) else { return false };
    let Ok(u) = url::Url::parse(s) else { return false };
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return false;
    }
    let Some(host) = u.host_str().map(str::to_ascii_lowercase) else { return false };
    if !host.contains('.') || host == "localhost" || host.ends_with(".local") || host.ends_with(".internal") {
        return false;
    }
    !(host.bytes().all(|b| b.is_ascii_digit() || b == b'.') || host.contains(':'))
}

fn is_host_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The hosting suggestions for one app (`desktop` or `android`). Empty items means "show nothing".
pub fn sanitize_hosts(raw: &Value, device: &str) -> Value {
    let empty = json!({ "intro": "", "disclosure": "", "items": [] });
    if !raw.is_object() {
        return empty;
    }
    let mut items: Vec<Value> = Vec::new();
    for it in raw["items"].as_array().map(Vec::as_slice).unwrap_or_default() {
        if items.len() >= MAX_HOSTS || !it.is_object() {
            continue;
        }
        let id = it["id"].as_str().unwrap_or("");
        if !is_host_id(id) || items.iter().any(|i| i["id"] == id) {
            continue;
        }
        let name = clean_text(&it["name"], 40);
        if name.is_empty() || !is_safe_host_url(&it["url"]) {
            continue;
        }
        if let Some(only) = it["for"].as_array() {
            if !only.iter().any(|d| d == device) {
                continue;
            }
        }
        items.push(json!({ "id": id, "name": name, "blurb": clean_text(&it["blurb"], 140), "url": it["url"], "affiliate": it["affiliate"] == true }));
    }
    if items.is_empty() {
        return empty;
    }
    let intro = if raw["intro"].is_object() { clean_text(&raw["intro"][device], 220) } else { clean_text(&raw["intro"], 220) };
    let disclosure = Some(clean_text(&raw["disclosure"], 300)).filter(|d| !d.is_empty()).unwrap_or_else(|| DEFAULT_DISCLOSURE.to_string());
    json!({ "intro": intro, "disclosure": disclosure, "items": items })
}

pub fn sanitize_supporter(raw: &Value) -> Value {
    if !raw.is_object() {
        return default_supporter();
    }
    let mut tiers: Vec<Value> = Vec::new();
    for t in raw["tiers"].as_array().map(|a| a.iter().take(MAX_TIERS)).into_iter().flatten() {
        if !t.is_object() {
            continue;
        }
        let name = clean_text(&t["name"], 30);
        let inr = t["inr"].as_f64().filter(|n| n.is_finite() && *n > 0.0 && *n < 1e6).map(|n| n.round() as u64).unwrap_or(0);
        let perks: Vec<String> = t["perks"].as_array().map(|a| a.iter().take(MAX_PERKS).map(|p| clean_text(p, 200)).filter(|p| !p.is_empty()).collect()).unwrap_or_default();
        if !name.is_empty() && inr != 0 && !perks.is_empty() {
            tiers.push(json!({ "name": name, "inr": inr, "perks": perks }));
        }
    }
    if tiers.is_empty() {
        return default_supporter();
    }
    let d = default_supporter();
    let text = |k: &str, max: usize| Some(clean_text(&raw[k], max)).filter(|t| !t.is_empty()).unwrap_or_else(|| d[k].as_str().unwrap().to_string());
    json!({ "intro": text("intro", 300), "tiers": tiers, "how": text("how", 400), "fine": text("fine", 300) })
}

/// Everything the Support screen shows, from whatever support.json said (or nothing).
pub fn build_support(remote: Option<&Value>, device: &str) -> Value {
    let null = Value::Null;
    let r = remote.filter(|r| r.is_object()).unwrap_or(&null);
    json!({
        "donate": { "upiId": UPI_ID, "upiLink": UPI_LINK, "sponsorsUrl": SPONSORS_URL, "pageUrl": PAGE_URL, "perksUrl": PERKS_URL },
        "contact": CONTACT,
        "supporter": sanitize_supporter(&r["supporter"]),
        "hosts": sanitize_hosts(&r["hosts"], device),
    })
}

/// The client for support.json: voxelport.in only, and a short time limit (this screen must not hang on a bad connection).
pub fn support_fetcher() -> Fetcher {
    Fetcher::new(HostPolicy::exact(&["voxelport.in"]), "Support", crate::mc_versions::USER_AGENT).with_timeout(FETCH_TIMEOUT)
}

fn read_cache(file: &Path) -> Option<(Value, SystemTime)> {
    let at = fs::metadata(file).ok()?.modified().ok()?;
    let data = serde_json::from_str(&fs::read_to_string(file).ok()?).ok()?;
    Some((data, at))
}

/// support.json from voxelport.in, cached in `dir` for 12 hours; falls back to the last good copy, then to nothing (the built-in
/// defaults). Never fails.
pub fn load_remote(dir: &Path, fetcher: &Fetcher, url: &str, now: SystemTime, force: bool) -> Option<Value> {
    let file = dir.join(CACHE_FILE);
    let cached = read_cache(&file);
    if let Some((data, at)) = &cached {
        if !force && now.duration_since(*at).map_or(true, |age| age < CACHE_MAX_AGE) {
            return Some(data.clone());
        }
    }
    let fetched = fetcher.fetch_json(url, MAX_JSON_BYTES).ok().filter(|d| d.is_object() && d["version"] == 1);
    match fetched {
        Some(data) => {
            let _ = fs::create_dir_all(dir);
            let _ = atomic_write(&file, data.to_string().as_bytes()); // the cache is optional
            Some(data)
        }
        None => cached.map(|(d, _)| d),
    }
}

pub fn get_support(dir: &Path, device: &str, fetcher: &Fetcher, url: &str, now: SystemTime, force: bool) -> Value {
    build_support(load_remote(dir, fetcher, url, now, force).as_ref(), device)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_made_plain_and_cut() {
        assert_eq!(clean_text(&json!("  a\u{1}b\t<b>c</b>\n\n d "), 50), "a b b c /b d");
        assert_eq!(clean_text(&json!("x".repeat(100)), 10), "xxxxxxxxxx");
        assert_eq!(clean_text(&json!("hello world"), 6), "hello");
        assert_eq!(clean_text(&json!(5), 10), "");
        assert_eq!(clean_text(&Value::Null, 10), "");
        assert_eq!(clean_text(&json!("★ badge — ok"), 50), "★ badge — ok", "ordinary non-ASCII text stays");
    }

    #[test]
    fn a_hosting_link_must_be_a_plain_https_address_to_a_real_domain() {
        for ok in ["https://example.com/", "https://www.host.example.in/plans?ref=vp", "https://a.io/x#y"] {
            assert!(is_safe_host_url(&json!(ok)), "{ok}");
        }
        for bad in [
            "http://example.com/", "https://user:pw@example.com/", "https://example.com:8443/", "https://localhost/", "https://127.0.0.1/",
            "https://2130706433/", "https://[::1]/", "https://printer.local/", "https://db.internal/", "https://nodots/", "javascript:alert(1)",
            "ftp://example.com/", "nope", "",
        ] {
            assert!(!is_safe_host_url(&json!(bad)), "{bad}");
        }
        assert!(!is_safe_host_url(&json!(format!("https://example.com/{}", "a".repeat(500)))), "too long");
        assert!(!is_safe_host_url(&json!(5)));
    }

    fn hosts() -> Value {
        json!({
            "intro": { "desktop": "For your PC", "android": "For your phone" },
            "items": [
                { "id": "one", "name": "Host One", "blurb": "Fast", "url": "https://one.example/", "affiliate": true },
                { "id": "one", "name": "Duplicate", "url": "https://dup.example/" },
                { "id": "Bad Id", "name": "Bad", "url": "https://bad.example/" },
                { "id": "evil", "name": "Evil", "url": "javascript:alert(1)" },
                { "id": "phone", "name": "Phone only", "url": "https://phone.example/", "for": ["android"] },
                { "id": "noname", "name": "  ", "url": "https://noname.example/" },
                { "id": "two", "name": "<Two>", "url": "https://two.example/", "for": ["desktop", "android"] },
            ],
        })
    }

    #[test]
    fn hosting_suggestions_keep_only_safe_unique_entries_for_this_app() {
        let h = sanitize_hosts(&hosts(), "desktop");
        let ids: Vec<&str> = h["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["one", "two"]);
        assert_eq!(h["items"][0], json!({ "id": "one", "name": "Host One", "blurb": "Fast", "url": "https://one.example/", "affiliate": true }));
        assert_eq!(h["items"][1]["name"], "Two", "angle brackets are removed from names");
        assert_eq!(h["intro"], "For your PC");
        assert_eq!(h["disclosure"], DEFAULT_DISCLOSURE, "an affiliate note is always shown");
        assert_eq!(sanitize_hosts(&hosts(), "android")["intro"], "For your phone");
        assert_eq!(sanitize_hosts(&hosts(), "android")["items"].as_array().unwrap().len(), 3);
        assert_eq!(sanitize_hosts(&json!({ "intro": "plain", "items": [{ "id": "a", "name": "A", "url": "https://a.example/" }] }), "desktop")["intro"], "plain");
        for none in [Value::Null, json!("x"), json!({}), json!({ "items": [] }), json!({ "items": [{ "id": "e", "name": "E", "url": "http://e.example/" }] })] {
            assert_eq!(sanitize_hosts(&none, "desktop"), json!({ "intro": "", "disclosure": "", "items": [] }), "{none}");
        }
        let many: Vec<Value> = (0..10).map(|i| json!({ "id": format!("h{i}"), "name": "H", "url": "https://h.example/" })).collect();
        assert_eq!(sanitize_hosts(&json!({ "items": many }), "desktop")["items"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn supporter_tiers_are_validated_and_fall_back_to_the_built_in_ones() {
        let ok = sanitize_supporter(&json!({
            "intro": "Hi <there>", "how": "Email us", "fine": "Fine print",
            "tiers": [
                { "name": "Gold", "inr": 149.6, "perks": ["A", "", "B", 5] },
                { "name": "Free", "inr": 0, "perks": ["x"] },
                { "name": "NoPerks", "inr": 10, "perks": [] },
                { "name": "", "inr": 10, "perks": ["x"] },
                { "name": "Huge", "inr": 1e9, "perks": ["x"] },
                { "name": "Text", "inr": "99", "perks": ["x"] },
            ],
        }));
        assert_eq!(ok["tiers"], json!([{ "name": "Gold", "inr": 150, "perks": ["A", "B"] }]));
        assert_eq!((ok["intro"].as_str(), ok["how"].as_str(), ok["fine"].as_str()), (Some("Hi there"), Some("Email us"), Some("Fine print")));
        let partial = sanitize_supporter(&json!({ "tiers": [{ "name": "Gold", "inr": 10, "perks": ["A"] }] }));
        assert_eq!(partial["intro"], default_supporter()["intro"], "missing words come from the built-in text");
        for none in [Value::Null, json!([]), json!({}), json!({ "tiers": [] }), json!({ "tiers": [{ "name": "x" }] })] {
            assert_eq!(sanitize_supporter(&none), default_supporter(), "{none}");
        }
        assert_eq!(sanitize_supporter(&json!({ "tiers": (0..9).map(|i| json!({ "name": format!("T{i}"), "inr": 1, "perks": ["p"] })).collect::<Vec<_>>() }))["tiers"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn the_donation_target_is_fixed_whatever_the_website_says() {
        let s = build_support(Some(&json!({ "version": 1, "donate": { "upiId": "evil@upi", "upiLink": "upi://pay?pa=evil@upi" }, "contact": "evil@example.com" })), "desktop");
        assert_eq!(s["donate"]["upiId"], "trazhub@upi");
        assert_eq!(s["donate"]["upiLink"], UPI_LINK);
        assert_eq!(s["donate"]["sponsorsUrl"], "https://github.com/sponsors/trazhub");
        assert_eq!(s["contact"], "traz@voxelport.in");
        let none = build_support(None, "desktop");
        assert_eq!(none["supporter"], default_supporter());
        assert_eq!(none["hosts"]["items"], json!([]));
        assert_eq!(build_support(Some(&json!("x")), "desktop")["hosts"]["items"], json!([]));
    }
}

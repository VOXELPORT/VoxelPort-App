//! VoxelPort relay regions. Each region is its own relay: a public port (and a custom address) belongs to the region it was handed out
//! by. Ported from `regions.js`.
//!
//! `relay_urls` are tried in order (see the tunnel): India is reached directly first, then through Cloudflare if the direct port is
//! blocked. The Europe relay serves wss straight on :443 with its own certificate, so it has a single relay URL. Custom addresses
//! (supporters) exist on the India relay only; the app keeps an address on the region that owns it.

use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub struct Region {
    pub id: &'static str,
    pub label: &'static str,
    pub relay_urls: &'static [&'static str],
    pub status_urls: &'static [&'static str],
    pub public_host: &'static str,
}

pub const REGIONS: &[Region] = &[
    Region { id: "in", label: "India", relay_urls: &["wss://direct.voxelport.in:26499", "wss://relay.voxelport.in"], status_urls: &["https://direct.voxelport.in:26499/api/status", "https://relay.voxelport.in/api/status"], public_host: "play.voxelport.in" },
    Region { id: "eu", label: "Europe", relay_urls: &["wss://eu.voxelport.in"], status_urls: &["https://eu.voxelport.in/api/status"], public_host: "play-eu.voxelport.in" },
];
pub const DEFAULT_REGION: &str = "in";
/// The relay address "use VoxelPort's relay" stands for: the region is picked per tunnel. Any other address is a self-hosted relay.
pub const DEFAULT_RELAY_URL: &str = "wss://relay.voxelport.in";

pub fn region(id: &str) -> Option<&'static Region> {
    REGIONS.iter().find(|r| r.id == id)
}

pub fn is_region(id: &str) -> bool {
    region(id).is_some()
}

/// `auto` or the id of a shipped region; anything else is `auto`.
pub fn normalize_preference(p: &str) -> &str {
    if p == "auto" || is_region(p) { p } else { "auto" }
}

/// Round-trip time to one region in ms: the best of a few small requests to its status endpoint (the first pays for DNS and TLS,
/// later ones show the real latency). None if it cannot be reached. `get` makes one request and says whether it answered OK.
pub fn measure_region(region: &Region, tries: u32, get: &dyn Fn(&str) -> bool) -> Option<u64> {
    let mut best: Option<u64> = None;
    for url in region.status_urls {
        for _ in 0..tries {
            let t0 = Instant::now();
            if get(url) {
                let ms = t0.elapsed().as_millis() as u64;
                best = Some(best.map_or(ms, |b| b.min(ms)));
            } else {
                break; // unreachable this way: do not wait on more timeouts
            }
        }
        if best.is_some() {
            break; // the preferred route works; skip the fallback
        }
    }
    best
}

/// One real request to a status endpoint: true if it answered with a success status within `timeout`.
pub fn http_get_ok(url: &str, timeout: Duration) -> bool {
    ureq::AgentBuilder::new().timeout(timeout).build().get(url).set("Cache-Control", "no-store").call().is_ok_and(|r| {
        let ok = (200..300).contains(&r.status());
        let mut sink = Vec::new();
        let _ = std::io::Read::read_to_end(&mut r.into_reader(), &mut sink);
        ok
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pick {
    pub region: &'static Region,
    /// `chosen`, `address`, `only`, `fastest` or `fallback`.
    pub reason: &'static str,
    /// Measured milliseconds per region id (only those that answered).
    pub latency: Vec<(&'static str, u64)>,
}

/// Which region a tunnel should use. An explicit preference wins; on `auto` a custom address pins the tunnel to the region that owns it
/// (it only exists there); otherwise the region with the lowest measured latency, India if none can be measured.
/// `regions` defaults to the shipped set; tests pass their own. Regions are measured in parallel.
pub fn pick_region(preference: &str, name_region: &str, regions: &'static [Region], measure: &(dyn Fn(&Region) -> Option<u64> + Sync)) -> Pick {
    let find = |id: &str| regions.iter().find(|r| r.id == id);
    let pref = if preference == "auto" || find(preference).is_some() { preference } else { "auto" };
    if pref != "auto" {
        return Pick { region: find(pref).expect("checked"), reason: "chosen", latency: vec![] };
    }
    if let Some(r) = find(name_region) {
        return Pick { region: r, reason: "address", latency: vec![] };
    }
    // One region: no point measuring, just use it.
    if regions.len() == 1 {
        return Pick { region: &regions[0], reason: "only", latency: vec![] };
    }
    let times: Vec<Option<u64>> = std::thread::scope(|s| {
        let handles: Vec<_> = regions.iter().map(|r| s.spawn(move || measure(r))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or(None)).collect()
    });
    let mut best = find(DEFAULT_REGION).unwrap_or(&regions[0]);
    let mut best_ms: Option<u64> = None;
    let mut latency = Vec::new();
    for (r, t) in regions.iter().zip(&times) {
        if let Some(ms) = t {
            latency.push((r.id, *ms));
            if best_ms.map_or(true, |b| *ms < b) {
                best_ms = Some(*ms);
                best = r;
            }
        }
    }
    Pick { region: best, reason: if best_ms.is_some() { "fastest" } else { "fallback" }, latency }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    static TWO: &[Region] = &[
        Region { id: "in", label: "India", relay_urls: &["wss://relay.voxelport.in"], status_urls: &["https://relay.voxelport.in/api/status"], public_host: "play.voxelport.in" },
        Region { id: "na", label: "North America", relay_urls: &["wss://na.voxelport.in"], status_urls: &["https://na.voxelport.in/api/status"], public_host: "play-na.voxelport.in" },
    ];
    fn fixed(table: &'static [(&'static str, Option<u64>)]) -> impl Fn(&Region) -> Option<u64> + Sync {
        move |r| table.iter().find(|(id, _)| *id == r.id).and_then(|(_, ms)| *ms)
    }
    fn never(_: &Region) -> Option<u64> {
        panic!("measured")
    }

    #[test]
    fn every_shipped_region_has_urls_and_a_public_host() {
        assert!(REGIONS.iter().all(|r| r.relay_urls.iter().all(|u| u.starts_with("wss://")) && r.status_urls.iter().all(|u| u.starts_with("https://")) && r.public_host.ends_with(".voxelport.in")));
        assert!(is_region(DEFAULT_REGION));
        assert_eq!(REGIONS.iter().map(|r| r.id).collect::<Vec<_>>(), ["in", "eu"], "India and Europe ship; North America is not offered");
        let eu = region("eu").unwrap();
        assert_eq!((eu.label, eu.relay_urls, eu.status_urls, eu.public_host), ("Europe", &["wss://eu.voxelport.in"][..], &["https://eu.voxelport.in/api/status"][..], "play-eu.voxelport.in"));
    }

    #[test]
    fn preferences_are_auto_plus_the_shipped_regions() {
        for (given, want) in [("in", "in"), ("eu", "eu"), ("auto", "auto"), ("na", "auto"), ("mars", "auto"), ("", "auto")] {
            assert_eq!(normalize_preference(given), want, "{given}");
        }
    }

    #[test]
    fn a_single_region_is_used_without_measuring() {
        static ONE: &[Region] = &[Region { id: "in", label: "India", relay_urls: &[], status_urls: &[], public_host: "play.voxelport.in" }];
        let p = pick_region("auto", "", ONE, &never);
        assert_eq!((p.region.id, p.reason), ("in", "only"));
    }

    #[test]
    fn shipped_regions_a_player_near_india_stays_and_one_near_europe_gets_europe() {
        let p = pick_region("auto", "", REGIONS, &fixed(&[("in", Some(18)), ("eu", Some(160))]));
        assert_eq!(p.region.id, "in");
        let p = pick_region("auto", "", REGIONS, &fixed(&[("in", Some(150)), ("eu", Some(22))]));
        assert_eq!((p.region.id, p.reason), ("eu", "fastest"));
    }

    #[test]
    fn a_custom_address_keeps_the_tunnel_on_its_region_even_when_another_is_faster() {
        let p = pick_region("auto", "in", REGIONS, &fixed(&[("in", Some(150)), ("eu", Some(22))]));
        assert_eq!((p.region.id, p.reason), ("in", "address"));
        let p = pick_region("auto", "in", TWO, &fixed(&[("in", Some(300)), ("na", Some(20))]));
        assert_eq!((p.region.id, p.reason), ("in", "address"));
    }

    #[test]
    fn europe_being_down_falls_back_to_india() {
        let p = pick_region("auto", "", REGIONS, &fixed(&[("in", Some(30)), ("eu", None)]));
        assert_eq!(p.region.id, "in");
    }

    #[test]
    fn an_explicit_region_wins_without_measuring() {
        let p = pick_region("eu", "in", REGIONS, &never);
        assert_eq!((p.region.id, p.reason), ("eu", "chosen"));
        let p = pick_region("na", "in", TWO, &never);
        assert_eq!((p.region.id, p.reason), ("na", "chosen"));
    }

    #[test]
    fn auto_picks_the_lowest_latency_and_skips_an_unreachable_region() {
        let p = pick_region("auto", "", TWO, &fixed(&[("in", Some(280)), ("na", Some(35))]));
        assert_eq!((p.region.id, p.reason, p.latency.clone()), ("na", "fastest", vec![("in", 280), ("na", 35)]));
        let p = pick_region("auto", "", TWO, &fixed(&[("in", None), ("na", Some(240))]));
        assert_eq!((p.region.id, p.latency.clone()), ("na", vec![("na", 240)]));
    }

    #[test]
    fn auto_falls_back_to_india_when_nothing_can_be_measured() {
        let p = pick_region("auto", "", TWO, &fixed(&[("in", None), ("na", None)]));
        assert_eq!((p.region.id, p.reason), ("in", "fallback"));
    }

    #[test]
    fn the_fallback_status_url_is_used_only_when_the_first_fails() {
        let calls = RefCell::new(Vec::<String>::new());
        let get = |u: &str| {
            calls.borrow_mut().push(u.to_string());
            !u.contains("direct")
        };
        let ms = measure_region(region("in").unwrap(), 2, &get);
        assert!(ms.is_some());
        let calls = calls.borrow();
        assert_eq!(calls.iter().filter(|u| u.contains("direct")).count(), 1);
        assert_eq!(calls.iter().filter(|u| u.contains("relay.voxelport.in")).count(), 2);
    }

    #[test]
    fn an_unreachable_region_measures_as_none() {
        assert_eq!(measure_region(region("in").unwrap(), 3, &|_| false), None);
    }
}

//! Per-profile auto-sleep settings: same shape and conventions as backups.rs's own settings.

use serde_json::json;
use voxelport_core::sleep::*;

#[test]
fn defaults_are_off_and_twenty_minutes() {
    let s = sleep_settings(&json!({}));
    assert_eq!(s, SleepSettings { auto: false, idle_min: 20 });
}

#[test]
fn stored_settings_are_used_and_out_of_range_falls_back() {
    let s = sleep_settings(&json!({ "sleep": { "auto": true, "idleMin": 30 } }));
    assert_eq!(s, SleepSettings { auto: true, idle_min: 30 });
    let s = sleep_settings(&json!({ "sleep": { "auto": "yes", "idleMin": 1 } }));
    assert_eq!(s, SleepSettings { auto: false, idle_min: 20 });
}

#[test]
fn to_json_round_trips_through_sleep_settings() {
    let s = SleepSettings { auto: true, idle_min: 10 };
    let back = sleep_settings(&json!({ "sleep": s.to_json() }));
    assert_eq!(back, s);
}

#[test]
fn validate_rejects_non_bool_auto_and_out_of_range_idle() {
    assert!(validate_sleep_settings(&json!({ "auto": "nope" })).is_err());
    assert!(validate_sleep_settings(&json!({ "idleMin": 1 })).is_err());
    assert!(validate_sleep_settings(&json!({ "idleMin": 999 })).is_err());
}

#[test]
fn validate_only_returns_fields_that_were_present() {
    let out = validate_sleep_settings(&json!({ "auto": true })).unwrap();
    assert!(out.contains_key("auto") && !out.contains_key("idleMin"));
}

// ─── SleepSchedule ───────────────────────────────────────────────────────────

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[test]
fn does_nothing_while_turned_off() {
    let stopped = Arc::new(AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: false, idle_min: 10 }, move || { s2.fetch_add(1, Ordering::SeqCst); });
    sched.tick(&[], true, 0);
    sched.tick(&[], true, 60 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 0);
}

#[test]
fn sleeps_once_idle_for_the_setting_counting_from_readiness() {
    let stopped = Arc::new(AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: true, idle_min: 10 }, move || { s2.fetch_add(1, Ordering::SeqCst); });
    sched.tick(&[], true, 1_000_000); // readiness noticed: idle clock starts here
    sched.tick(&[], true, 1_000_000 + 9 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 0);
    sched.tick(&[], true, 1_000_000 + 11 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 1);
}

#[test]
fn a_player_resets_the_idle_clock_and_leaving_starts_it_again() {
    let stopped = Arc::new(AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: true, idle_min: 10 }, move || { s2.fetch_add(1, Ordering::SeqCst); });
    sched.tick(&[], true, 0);
    sched.tick(&["Steve".to_string()], true, 8 * 60_000);
    sched.tick(&["Steve".to_string()], true, 17 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 0, "someone is still on");
    sched.tick(&[], true, 18 * 60_000); // left: idle clock restarts from here
    sched.tick(&[], true, 27 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 0, "not idle long enough since the leave");
    sched.tick(&[], true, 29 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 1);
}

#[test]
fn only_sleeps_once_per_readiness_never_stopping_twice_in_a_row() {
    let stopped = Arc::new(AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: true, idle_min: 10 }, move || { s2.fetch_add(1, Ordering::SeqCst); });
    sched.tick(&[], true, 0);
    sched.tick(&[], true, 11 * 60_000);
    sched.tick(&[], true, 12 * 60_000);
    sched.tick(&[], true, 13 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 1);
}

#[test]
fn turning_it_on_after_a_long_idle_starts_the_count_then_not_in_the_past() {
    let stopped = Arc::new(AtomicUsize::new(0));
    let s2 = stopped.clone();
    let on = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let o2 = on.clone();
    let mut sched = SleepSchedule::new(move || SleepSettings { auto: o2.load(Ordering::SeqCst), idle_min: 10 }, move || { s2.fetch_add(1, Ordering::SeqCst); });
    sched.tick(&[], true, 0);
    sched.tick(&[], true, 60 * 60_000);
    on.store(true, Ordering::SeqCst);
    sched.tick(&[], true, 61 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 0, "must not stop the moment the box is ticked");
    sched.tick(&[], true, 70 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 1);
}

#[test]
fn does_nothing_before_the_server_is_ready() {
    let stopped = Arc::new(AtomicUsize::new(0));
    let s2 = stopped.clone();
    let mut sched = SleepSchedule::new(|| SleepSettings { auto: true, idle_min: 10 }, move || { s2.fetch_add(1, Ordering::SeqCst); });
    sched.tick(&[], false, 0);
    sched.tick(&[], false, 60 * 60_000);
    assert_eq!(stopped.load(Ordering::SeqCst), 0);
}

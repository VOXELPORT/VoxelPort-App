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

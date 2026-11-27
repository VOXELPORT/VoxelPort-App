//! Per-profile auto-sleep settings: a server can be set to stop itself once nobody has played for a while, to
//! save power. The idle timer itself (SleepSchedule) runs out of main.rs, next to the server process it watches;
//! this is just the settings get/set, mirroring backupservice.rs's own shape.

use serde_json::Value;
use voxelport_core::{profiles, sleep};

use crate::AppState;

const NOT_FOUND: &str = "Server profile not found.";

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

pub fn describe(state: &AppState, args: &Value) -> Result<Value, String> {
    let id = str_arg(args, "id").unwrap_or_default();
    let profile = profiles::get(&state.data_dir, id).ok_or(NOT_FOUND)?;
    Ok(sleep::sleep_settings(&profile).to_json())
}

pub fn set_settings(state: &AppState, args: &Value) -> Result<Value, String> {
    let id = str_arg(args, "id").unwrap_or_default();
    let profile = profiles::get(&state.data_dir, id).ok_or(NOT_FOUND)?;
    let changes = sleep::validate_sleep_settings(&args["settings"])?;
    let mut merged = sleep::sleep_settings(&profile);
    if let Some(a) = changes.get("auto").and_then(Value::as_bool) {
        merged.auto = a;
    }
    if let Some(n) = changes.get("idleMin").and_then(Value::as_i64) {
        merged.idle_min = n;
    }
    let mut c = serde_json::Map::new();
    c.insert("sleep".into(), merged.to_json());
    profiles::update(&state.data_dir, id, &c)?;
    Ok(merged.to_json())
}

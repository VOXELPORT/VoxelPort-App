//! Per-profile auto-sleep settings and the idle timer that uses them. A server can be set to stop itself after
//! sitting empty for a while, to save power on a PC nobody is using. Settings follow backups.rs's own shape.

use serde_json::{json, Value};

pub const DEFAULTS: (bool, i64) = (false, 20); // auto, idleMin
pub const IDLE_RANGE: (i64, i64) = (5, 360);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SleepSettings {
    pub auto: bool,
    pub idle_min: i64,
}

impl SleepSettings {
    pub fn to_json(self) -> Value {
        json!({ "auto": self.auto, "idleMin": self.idle_min })
    }
}

/// A profile's sleep settings, with defaults filled in and values kept in range.
pub fn sleep_settings(profile: &Value) -> SleepSettings {
    let s = &profile["sleep"];
    let clamp = |v: &Value, (lo, hi): (i64, i64), fallback: i64| v.as_i64().filter(|n| (lo..=hi).contains(n)).unwrap_or(fallback);
    SleepSettings { auto: s["auto"].as_bool().unwrap_or(DEFAULTS.0), idle_min: clamp(&s["idleMin"], IDLE_RANGE, DEFAULTS.1) }
}

fn js_integer(v: &Value) -> Option<i64> {
    let f = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (f.fract() == 0.0 && f.is_finite()).then_some(f as i64)
}

/// Checks settings coming from the screen. Only what is present is returned.
pub fn validate_sleep_settings(input: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let Some(map) = input.as_object() else { return Err("Invalid sleep settings.".into()) };
    let mut out = serde_json::Map::new();
    if let Some(a) = map.get("auto").filter(|v| !v.is_null()) {
        out.insert("auto".into(), json!(a.as_bool().ok_or("Auto-sleep must be on or off.")?));
    }
    let (lo, hi) = IDLE_RANGE;
    if let Some(v) = map.get("idleMin").filter(|v| !v.is_null()) {
        let n = js_integer(v).filter(|n| (lo..=hi).contains(n)).ok_or_else(|| format!("Minutes idle before sleeping must be between {lo} and {hi}."))?;
        out.insert("idleMin".into(), json!(n));
    }
    Ok(out)
}

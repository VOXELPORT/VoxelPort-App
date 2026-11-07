//! Whether this install may host publicly: the Discord join gate. Pure rules, ported from `discordGate.js`.
//!
//! Grace is judged on the server's clock plus the time elapsed since it was read, and elapsed time never goes
//! negative, so setting the PC clock back cannot extend it. Only installs that existed before the requirement
//! shipped get grace.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::fsutil::atomic_write;

const DAY_MS: i64 = 86_400_000;
const OFFLINE_HOLD_MS: i64 = 7 * DAY_MS;

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub grace_until: Option<i64>,
    pub server_now: i64,
    /// PC time when the config was read.
    pub at: i64,
    pub invite_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MemberStatus {
    pub member: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StatusError {
    Unreachable,
    Unauthorized,
}

impl StatusError {
    pub fn as_str(self) -> &'static str {
        match self {
            StatusError::Unreachable => "unreachable",
            StatusError::Unauthorized => "unauthorized",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LastGood {
    pub member: bool,
    pub at: i64,
}

pub struct GateInput<'a> {
    pub existing_install: bool,
    pub session: bool,
    pub config: Option<&'a Config>,
    pub status: Option<&'a MemberStatus>,
    pub status_error: Option<StatusError>,
    pub last_good: Option<&'a LastGood>,
    pub now: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Banner {
    None,
    Grace,
    Blocked,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Gate {
    pub allowed: bool,
    pub must_sign_in: bool,
    pub banner: Banner,
    pub reason: String,
    pub grace_days_left: Option<i64>,
}

impl Gate {
    /// The fields the screens read (same names as the Electron app's `discord:state`).
    pub fn to_json(&self) -> Value {
        json!({
            "allowed": self.allowed,
            "mustSignIn": self.must_sign_in,
            "banner": match self.banner { Banner::None => "none", Banner::Grace => "grace", Banner::Blocked => "blocked" },
            "reason": self.reason,
            "graceDaysLeft": self.grace_days_left,
        })
    }
}

struct Verdict {
    allowed: bool,
    must_sign_in: bool,
    reason: String,
}

fn verdict(i: &GateInput) -> Verdict {
    let v = |allowed, must_sign_in, reason: &str| Verdict { allowed, must_sign_in, reason: reason.to_string() };
    if !i.session {
        return v(false, true, "signed_out");
    }
    if i.status_error == Some(StatusError::Unauthorized) {
        return v(false, true, "session_rejected");
    }
    if i.status_error == Some(StatusError::Unreachable) || i.status.is_none() {
        // The service cannot be asked: trust the last good answer for a week, then stop getting in people's way.
        return match i.last_good {
            Some(g) if i.now - g.at <= OFFLINE_HOLD_MS => {
                if g.member { v(true, false, "ok") } else { v(false, false, "not_in_server") }
            }
            _ => v(true, false, "offline_ok"),
        };
    }
    let status = i.status.expect("checked above");
    if status.member {
        return v(true, false, "ok");
    }
    let reason = status.reason.clone().unwrap_or_else(|| "not_in_server".to_string());
    Verdict { allowed: false, must_sign_in: reason == "recheck", reason }
}

pub fn evaluate_gate(i: &GateInput) -> Gate {
    let grace_until = i.config.and_then(|c| c.grace_until);
    let server_now = i.config.map(|c| c.server_now + (i.now - c.at).max(0));
    let grace_over = matches!((grace_until, server_now), (Some(g), Some(n)) if n >= g);
    let grace_active = i.existing_install && !grace_over;
    let grace_days_left = if grace_active {
        match (grace_until, server_now) {
            // Ceiling division of a non-negative span, like Math.ceil in the original.
            (Some(g), Some(n)) => Some(((g - n).max(0) + DAY_MS - 1) / DAY_MS),
            _ => None,
        }
    } else {
        None
    };

    let vd = verdict(i);
    if grace_active {
        return Gate { allowed: true, must_sign_in: false, banner: if vd.allowed { Banner::None } else { Banner::Grace }, reason: vd.reason, grace_days_left };
    }
    Gate { allowed: vd.allowed, must_sign_in: vd.must_sign_in, banner: if vd.allowed { Banner::None } else { Banner::Blocked }, reason: vd.reason, grace_days_left: None }
}

/// What `recordInstall` remembers: when this version first ran and whether the install is older than the requirement.
#[derive(Clone, Debug, PartialEq)]
pub struct InstallRecord {
    pub installed_at: i64,
    pub existing_install: bool,
}

/// Remembers, once, whether this install existed before the Discord requirement shipped. It must run before the
/// device token is created: an install that already has a device token file is an existing one.
pub fn record_install(user_data_dir: &Path, now: i64) -> InstallRecord {
    let file = user_data_dir.join("discord-gate.json");
    if let Ok(text) = fs::read_to_string(&file) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(existing) = v.get("existingInstall").and_then(Value::as_bool) {
                return InstallRecord { installed_at: v.get("installedAt").and_then(Value::as_i64).unwrap_or(0), existing_install: existing };
            }
        }
    }
    let record = InstallRecord { installed_at: now, existing_install: user_data_dir.join("device-token.json").exists() };
    let _ = fs::create_dir_all(user_data_dir);
    let _ = atomic_write(&file, json!({ "installedAt": record.installed_at, "existingInstall": record.existing_install }).to_string().as_bytes());
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_793_491_200_000; // 2026-11-01 UTC
    fn cfg(grace_days: Option<i64>, server_now: i64, at: i64) -> Config {
        Config { grace_until: grace_days.map(|d| T0 + d * DAY_MS), server_now, at, invite_url: None }
    }
    struct Case {
        existing: bool,
        session: bool,
        config: Option<Config>,
        status: Option<MemberStatus>,
        err: Option<StatusError>,
        last: Option<LastGood>,
        now: i64,
    }
    fn base() -> Case {
        Case { existing: false, session: true, config: Some(cfg(Some(10), T0, T0)), status: Some(MemberStatus { member: true, reason: None }), err: None, last: None, now: T0 }
    }
    fn gate(c: &Case) -> (bool, bool, Banner, String) {
        let g = evaluate_gate(&GateInput { existing_install: c.existing, session: c.session, config: c.config.as_ref(), status: c.status.as_ref(), status_error: c.err, last_good: c.last.as_ref(), now: c.now });
        (g.allowed, g.must_sign_in, g.banner, g.reason)
    }
    fn full(c: &Case) -> Gate {
        evaluate_gate(&GateInput { existing_install: c.existing, session: c.session, config: c.config.as_ref(), status: c.status.as_ref(), status_error: c.err, last_good: c.last.as_ref(), now: c.now })
    }
    fn not_member(reason: &str) -> Option<MemberStatus> {
        Some(MemberStatus { member: false, reason: Some(reason.into()) })
    }
    fn r(s: &str) -> String { s.into() }

    #[test]
    fn new_install_member_is_allowed_with_no_banner() {
        assert_eq!(gate(&base()), (true, false, Banner::None, r("ok")));
    }

    #[test]
    fn new_install_signed_out_must_sign_in_even_in_grace_window() {
        let c = Case { session: false, status: None, ..base() };
        assert_eq!(gate(&c), (false, true, Banner::Blocked, r("signed_out")));
    }

    #[test]
    fn not_in_server_is_blocked_and_screening_is_separate() {
        assert_eq!(gate(&Case { status: not_member("not_in_server"), ..base() }), (false, false, Banner::Blocked, r("not_in_server")));
        assert_eq!(gate(&Case { status: not_member("screening"), ..base() }), (false, false, Banner::Blocked, r("screening")));
    }

    #[test]
    fn recheck_asks_for_a_new_sign_in() {
        assert_eq!(gate(&Case { status: not_member("recheck"), ..base() }), (false, true, Banner::Blocked, r("recheck")));
    }

    #[test]
    fn existing_install_keeps_working_in_grace_with_days_left() {
        let c = Case { existing: true, session: false, status: None, now: T0 + 2 * DAY_MS, ..base() };
        assert_eq!(gate(&c), (true, false, Banner::Grace, r("signed_out")));
        assert_eq!(full(&c).grace_days_left, Some(8));
        assert_eq!(gate(&Case { existing: true, status: not_member("not_in_server"), ..base() }), (true, false, Banner::Grace, r("not_in_server")));
        assert_eq!(full(&Case { existing: true, ..base() }).banner, Banner::None);
    }

    #[test]
    fn blocked_once_grace_has_ended_judged_by_server_time() {
        let late = Case { existing: true, session: false, status: None, now: T0 + 10 * DAY_MS, ..base() };
        assert_eq!(gate(&late), (false, true, Banner::Blocked, r("signed_out")));
        let just_before = Case { existing: true, session: false, status: None, now: T0 + 10 * DAY_MS - 1, ..base() };
        assert_eq!(gate(&just_before), (true, false, Banner::Grace, r("signed_out")));
    }

    #[test]
    fn setting_the_pc_clock_back_cannot_extend_grace() {
        let config = Some(cfg(Some(10), T0 + 9 * DAY_MS, T0 + 9 * DAY_MS));
        let back = Case { existing: true, session: false, status: None, config: config.clone(), now: T0 + 9 * DAY_MS - 30 * DAY_MS, ..base() };
        assert_eq!(full(&back).grace_days_left, Some(1));
        let after = Case { existing: true, session: false, status: None, config, now: T0 + 10 * DAY_MS + 1, ..base() };
        assert_eq!(gate(&after), (false, true, Banner::Blocked, r("signed_out")));
    }

    #[test]
    fn no_grace_date_or_no_config_never_blocks_an_existing_install() {
        let c = Case { existing: true, session: false, status: None, config: Some(cfg(None, T0, T0)), now: T0 + 400 * DAY_MS, ..base() };
        assert!(gate(&c).0);
        let c = Case { existing: true, session: false, status: None, config: None, ..base() };
        assert!(gate(&c).0);
    }

    #[test]
    fn unreachable_service_holds_last_good_for_seven_days_then_allows() {
        let down = |last: Option<LastGood>, now: i64| Case { err: Some(StatusError::Unreachable), status: None, last, now, ..base() };
        let lg = |member| Some(LastGood { member, at: T0 });
        assert_eq!(gate(&down(lg(true), T0 + 3 * DAY_MS)), (true, false, Banner::None, r("ok")));
        assert_eq!(gate(&down(lg(false), T0 + 3 * DAY_MS)), (false, false, Banner::Blocked, r("not_in_server")));
        assert_eq!(gate(&down(lg(false), T0 + 8 * DAY_MS)), (true, false, Banner::None, r("offline_ok")));
        assert_eq!(gate(&down(None, T0)), (true, false, Banner::None, r("offline_ok")));
    }

    #[test]
    fn rejected_session_never_fails_open_after_grace_and_only_warns_during_it() {
        let rejected = Case { err: Some(StatusError::Unauthorized), status: None, ..base() };
        assert_eq!(gate(&rejected), (false, true, Banner::Blocked, r("session_rejected")));
        let rejected = Case { existing: true, err: Some(StatusError::Unauthorized), status: None, ..base() };
        assert_eq!(gate(&rejected), (true, false, Banner::Grace, r("session_rejected")));
    }

    #[test]
    fn signed_out_install_is_never_rescued_by_unreachable_fail_open() {
        let c = Case { session: false, status: None, err: Some(StatusError::Unreachable), last: None, ..base() };
        assert_eq!(gate(&c), (false, true, Banner::Blocked, r("signed_out")));
    }

    #[test]
    fn install_record_marks_existing_install_once() {
        let fresh = tempfile::tempdir().unwrap();
        let old = tempfile::tempdir().unwrap();
        fs::write(old.path().join("device-token.json"), "{}").unwrap();
        assert_eq!(record_install(fresh.path(), 111), InstallRecord { installed_at: 111, existing_install: false });
        assert_eq!(record_install(old.path(), 222), InstallRecord { installed_at: 222, existing_install: true });
        // The first answer is kept, even after the device token now exists on the fresh install.
        fs::write(fresh.path().join("device-token.json"), "{}").unwrap();
        assert_eq!(record_install(fresh.path(), 999), InstallRecord { installed_at: 111, existing_install: false });
        assert_eq!(record_install(old.path(), 999), InstallRecord { installed_at: 222, existing_install: true });
    }
}

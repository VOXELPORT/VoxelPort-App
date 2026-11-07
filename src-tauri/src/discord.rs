//! The shell's side of the Discord gate: builds the `discord:state` the screens read, runs the periodic re-check, and
//! handles the sign-in, sign-out, invite and address-backup channels. The rules themselves live in `voxelport-core`
//! (`gate`, `account`, `identity`) and are tested there.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use voxelport_core::account::{AccountOptions, OpenExternal, DEFAULT_SIGN_IN_TIMEOUT};
use voxelport_core::gate::{evaluate_gate, Gate, GateInput};
use voxelport_core::identity::{mask_token, replace_token, short_id};

use crate::{secrets, AppState};

/// How often the app asks the accounts service again while it is open (Electron: every 15 minutes).
pub const RECHECK: Duration = Duration::from_secs(15 * 60);
/// Coming back to the window re-checks, at most this often.
const FOCUS_RECHECK_MIN: Duration = Duration::from_secs(60);

const GENERIC_FAILURE: &str = "That didn't work. Check your connection and try again.";

/// The accounts service. A development build may point somewhere else for testing; a release build cannot.
pub fn accounts_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(u) = std::env::var("VOXELPORT_ACCOUNTS_URL") {
        return u;
    }
    "https://accounts.voxelport.in".to_string()
}

/// How the sign-in page is opened. A development build can set `VOXELPORT_NO_BROWSER=1` to have the app itself follow
/// the sign-in URL (the test accounts service answers with the redirect a browser would follow), so the whole loop
/// runs without opening a window. Compiled out of release builds.
pub fn opener() -> OpenExternal {
    #[cfg(debug_assertions)]
    if std::env::var("VOXELPORT_NO_BROWSER").as_deref() == Ok("1") {
        return Arc::new(|url: &str| {
            let url = url.to_string();
            std::thread::spawn(move || {
                let _ = ureq::get(&url).call();
            });
            true
        });
    }
    Arc::new(|url: &str| secrets::open_url(url))
}

pub fn account_options(state_dir: &std::path::Path, device_token: String, secrets: Arc<dyn voxelport_core::identity::SecretBox>) -> AccountOptions {
    AccountOptions {
        base_url: accounts_url(),
        user_data_dir: state_dir.to_path_buf(),
        secrets,
        open_external: opener(),
        device_token,
        now: voxelport_core::account::system_clock(),
        sign_in_timeout: DEFAULT_SIGN_IN_TIMEOUT,
    }
}

fn now_ms() -> i64 {
    (voxelport_core::account::system_clock())()
}

/// Whether this install may host publicly right now.
pub fn current_gate(state: &AppState) -> Gate {
    let snap = state.account.snapshot();
    evaluate_gate(&GateInput {
        existing_install: state.install.existing_install,
        session: snap.session,
        config: snap.config.as_ref(),
        status: snap.status.as_ref(),
        status_error: snap.status_error,
        last_good: snap.last_good.as_ref(),
        now: now_ms(),
    })
}

/// English or Hinglish, following the language the screens last announced.
pub fn say(state: &AppState, en: &str, hinglish: &str) -> String {
    if state.lang.lock().unwrap().as_str() == "hinglish" { hinglish.to_string() } else { en.to_string() }
}

pub fn gate_refusal(state: &AppState) -> Value {
    json!({ "ok": false, "error": say(state,
        "Join the VoxelPort Discord first: press Continue with Discord at the top of the app.",
        "Pehle VoxelPort Discord join karo: app ke upar Continue with Discord dabao.") })
}

/// Everything the Discord banner and settings read (same fields as the Electron app's `discord:state`).
pub fn discord_state(state: &AppState) -> Value {
    let snap = state.account.snapshot();
    let mut v = current_gate(state).to_json();
    let this_id = short_id(&state.device.lock().unwrap().token);
    let o = v.as_object_mut().expect("gate json is an object");
    o.insert("newInstall".into(), json!(!state.install.existing_install));
    o.insert("reachable".into(), json!(snap.config.is_some()));
    o.insert("rank".into(), json!(snap.standing.as_ref().map(|s| s.rank.clone())));
    o.insert("planName".into(), json!(snap.standing.as_ref().map(|s| s.plan_name.clone())));
    o.insert("inviteUrl".into(), json!(snap.config.as_ref().and_then(|c| c.invite_url.clone())));
    o.insert("discordName".into(), json!(snap.discord_name));
    o.insert("linkError".into(), json!(state.link_error.lock().unwrap().clone()));
    // Only the last 4 characters of the backup's id are for showing, and whether it is this PC's own.
    o.insert("backup".into(), match snap.identity_backup {
        Some(b) => json!({ "id": b.vp_id.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>(), "updatedAt": b.updated_at, "thisPc": b.vp_id == this_id }),
        None => Value::Null,
    });
    v
}

pub fn emit_state(state: &AppState) {
    let _ = state.app.emit("discord:state", discord_state(state));
}

pub async fn refresh(state: &AppState) {
    state.account.refresh_config().await;
    state.account.refresh_status().await;
    emit_state(state);
}

/// Coming back to the window re-checks (at most once a minute), so a new plan, a changed rank or a removed account shows at once.
pub fn refresh_soon(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut last = state.last_refresh.lock().unwrap();
        if last.map(|t| t.elapsed() < FOCUS_RECHECK_MIN).unwrap_or(false) {
            return;
        }
        *last = Some(Instant::now());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { refresh(&app.state::<AppState>()).await });
}

pub fn app_info(state: &AppState) -> Value {
    let d = state.device.lock().unwrap();
    json!({
        "publicHost": "play.voxelport.in",
        "defaultRelayUrl": "wss://relay.voxelport.in",
        "maskedToken": mask_token(&d.token),
        "supporterID": short_id(&d.token),
        "tokenEncryptedAtRest": d.encrypted_at_rest,
        "tokenUnreadable": d.unreadable,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

pub async fn sign_in(state: &AppState) -> Value {
    let mut result = state.account.sign_in().await;
    *state.link_error.lock().unwrap() = if result["ok"] == true { result["linkError"].as_str().map(str::to_string) } else { None };
    emit_state(state);
    result["state"] = discord_state(state);
    result
}

pub async fn sign_out(state: &AppState) -> Value {
    state.account.sign_out().await;
    *state.link_error.lock().unwrap() = None;
    emit_state(state);
    discord_state(state)
}

/// Opens the Discord invite the accounts service reported, but only if it has the exact shape of a discord.gg invite.
pub fn open_invite(state: &AppState) -> Value {
    let url = state.account.snapshot().config.and_then(|c| c.invite_url);
    match url {
        Some(u) if is_invite(&u) => json!({ "ok": secrets::open_url(&u) }),
        _ => json!({ "ok": false }),
    }
}

fn is_invite(u: &str) -> bool {
    u.strip_prefix("https://discord.gg/").map(|c| (2..=32).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')).unwrap_or(false)
}

fn backup_failure(code: &str) -> Value {
    let msg = match code {
        "too_short" => "Use at least 12 characters.",
        "too_simple" => "Choose something less repetitive.",
        "wrong_passphrase" => "That passphrase doesn't open the backup.",
        "not_found" => "There is no backup on your account.",
        "signed_out" | "unauthorized" => "Please sign in with Discord again.",
        _ => GENERIC_FAILURE,
    };
    json!({ "ok": false, "error": msg })
}

/// One backup action at a time, then the screens get the new state.
pub async fn identity(state: &AppState, which: &str, passphrase: &str) -> Value {
    if state.backup_busy.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "error": GENERIC_FAILURE });
    }
    let result = identity_inner(state, which, passphrase).await;
    emit_state(state);
    state.backup_busy.store(false, Ordering::SeqCst);
    result
}

async fn identity_inner(state: &AppState, which: &str, passphrase: &str) -> Value {
    let fail = |r: &Value| backup_failure(r["error"].as_str().unwrap_or(""));
    match which {
        "save" => {
            let r = state.account.save_backup(passphrase).await;
            if r["ok"] == true { json!({ "ok": true, "message": "Backed up. Remember your passphrase: VoxelPort can't recover it." }) } else { fail(&r) }
        }
        "delete" => {
            let r = state.account.delete_backup().await;
            if r["ok"] == true { json!({ "ok": true, "message": "Backup deleted." }) } else { fail(&r) }
        }
        _ => {
            // (No public address can be live in this build yet; when the tunnel is ported, restoring must refuse while it is.)
            let r = state.account.restore_backup(passphrase).await;
            let Some(token) = r["token"].as_str().filter(|_| r["ok"] == true) else { return fail(&r) };
            if replace_token(&state.data_dir, token, state.secrets.as_ref()).is_err() {
                return backup_failure("failed");
            }
            {
                let mut d = state.device.lock().unwrap();
                d.token = token.to_string();
                d.unreadable = false;
                d.encrypted_at_rest = state.secrets.available();
            }
            state.account.set_device_token(token);
            let app = state.app.clone();
            tauri::async_runtime::spawn(async move { refresh(&app.state::<AppState>()).await });
            json!({ "ok": true, "message": "Restored. Make your server public to get your address back." })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_discord_invites_are_opened() {
        assert!(is_invite("https://discord.gg/JAUfmey2fP"));
        assert!(is_invite("https://discord.gg/a-b"));
        for bad in ["http://discord.gg/abc", "https://discord.gg/", "https://discord.gg/a", "https://discord.gg/abc/def", "https://discord.gg/abc?x=1", "https://evil.example/discord.gg/abc", "https://discord.gg.evil.example/abc", "javascript:alert(1)", &format!("https://discord.gg/{}", "a".repeat(33))] {
            assert!(!is_invite(bad), "{bad}");
        }
    }

    #[test]
    fn backup_errors_use_the_electron_wording() {
        assert_eq!(backup_failure("too_short")["error"], "Use at least 12 characters.");
        assert_eq!(backup_failure("unauthorized")["error"], "Please sign in with Discord again.");
        assert_eq!(backup_failure("weird")["error"], GENERIC_FAILURE);
    }
}

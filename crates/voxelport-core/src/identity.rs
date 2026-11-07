//! The device token (this install's identity) and the end-to-end encrypted address backup. Ported from `token.js`
//! and `identityBackup.js`. The backup format is shared with the Android app and the Electron app, byte for byte:
//!
//!   key  = PBKDF2-HMAC-SHA256(passphrase in Unicode NFC, UTF-8, salt 16 bytes, 600,000 rounds) -> 32 bytes
//!   blob = AES-256-GCM(key, iv 12 bytes, aad "voxelport-identity-v1|<12-character id>", the code in UTF-8)
//!          = ciphertext + 16-byte tag, sent as { v:1, kdf:"pbkdf2-sha256", i, salt, iv, ct } in base64url (no padding)

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::fsutil::atomic_write;

pub const ITERATIONS: u32 = 600_000;
const MIN_ITERATIONS: i64 = 200_000;
const MAX_ITERATIONS: i64 = 2_000_000;
const MIN_PASSPHRASE: usize = 12;
const AAD_PREFIX: &str = "voxelport-identity-v1|";

// ─── Device token ───────────────────────────────────────────────────────────

/// `vp_` then at least 10 characters of `[A-Za-z0-9_-]`.
pub fn is_valid_token(token: &str) -> bool {
    match token.strip_prefix("vp_") {
        Some(rest) => rest.len() >= 10 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        None => false,
    }
}

pub fn generate_device_token() -> String {
    let mut bytes = [0u8; 18];
    getrandom::getrandom(&mut bytes).expect("the operating system's random source");
    format!("vp_{}", B64.encode(bytes))
}

/// Never returns the real token: only the "last 4" hint the screens show.
pub fn mask_token(token: &str) -> String {
    if is_valid_token(token) {
        format!("••••••••{}", &token[token.len() - 4..])
    } else {
        "••••••••".to_string()
    }
}

/// OS-backed encryption for secrets at rest (DPAPI on Windows). The shell supplies one; the core only needs this.
pub trait SecretBox: Send + Sync {
    fn available(&self) -> bool;
    fn encrypt(&self, plain: &str) -> Option<Vec<u8>>;
    fn decrypt(&self, cipher: &[u8]) -> Option<String>;
}

/// A [`SecretBox`] for platforms with no secret store: nothing is encrypted, the value is stored as plain text, and
/// callers are told so through `available()`.
pub struct NoSecretBox;
impl SecretBox for NoSecretBox {
    fn available(&self) -> bool { false }
    fn encrypt(&self, _: &str) -> Option<Vec<u8>> { None }
    fn decrypt(&self, _: &[u8]) -> Option<String> { None }
}

#[derive(Debug, Clone)]
pub struct LoadedToken {
    pub token: String,
    pub encrypted_at_rest: bool,
    /// A token file exists but cannot be read right now; this run uses a temporary token and the file is untouched.
    pub unreadable: bool,
}

fn token_file(dir: &Path) -> PathBuf {
    dir.join("device-token.json")
}

fn persist(file: &Path, token: &str, secrets: &dyn SecretBox) -> std::io::Result<()> {
    let record = match secrets.available().then(|| secrets.encrypt(token)).flatten() {
        Some(enc) => json!({ "enc": base64::engine::general_purpose::STANDARD.encode(enc) }),
        None => json!({ "token": token }),
    };
    atomic_write(file, serde_json::to_string_pretty(&record).unwrap().as_bytes())
}

fn is_unreadable_copy(name: &str) -> bool {
    name.starts_with("device-token.unreadable-") && name.ends_with(".json") && name.len() > "device-token.unreadable-.json".len()
}

/// `device-token.unreadable-<time>.json` beside the original, unless a copy with the same contents is already there.
fn keep_unreadable_copy(dir: &Path, file: &Path, raw: Option<&[u8]>) {
    let bytes: Vec<u8> = match raw {
        Some(r) => r.to_vec(),
        None => match fs::read(file) {
            Ok(b) => b,
            Err(_) => return,
        },
    };
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if is_unreadable_copy(&e.file_name().to_string_lossy()) && fs::read(e.path()).map(|b| b == bytes).unwrap_or(false) {
                return;
            }
        }
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let copy = dir.join(format!("device-token.unreadable-{stamp}.json"));
    let _ = fs::write(copy, bytes);
}

/// Loads this install's token, or creates one on the very first run. Only a file that does not exist at all may be
/// replaced by a new token: one that is there but cannot be read right now (a locked store, a failed decrypt, a
/// damaged file) holds the person's identity, and with it their custom address, so it is left exactly as it is.
pub fn load_or_create_token(dir: &Path, secrets: &dyn SecretBox) -> LoadedToken {
    let file = token_file(dir);
    let can_encrypt = secrets.available();

    let (raw, existed) = match fs::read(&file) {
        Ok(b) => (Some(b), true),
        Err(e) => (None, e.kind() != std::io::ErrorKind::NotFound),
    };
    let record: Option<Value> = raw.as_deref().and_then(|b| serde_json::from_slice(b).ok()).filter(Value::is_object);

    if let Some(record) = record {
        let enc = record.get("enc").and_then(Value::as_str).filter(|s| !s.is_empty());
        let token: Option<String> = if let (Some(enc), true) = (enc, can_encrypt) {
            base64::engine::general_purpose::STANDARD.decode(enc).ok().and_then(|c| secrets.decrypt(&c))
        } else {
            record.get("token").and_then(Value::as_str).map(str::to_string)
        };
        if let Some(token) = token.filter(|t| is_valid_token(t)) {
            // Opportunistically move a plaintext token to encrypted storage; the value itself is preserved exactly.
            if enc.is_none() && can_encrypt {
                let _ = persist(&file, &token, secrets);
            }
            return LoadedToken { token, encrypted_at_rest: enc.is_some() || can_encrypt, unreadable: false };
        }
    }

    if existed {
        keep_unreadable_copy(dir, &file, raw.as_deref());
        return LoadedToken { token: generate_device_token(), encrypted_at_rest: false, unreadable: true };
    }

    let token = generate_device_token();
    let _ = fs::create_dir_all(dir);
    let _ = persist(&file, &token, secrets);
    LoadedToken { token, encrypted_at_rest: can_encrypt, unreadable: false }
}

/// Swaps the stored token for another (restoring an address from the person's Discord backup). The file that is
/// there now is copied aside first, so the address this PC had can still be recovered by hand.
pub fn replace_token(dir: &Path, token: &str, secrets: &dyn SecretBox) -> Result<(), String> {
    if !is_valid_token(token) {
        return Err("invalid token".into());
    }
    let file = token_file(dir);
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    if file.exists() {
        keep_unreadable_copy(dir, &file, None);
    }
    persist(&file, token, secrets).map_err(|e| e.to_string())
}

// ─── Address backup ─────────────────────────────────────────────────────────

/// The 12-character VoxelPort ID of a code: what the apps and the accounts service show and match on.
pub fn short_id(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

/// `Some("too_short")`, `Some("too_simple")` or `None`. Same rules as Android: 12+ characters and at least 5
/// different ones. Counted in UTF-16 units after NFC, exactly as JavaScript and Kotlin count them.
pub fn passphrase_problem(raw: &str) -> Option<&'static str> {
    let p = nfc(raw);
    let units: Vec<u16> = p.encode_utf16().collect();
    if units.len() < MIN_PASSPHRASE {
        return Some("too_short");
    }
    if units.iter().collect::<HashSet<_>>().len() < 5 {
        return Some("too_simple");
    }
    None
}

fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(nfc(passphrase).as_bytes(), salt, iterations, &mut key);
    key
}

/// The blob to send. `salt` and `iv` are fresh random bytes unless a test fixes them.
pub fn encrypt_token(token: &str, passphrase: &str, salt: Option<[u8; 16]>, iv: Option<[u8; 12]>, iterations: u32) -> Value {
    let salt = salt.unwrap_or_else(|| {
        let mut b = [0u8; 16];
        getrandom::getrandom(&mut b).expect("random source");
        b
    });
    let iv = iv.unwrap_or_else(|| {
        let mut b = [0u8; 12];
        getrandom::getrandom(&mut b).expect("random source");
        b
    });
    let cipher = Aes256Gcm::new_from_slice(&derive_key(passphrase, &salt, iterations)).expect("32-byte key");
    let aad = format!("{AAD_PREFIX}{}", short_id(token));
    let ct = cipher.encrypt(Nonce::from_slice(&iv), Payload { msg: token.as_bytes(), aad: aad.as_bytes() }).expect("AES-GCM encryption does not fail");
    json!({ "v": 1, "kdf": "pbkdf2-sha256", "i": iterations, "salt": B64.encode(salt), "iv": B64.encode(iv), "ct": B64.encode(ct) })
}

/// The code, or `None` if the passphrase is wrong, the blob was changed, it belongs to another address (`vp_id`),
/// or it has the wrong shape.
pub fn decrypt_token(blob: &Value, passphrase: &str, vp_id: &str) -> Option<String> {
    if blob.get("v")?.as_i64()? != 1 || blob.get("kdf")?.as_str()? != "pbkdf2-sha256" {
        return None;
    }
    let iterations = blob.get("i")?.as_i64()?;
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&iterations) {
        return None;
    }
    let salt = B64.decode(blob.get("salt")?.as_str()?).ok()?;
    let iv = B64.decode(blob.get("iv")?.as_str()?).ok()?;
    let ct = B64.decode(blob.get("ct")?.as_str()?).ok()?;
    if salt.len() != 16 || iv.len() != 12 || ct.len() < 16 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(&derive_key(passphrase, &salt, iterations as u32)).ok()?;
    let aad = format!("{AAD_PREFIX}{vp_id}");
    let plain = cipher.decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: aad.as_bytes() }).ok()?;
    let token = String::from_utf8(plain).ok()?;
    // Only a code that really is the one this backup was filed under is accepted.
    (is_valid_token(&token) && short_id(&token) == vp_id).then_some(token)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A reversible stand-in for the OS secret store that can be "locked".
    pub struct FakeSecrets(pub AtomicBool);
    impl FakeSecrets {
        pub fn new(available: bool) -> Self { Self(AtomicBool::new(available)) }
    }
    impl SecretBox for FakeSecrets {
        fn available(&self) -> bool { self.0.load(Ordering::SeqCst) }
        fn encrypt(&self, p: &str) -> Option<Vec<u8>> { Some(format!("ENC:{p}").into_bytes()) }
        fn decrypt(&self, c: &[u8]) -> Option<String> { String::from_utf8(c.to_vec()).ok()?.strip_prefix("ENC:").map(str::to_string) }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::FakeSecrets;
    use super::*;

    // Generated with Node crypto and shared with the Android app's tests: both sides must open and produce exactly this.
    const PASS: &str = "correct horse battery staple";
    const TOKEN: &str = "vp_testtoken_abcdefghijkl";
    const VP_ID: &str = "0c67f05015ae";

    fn blob() -> Value {
        json!({ "v": 1, "kdf": "pbkdf2-sha256", "i": 600000, "salt": "MDEyMzQ1Njc4OWFiY2RlZg", "iv": "YWJjZGVmZ2hpamts", "ct": "MsyHgM7Ii1e5kIcAq93ktU1lKVGATxIQ5uoB0Q9AYm_7XG9-hIDvmT8" })
    }

    #[test]
    fn id_is_first_12_hex_digits_of_sha256() {
        assert_eq!(short_id(TOKEN), VP_ID);
    }

    #[test]
    fn fixed_vector_from_electron_and_android_decrypts() {
        assert_eq!(decrypt_token(&blob(), PASS, VP_ID).as_deref(), Some(TOKEN));
    }

    #[test]
    fn same_salt_and_iv_give_the_identical_blob() {
        assert_eq!(encrypt_token(TOKEN, PASS, Some(*b"0123456789abcdef"), Some(*b"abcdefghijkl"), ITERATIONS), blob());
    }

    #[test]
    fn fresh_encryption_round_trips_and_never_repeats() {
        let a = encrypt_token(TOKEN, PASS, None, None, 200_000);
        let b = encrypt_token(TOKEN, PASS, None, None, 200_000);
        assert_ne!(a["ct"], b["ct"]);
        assert_eq!(decrypt_token(&a, PASS, VP_ID).as_deref(), Some(TOKEN));
    }

    #[test]
    fn unicode_forms_of_a_passphrase_are_the_same() {
        let composed = "caf\u{e9} au lait 123";
        let decomposed = "cafe\u{301} au lait 123";
        let b = encrypt_token(TOKEN, composed, None, None, 200_000);
        assert_eq!(decrypt_token(&b, decomposed, VP_ID).as_deref(), Some(TOKEN));
    }

    #[test]
    fn wrong_passphrase_and_wrong_address_do_not_open_it() {
        assert_eq!(decrypt_token(&blob(), "correct horse battery stapl3", VP_ID), None);
        assert_eq!(decrypt_token(&blob(), PASS, "000000000000"), None);
    }

    #[test]
    fn a_changed_blob_does_not_open() {
        let mut ct = B64.decode(blob()["ct"].as_str().unwrap()).unwrap();
        ct[3] ^= 1;
        let mut flipped = blob();
        flipped["ct"] = json!(B64.encode(&ct));
        assert_eq!(decrypt_token(&flipped, PASS, VP_ID), None);
        let mut cut = blob();
        let s = cut["ct"].as_str().unwrap().to_string();
        cut["ct"] = json!(&s[..s.len() - 4]);
        assert_eq!(decrypt_token(&cut, PASS, VP_ID), None);
        let mut salted = blob();
        salted["salt"] = json!(B64.encode(b"0123456789abcdeg"));
        assert_eq!(decrypt_token(&salted, PASS, VP_ID), None);
    }

    #[test]
    fn blobs_with_the_wrong_shape_are_refused_without_panicking() {
        let with = |k: &str, v: Value| { let mut b = blob(); b[k] = v; b };
        let bad = vec![
            Value::Null, json!("x"), json!({}),
            with("v", json!(2)), with("kdf", json!("scrypt")), with("i", json!(199_999)), with("i", json!(2_000_001)),
            with("i", json!(600000.5)), with("i", json!("600000")),
            with("salt", json!("AAAA")), with("iv", json!("AAAA")), with("ct", json!("AA")), with("ct", Value::Null),
        ];
        for b in bad {
            assert_eq!(decrypt_token(&b, PASS, VP_ID), None, "{b}");
        }
    }

    #[test]
    fn a_result_that_is_not_a_valid_code_is_refused() {
        let b = encrypt_token("not a token", PASS, None, None, 200_000);
        assert_eq!(decrypt_token(&b, PASS, &short_id("not a token")), None);
    }

    #[test]
    fn passphrase_rules() {
        assert_eq!(passphrase_problem("short one"), Some("too_short"));
        assert_eq!(passphrase_problem("12345678901"), Some("too_short"));
        assert_eq!(passphrase_problem("aaaaaaaaaaaa"), Some("too_simple"));
        assert_eq!(passphrase_problem("abababababab"), Some("too_simple"));
        assert_eq!(passphrase_problem("abcdabcdabcd"), Some("too_simple"));
        assert_eq!(passphrase_problem("abcdeabcdeab"), None);
        assert_eq!(passphrase_problem(PASS), None);
        assert_eq!(passphrase_problem("éééééé"), Some("too_short"));
        assert_eq!(passphrase_problem("e\u{301}e\u{301}e\u{301}e\u{301}e\u{301}e\u{301}"), Some("too_short"), "six characters after NFC");
    }

    // ─── Token store ────────────────────────────────────────────────────────

    fn copies(dir: &Path) -> Vec<String> {
        fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| is_unreadable_copy(n)).collect()
    }

    #[test]
    fn first_run_creates_a_valid_token_stored_encrypted_and_never_beside_the_raw_one() {
        let dir = tempfile::tempdir().unwrap();
        let l = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        assert!(is_valid_token(&l.token) && l.encrypted_at_rest && !l.unreadable);
        let on_disk: Value = serde_json::from_str(&fs::read_to_string(dir.path().join("device-token.json")).unwrap()).unwrap();
        assert!(on_disk["enc"].is_string());
        assert!(on_disk.get("token").is_none());
        assert!(!fs::read_to_string(dir.path().join("device-token.json")).unwrap().contains(&l.token));
    }

    #[test]
    fn the_same_token_comes_back_every_time() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        let b = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        assert_eq!(a.token, b.token);
    }

    #[test]
    fn without_a_secret_store_the_token_is_plain_but_usable() {
        let dir = tempfile::tempdir().unwrap();
        let l = load_or_create_token(dir.path(), &NoSecretBox);
        assert!(is_valid_token(&l.token) && !l.encrypted_at_rest);
        let on_disk: Value = serde_json::from_str(&fs::read_to_string(dir.path().join("device-token.json")).unwrap()).unwrap();
        assert_eq!(on_disk["token"], json!(l.token));
    }

    #[test]
    fn a_plaintext_token_is_encrypted_without_changing_its_value() {
        let dir = tempfile::tempdir().unwrap();
        let original = format!("vp_{}", "a".repeat(24));
        fs::write(dir.path().join("device-token.json"), json!({ "token": original }).to_string()).unwrap();
        assert_eq!(load_or_create_token(dir.path(), &FakeSecrets::new(true)).token, original);
        let on_disk: Value = serde_json::from_str(&fs::read_to_string(dir.path().join("device-token.json")).unwrap()).unwrap();
        assert!(on_disk["enc"].is_string());
        assert_eq!(load_or_create_token(dir.path(), &FakeSecrets::new(true)).token, original);
    }

    #[test]
    fn a_corrupted_encrypted_record_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let bad = json!({ "enc": "not-valid-base64-cipher" }).to_string();
        fs::write(dir.path().join("device-token.json"), &bad).unwrap();
        let l = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        assert!(l.unreadable && is_valid_token(&l.token));
        assert_eq!(fs::read_to_string(dir.path().join("device-token.json")).unwrap(), bad);
    }

    #[test]
    fn mask_never_reveals_the_token_and_handles_bad_input() {
        let token = format!("vp_{}", "b".repeat(24));
        let m = mask_token(&token);
        assert!(m.ends_with(&token[token.len() - 4..]) && !m.contains(&token[..20]));
        for bad in ["", "x", "vp_short"] {
            assert_eq!(mask_token(bad), "••••••••");
        }
    }

    #[test]
    fn token_survives_a_secret_store_outage_and_comes_back_when_unlocked() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        let file = dir.path().join("device-token.json");
        let before = fs::read_to_string(&file).unwrap();

        let during = load_or_create_token(dir.path(), &FakeSecrets::new(false));
        assert!(during.unreadable && is_valid_token(&during.token));
        assert_ne!(during.token, first.token, "a temporary token is used meanwhile");
        assert_eq!(fs::read_to_string(&file).unwrap(), before, "the saved file is untouched");
        assert_eq!(copies(dir.path()).len(), 1, "and a copy is kept for recovery");

        let after = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        assert_eq!(after.token, first.token);
        assert!(!after.unreadable);
    }

    #[test]
    fn repeated_failed_launches_do_not_pile_up_copies() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("device-token.json");
        let bad = json!({ "enc": base64::engine::general_purpose::STANDARD.encode("wrong key") }).to_string();
        fs::write(&file, &bad).unwrap();
        for _ in 0..3 {
            let r = load_or_create_token(dir.path(), &FakeSecrets::new(true));
            assert!(r.unreadable && is_valid_token(&r.token));
        }
        assert_eq!(fs::read_to_string(&file).unwrap(), bad);
        let c = copies(dir.path());
        assert_eq!(c.len(), 1);
        assert_eq!(fs::read_to_string(dir.path().join(&c[0])).unwrap(), bad);
    }

    #[test]
    fn a_damaged_file_is_left_alone_and_the_temporary_token_is_never_saved() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("device-token.json");
        fs::write(&file, "{\"enc\": \"trunc").unwrap();
        let r = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        assert!(r.unreadable);
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"enc\": \"trunc");
        assert!(!fs::read_dir(dir.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(".tmp-")));
    }

    #[test]
    fn only_when_there_was_no_file_at_all_is_a_new_token_written() {
        let dir = tempfile::tempdir().unwrap();
        let r = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        assert!(!r.unreadable);
        assert!(copies(dir.path()).is_empty());
    }

    #[test]
    fn replace_keeps_the_old_file_aside_and_refuses_a_bad_token() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_token(dir.path(), &FakeSecrets::new(true));
        assert!(replace_token(dir.path(), "nope", &FakeSecrets::new(true)).is_err());
        let new = generate_device_token();
        replace_token(dir.path(), &new, &FakeSecrets::new(true)).unwrap();
        assert_eq!(load_or_create_token(dir.path(), &FakeSecrets::new(true)).token, new);
        assert_eq!(copies(dir.path()).len(), 1);
        assert_ne!(first.token, new);
    }
}

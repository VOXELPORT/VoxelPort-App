//! OS-backed secret storage and opening the default browser.
//!
//! Secrets (the device token and the Discord session) are encrypted with Windows DPAPI, bound to the signed-in
//! Windows user. NOTE: this is **not** the format Electron's `safeStorage` writes (that is Chromium's `os_crypt`: an
//! AES key kept in `Local State`, itself DPAPI-protected). This build keeps its own separate files; the one-way reader that brings the old
//! app's data across once, on the person's say-so, is `voxelport_core::legacy_import`, with [`ChromiumKeyUnprotect`] below as its DPAPI half.

use voxelport_core::identity::SecretBox;

#[cfg(windows)]
mod imp {
    use super::SecretBox;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    /// Extra bytes mixed into the key so another program running as the same user does not decrypt these by default.
    const ENTROPY: &[u8] = b"VoxelPort device secret v1";

    pub struct Dpapi;

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
    }

    /// For the test that makes a blob the way Chromium does.
    #[cfg(test)]
    pub fn take_for_test(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        take(out)
    }

    /// Copies the system-allocated output out and frees it.
    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success DPAPI returns `cbData` readable bytes at `pbData`, allocated with LocalAlloc.
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as _) };
        v
    }

    impl SecretBox for Dpapi {
        fn available(&self) -> bool {
            true
        }
        fn encrypt(&self, plain: &str) -> Option<Vec<u8>> {
            let (input, entropy) = (blob(plain.as_bytes()), blob(ENTROPY));
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
            // SAFETY: both blobs point at live byte slices for the call; `out` is filled by the API.
            let ok = unsafe { CryptProtectData(&input, null(), &entropy, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
            (ok != 0).then(|| take(out))
        }
        fn decrypt(&self, cipher: &[u8]) -> Option<String> {
            let (input, entropy) = (blob(cipher), blob(ENTROPY));
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
            // SAFETY: as above.
            let ok = unsafe { CryptUnprotectData(&input, null_mut(), &entropy, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
            (ok != 0).then(|| String::from_utf8(take(out)).ok()).flatten()
        }
    }

    /// Opens a DPAPI blob that Chromium (and so Electron's `safeStorage`) made for the signed-in Windows user: no extra entropy, which is how it
    /// protects its `os_crypt` key. It only ever opens: this build writes nothing in that format.
    pub struct ChromiumKeyUnprotect;

    impl voxelport_core::legacy_import::KeyUnprotect for ChromiumKeyUnprotect {
        fn unprotect(&self, bytes: &[u8]) -> Option<Vec<u8>> {
            let input = blob(bytes);
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
            // SAFETY: `input` points at a live byte slice for the call; no entropy or prompt is given (null, and the UI-forbidden flag); `out` is filled by the API.
            let ok = unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
            (ok != 0).then(|| take(out))
        }
    }

    /// Opens `url` in the default browser. The URL is passed to the shell as one argument, never through `cmd`.
    pub fn open_url(url: &str) -> bool {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (verb, target) = (wide("open"), wide(url));
        // SAFETY: both strings are NUL-terminated and live for the call.
        let result = unsafe { ShellExecuteW(null_mut(), verb.as_ptr(), target.as_ptr(), null(), null(), SW_SHOWNORMAL) };
        result as usize > 32
    }
}

#[cfg(windows)]
pub use imp::{open_url, ChromiumKeyUnprotect, Dpapi};

/// Nothing can be opened where there is no DPAPI, so an import finds the old token unreadable there.
#[cfg(not(windows))]
pub struct ChromiumKeyUnprotect;
#[cfg(not(windows))]
impl voxelport_core::legacy_import::KeyUnprotect for ChromiumKeyUnprotect {
    fn unprotect(&self, _: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(not(windows))]
pub fn open_url(_url: &str) -> bool {
    false
}

/// The secret store for this platform.
pub fn platform_secrets() -> std::sync::Arc<dyn SecretBox> {
    #[cfg(windows)]
    {
        std::sync::Arc::new(Dpapi)
    }
    #[cfg(not(windows))]
    {
        std::sync::Arc::new(voxelport_core::identity::NoSecretBox)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trips_and_does_not_store_plain_text() {
        let d = Dpapi;
        let enc = d.encrypt("vp_secret_value_12345").unwrap();
        assert!(!String::from_utf8_lossy(&enc).contains("secret_value"));
        assert_eq!(d.decrypt(&enc).as_deref(), Some("vp_secret_value_12345"));
        assert_eq!(d.decrypt(b"not a dpapi blob"), None);
    }

    /// Protects bytes the way Chromium does (no extra entropy), then opens them with the reader the import uses.
    #[test]
    fn the_chromium_key_reader_opens_what_chromium_style_protection_makes_and_refuses_the_rest() {
        use voxelport_core::legacy_import::KeyUnprotect;
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
        let key = [42u8; 32];
        let input = CRYPT_INTEGER_BLOB { cbData: key.len() as u32, pbData: key.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: `input` is a live slice for the call, `out` is filled by the API and freed by `take`.
        let ok = unsafe { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        assert_ne!(ok, 0);
        let protected = imp::take_for_test(out);
        assert_eq!(ChromiumKeyUnprotect.unprotect(&protected).as_deref(), Some(&key[..]));
        assert_eq!(ChromiumKeyUnprotect.unprotect(b"not a dpapi blob"), None);
        // This build's own secrets (made with its entropy) are not Chromium's: the reader does not open them.
        let ours = Dpapi.encrypt("vp_secret_value_12345").unwrap();
        assert_eq!(ChromiumKeyUnprotect.unprotect(&ours), None);
    }
}

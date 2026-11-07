//! OS-backed secret storage and opening the default browser.
//!
//! Secrets (the device token and the Discord session) are encrypted with Windows DPAPI, bound to the signed-in
//! Windows user. NOTE: this is **not** the format Electron's `safeStorage` writes (that is Chromium's `os_crypt`: an
//! AES key kept in `Local State`, itself DPAPI-protected). A Tauri build that replaces the Electron app on the same
//! data folder would need a one-way reader for that format; until then this build keeps its own separate files.

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
pub use imp::{open_url, Dpapi};

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
}

//! Small facts about this computer, read without extra dependencies.

/// Installed memory in MB, or None when this platform can't say.
pub fn total_memory_mb() -> Option<u64> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: `status` is a properly sized, zeroed MEMORYSTATUSEX with dwLength set, as the API requires.
        let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
        if ok != 0 { Some(status.ullTotalPhys / (1024 * 1024)) } else { None }
    }
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = text.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb / 1024)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        None
    }
}

/// How much RAM to suggest for a server (same steps as the Electron app's recommendedRamMb).
pub fn recommended_ram_mb(total_mb: u64) -> u64 {
    match total_mb {
        0..=4096 => 1024,
        4097..=8192 => 3072,
        8193..=16384 => 6144,
        _ => 8192,
    }
}

/// Puts text on the clipboard. A development build can write it to a file instead (`VOXELPORT_TEST_CLIPBOARD_FILE=<path>`) so the
/// copy buttons can be tested without touching what the person has copied.
pub fn set_clipboard(text: &str) -> bool {
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("VOXELPORT_TEST_CLIPBOARD_FILE") {
        return std::fs::write(path, text).is_ok();
    }
    set_clipboard_native(text)
}

#[cfg(windows)]
fn set_clipboard_native(text: &str) -> bool {
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    const CF_UNICODETEXT: u32 = 13;
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * 2;
    // SAFETY: the memory block is sized for the whole NUL-terminated string and filled before it is handed to the clipboard, which
    // then owns it (it is freed here only if the clipboard did not take it); the clipboard is closed on every path after it is opened.
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return false;
        }
        let mut ok = false;
        if EmptyClipboard() != 0 {
            let mem: HANDLE = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if !mem.is_null() {
                let dst = GlobalLock(mem) as *mut u16;
                if dst.is_null() {
                    GlobalFree(mem);
                } else {
                    std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
                    GlobalUnlock(mem);
                    if SetClipboardData(CF_UNICODETEXT, mem).is_null() {
                        GlobalFree(mem);
                    } else {
                        ok = true;
                    }
                }
            }
        }
        CloseClipboard();
        ok
    }
}

#[cfg(not(windows))]
fn set_clipboard_native(_text: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommendation_steps_match_the_electron_app() {
        assert_eq!(recommended_ram_mb(4096), 1024);
        assert_eq!(recommended_ram_mb(4097), 3072);
        assert_eq!(recommended_ram_mb(8192), 3072);
        assert_eq!(recommended_ram_mb(16384), 6144);
        assert_eq!(recommended_ram_mb(32768), 8192);
    }

    #[test]
    fn this_computer_reports_some_memory() {
        assert!(total_memory_mb().unwrap_or(0) > 256);
    }

    /// Writes to the real clipboard, so it is not run with the others: `cargo test -p voxelport-tauri clipboard -- --ignored`, then look
    /// at what is on the clipboard (it should read `vp clipboard test ✓ héllo`).
    #[test]
    #[ignore = "writes to the real clipboard"]
    fn the_clipboard_gets_the_text() {
        assert!(set_clipboard("vp clipboard test ✓ héllo"));
    }
}

/// Turns real time into the computer's local wall clock and back, with its time zone and daylight saving rules (backup names
/// carry local time, as in the Electron app).
pub struct WindowsLocalTime;

#[cfg(windows)]
mod local_time {
    use super::WindowsLocalTime;
    use voxelport_core::backups::{LocalTime, Parts};
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToFileTime, SystemTimeToTzSpecificLocalTime, TzSpecificLocalTimeToSystemTime};

    /// 100-nanosecond ticks from 1601-01-01 to 1970-01-01, in milliseconds.
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;

    fn to_filetime(ms: i64) -> FILETIME {
        let ticks = ((ms + EPOCH_DIFF_MS).max(0) as u64) * 10_000;
        FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 }
    }
    fn from_filetime(f: &FILETIME) -> i64 {
        (((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) / 10_000) as i64 - EPOCH_DIFF_MS
    }

    impl LocalTime for WindowsLocalTime {
        fn parts_of(&self, ms: i64) -> Parts {
            let (ft, mut utc, mut local) = (to_filetime(ms), unsafe { std::mem::zeroed::<SYSTEMTIME>() }, unsafe { std::mem::zeroed::<SYSTEMTIME>() });
            // SAFETY: all pointers are to live, correctly typed locals; a null time zone means the current one.
            let ok = unsafe { FileTimeToSystemTime(&ft, &mut utc) != 0 && SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) != 0 };
            let t = if ok { local } else { utc };
            Parts { y: i32::from(t.wYear), mo: u32::from(t.wMonth), d: u32::from(t.wDay), h: u32::from(t.wHour), mi: u32::from(t.wMinute), s: u32::from(t.wSecond) }
        }
        fn epoch_ms_of(&self, p: Parts) -> i64 {
            let mut local: SYSTEMTIME = unsafe { std::mem::zeroed() };
            (local.wYear, local.wMonth, local.wDay, local.wHour, local.wMinute, local.wSecond) = (p.y as u16, p.mo as u16, p.d as u16, p.h as u16, p.mi as u16, p.s as u16);
            let (mut utc, mut ft) = (unsafe { std::mem::zeroed::<SYSTEMTIME>() }, FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 });
            // SAFETY: as above.
            let ok = unsafe { TzSpecificLocalTimeToSystemTime(std::ptr::null(), &local, &mut utc) != 0 && SystemTimeToFileTime(&utc, &mut ft) != 0 };
            if ok { from_filetime(&ft) } else { voxelport_core::backups::Utc.epoch_ms_of(p) }
        }
    }
}

#[cfg(not(windows))]
impl voxelport_core::backups::LocalTime for WindowsLocalTime {
    fn parts_of(&self, ms: i64) -> voxelport_core::backups::Parts {
        voxelport_core::backups::Utc.parts_of(ms)
    }
    fn epoch_ms_of(&self, p: voxelport_core::backups::Parts) -> i64 {
        voxelport_core::backups::Utc.epoch_ms_of(p)
    }
}

#[cfg(all(test, windows))]
mod local_time_tests {
    use super::*;
    use voxelport_core::backups::{LocalTime, Parts};

    #[test]
    fn local_time_round_trips_through_the_windows_time_zone() {
        let c = WindowsLocalTime;
        for ms in [1_793_491_200_000_i64, 1_781_000_000_000, 1_700_000_000_000, 1_000_000_000_000] {
            let p: Parts = c.parts_of(ms);
            assert_eq!(c.epoch_ms_of(p), ms / 1000 * 1000, "{p:?}");
        }
        let p = c.parts_of(1_793_491_200_000);
        assert!((2026..=2026).contains(&p.y) && (1..=12).contains(&p.mo) && p.d >= 1 && p.h < 24);
    }
}

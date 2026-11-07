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

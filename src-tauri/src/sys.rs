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

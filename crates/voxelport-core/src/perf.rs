//! The performance panel: CPU and memory of the server process, and TPS from the vanilla `tick query` command. Ported from
//! `perfMonitor.js`.
//!
//! Electron kept one PowerShell process alive to read the numbers; here the operating system is asked directly (Windows: process
//! times and working set; Linux: `/proc`), so the monitor costs nothing beside the server. CPU is a share of the whole machine
//! (100% = every core busy). macOS is not built, so it reports nothing there.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use crate::server_process::strip_log_prefix;

pub const SAMPLE_EVERY: Duration = Duration::from_millis(2000);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub cpu_percent: f64,
    pub mem_mb: u64,
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round().max(0.0) / 10.0
}

/// What the panel shows. Everything is unknown (`null`) until the first sample or `tick query` answer arrives.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PerfState {
    pub cpu_percent: Option<f64>,
    pub mem_mb: Option<u64>,
    pub tps: Option<f64>,
    pub mspt: Option<f64>,
    pub lag_warnings: u32,
}

impl PerfState {
    /// The `perf:sample` payload; `max_ram_mb` is the server's RAM limit, for the bar.
    pub fn to_json(&self, max_ram_mb: Option<u64>) -> Value {
        json!({ "cpuPercent": self.cpu_percent, "memMb": self.mem_mb, "tps": self.tps, "mspt": self.mspt, "lagWarnings": self.lag_warnings, "maxRamMb": max_ram_mb })
    }
}

// ─── TPS via the vanilla `tick query` command (Minecraft 1.20.3+) ─────────

/// True for versions that have `/tick` (1.20.3 and newer, including the year-based 26.x).
pub fn supports_tick_query(version: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^([0-9]+)\.([0-9]+)(?:\.([0-9]+))?").unwrap());
    let Some(m) = re.captures(version) else { return false };
    let num = |i: usize| m.get(i).and_then(|g| g.as_str().parse::<u64>().ok()).unwrap_or(0);
    let (major, minor, patch) = (num(1), num(2), num(3));
    if major >= 2 {
        return true; // year-based versions (26.1+)
    }
    if minor != 20 {
        return minor > 20;
    }
    patch >= 3
}

/// The lines `tick query` prints, so they can be kept out of the visible console. Only the server's own message counts (what is
/// left after the `[time] [thread/LEVEL]:` front, matched from its start): a player typing the same words in chat, which shows
/// as `<name> text`, is not the server answering. (The Electron app matched anywhere in the line, so a chat message could pass.)
pub fn is_tick_query_line(line: &str) -> bool {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    let res = RES.get_or_init(|| {
        [
            r"(?i)^The game is (?:running|frozen|sprinting|stepping|not running)",
            r"(?i)^Target tick rate: [0-9.]+ per second",
            r"(?i)^Average time per tick: [0-9.]+ ?ms",
            r"(?i)^Percentiles: P50: ",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    });
    let message = strip_log_prefix(line);
    res.iter().any(|r| r.is_match(&message))
}

/// Milliseconds per tick from a `tick query` line (the server's own message, as for [`is_tick_query_line`]).
pub fn parse_mspt(line: &str) -> Option<f64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)^Average time per tick: ([0-9.]+) ?ms").unwrap());
    re.captures(&strip_log_prefix(line)).and_then(|m| m[1].parse().ok())
}

/// Ticks per second implied by milliseconds per tick (20 is perfect).
pub fn tps_from_mspt(mspt: f64) -> f64 {
    if !mspt.is_finite() || mspt <= 0.0 {
        return 20.0;
    }
    ((1000.0 / mspt) * 10.0).round().min(200.0) / 10.0
}

/// The server's "can't keep up" warning (its own message, not a player quoting it).
pub fn is_lag_line(line: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^Can't keep up! Is the server overloaded\?").unwrap()).is_match(&strip_log_prefix(line))
}

// ─── CPU and memory ───────────────────────────────────────────────────────

/// A reading of the process's total CPU time (seconds) and its memory (MB), or `None` once it no longer exists.
fn read_process(pid: u32) -> Option<(f64, u64)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
        use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: plain Win32 calls on a handle opened here and closed before returning; the out-parameters are local structs.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let ok_times = GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) != 0;
            let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let ok_mem = K32GetProcessMemoryInfo(h, &mut counters, counters.cb) != 0;
            CloseHandle(h);
            if !ok_times || !ok_mem {
                return None;
            }
            let ticks = |f: FILETIME| ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64; // 100-nanosecond units
            // A finished process still has a handle-able record; it has exited when its exit time is set.
            if exited.dwHighDateTime != 0 || exited.dwLowDateTime != 0 {
                return None;
            }
            Some(((ticks(kernel) + ticks(user)) / 10_000_000.0, (counters.WorkingSetSize as u64) / (1024 * 1024)))
        }
    }
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields: Vec<&str> = stat[stat.rfind(')')? + 2..].split(' ').collect();
        let ticks: f64 = fields.get(11)?.parse::<f64>().ok()? + fields.get(12)?.parse::<f64>().ok()?; // utime + stime
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        let rss_kb: u64 = status.lines().find_map(|l| l.strip_prefix("VmRSS:"))?.split_whitespace().next()?.parse().ok()?;
        Some((ticks / 100.0, rss_kb / 1024)) // USER_HZ is 100 on every mainstream Linux build
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = pid;
        None
    }
}

/// CPU share of the whole machine between two readings.
fn cpu_percent(cpu_before: f64, cpu_after: f64, wall: Duration, cores: usize) -> f64 {
    let secs = wall.as_secs_f64();
    if secs <= 0.0 {
        return 0.0;
    }
    round1(((cpu_after - cpu_before) / secs / cores.max(1) as f64) * 100.0)
}

/// Samples one process every two seconds and reports each reading. Starting again replaces the earlier sampling.
#[derive(Default)]
pub struct Monitor {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Monitor {
    pub fn start(&self, pid: u32, on_sample: impl Fn(Sample) + Send + 'static) {
        self.stop();
        if pid == 0 {
            return;
        }
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        let handle = tokio::spawn(async move {
            let Some((mut prev_cpu, _)) = read_process(pid) else { return };
            let mut prev_at = Instant::now();
            loop {
                tokio::time::sleep(SAMPLE_EVERY).await;
                let Some((cpu, mem_mb)) = read_process(pid) else { return };
                let now = Instant::now();
                on_sample(Sample { cpu_percent: cpu_percent(prev_cpu, cpu, now - prev_at, cores), mem_mb });
                prev_cpu = cpu;
                prev_at = now;
            }
        });
        *self.task.lock().unwrap() = Some(handle);
    }

    pub fn stop(&self) {
        if let Some(h) = self.task.lock().unwrap().take() {
            h.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_query_exists_from_1_20_3_and_for_year_based_versions() {
        for yes in ["1.20.3", "1.20.4", "1.20.6", "1.21", "1.21.4", "1.22", "2.0", "26.1", "26.2.1", "1.21-pre1"] {
            assert!(supports_tick_query(yes), "{yes}");
        }
        for no in ["1.20", "1.20.1", "1.20.2", "1.19.4", "1.8.9", "", "unknown", "24w01a"] {
            assert!(!supports_tick_query(no), "{no}");
        }
    }

    #[test]
    fn our_own_tick_query_lines_are_recognised_and_ordinary_lines_are_not() {
        for yes in [
            "[12:00:00] [Server thread/INFO]: The game is running normally",
            "The game is frozen",
            "Target tick rate: 20.0 per second.",
            "Average time per tick: 2.8 ms (Target: 50.0 ms)",
            "Average time per tick: 2.8ms",
            "Percentiles: P50: 2.1 ms P95: 4.0 ms P99: 5.5 ms, sample: 100",
        ] {
            assert!(is_tick_query_line(yes), "{yes}");
        }
        for no in [
            "<Steve> the game is fun",
            "Can't keep up!",
            "Done (3.2s)! For help, type \"help\"",
            "[12:00:00] [Server thread/INFO]: <Steve> Average time per tick: 99 ms",
            "<Steve> Target tick rate: 1 per second.",
            "[12:00:00] [Server thread/INFO]: [Steve] The game is frozen",
        ] {
            assert!(!is_tick_query_line(no), "{no}");
        }
    }

    #[test]
    fn milliseconds_per_tick_become_ticks_per_second() {
        assert_eq!(parse_mspt("Average time per tick: 2.8 ms (Target: 50.0 ms)"), Some(2.8));
        assert_eq!(parse_mspt("Average time per tick: 55 ms"), Some(55.0));
        assert_eq!(parse_mspt("[12:00:00] [Server thread/INFO]: Average time per tick: 2.8 ms (Target: 50.0 ms)"), Some(2.8));
        assert_eq!(parse_mspt("[12:00:00] [Server thread/INFO]: <Steve> Average time per tick: 99 ms"), None, "chat is not the server");
        assert_eq!(parse_mspt("nothing"), None);
        assert_eq!(tps_from_mspt(2.8), 20.0, "a fast server is capped at a perfect 20");
        assert_eq!(tps_from_mspt(50.0), 20.0);
        assert_eq!(tps_from_mspt(100.0), 10.0);
        assert_eq!(tps_from_mspt(66.7), 15.0);
        assert_eq!(tps_from_mspt(0.0), 20.0);
        assert_eq!(tps_from_mspt(f64::NAN), 20.0);
    }

    #[test]
    fn the_lag_warning_is_counted() {
        assert!(is_lag_line("[Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2345ms or 46 ticks behind"));
        assert!(is_lag_line("Can't keep up! Is the server overloaded?"));
        assert!(!is_lag_line("<Steve> I can keep up"));
        assert!(!is_lag_line("[12:00:00] [Server thread/INFO]: <Steve> Can't keep up! Is the server overloaded?"), "a player quoting it does not count");
    }

    #[test]
    fn the_panel_payload_has_nulls_until_something_is_known() {
        let empty = PerfState::default().to_json(Some(2048));
        assert_eq!(empty, json!({ "cpuPercent": null, "memMb": null, "tps": null, "mspt": null, "lagWarnings": 0, "maxRamMb": 2048 }));
        let full = PerfState { cpu_percent: Some(12.5), mem_mb: Some(900), tps: Some(19.5), mspt: Some(51.0), lag_warnings: 2 }.to_json(None);
        assert_eq!(full["memMb"], 900);
        assert_eq!(full["maxRamMb"], Value::Null);
    }

    #[test]
    fn cpu_is_a_share_of_the_whole_machine_and_never_negative() {
        assert_eq!(cpu_percent(0.0, 1.0, Duration::from_secs(2), 4), 12.5);
        assert_eq!(cpu_percent(0.0, 8.0, Duration::from_secs(2), 4), 100.0);
        assert_eq!(cpu_percent(5.0, 4.0, Duration::from_secs(2), 4), 0.0);
        assert_eq!(cpu_percent(0.0, 1.0, Duration::ZERO, 4), 0.0);
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn the_operating_system_reports_this_process_and_none_for_one_that_does_not_exist() {
        let (cpu, mem) = read_process(std::process::id()).expect("this test's own process");
        assert!(cpu >= 0.0);
        assert!(mem > 0, "a running test holds some memory");
        assert!(read_process(u32::MAX - 7).is_none());
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[tokio::test]
    async fn the_monitor_reports_a_busy_process_and_stops_when_told() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let m = Monitor::default();
        m.start(std::process::id(), move |s| {
            let _ = tx.send(s);
        });
        let spin = tokio::task::spawn_blocking(|| {
            let end = Instant::now() + Duration::from_millis(2600);
            let mut x = 0u64;
            while Instant::now() < end {
                x = x.wrapping_add(1);
            }
            x
        });
        let first = tokio::time::timeout(Duration::from_secs(8), rx.recv()).await.expect("a sample within 8 s").unwrap();
        let _ = spin.await;
        assert!(first.mem_mb > 0);
        assert!(first.cpu_percent > 0.0, "a spinning thread uses some CPU: {first:?}");
        assert!(first.cpu_percent <= 100.0);
        m.stop();
        while rx.try_recv().is_ok() {}
        tokio::time::sleep(Duration::from_millis(2300)).await;
        assert!(rx.try_recv().is_err(), "no samples after stop");
    }
}

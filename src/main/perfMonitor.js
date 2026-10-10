'use strict';

const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SAMPLE_MS = 2000;

/**
 * Samples a process's CPU and memory every 2s and emits
 * 'sample' { cpuPercent, memMb }. CPU is a share of the whole machine
 * (100% = every core busy).
 *
 * Windows: one long-lived PowerShell process prints a line per sample
 * (spawning a new process per sample would cost more than the server).
 * Linux: /proc. macOS: ps.
 */
class PerfMonitor extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.child = null;
    this.timer = null;
  }

  start(pid) {
    this.stop();
    if (!Number.isInteger(pid) || pid <= 0) return;
    this.pid = pid;
    if (process.platform === 'win32') this._startWindows(pid);
    else if (process.platform === 'linux') this._startLinux(pid);
    else this._startPs(pid);
  }

  stop() {
    this.pid = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.child) {
      try { this.child.kill(); } catch { /* already gone */ }
    }
    this.child = null;
  }

  _startWindows(pid) {
    // pid is a validated integer, so interpolating it is safe.
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$p = Get-Process -Id ${pid}`,
      '$n = [Environment]::ProcessorCount',
      '$inv = [Globalization.CultureInfo]::InvariantCulture',
      '$prev = $p.TotalProcessorTime.TotalMilliseconds',
      '$sw = [Diagnostics.Stopwatch]::StartNew()',
      'while ($true) {',
      `  Start-Sleep -Milliseconds ${SAMPLE_MS}`,
      '  $p.Refresh(); if ($p.HasExited) { break }',
      '  $cpu = $p.TotalProcessorTime.TotalMilliseconds; $el = $sw.Elapsed.TotalMilliseconds; $sw.Restart()',
      '  [Console]::Out.WriteLine([string]::Format($inv, "{0:0.0} {1}", (($cpu - $prev) / $el / $n * 100), [math]::Round($p.WorkingSet64 / 1MB)))',
      '  [Console]::Out.Flush(); $prev = $cpu',
      '}',
    ].join('\n');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true, shell: false,
    });
    this.child = child;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const s = parseSampleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (s) this.emit('sample', s);
      }
    });
    child.on('error', () => { /* no PowerShell — just no samples */ });
    child.on('exit', () => { if (this.child === child) this.child = null; });
  }

  _startLinux(pid) {
    const ticks = 100; // USER_HZ on every mainstream Linux build
    const cores = os.cpus().length || 1;
    let prev = null;
    this.timer = setInterval(() => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const cpuTicks = Number(fields[11]) + Number(fields[12]); // utime + stime
        const rssKb = Number((/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')) || [])[1] || 0);
        const now = Date.now();
        if (prev) {
          const cpuPercent = ((cpuTicks - prev.cpuTicks) / ticks) / ((now - prev.at) / 1000) / cores * 100;
          this.emit('sample', { cpuPercent: round1(cpuPercent), memMb: Math.round(rssKb / 1024) });
        }
        prev = { cpuTicks, at: now };
      } catch {
        this.stop();
      }
    }, SAMPLE_MS);
  }

  _startPs(pid) {
    const cores = os.cpus().length || 1;
    this.timer = setInterval(() => {
      const ps = spawn('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], { shell: false });
      let out = '';
      ps.stdout.on('data', (d) => { out += d; });
      ps.on('close', () => {
        const [cpu, rss] = out.trim().split(/\s+/).map(Number);
        if (Number.isFinite(cpu) && Number.isFinite(rss)) this.emit('sample', { cpuPercent: round1(cpu / cores), memMb: Math.round(rss / 1024) });
      });
      ps.on('error', () => this.stop());
    }, SAMPLE_MS);
  }
}

function round1(n) {
  return Math.max(0, Math.round(n * 10) / 10);
}

function parseSampleLine(line) {
  const m = /^\s*(-?[\d.]+)\s+(\d+)\s*$/.exec(line);
  if (!m) return null;
  return { cpuPercent: round1(Number(m[1])), memMb: Number(m[2]) };
}

// ─── TPS via the vanilla `tick query` command (Minecraft 1.20.3+) ─────────

/** True for versions that have /tick (1.20.3 and newer, including 26.x). */
function supportsTickQuery(version) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version || ''));
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  if (major >= 2) return true; // year-based versions (26.1+)
  if (minor !== 20) return minor > 20;
  return patch >= 3;
}

// Lines `tick query` prints, so they can be kept out of the visible console.
const TICK_QUERY_LINES = [
  /The game is (?:running|frozen|sprinting|stepping|not running)/i,
  /Target tick rate: [\d.]+ per second/i,
  /Average time per tick: [\d.]+ ?ms/i,
  /Percentiles: P50: /i,
];

function isTickQueryLine(line) {
  return TICK_QUERY_LINES.some((re) => re.test(line));
}

/** Milliseconds per tick from a `tick query` line, or null. */
function parseMspt(line) {
  const m = /Average time per tick: ([\d.]+) ?ms/i.exec(line);
  return m ? Number(m[1]) : null;
}

/** Ticks per second implied by ms-per-tick (20 is perfect). */
function tpsFromMspt(mspt) {
  if (!Number.isFinite(mspt) || mspt <= 0) return 20;
  return Math.min(20, Math.round((1000 / mspt) * 10) / 10);
}

const LAG_RE = /Can't keep up! Is the server overloaded\?/i;

module.exports = {
  PerfMonitor, parseSampleLine, supportsTickQuery, isTickQueryLine, parseMspt, tpsFromMspt, LAG_RE,
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const {
  PerfMonitor, parseSampleLine, supportsTickQuery, isTickQueryLine, parseMspt, tpsFromMspt, LAG_RE,
} = require('../src/main/perfMonitor');

test('parseSampleLine reads "cpu mem" lines', () => {
  assert.deepEqual(parseSampleLine('12.5 2048'), { cpuPercent: 12.5, memMb: 2048 });
  assert.deepEqual(parseSampleLine(' 0.0 512 \r'), { cpuPercent: 0, memMb: 512 });
  assert.equal(parseSampleLine('Get-Process : Cannot find a process'), null);
});

test('supportsTickQuery knows which versions have /tick', () => {
  for (const v of ['1.20.3', '1.20.6', '1.21', '1.21.8', '26.1', '26.2.1']) assert.equal(supportsTickQuery(v), true, v);
  for (const v of ['1.20.2', '1.20', '1.19.4', '1.8.9', 'unknown', '']) assert.equal(supportsTickQuery(v), false, v);
});

test('tick query output is recognised and parsed', () => {
  const lines = [
    '[12:00:00] [Server thread/INFO]: The game is running normally',
    '[12:00:00] [Server thread/INFO]: Target tick rate: 20.0 per second.',
    'Average time per tick: 12.4ms (Target: 50.0ms)',
    '[12:00:00] [Server thread/INFO]: Percentiles: P50: 11.2ms P95: 20.1ms P99: 31.0ms, sample: 100',
  ];
  for (const l of lines) assert.ok(isTickQueryLine(l), l);
  assert.equal(isTickQueryLine('[Server thread/INFO]: Steve joined the game'), false);
  assert.equal(parseMspt(lines[2]), 12.4);
  assert.equal(parseMspt(lines[0]), null);
});

test('tpsFromMspt caps at 20 and drops when ticks are slow', () => {
  assert.equal(tpsFromMspt(12), 20);
  assert.equal(tpsFromMspt(50), 20);
  assert.equal(tpsFromMspt(100), 10);
  assert.equal(tpsFromMspt(0), 20);
});

test('LAG_RE spots "Can\'t keep up" warnings', () => {
  assert.ok(LAG_RE.test("[Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2034ms or 40 ticks behind"));
});

test('PerfMonitor samples a real process', { timeout: 20000 }, async () => {
  const busy = spawn(process.execPath, ['-e', 'const end = Date.now() + 15000; while (Date.now() < end) {}']);
  const mon = new PerfMonitor();
  try {
    const sample = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no sample within 12s')), 12000);
      mon.on('sample', (s) => { clearTimeout(t); resolve(s); });
      mon.start(busy.pid);
    });
    assert.ok(sample.memMb > 5, `memMb ${sample.memMb}`);
    assert.ok(sample.cpuPercent > 0, `cpu ${sample.cpuPercent}`);
  } finally {
    mon.stop();
    busy.kill();
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuitGate } = require('../src/main/quitGate');

/** The gate with a controllable server: `exit()` ends the wait the way the server's own exit does. */
function setup({ running = true } = {}) {
  const log = [];
  const state = { running };
  let release;
  const gate = createQuitGate({
    serverRunning: () => state.running,
    stopEverything: () => log.push('stop'),
    waitForServerStopped: (ms) => { log.push(`wait:${ms}`); return new Promise((resolve) => { release = () => { state.running = false; resolve(); }; }); },
    quit: () => { log.push('quit'); gate.onBeforeQuit(fakeEvent(log)); },
    timeoutMs: 25000,
  });
  return { gate, log, state, exit: () => release() };
}

function fakeEvent(log) {
  return { preventDefault: () => log.push('prevented') };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('D4: with no server running, quitting goes straight through', () => {
  const { gate, log } = setup({ running: false });
  gate.onBeforeQuit(fakeEvent(log));
  assert.deepEqual(log, []);
  assert.equal(gate.isQuitting(), true);
});

test('D4: with a server running, the first quit is held, the server is stopped, and the app waits for it', async () => {
  const { gate, log, exit } = setup();
  gate.onBeforeQuit(fakeEvent(log));
  assert.deepEqual(log, ['prevented', 'stop', 'wait:25000']);
  await tick();
  assert.ok(!log.includes('quit'), 'not before the server has stopped');
  exit();
  await tick();
  // quit() asks again: that second request is let through (it is not prevented).
  assert.deepEqual(log, ['prevented', 'stop', 'wait:25000', 'quit']);
  assert.equal(gate.isQuitting(), true);
});

test('D4: more quit requests while waiting change nothing: the server is stopped once and quit is asked once', async () => {
  const { gate, log, exit } = setup();
  gate.onBeforeQuit(fakeEvent(log));
  gate.onBeforeQuit(fakeEvent(log));
  gate.onBeforeQuit(fakeEvent(log));
  assert.equal(log.filter((l) => l === 'stop').length, 1);
  assert.equal(log.filter((l) => l.startsWith('wait')).length, 1);
  assert.equal(log.filter((l) => l === 'prevented').length, 3, 'each of them is held');
  exit();
  await tick();
  assert.equal(log.filter((l) => l === 'quit').length, 1);
});

test('D4: if the wait runs out (the wait resolves anyway), the app still quits', async () => {
  const log = [];
  const gate = createQuitGate({
    serverRunning: () => true, // the server never went away
    stopEverything: () => log.push('stop'),
    waitForServerStopped: async () => { log.push('timeout'); },
    quit: () => { log.push('quit'); gate.onBeforeQuit(fakeEvent(log)); },
    timeoutMs: 1,
  });
  gate.onBeforeQuit(fakeEvent(log));
  await tick();
  assert.deepEqual(log, ['prevented', 'stop', 'timeout', 'quit'], 'and the second request is not held again');
});

test('D4: a failure while stopping or waiting still ends in a quit', async () => {
  for (const [stopEverything, waitForServerStopped] of [
    [() => { throw new Error('tunnel blew up'); }, async () => {}],
    [() => {}, () => Promise.reject(new Error('wait blew up'))],
  ]) {
    const log = [];
    const gate = createQuitGate({
      serverRunning: () => true, stopEverything, waitForServerStopped,
      quit: () => { log.push('quit'); gate.onBeforeQuit(fakeEvent(log)); }, timeoutMs: 1,
    });
    gate.onBeforeQuit(fakeEvent(log));
    await tick();
    await tick();
    assert.deepEqual(log, ['prevented', 'quit']);
  }
});

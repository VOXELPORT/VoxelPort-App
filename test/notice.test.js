'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chatSafe, timeLeftPhrase, NoticeAnnouncer, MAX_CHAT_LEN } = require('../src/main/notice');

/** An announcer with a fake clock and fake timers, so a test can "wait" ten minutes instantly. */
function rig(lang = 'en') {
  let now = 1_000_000;
  const said = [];
  const timers = [];
  const announcer = new NoticeAnnouncer({
    say: (line) => said.push(line),
    lang: () => lang,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
  });
  /** Moves the clock forward and fires every timer that has come due, in order. */
  const advance = (seconds) => {
    now += seconds * 1000;
    for (const t of timers.filter((x) => x.live && x.at <= now).sort((a, b) => a.at - b.at)) { t.live = false; t.fn(); }
  };
  return { announcer, said, advance, liveTimers: () => timers.filter((t) => t.live).length };
}

test('chatSafe keeps text to one plain line: no formatting codes, controls or newlines', () => {
  assert.equal(chatSafe('Hi§cred\nline'), 'Hi cred line');
  assert.equal(chatSafe('  spaced   out  '), 'spaced out');
  assert.equal(chatSafe(null), '');
  assert.equal(chatSafe('a'.repeat(500)).length, MAX_CHAT_LEN);
});

test('timeLeftPhrase says the time in plain words, in both languages', () => {
  assert.equal(timeLeftPhrase(0), 'now');
  assert.equal(timeLeftPhrase(30), 'in less than a minute');
  assert.equal(timeLeftPhrase(60), 'in 1 minute');
  assert.equal(timeLeftPhrase(61), 'in 2 minutes');
  assert.equal(timeLeftPhrase(600), 'in 10 minutes');
  assert.equal(timeLeftPhrase(3 * 3600), 'in about 3 hours');
  assert.equal(timeLeftPhrase(600, 'hinglish'), '10 minute mein');
  assert.equal(timeLeftPhrase(0, 'hinglish'), 'abhi');
  assert.equal(timeLeftPhrase(600, 'no-such-language'), 'in 10 minutes');
});

test('a timed notice is said at once, again 5 and 1 minutes before, and when the time is up', () => {
  const { announcer, said, advance } = rig();
  announcer.handle({ message: 'The VoxelPort relay will restart.', seconds: 600 });
  assert.deepEqual(said, ['[VoxelPort] The VoxelPort relay will restart. (in 10 minutes)']);
  advance(300);
  assert.equal(said.at(-1), '[VoxelPort] The VoxelPort relay will restart. (in 5 minutes)');
  advance(240);
  assert.equal(said.at(-1), '[VoxelPort] The VoxelPort relay will restart. (in 1 minute)');
  advance(60);
  assert.equal(said.at(-1), '[VoxelPort] The VoxelPort relay will restart. (now)');
  assert.equal(said.length, 4);
});

test('a short notice only gets the reminders that still fit, then "now"', () => {
  const { announcer, said, advance } = rig();
  announcer.handle({ message: 'Restarting.', seconds: 100 }); // no 5 minute reminder; a 1 minute one fits
  advance(40);
  advance(60);
  assert.deepEqual(said.map((l) => l.replace(/^.*\(/, '(')), ['(in 2 minutes)', '(in 1 minute)', '(now)']);
});

test('a notice with no time is said once, with no time in it, and nothing is scheduled', () => {
  const { announcer, said, liveTimers } = rig();
  announcer.handle({ message: 'Maintenance tonight.', seconds: 0 });
  assert.deepEqual(said, ['[VoxelPort] Maintenance tonight.']);
  assert.equal(liveTimers(), 0);
});

test('the same notice handed over again by a reconnect is not said twice, but the countdown stays right', () => {
  const { announcer, said, advance } = rig();
  announcer.handle({ message: 'The VoxelPort relay will restart.', seconds: 600 });
  advance(100);
  announcer.handle({ message: 'The VoxelPort relay will restart.', seconds: 500 }); // the host reconnected
  assert.equal(said.length, 1, 'players were not told twice');
  advance(200); // 300 s left: the 5 minute reminder
  assert.equal(said.length, 2);
  assert.match(said.at(-1), /\(in 5 minutes\)$/);
});

test('a different notice is said straight away, and the old reminders are dropped', () => {
  const { announcer, said, advance } = rig();
  announcer.handle({ message: 'First thing.', seconds: 600 });
  announcer.handle({ message: 'Second thing.', seconds: 600 });
  assert.equal(said.length, 2);
  advance(300);
  assert.equal(said.filter((l) => l.includes('First thing')).length, 1, 'nothing more about the first notice');
});

test('an empty notice withdraws everything that was scheduled', () => {
  const { announcer, said, advance, liveTimers } = rig();
  announcer.handle({ message: 'The VoxelPort relay will restart.', seconds: 600 });
  announcer.handle({ message: '', seconds: 0 });
  assert.equal(liveTimers(), 0);
  advance(1200);
  assert.equal(said.length, 1);
});

test('the same words are said again once enough time has passed since last time', () => {
  const { announcer, said, advance } = rig();
  announcer.handle({ message: 'Restarting soon.', seconds: 0 });
  advance(11 * 60);
  announcer.handle({ message: 'Restarting soon.', seconds: 0 });
  assert.equal(said.length, 2);
});

test('it speaks Hinglish when the app does, and survives a server that just stopped', () => {
  const r = rig('hinglish');
  r.announcer.handle({ message: 'Relay restart hoga.', seconds: 600 });
  assert.equal(r.said[0], '[VoxelPort] Relay restart hoga. (10 minute mein)');

  const broken = new NoticeAnnouncer({ say: () => { throw new Error('server is gone'); } });
  assert.doesNotThrow(() => broken.handle({ message: 'Hello', seconds: 0 }));
});

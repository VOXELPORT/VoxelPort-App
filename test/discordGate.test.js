'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGate } = require('../src/main/discordGate');

const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 1);
const base = {
  existingInstall: false, session: true,
  config: { graceUntil: T0 + 10 * DAY, serverNow: T0, at: T0 },
  status: { member: true, reason: null }, statusError: null, lastGood: null, now: T0,
};
const gate = (over) => evaluateGate({ ...base, ...over });
const pick = (g) => [g.allowed, g.mustSignIn, g.banner, g.reason];

test('a new install that is a member is allowed with no banner', () => {
  assert.deepEqual(pick(gate({})), [true, false, 'none', 'ok']);
});

test('a new install that is signed out must sign in, even during the grace window', () => {
  assert.deepEqual(pick(gate({ session: false, status: null })), [false, true, 'blocked', 'signed_out']);
});

test('a new install that is not in the server is blocked with the invite, and screening is reported separately', () => {
  assert.deepEqual(pick(gate({ status: { member: false, reason: 'not_in_server' } })), [false, false, 'blocked', 'not_in_server']);
  assert.deepEqual(pick(gate({ status: { member: false, reason: 'screening' } })), [false, false, 'blocked', 'screening']);
});

test('a membership that needs re-confirming asks for a new sign-in', () => {
  assert.deepEqual(pick(gate({ status: { member: false, reason: 'recheck' } })), [false, true, 'blocked', 'recheck']);
});

test('an existing install keeps working during grace and sees a banner with the days left', () => {
  const g = gate({ existingInstall: true, session: false, status: null, now: T0 + 2 * DAY, config: { graceUntil: T0 + 10 * DAY, serverNow: T0, at: T0 } });
  assert.deepEqual(pick(g), [true, false, 'grace', 'signed_out']);
  assert.equal(g.graceDaysLeft, 8);
  assert.deepEqual(pick(gate({ existingInstall: true, status: { member: false, reason: 'not_in_server' } })), [true, false, 'grace', 'not_in_server']);
  assert.equal(gate({ existingInstall: true }).banner, 'none');
});

test('the same existing install is blocked once grace has ended, judged by server time', () => {
  const late = { existingInstall: true, session: false, status: null, now: T0 + 10 * DAY, config: { graceUntil: T0 + 10 * DAY, serverNow: T0, at: T0 } };
  assert.deepEqual(pick(gate(late)), [false, true, 'blocked', 'signed_out']);
  assert.deepEqual(pick(gate({ ...late, now: T0 + 10 * DAY - 1 })), [true, false, 'grace', 'signed_out']);
});

test('setting the PC clock back cannot extend grace', () => {
  const config = { graceUntil: T0 + 10 * DAY, serverNow: T0 + 9 * DAY, at: T0 + 9 * DAY };
  const g = gate({ existingInstall: true, session: false, status: null, config, now: T0 + 9 * DAY - 30 * DAY });
  assert.equal(g.graceDaysLeft, 1);
  assert.deepEqual(pick(gate({ existingInstall: true, session: false, status: null, config, now: T0 + 10 * DAY + 1 })), [false, true, 'blocked', 'signed_out']);
});

test('no grace date means grace has not ended, and no config at all never blocks an existing install', () => {
  assert.equal(gate({ existingInstall: true, session: false, status: null, config: { graceUntil: null, serverNow: T0, at: T0 }, now: T0 + 400 * DAY }).allowed, true);
  assert.equal(gate({ existingInstall: true, session: false, status: null, config: null }).allowed, true);
});

test('when the service is unreachable the last good answer holds for 7 days, then hosting is allowed', () => {
  const down = { statusError: 'unreachable', status: null };
  assert.deepEqual(pick(gate({ ...down, lastGood: { member: true, at: T0 }, now: T0 + 3 * DAY })), [true, false, 'none', 'ok']);
  assert.deepEqual(pick(gate({ ...down, lastGood: { member: false, at: T0 }, now: T0 + 3 * DAY })), [false, false, 'blocked', 'not_in_server']);
  assert.deepEqual(pick(gate({ ...down, lastGood: { member: false, at: T0 }, now: T0 + 8 * DAY })), [true, false, 'none', 'offline_ok']);
  assert.deepEqual(pick(gate({ ...down, lastGood: null })), [true, false, 'none', 'offline_ok']);
});

test('a rejected session never fails open after grace and only warns during it', () => {
  const rejected = { statusError: 'unauthorized', status: null };
  assert.deepEqual(pick(gate(rejected)), [false, true, 'blocked', 'session_rejected']);
  assert.deepEqual(pick(gate({ ...rejected, existingInstall: true })), [true, false, 'grace', 'session_rejected']);
});

test('a signed-out install is never rescued by the unreachable fail-open', () => {
  assert.deepEqual(pick(gate({ session: false, status: null, statusError: 'unreachable', lastGood: null })), [false, true, 'blocked', 'signed_out']);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordInstall } = require('../src/main/discordGate');

test('the install record marks an install with an existing device token as pre-existing, once', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-gate-'));
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-gate-'));
  try {
    fs.writeFileSync(path.join(old, 'device-token.json'), '{}');
    assert.deepEqual(recordInstall(fresh, 111), { installedAt: 111, existingInstall: false });
    assert.deepEqual(recordInstall(old, 222), { installedAt: 222, existingInstall: true });
    // The first answer is kept, even after the device token now exists on the fresh install.
    fs.writeFileSync(path.join(fresh, 'device-token.json'), '{}');
    assert.deepEqual(recordInstall(fresh, 999), { installedAt: 111, existingInstall: false });
    assert.deepEqual(recordInstall(old, 999), { installedAt: 222, existingInstall: true });
  } finally { fs.rmSync(fresh, { recursive: true, force: true }); fs.rmSync(old, { recursive: true, force: true }); }
});

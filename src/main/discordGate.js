'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

const DAY = 86400000;
const OFFLINE_HOLD_MS = 7 * DAY;

/**
 * Decides whether this install may host publicly. Pure: everything it needs is passed in.
 *
 *   existingInstall  the app was already installed before the Discord requirement shipped
 *   session          there is a saved app session
 *   config           { graceUntil, serverNow, at } from the accounts service (public, needs no session)
 *   status           { member, reason } from the last successful status check
 *   statusError      'unreachable' | 'unauthorized' | null for the latest attempt
 *   lastGood         { member, at } the last successful answer
 *
 * Grace is judged on the server's clock plus the time elapsed since it was read, and elapsed time never
 * goes negative, so setting the PC clock back cannot extend it. Only existing installs get grace.
 */
function evaluateGate({ existingInstall, session, config, status, statusError, lastGood, now }) {
  const graceUntil = config ? config.graceUntil : null;
  const serverNow = config ? config.serverNow + Math.max(0, now - config.at) : null;
  const graceActive = !!existingInstall && !(graceUntil != null && serverNow >= graceUntil);
  const graceDaysLeft = graceActive && graceUntil != null ? Math.max(0, Math.ceil((graceUntil - serverNow) / DAY)) : null;

  const verdict = membershipVerdict({ session, status, statusError, lastGood, now });
  if (graceActive) {
    return { allowed: true, mustSignIn: false, banner: verdict.allowed ? 'none' : 'grace', reason: verdict.reason, graceDaysLeft };
  }
  return { allowed: verdict.allowed, mustSignIn: verdict.mustSignIn, banner: verdict.allowed ? 'none' : 'blocked', reason: verdict.reason, graceDaysLeft: null };
}

function membershipVerdict({ session, status, statusError, lastGood, now }) {
  if (!session) return { allowed: false, mustSignIn: true, reason: 'signed_out' };
  if (statusError === 'unauthorized') return { allowed: false, mustSignIn: true, reason: 'session_rejected' };
  if (statusError === 'unreachable' || !status) {
    // The service cannot be asked: trust the last good answer for a week, then stop getting in people's way.
    if (!lastGood || now - lastGood.at > OFFLINE_HOLD_MS) return { allowed: true, mustSignIn: false, reason: 'offline_ok' };
    return lastGood.member ? { allowed: true, mustSignIn: false, reason: 'ok' } : { allowed: false, mustSignIn: false, reason: 'not_in_server' };
  }
  if (status.member) return { allowed: true, mustSignIn: false, reason: 'ok' };
  const reason = status.reason || 'not_in_server';
  return { allowed: false, mustSignIn: reason === 'recheck', reason };
}

/**
 * Remembers, once, whether this install existed before the Discord requirement shipped. It must run before the
 * device token is created: an install that already has a device token file is an existing one.
 */
function recordInstall(userDataDir, now) {
  const file = path.join(userDataDir, 'discord-gate.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.existingInstall === 'boolean') return { installedAt: saved.installedAt, existingInstall: saved.existingInstall };
  } catch { /* first run of this version */ }
  const record = { installedAt: now, existingInstall: fs.existsSync(path.join(userDataDir, 'device-token.json')) };
  try { fs.mkdirSync(userDataDir, { recursive: true }); atomicWriteFileSync(file, JSON.stringify(record)); } catch { /* best effort */ }
  return record;
}

module.exports = { evaluateGate, recordInstall };

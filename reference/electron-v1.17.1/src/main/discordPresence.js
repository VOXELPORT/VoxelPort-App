'use strict';

const net = require('net');
const path = require('path');
const os = require('os');

// Discord "Rich Presence": a line under the user's name in Discord ("Hosting a Paper server · 3 players online").
// It talks only to the Discord app running on the same computer, over its local pipe: nothing goes to the internet from here,
// and the server's name and address are never sent. It is off unless the user turns it on.
//
// Needs a Discord application id (a free "application" made at discord.com/developers). Without one this does nothing.

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;
const MAX_FRAME_BYTES = 64 * 1024;
const RETRY_MS = 30000;

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** Cuts a stream of bytes into Discord frames; keeps what is not a whole frame yet. */
function createDecoder(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0);
      const len = buf.readInt32LE(4);
      if (len < 0 || len > MAX_FRAME_BYTES) { buf = Buffer.alloc(0); onFrame(OP_CLOSE, null); return; }
      if (buf.length < 8 + len) return;
      let data = null;
      try { data = JSON.parse(buf.subarray(8, 8 + len).toString('utf8')); } catch { /* an unreadable frame is ignored */ }
      buf = buf.subarray(8 + len);
      onFrame(op, data);
    }
  };
}

/** Where Discord listens, for pipe number `n`. */
function pipePath(n, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${n}`;
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || os.tmpdir() || '/tmp';
  return path.join(base, `discord-ipc-${n}`);
}

/** What shows in Discord. `info` is { type, version, players } of the server that is running. */
function buildActivity(info, startedAt) {
  const type = { paper: 'Paper', fabric: 'Fabric', vanilla: 'Vanilla' }[info && info.type] || 'Minecraft';
  const players = Math.max(0, Math.min(9999, Number(info && info.players) || 0));
  const version = typeof (info && info.version) === 'string' ? info.version.replace(/[^\w.\-+ ]/g, '').slice(0, 20) : '';
  return {
    details: `Hosting a ${type}${version ? ' ' + version : ''} server`.slice(0, 128),
    state: players === 1 ? '1 player online' : `${players} players online`,
    timestamps: { start: Math.floor(startedAt / 1000) },
    instance: false,
  };
}

class DiscordPresence {
  /** `connect(pipePath)` returns a socket-like object; it is replaced in tests. */
  constructor({ clientId = '', connect = (p) => net.createConnection(p), pid = process.pid, now = Date.now } = {}) {
    this.clientId = /^\d{15,25}$/.test(String(clientId)) ? String(clientId) : '';
    this.connect = connect;
    this.pid = pid;
    this.now = now;
    this.enabled = false;
    this.info = null; // null = nothing to show
    this.startedAt = 0;
    this.sock = null;
    this.ready = false;
    this.retry = null;
    this.nonce = 0;
  }

  /** False when there is no application id: the screen then hides the option altogether. */
  get available() { return this.clientId !== ''; }

  setEnabled(on) {
    this.enabled = Boolean(on) && this.available;
    if (this.enabled) this._open();
    else this._close();
  }

  /** The running server, or null when none runs. Only changes what is sent when it really changed. */
  update(info) {
    const had = this.info !== null;
    this.info = info ? { type: info.type, version: info.version, players: info.players } : null;
    if (this.info && !had) this.startedAt = this.now();
    this._push();
  }

  _open(n = 0) {
    if (!this.enabled || this.sock) return;
    if (n > 9) { this._scheduleRetry(); return; } // Discord is not running: look again later
    let sock;
    try { sock = this.connect(pipePath(n)); } catch { this._open(n + 1); return; }
    this.sock = sock;
    let opened = false;
    const decode = createDecoder((op, data) => {
      if (op === OP_PING) this._write(OP_PONG, data || {});
      else if (op === OP_CLOSE) this._drop(false);
      else if (op === OP_FRAME && data && data.evt === 'READY') { this.ready = true; this._push(); }
    });
    sock.on('connect', () => { opened = true; this._write(OP_HANDSHAKE, { v: 1, client_id: this.clientId }); });
    sock.on('data', decode);
    sock.on('error', () => {
      if (!opened) { this._drop(false); this._open(n + 1); } else this._drop(true);
    });
    sock.on('close', () => { if (this.sock === sock) this._drop(opened); });
  }

  _scheduleRetry() {
    if (this.retry || !this.enabled) return;
    this.retry = setTimeout(() => { this.retry = null; this._open(); }, RETRY_MS);
    if (this.retry.unref) this.retry.unref();
  }

  _drop(retry) {
    const sock = this.sock;
    this.sock = null;
    this.ready = false;
    if (sock) { try { sock.destroy(); } catch { /* already gone */ } }
    if (retry) this._scheduleRetry();
  }

  _write(op, payload) {
    if (!this.sock) return;
    try { this.sock.write(encode(op, payload)); } catch { /* the pipe went away: its close event follows */ }
  }

  _push() {
    if (!this.enabled || !this.ready) return;
    this._write(OP_FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: this.pid, activity: this.info ? buildActivity(this.info, this.startedAt) : null },
      nonce: String(++this.nonce),
    });
  }

  _close() {
    clearTimeout(this.retry);
    this.retry = null;
    if (this.sock && this.ready) this._write(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: this.pid, activity: null }, nonce: String(++this.nonce) });
    this._drop(false);
  }

  dispose() { this.enabled = false; this._close(); }
}

module.exports = { DiscordPresence, encode, createDecoder, pipePath, buildActivity };

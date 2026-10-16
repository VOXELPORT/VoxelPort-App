'use strict';

// A player's connection to the relay's /join endpoint: present the code, then pass WebRTC setup messages to the
// host and back until the two PCs have connected. The relay carries no game traffic.

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const MAX_SIGNAL_CHARS = 8 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;
const PING_EVERY_MS = 20000;

/**
 * Events: 'joined' ({ peer, address, port } — the host's ordinary relay address, a fallback),
 *         'signal' (string — a setup message from the host), 'error' (message), 'closed'.
 */
class JoinSignaling extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.pingTimer = null;
    this.done = false;
  }

  start({ relayUrl, code, client }) {
    this.done = false;
    const url = relayUrl.replace(/\/+$/, '') + '/join';
    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 8000, maxPayload: MAX_MESSAGE_BYTES });
    } catch (err) {
      this._fail('Could not reach the relay.');
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', code: String(code || '').slice(0, 40), client: String(client || '').slice(0, 64) }));
      this.pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* closing */ } }, PING_EVERY_MS);
      if (this.pingTimer.unref) this.pingTimer.unref();
    });
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('error', () => this._fail('Could not reach the relay.'));
    ws.on('close', () => { this._stopPing(); if (!this.done) { this.done = true; this.emit('closed'); } });
  }

  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'joined':
        if (typeof m.peer === 'string' && typeof m.address === 'string' && Number.isInteger(m.port) && m.port > 0 && m.port <= 65535) {
          this.emit('joined', { peer: m.peer, address: m.address, port: m.port });
        }
        break;
      case 'signal':
        if (typeof m.signal === 'string' && m.signal.length > 0 && m.signal.length <= MAX_SIGNAL_CHARS) this.emit('signal', m.signal);
        break;
      case 'join_error':
        this._fail(typeof m.message === 'string' && m.message.length <= 500 ? m.message : 'The relay refused the code.');
        break;
      default:
        break;
    }
  }

  sendSignal(signal) {
    if (typeof signal !== 'string' || !signal || signal.length > MAX_SIGNAL_CHARS) return;
    this._send({ type: 'signal', signal });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _fail(message) {
    if (this.done) return;
    this.done = true;
    this._stopPing();
    this.emit('error', message);
    this.close();
  }

  _stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Tells the relay the player is done (the PCs are connected, or it gave up) and closes. */
  leave() {
    this._send({ type: 'leave' });
    this.close();
  }

  close() {
    this._stopPing();
    if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } }
    this.ws = null;
    this.done = true;
  }
}

module.exports = { JoinSignaling, MAX_SIGNAL_CHARS };

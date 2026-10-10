'use strict';

const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

// Matches the relay's own maxWSMessageBytes (relay/relay.go) so a
// legitimate max-size frame is never rejected, and the client-side
// `ws` library enforces it too (closes the socket if exceeded) rather than
// trusting only our own post-parse checks.
const MAX_WS_MESSAGE_BYTES = 4 * 1024 * 1024;
// A base64 "data" field this long could never decode to a legitimate frame
// within MAX_WS_MESSAGE_BYTES once wrapped in the surrounding JSON — reject
// before even attempting base64 decode.
const MAX_B64_DATA_CHARS = Math.ceil((MAX_WS_MESSAGE_BYTES * 4) / 3) + 1024;
const MAX_CONN_ID_LEN = 128;

// Item 19: a malicious/misbehaving relay must not be able to make VoxelPort
// open unlimited local sockets. Matches the relay's own per-tunnel player
// cap (relay/relay.go maxPlayersPerTunnel) so the app is never the
// bottleneck below what the relay would already allow.
const MAX_LOCAL_PLAYERS = 256;

// Handshake timeout for a relay candidate that has a fallback behind it, so a
// network that silently drops the direct port doesn't stall hosting for long.
const FALLBACK_HANDSHAKE_TIMEOUT_MS = 5000;

// Item 20: per-player bound on bytes handed to a local socket that hasn't
// finished flushing them yet. Backpressure, not deletion — once exceeded,
// the player is disconnected cleanly rather than growing memory forever.
const MAX_PLAYER_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
// If the shared control WebSocket stays backed up (players paused waiting
// on it) for longer than this, something is wrong with the tunnel itself,
// not one player — give up and let the normal error/close path run.
const WS_STALL_TIMEOUT_MS = 30000;
const WS_BUFFERED_HIGH_WATERMARK = 4 * 1024 * 1024;
const WS_BUFFERED_LOW_WATERMARK = 1 * 1024 * 1024;

const LOCAL_CONNECT_TIMEOUT_MS = 10000;

// Bedrock (UDP) sessions — mirrors the relay's own caps (relay/udp.go).
const MAX_UDP_SESSIONS = 256;
const MAX_UDP_DATAGRAM = 2048;
const MAX_UDP_B64_CHARS = Math.ceil((MAX_UDP_DATAGRAM * 4) / 3) + 4;
const UDP_SESSION_IDLE_MS = 60000;

function isValidConnId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_CONN_ID_LEN;
}

/**
 * Validates an incoming relay frame before anything acts on it (item 18) —
 * the relay is untrusted input from VoxelPort's perspective, same as the
 * relay treats the mod/app as untrusted. Unknown types are left to the
 * caller's switch (which safely ignores them); every known type gets its
 * fields checked here.
 */
function isValidRelayMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'port':
      return Number.isInteger(msg.port) && msg.port >= 1 && msg.port <= 65535;
    case 'connect':
      return isValidConnId(msg.conn) && (msg.ip === undefined || (typeof msg.ip === 'string' && msg.ip.length <= 64));
    case 'data':
      return isValidConnId(msg.conn) && typeof msg.data === 'string' && msg.data.length <= MAX_B64_DATA_CHARS;
    case 'close':
      return isValidConnId(msg.conn);
    case 'error':
    case 'name_error':
    case 'listing_error':
    case 'udp_error':
      return msg.message === undefined || (typeof msg.message === 'string' && msg.message.length <= 500);
    case 'udp':
      return isValidConnId(msg.conn) && typeof msg.data === 'string' && msg.data.length <= MAX_UDP_B64_CHARS
        && (msg.ip === undefined || (typeof msg.ip === 'string' && msg.ip.length <= 64));
    case 'udp_close':
      return isValidConnId(msg.conn);
    case 'name':
      return (msg.name === undefined || (typeof msg.name === 'string' && /^[a-z0-9-]{0,32}$/.test(msg.name)))
        && (msg.address === undefined || (typeof msg.address === 'string' && msg.address.length <= 253));
    case 'pong':
      return true;
    default:
      return true;
  }
}

/**
 * Tunnel is a Node implementation of the VoxelPort host protocol — the same
 * contract the Fabric mod speaks (see relay/README.md). It opens a WebSocket to
 * the relay, registers with a device token, receives a public port, and bridges
 * each vanilla player connection to a local Minecraft server.
 *
 * Events: 'status' (state), 'assigned' (port), 'players' (count), 'ping' (ms),
 *         'log' (line), 'error' (message), 'stopped',
 *         'name' ({ name, address } — empty when none), 'nameError' (message),
 *         'listingError' (message), 'udpError' (message).
 *
 * With `udpPort`, Bedrock players are bridged too: the relay forwards UDP on
 * the same public port, and each remote player becomes a local UDP socket
 * talking to Geyser on 127.0.0.1:udpPort.
 */
class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.players = new Map(); // connID -> { sock, pendingBytes, closed }
    this.running = false;
    this.manualStop = false;
    this.pingTimer = null;
    this.lastPingSent = 0;
    this.reconnectDelay = 1000;
    this.wsStallTimer = null;
    this.udpSessions = new Map(); // connID -> { sock, idleTimer }
    this.listing = null; // re-sent after every (re)registration
  }

  /**
   * `relayUrls` is an ordered list of candidates (preferred first). If a
   * candidate can't be reached at all, the next one is tried immediately;
   * after any drop of an established connection, the preferred one is tried
   * again first. `relayUrl` alone is the single-candidate form.
   */
  start({ relayUrl, relayUrls, token, localPort, udpPort = null }) {
    this.relayUrls = (relayUrls && relayUrls.length) ? relayUrls : [relayUrl];
    this.urlIndex = 0;
    this.relayUrl = this.relayUrls[0];
    this.token = token;
    this.localPort = localPort;
    this.udpPort = udpPort;
    this.manualStop = false;
    this._connect();
  }

  _connect() {
    this.relayUrl = this.relayUrls[this.urlIndex];
    const hasFallback = this.urlIndex < this.relayUrls.length - 1;
    this.emit('status', 'connecting');
    this.emit('log', `Connecting to ${this.relayUrl}…`);

    let ws;
    let opened = false;
    try {
      ws = new WebSocket(this.relayUrl.replace(/\/+$/, '') + '/ws', {
        // Fail over quickly when another candidate is waiting.
        handshakeTimeout: hasFallback ? FALLBACK_HANDSHAKE_TIMEOUT_MS : 15000,
        maxPayload: MAX_WS_MESSAGE_BYTES,
      });
    } catch (err) {
      this.emit('error', 'Bad relay URL: ' + err.message);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      opened = true;
      this.emit('log', 'Connected. Registering…');
      const reg = { type: 'register', token: this.token };
      if (this.udpPort) reg.udp = true;
      this._send(reg);
    });

    ws.on('message', (raw) => this._onMessage(raw));

    ws.on('close', () => {
      this._teardownPlayers();
      this._teardownUdp();
      this._stopPing();
      this._clearWsStallTimer();
      if (this.manualStop) {
        this.running = false;
        this.emit('status', 'stopped');
        this.emit('stopped');
        return;
      }
      this.running = false;
      // Never reached this candidate — move straight on to the next one.
      if (!opened && hasFallback) {
        this.urlIndex++;
        this.emit('log', `Could not reach ${this.relayUrl}, trying ${this.relayUrls[this.urlIndex]}…`);
        this._connect();
        return;
      }
      // Next attempt starts from the preferred candidate again.
      this.urlIndex = 0;
      // Unexpected drop — retry with backoff while the user wants it running.
      this.emit('status', 'reconnecting');
      this.emit('log', `Disconnected. Reconnecting in ${Math.round(this.reconnectDelay / 1000)}s…`);
      setTimeout(() => {
        if (!this.manualStop) this._connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    });

    ws.on('error', (err) => {
      this.emit('log', 'Socket error: ' + err.message);
      // 'close' fires next and handles reconnect/stop.
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!isValidRelayMessage(msg)) {
      this.emit('log', `Ignored malformed relay frame (type=${msg && msg.type}).`);
      return;
    }

    switch (msg.type) {
      case 'port':
        this.running = true;
        this.reconnectDelay = 1000;
        this.emit('status', 'online');
        this.emit('assigned', msg.port);
        this.emit('log', `Tunnel is live on public port ${msg.port}.`);
        this._startPing();
        if (this.listing) this._send({ type: 'listing', listing: this.listing });
        break;

      case 'name':
        this.emit('name', { name: msg.name || '', address: msg.address || '' });
        break;

      case 'name_error':
        this.emit('nameError', msg.message || 'Could not set that address.');
        break;

      case 'listing_error':
        this.emit('listingError', msg.message || 'Could not list this server.');
        break;

      case 'udp_error':
        this.emit('udpError', msg.message || 'Bedrock forwarding is unavailable.');
        this.emit('log', 'Relay: ' + (msg.message || 'Bedrock forwarding is unavailable.'));
        break;

      case 'udp': {
        if (!this.udpPort) break;
        let data;
        try { data = Buffer.from(msg.data, 'base64'); } catch { break; }
        if (!data.length || data.length > MAX_UDP_DATAGRAM) break;
        let s = this.udpSessions.get(msg.conn);
        if (!s) {
          if (this.udpSessions.size >= MAX_UDP_SESSIONS) break;
          s = this._openUdpSession(msg.conn);
        }
        this._touchUdpSession(msg.conn, s);
        s.sock.send(data, this.udpPort, '127.0.0.1');
        break;
      }

      case 'udp_close':
        this._closeUdpSession(msg.conn, false);
        break;

      case 'error':
        this.emit('error', msg.message || 'relay rejected the connection');
        this.emit('log', 'Relay error: ' + (msg.message || 'unknown'));
        break;

      case 'connect':
        if (this.players.has(msg.conn)) {
          // Duplicate connection id — never silently replace/leak the
          // existing socket for it (item 18).
          this.emit('log', `Ignored duplicate connect for an already-open connection.`);
          break;
        }
        if (this.players.size >= MAX_LOCAL_PLAYERS) {
          this.emit('log', `Rejected a new player — local connection cap (${MAX_LOCAL_PLAYERS}) reached.`);
          this._send({ type: 'close', conn: msg.conn });
          break;
        }
        this._openPlayer(msg.conn, msg.ip);
        break;

      case 'data': {
        const pc = this.players.get(msg.conn);
        if (!pc || pc.closed) break; // unknown/already-closed conn id creates no state
        let decoded;
        try {
          decoded = Buffer.from(msg.data, 'base64');
        } catch {
          break;
        }
        // Buffer.from(..., 'base64') never throws on malformed input, it
        // just decodes what it can — bound the *decoded* size too.
        if (decoded.length > MAX_WS_MESSAGE_BYTES) break;
        this._writeToPlayer(msg.conn, pc, decoded);
        break;
      }

      case 'close': {
        this._closePlayer(msg.conn, /* notifyRelay */ false);
        break;
      }

      case 'pong':
        if (this.lastPingSent) this.emit('ping', Date.now() - this.lastPingSent);
        break;
    }
  }

  _openPlayer(conn, ip) {
    const sock = new net.Socket();
    const pc = { sock, pendingBytes: 0, closed: false };
    this.players.set(conn, pc);
    this.emit('players', this.players.size);
    this.emit('log', `Player connected${ip ? ' from ' + ip : ''} → 127.0.0.1:${this.localPort}`);

    let connected = false;
    const connectTimer = setTimeout(() => {
      if (!connected) {
        sock.destroy(new Error(`Local server connect timeout after ${LOCAL_CONNECT_TIMEOUT_MS}ms`));
      }
    }, LOCAL_CONNECT_TIMEOUT_MS);

    sock.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
    });

    sock.connect(this.localPort, '127.0.0.1');

    sock.on('data', (buf) => this._onLocalData(conn, buf));

    const closeThisPlayer = () => {
      clearTimeout(connectTimer);
      this._closePlayer(conn, /* notifyRelay */ true);
    };
    sock.on('close', closeThisPlayer);
    sock.on('error', (err) => {
      if (!connected) {
        this.emit('log', `Could not reach a local server on 127.0.0.1:${this.localPort}: ${err.message}`);
      }
      closeThisPlayer();
    });
  }

  /** Local server -> relay, with bounded backpressure on the shared WebSocket (item 20). */
  _onLocalData(conn, buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this._send({ type: 'data', conn, data: buf.toString('base64') });

    if (this.ws.bufferedAmount > WS_BUFFERED_HIGH_WATERMARK) {
      const pc = this.players.get(conn);
      if (pc && !pc.sock.isPaused()) pc.sock.pause();
      this._armWsStallWatch();
    }
  }

  _armWsStallWatch() {
    if (this.wsStallTimer) return;
    const deadline = Date.now() + WS_STALL_TIMEOUT_MS;
    this.wsStallTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this._clearWsStallTimer();
        return;
      }
      if (this.ws.bufferedAmount <= WS_BUFFERED_LOW_WATERMARK) {
        for (const pc of this.players.values()) {
          if (pc.sock.isPaused()) pc.sock.resume();
        }
        this._clearWsStallTimer();
        return;
      }
      if (Date.now() > deadline) {
        // The shared control connection has been backed up for too long —
        // this reflects the tunnel's own network path, not any one player.
        // Bound the damage: drop everyone paused rather than buffer forever.
        this.emit('log', 'Relay connection is stalled — disconnecting paused players.');
        for (const [conn, pc] of this.players) {
          if (pc.sock.isPaused()) this._closePlayer(conn, true);
        }
        this._clearWsStallTimer();
      }
    }, 500);
  }

  _clearWsStallTimer() {
    if (this.wsStallTimer) clearInterval(this.wsStallTimer);
    this.wsStallTimer = null;
  }

  /** Relay -> local server, with a bounded per-player pending-write budget (item 20). */
  _writeToPlayer(conn, pc, chunk) {
    if (pc.pendingBytes + chunk.length > MAX_PLAYER_PENDING_WRITE_BYTES) {
      this.emit('log', 'A player\'s local connection could not keep up — disconnecting it.');
      this._closePlayer(conn, true);
      return;
    }
    pc.pendingBytes += chunk.length;
    pc.sock.write(chunk, () => {
      pc.pendingBytes -= chunk.length;
    });
  }

  _closePlayer(conn, notifyRelay) {
    const pc = this.players.get(conn);
    if (!pc || pc.closed) return;
    pc.closed = true;
    this.players.delete(conn);
    pc.sock.destroy();
    if (notifyRelay) this._send({ type: 'close', conn });
    this.emit('players', this.players.size);
  }

  _openUdpSession(conn) {
    const sock = dgram.createSocket('udp4');
    const s = { sock, idleTimer: null };
    this.udpSessions.set(conn, s);
    sock.on('message', (buf) => {
      if (buf.length > MAX_UDP_DATAGRAM) return;
      this._touchUdpSession(conn, s);
      this._send({ type: 'udp', conn, data: buf.toString('base64') });
    });
    sock.on('error', () => this._closeUdpSession(conn, true));
    return s;
  }

  _touchUdpSession(conn, s) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => this._closeUdpSession(conn, true), UDP_SESSION_IDLE_MS);
  }

  _closeUdpSession(conn, notifyRelay) {
    const s = this.udpSessions.get(conn);
    if (!s) return;
    this.udpSessions.delete(conn);
    clearTimeout(s.idleTimer);
    try { s.sock.close(); } catch { /* already closed */ }
    if (notifyRelay) this._send({ type: 'udp_close', conn });
  }

  _teardownUdp() {
    for (const conn of [...this.udpSessions.keys()]) this._closeUdpSession(conn, false);
  }

  /** Asks the relay for the custom address `name` (answered by 'name' or 'nameError'). */
  claimName(name) {
    this._send({ type: 'claim_name', name: String(name || '').trim().toLowerCase() });
  }

  releaseName() {
    this._send({ type: 'release_name' });
  }

  /** Publishes (or, with null, withdraws) this server's public-list entry. */
  setListing(listing) {
    this.listing = listing || null;
    if (this.running) this._send(listing ? { type: 'listing', listing } : { type: 'listing' });
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.lastPingSent = Date.now();
        this._send({ type: 'ping' });
      }
    }, 15000);
  }

  _stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  _teardownPlayers() {
    for (const pc of this.players.values()) {
      pc.closed = true;
      pc.sock.destroy();
    }
    this.players.clear();
    this.emit('players', 0);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  stop() {
    this.manualStop = true;
    this._stopPing();
    this._clearWsStallTimer();
    this._teardownPlayers();
    this._teardownUdp();
    this.running = false;
    // If we're mid-reconnect-backoff, this.ws is already closed and its
    // 'close' handler already ran (with manualStop still false at the
    // time) — it will never fire again, so ws.close() here would be a
    // silent no-op and 'stopped' would never be emitted, leaving a caller
    // waiting forever. Only rely on the 'close' handler when the socket is
    // actually still open/connecting; otherwise emit 'stopped' directly.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    } else {
      this.emit('status', 'stopped');
      this.emit('stopped');
    }
  }
}

module.exports = { Tunnel, isValidRelayMessage, MAX_LOCAL_PLAYERS };

'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

/**
 * Tunnel is a Node implementation of the VoxelPort host protocol — the same
 * contract the Fabric mod speaks (see relay/README.md). It opens a WebSocket to
 * the relay, registers with a device token, receives a public port, and bridges
 * each vanilla player connection to a local Minecraft server.
 *
 * Events: 'status' (state), 'assigned' (port), 'players' (count), 'ping' (ms),
 *         'log' (line), 'error' (message), 'stopped'.
 */
class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.players = new Map(); // connID -> net.Socket
    this.running = false;
    this.manualStop = false;
    this.pingTimer = null;
    this.lastPingSent = 0;
    this.reconnectDelay = 1000;
  }

  start({ relayUrl, token, localPort }) {
    this.relayUrl = relayUrl;
    this.token = token;
    this.localPort = localPort;
    this.manualStop = false;
    this._connect();
  }

  _connect() {
    this.emit('status', 'connecting');
    this.emit('log', `Connecting to ${this.relayUrl}…`);

    let ws;
    try {
      ws = new WebSocket(this.relayUrl.replace(/\/+$/, '') + '/ws', {
        handshakeTimeout: 15000,
      });
    } catch (err) {
      this.emit('error', 'Bad relay URL: ' + err.message);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.emit('log', 'Connected. Registering…');
      this._send({ type: 'register', token: this.token });
    });

    ws.on('message', (raw) => this._onMessage(raw));

    ws.on('close', () => {
      this._teardownPlayers();
      this._stopPing();
      if (this.manualStop) {
        this.running = false;
        this.emit('status', 'stopped');
        this.emit('stopped');
        return;
      }
      // Unexpected drop — retry with backoff while the user wants it running.
      this.running = false;
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

    switch (msg.type) {
      case 'port':
        this.running = true;
        this.reconnectDelay = 1000;
        this.emit('status', 'online');
        this.emit('assigned', msg.port);
        this.emit('log', `Tunnel is live on public port ${msg.port}.`);
        this._startPing();
        break;

      case 'error':
        this.emit('error', msg.message || 'relay rejected the connection');
        this.emit('log', 'Relay error: ' + (msg.message || 'unknown'));
        break;

      case 'connect':
        this._openPlayer(msg.conn, msg.ip);
        break;

      case 'data': {
        const sock = this.players.get(msg.conn);
        if (sock && msg.data) sock.write(Buffer.from(msg.data, 'base64'));
        break;
      }

      case 'close': {
        const sock = this.players.get(msg.conn);
        if (sock) sock.end();
        this.players.delete(msg.conn);
        this.emit('players', this.players.size);
        break;
      }

      case 'pong':
        if (this.lastPingSent) this.emit('ping', Date.now() - this.lastPingSent);
        break;
    }
  }

  _openPlayer(conn, ip) {
    const sock = net.connect(this.localPort, '127.0.0.1');
    this.players.set(conn, sock);
    this.emit('players', this.players.size);
    this.emit('log', `Player connected${ip ? ' from ' + ip : ''} → 127.0.0.1:${this.localPort}`);

    sock.on('data', (buf) => {
      this._send({ type: 'data', conn, data: buf.toString('base64') });
    });
    const closePlayer = () => {
      if (!this.players.has(conn)) return;
      this.players.delete(conn);
      this._send({ type: 'close', conn });
      this.emit('players', this.players.size);
    };
    sock.on('close', closePlayer);
    sock.on('error', () => {
      this.emit('log', `Could not reach a local server on 127.0.0.1:${this.localPort}. Is it running?`);
      closePlayer();
    });
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
    for (const sock of this.players.values()) sock.destroy();
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
    this._teardownPlayers();
    if (this.ws) this.ws.close();
    this.running = false;
  }
}

module.exports = { Tunnel };

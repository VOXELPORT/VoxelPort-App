'use strict';

// The player side of a join code. Given the host's code it:
//   1. asks the relay to introduce it to the host (joinSignaling.js) and learns the host's ordinary relay address,
//   2. tries to open a WebRTC connection to the host, exchanging setup messages through the relay,
//   3. listens on this PC (127.0.0.1 only) so Minecraft can connect to "localhost": through the direct connection if
//      it opened, otherwise (after a timeout, or if it later fails) straight to the host's relay address.
// The player's Minecraft never needs to know which path is in use.

const net = require('net');
const { EventEmitter } = require('events');
const { JoinSignaling } = require('./joinSignaling');
const { PipeSet } = require('./p2pBridge');

const PEER = 'join'; // this side has one peer: the host
const P2P_TIMEOUT_MS = 12000;
const CHANNEL_OPEN_TIMEOUT_MS = 8000;
const PREFERRED_PORT = 25565;

/**
 * Status: { state, path, port, reason, message }
 *   state:  idle | signaling | connecting | p2p | relay | failed | stopped
 *   path:   '' | 'lan' | 'direct' | 'relay'
 *   reason: why the relay is used instead of a direct connection: timeout | failed | lost | stalled (the screen words it)
 *   message: the relay's own words when joining failed (a wrong code, the host is offline…)
 * Events: 'status' (the status), 'log' (line).
 */
class P2PJoin extends EventEmitter {
  constructor({
    worker, signaling = new JoinSignaling(), createServer = net.createServer, connect = net.connect,
    p2pTimeoutMs = P2P_TIMEOUT_MS, channelOpenTimeoutMs = CHANNEL_OPEN_TIMEOUT_MS, preferredPort = PREFERRED_PORT,
  }) {
    super();
    this.worker = worker;
    this.signaling = signaling;
    this.createServer = createServer;
    this.connect = connect;
    this.p2pTimeoutMs = p2pTimeoutMs;
    this.channelOpenTimeoutMs = channelOpenTimeoutMs;
    this.preferredPort = preferredPort;
    this.pipes = new PipeSet(worker);
    this.status = { state: 'idle', path: '', port: 0, reason: '', message: '' };
    this.fallback = null; // { address, port }: the host's ordinary relay address
    this.server = null;
    this.nextConn = 1;
    this.p2pTimer = null;
    this.viaP2P = false; // new connections go through the data channels (otherwise through the relay)
    this.onWorker = (evt) => this._onWorker(evt);
    this.relayPipes = new Set();
    this.openTimers = new Map(); // conn -> timer: a connection waiting for its channel to open
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  /** Joins the host with this code through this relay. Resolves when it has either failed or started listening. */
  start({ relayUrl, code, client }) {
    if (this.status.state !== 'idle' && this.status.state !== 'stopped' && this.status.state !== 'failed') return;
    this._cleanup();
    this._set({ state: 'signaling', path: '', port: 0, reason: '', message: '' });
    const s = this.signaling;
    s.on('joined', (j) => this._onJoined(j));
    s.on('signal', (signal) => this.worker.send({ op: 'signal', peer: PEER, signal }));
    s.on('error', (message) => this._failed(message));
    s.on('closed', () => { /* the introduction is over; the connection carries on without it */ });
    this.worker.on('event', this.onWorker);
    s.start({ relayUrl, code, client });
  }

  _onJoined({ address, port }) {
    this.fallback = { address, port };
    this._set({ state: 'connecting' });
    this.worker.send({ op: 'peer-new', peer: PEER, role: 'join' });
    this.p2pTimer = setTimeout(() => this._useRelay('timeout'), this.p2pTimeoutMs);
    if (this.p2pTimer.unref) this.p2pTimer.unref();
  }

  _onWorker(evt) {
    if (evt.peer !== PEER) return;
    if (evt.evt === 'signal') { this.signaling.sendSignal(evt.signal); return; }
    if (evt.evt === 'state') {
      if (evt.state === 'connected' && this.status.state === 'connecting') {
        clearTimeout(this.p2pTimer);
        this.viaP2P = true;
        this.signaling.leave(); // the relay has done its part
        this._set({ state: 'p2p', path: evt.path === 'lan' ? 'lan' : 'direct', reason: '', message: '' });
        this._listen();
      } else if (evt.state === 'failed' || evt.state === 'closed') {
        if (this.status.state === 'connecting') this._useRelay('failed');
        else if (this.status.state === 'p2p') this._useRelay('lost');
      }
      return;
    }
    // Channel events: a connection that was waiting for its channel.
    if (this.pipes.handle(evt)) {
      if (evt.evt === 'open') clearTimeout(this.openTimers.get(evt.conn));
    }
  }

  /** Gives up on the direct route: everything new goes to the host's relay address. */
  _useRelay(reason) {
    if (this.status.state === 'relay' || this.status.state === 'failed' || this.status.state === 'stopped') return;
    clearTimeout(this.p2pTimer);
    this.viaP2P = false;
    this.worker.send({ op: 'peer-close', peer: PEER });
    this.pipes.closeAll();
    this.signaling.leave();
    this.emit('log', `No direct connection (${reason}). Using the relay instead.`);
    this._set({ state: 'relay', path: 'relay', reason, message: '' });
    this._listen();
  }

  _failed(message) {
    if (this.status.state === 'stopped') return;
    clearTimeout(this.p2pTimer);
    this._set({ state: 'failed', path: '', port: 0, reason: '', message: message || 'Could not join.' });
    this._cleanup();
  }

  _listen() {
    if (this.server) return;
    const server = this.createServer((socket) => this._onLocalConnection(socket));
    this.server = server;
    const tryListen = (port) => {
      server.once('error', (err) => {
        if (port !== 0 && err.code === 'EADDRINUSE') tryListen(0); // the usual port is taken: any free one
        else this._failed('Could not open a local port for Minecraft.');
      });
      server.listen(port, '127.0.0.1', () => {
        this._set({ port: server.address().port });
      });
    };
    tryListen(this.preferredPort);
  }

  _onLocalConnection(socket) {
    if (this.viaP2P) {
      const conn = String(this.nextConn++);
      const pipe = this.pipes.add(PEER, conn, socket);
      this.worker.send({ op: 'open', peer: PEER, conn });
      this.openTimers.set(conn, setTimeout(() => {
        if (!pipe.open) {
          pipe.close();
          this._useRelay('stalled');
        }
      }, this.channelOpenTimeoutMs));
      if (this.openTimers.get(conn).unref) this.openTimers.get(conn).unref();
    } else if (this.fallback) {
      const upstream = this.connect({ host: this.fallback.address, port: this.fallback.port });
      this.relayPipes.add(socket); this.relayPipes.add(upstream);
      const done = () => { socket.destroy(); upstream.destroy(); this.relayPipes.delete(socket); this.relayPipes.delete(upstream); };
      socket.pipe(upstream); upstream.pipe(socket);
      socket.on('close', done); upstream.on('close', done);
      socket.on('error', done); upstream.on('error', done);
    } else {
      socket.destroy();
    }
  }

  /** Stops listening and closes everything. */
  stop() {
    if (this.status.state === 'stopped') return;
    this._set({ state: 'stopped', path: '', port: 0, reason: '', message: '' });
    this._cleanup();
  }

  _cleanup() {
    clearTimeout(this.p2pTimer);
    for (const t of this.openTimers.values()) clearTimeout(t);
    this.openTimers = new Map();
    this.worker.off('event', this.onWorker);
    this.worker.send({ op: 'peer-close', peer: PEER });
    this.pipes.closeAll();
    for (const s of this.relayPipes) { try { s.destroy(); } catch { /* closed */ } }
    this.relayPipes.clear();
    this.signaling.removeAllListeners();
    this.signaling.close();
    if (this.server) { try { this.server.close(); } catch { /* not listening */ } }
    this.server = null;
    this.viaP2P = false;
    this.fallback = null;
  }
}

module.exports = { P2PJoin, PEER };

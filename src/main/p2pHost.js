'use strict';

// The host side of join codes. When the relay says a player with the host's code is waiting (tunnel 'peer'), this
// opens a WebRTC connection to that player (through the relay's message passing) and, for every channel the player
// opens, connects a socket to the LOCAL Minecraft server and joins the two. Nothing the player sends can choose where
// it goes: the only place a channel can lead is 127.0.0.1 on the server's own port.

const net = require('net');
const { EventEmitter } = require('events');
const { PipeSet } = require('./p2pBridge');

const MAX_PEERS = 16;
const MAX_CHANNELS_PER_PEER = 24;
const CONNECT_TIMEOUT_MS = 45000; // a player that hasn't connected by now is dropped
const CONN_ID = /^[0-9]{1,9}$/;

class P2PHost extends EventEmitter {
  /**
   * @param {object} o
   * @param {EventEmitter & {send: (cmd: object) => void}} o.worker the WebRTC worker (p2pWorker.js)
   * @param {() => number} o.getLocalPort the Minecraft server's own port
   * @param {Function} [o.connect] net.connect, replaceable in tests
   * @param {number} [o.connectTimeoutMs]
   */
  constructor({ worker, getLocalPort, connect = net.connect, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
    super();
    this.worker = worker;
    this.getLocalPort = getLocalPort;
    this.connect = connect;
    this.connectTimeoutMs = connectTimeoutMs;
    this.pipes = new PipeSet(worker);
    this.peers = new Map(); // peer -> { state, timer, client }
    this.tunnel = null;
    this.handlers = null;
    this.onWorker = (evt) => this._onWorker(evt);
  }

  /** Starts listening to the tunnel's join-code events. */
  attach(tunnel) {
    if (this.tunnel === tunnel && this.handlers) return; // already listening (a tunnel reconnect must not drop the players)
    this.detach();
    this.tunnel = tunnel;
    this.handlers = {
      peer: (p) => this._onPeer(p),
      peerSignal: (p) => { if (this.peers.has(p.peer)) this.worker.send({ op: 'signal', peer: p.peer, signal: p.signal }); },
      peerGone: (peer) => this._onPeerGone(peer),
    };
    for (const [event, fn] of Object.entries(this.handlers)) tunnel.on(event, fn);
    this.worker.on('event', this.onWorker);
  }

  /** Drops every player and stops listening. */
  detach() {
    if (this.tunnel && this.handlers) for (const [event, fn] of Object.entries(this.handlers)) this.tunnel.off(event, fn);
    this.worker.off('event', this.onWorker);
    this.handlers = null;
    for (const peer of [...this.peers.keys()]) this._drop(peer, { tellRelay: Boolean(this.tunnel) });
    this.pipes.closeAll();
    this.tunnel = null;
    this._changed();
  }

  /** How many players are playing through peer-to-peer connections right now. */
  get players() { return this.pipes.count(); }

  /** How many players are connected peer-to-peer (whether or not they have a game open). */
  get connectedPeers() { let n = 0; for (const p of this.peers.values()) if (p.state === 'connected') n++; return n; }

  _changed() { this.emit('changed', { players: this.players, peers: this.connectedPeers }); }

  _onPeer({ peer, client }) {
    if (this.peers.has(peer)) return;
    if (this.peers.size >= MAX_PEERS) { if (this.tunnel) this.tunnel.closePeer(peer); return; }
    const timer = setTimeout(() => this._drop(peer, { tellRelay: true }), this.connectTimeoutMs);
    if (timer.unref) timer.unref();
    this.peers.set(peer, { state: 'signaling', timer, client });
    this.worker.send({ op: 'peer-new', peer, role: 'host' });
    this.emit('log', `A player is connecting (${client || 'unknown app'}).`);
  }

  _onPeerGone(peer) {
    // The relay's introduction is over. A player that already connected stays connected: only one that never did is dropped.
    const p = this.peers.get(peer);
    if (p && p.state !== 'connected') this._drop(peer, { tellRelay: false });
  }

  _drop(peer, { tellRelay }) {
    const p = this.peers.get(peer);
    if (!p) return;
    clearTimeout(p.timer);
    this.peers.delete(peer);
    this.pipes.closePeer(peer);
    this.worker.send({ op: 'peer-close', peer });
    if (tellRelay && this.tunnel && p.state !== 'connected') this.tunnel.closePeer(peer);
    this._changed();
  }

  _onWorker(evt) {
    if (this.pipes.handle(evt)) { if (evt.evt === 'end') this._changed(); return; }
    const p = this.peers.get(evt.peer);
    if (!p) return;
    switch (evt.evt) {
      case 'signal':
        if (this.tunnel) this.tunnel.sendPeerSignal(evt.peer, evt.signal);
        break;
      case 'state':
        if (evt.state === 'connected') {
          p.state = 'connected';
          clearTimeout(p.timer);
          this.emit('log', `A player connected ${evt.path === 'lan' ? 'on your network' : 'directly'}.`);
          this._changed();
        } else if (evt.state === 'failed' || evt.state === 'closed') {
          this._drop(evt.peer, { tellRelay: true });
        }
        break;
      case 'open':
        this._onChannel(evt.peer, evt.conn);
        break;
      default:
        break;
    }
  }

  _onChannel(peer, conn) {
    const p = this.peers.get(peer);
    if (!p || p.state !== 'connected' || !CONN_ID.test(String(conn))) { this.worker.send({ op: 'end', peer, conn }); return; }
    if (this.pipes.count(peer) >= MAX_CHANNELS_PER_PEER) { this.worker.send({ op: 'end', peer, conn }); return; }
    const socket = this.connect({ host: '127.0.0.1', port: this.getLocalPort() });
    const pipe = this.pipes.add(peer, conn, socket, () => this._changed());
    pipe.opened();
    this._changed();
  }
}

module.exports = { P2PHost, MAX_PEERS, MAX_CHANNELS_PER_PEER };

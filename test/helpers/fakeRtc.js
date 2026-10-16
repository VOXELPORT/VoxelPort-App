'use strict';

// Stand-ins for the two things join codes depend on, so the logic around them can be tested without a browser:
//   FakeRtcNetwork: pretend WebRTC workers (same commands and events as src/renderer/p2p-worker.js). Two workers that
//                   exchange an offer and an answer become linked, and channel data then flows between them in memory.
//   FakeRelay:      pretend relay: the host's tunnel (peer / peerSignal events in, sendPeerSignal / closePeer out) and
//                   a player's JoinSignaling, wired to each other.

const { EventEmitter } = require('events');

class FakeWorker extends EventEmitter {
  constructor(net, name) {
    super();
    this.net = net;
    this.name = name;
    this.peers = new Map(); // peer -> { role, link: { other: FakeWorker, otherPeer } | null, linkId }
    this.sent = []; // every command received, for assertions
  }

  _emit(evt) { setImmediate(() => this.emit('event', evt)); }

  send(cmd) {
    this.sent.push(cmd);
    const p = this.peers.get(cmd.peer);
    switch (cmd.op) {
      case 'peer-new': {
        const linkId = `${this.name}-${cmd.peer}-${Math.random().toString(36).slice(2)}`;
        this.peers.set(cmd.peer, { role: cmd.role, link: null, linkId });
        this._emit({ evt: 'state', peer: cmd.peer, state: 'connecting' });
        if (cmd.role === 'join') {
          this.net.joiners.set(linkId, { worker: this, peer: cmd.peer });
          this._emit({ evt: 'signal', peer: cmd.peer, signal: JSON.stringify({ description: { type: 'offer', sdp: `fake:${linkId}` } }) });
        }
        break;
      }
      case 'signal': {
        if (!p) break;
        let m; try { m = JSON.parse(cmd.signal); } catch { break; }
        if (m.description && m.description.type === 'offer' && p.role === 'host') {
          const linkId = String(m.description.sdp).replace(/^fake:/, '');
          const joiner = this.net.joiners.get(linkId);
          if (this.net.mode === 'fail') {
            this._emit({ evt: 'state', peer: cmd.peer, state: 'failed' });
            if (joiner) joiner.worker._emit({ evt: 'state', peer: joiner.peer, state: 'failed' });
            break;
          }
          if (!joiner) break;
          this._emit({ evt: 'signal', peer: cmd.peer, signal: JSON.stringify({ description: { type: 'answer', sdp: `fake:${linkId}` } }) });
          if (this.net.mode !== 'silent') {
            p.link = { other: joiner.worker, otherPeer: joiner.peer };
            const jp = joiner.worker.peers.get(joiner.peer);
            if (jp) jp.link = { other: this, otherPeer: cmd.peer };
            this._emit({ evt: 'state', peer: cmd.peer, state: 'connected', path: this.net.path });
          }
        } else if (m.description && m.description.type === 'answer' && p.role === 'join') {
          if (this.net.mode === 'fail') { this._emit({ evt: 'state', peer: cmd.peer, state: 'failed' }); break; }
          if (this.net.mode !== 'silent') this._emit({ evt: 'state', peer: cmd.peer, state: 'connected', path: this.net.path });
        }
        break;
      }
      case 'open': {
        if (!p || !p.link) break;
        const { other, otherPeer } = p.link;
        this._emit({ evt: 'open', peer: cmd.peer, conn: cmd.conn });
        other._emit({ evt: 'open', peer: otherPeer, conn: cmd.conn });
        break;
      }
      case 'data': {
        if (!p || !p.link) break;
        const { other, otherPeer } = p.link;
        other._emit({ evt: 'data', peer: otherPeer, conn: cmd.conn, bytes: new Uint8Array(cmd.bytes) });
        break;
      }
      case 'end': {
        if (!p || !p.link) break;
        const { other, otherPeer } = p.link;
        other._emit({ evt: 'end', peer: otherPeer, conn: cmd.conn });
        break;
      }
      case 'peer-close': {
        if (!p) break;
        this.peers.delete(cmd.peer);
        if (p.link) {
          const { other, otherPeer } = p.link;
          const op = other.peers.get(otherPeer);
          if (op) { op.link = null; other._emit({ evt: 'state', peer: otherPeer, state: 'closed' }); }
        }
        break;
      }
      default: break;
    }
  }

  /** Cuts the connection as if the network between the two PCs went away. */
  dropLinks() {
    for (const [peer, p] of this.peers) {
      if (!p.link) continue;
      const { other, otherPeer } = p.link;
      p.link = null;
      const op = other.peers.get(otherPeer);
      if (op) op.link = null;
      this._emit({ evt: 'state', peer, state: 'failed' });
      other._emit({ evt: 'state', peer: otherPeer, state: 'failed' });
    }
  }
}

class FakeRtcNetwork {
  constructor() {
    this.joiners = new Map();
    this.mode = 'ok'; // ok | fail (the setup fails) | silent (it never connects)
    this.path = 'direct';
  }
  worker(name) { return new FakeWorker(this, name); }
}

/** A tunnel stand-in for the host: events in, the two methods the host calls out. */
class FakeTunnel extends EventEmitter {
  constructor(relay) { super(); this.relay = relay; this.closed = []; this.signalsSent = []; }
  sendPeerSignal(peer, signal) { this.signalsSent.push({ peer, signal }); this.relay._toPlayer(peer, signal); }
  closePeer(peer) { this.closed.push(peer); }
}

/** A JoinSignaling stand-in for a player. */
class FakeSignaling extends EventEmitter {
  constructor(relay) { super(); this.relay = relay; this.left = false; this.signals = []; }
  start({ code, client }) {
    this.code = code;
    this.client = client;
    setImmediate(() => this.relay._join(this));
  }
  sendSignal(signal) { this.signals.push(signal); this.relay._toHost(this.peer, signal); }
  leave() { this.left = true; this.close(); }
  close() { this.relay._leave(this); }
}

class FakeRelay {
  constructor({ code = 'K7M2Q-9XH4T', fallback = { address: '127.0.0.1', port: 1 } } = {}) {
    this.code = code;
    this.fallback = fallback;
    this.tunnel = new FakeTunnel(this);
    this.players = new Map(); // peer -> FakeSignaling
    this.next = 1;
    this.hostOnline = true;
  }
  signaling() { return new FakeSignaling(this); }
  _join(s) {
    const norm = (x) => String(x).toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (!this.hostOnline || norm(s.code) !== norm(this.code)) { s.emit('error', "That code isn't active."); return; }
    const peer = (this.next++).toString(16).padStart(8, '0');
    s.peer = peer;
    this.players.set(peer, s);
    s.emit('joined', { peer, address: this.fallback.address, port: this.fallback.port });
    this.tunnel.emit('peer', { peer, client: s.client || '' });
  }
  _toHost(peer, signal) { setImmediate(() => this.tunnel.emit('peerSignal', { peer, signal })); }
  _toPlayer(peer, signal) { const s = this.players.get(peer); if (s) setImmediate(() => s.emit('signal', signal)); }
  _leave(s) { if (s.peer && this.players.delete(s.peer)) setImmediate(() => this.tunnel.emit('peerGone', s.peer)); }
}

module.exports = { FakeRtcNetwork, FakeRelay, FakeWorker, FakeTunnel, FakeSignaling };

'use strict';

// Joins a TCP socket to a WebRTC data channel (which lives in the hidden worker window, see p2pWorker.js). Both the
// host (a player's channel <-> the local Minecraft server) and the player (the local Minecraft client <-> the host's
// channel) use it. The socket's data goes out as 'data' commands; the worker's 'data' events are written to the socket.

const MAX_QUEUED_BYTES = 4 * 1024 * 1024; // what a socket may send before its channel is open

class Pipe {
  constructor(worker, peer, conn, socket, onClose) {
    this.worker = worker;
    this.peer = peer;
    this.conn = String(conn);
    this.socket = socket;
    this.onClose = onClose;
    this.open = false;
    this.queue = [];
    this.queued = 0;
    this.closed = false;
    this.bytesIn = 0; // channel -> socket
    this.bytesOut = 0; // socket -> channel
    socket.setNoDelay?.(true);
    socket.on('data', (buf) => this._fromSocket(buf));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }

  _fromSocket(buf) {
    if (this.closed) return;
    if (!this.open) {
      this.queue.push(buf);
      this.queued += buf.length;
      if (this.queued > MAX_QUEUED_BYTES) this.close();
      return;
    }
    this.bytesOut += buf.length;
    this.worker.send({ op: 'data', peer: this.peer, conn: this.conn, bytes: new Uint8Array(buf) });
  }

  opened() {
    if (this.closed || this.open) return;
    this.open = true;
    for (const b of this.queue) {
      this.bytesOut += b.length;
      this.worker.send({ op: 'data', peer: this.peer, conn: this.conn, bytes: new Uint8Array(b) });
    }
    this.queue = [];
    this.queued = 0;
  }

  fromChannel(bytes) {
    if (this.closed) return;
    const buf = Buffer.from(bytes.buffer ? bytes : new Uint8Array(bytes));
    this.bytesIn += buf.length;
    this.socket.write(buf);
  }

  setPaused(paused) {
    if (this.closed) return;
    if (paused) this.socket.pause(); else this.socket.resume();
  }

  /** Closes both ends (once). notifyChannel is false when the channel is what closed. */
  close(notifyChannel = true) {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    try { this.socket.destroy(); } catch { /* already closed */ }
    if (notifyChannel) this.worker.send({ op: 'end', peer: this.peer, conn: this.conn });
    if (this.onClose) this.onClose(this);
  }
}

class PipeSet {
  constructor(worker) {
    this.worker = worker;
    this.pipes = new Map(); // `${peer}:${conn}` -> Pipe
  }

  key(peer, conn) { return `${peer}:${conn}`; }

  add(peer, conn, socket, onClose) {
    const pipe = new Pipe(this.worker, peer, conn, socket, (p) => {
      this.pipes.delete(this.key(p.peer, p.conn));
      if (onClose) onClose(p);
    });
    this.pipes.set(this.key(peer, conn), pipe);
    return pipe;
  }

  get(peer, conn) { return this.pipes.get(this.key(peer, conn)); }

  /** Handles a worker event about a channel. Returns true if it belonged to a pipe here. */
  handle(evt) {
    const pipe = this.get(evt.peer, evt.conn);
    if (!pipe) return false;
    switch (evt.evt) {
      case 'open': pipe.opened(); break;
      case 'data': pipe.fromChannel(evt.bytes); break;
      case 'flow': pipe.setPaused(Boolean(evt.paused)); break;
      case 'end': pipe.close(false); break;
      default: return false;
    }
    return true;
  }

  count(peer) {
    if (peer === undefined) return this.pipes.size;
    let n = 0;
    for (const p of this.pipes.values()) if (p.peer === peer) n++;
    return n;
  }

  closePeer(peer) {
    for (const p of [...this.pipes.values()]) if (p.peer === peer) p.close();
  }

  closeAll() {
    for (const p of [...this.pipes.values()]) p.close();
  }
}

module.exports = { PipeSet, Pipe, MAX_QUEUED_BYTES };

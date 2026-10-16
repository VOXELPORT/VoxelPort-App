'use strict';

// Direct mode for the server that is public right now. It joins the pieces:
//   1. the router: forward a port to this PC (upnp.js),
//   2. the relay: ask it to check from the internet that the port reaches this server, and to send players
//      straight to it (tunnel.js setDirect),
//   3. the state the screen shows.
// When it is turned off, or the tunnel stops, the router's port is closed again.
//
// States: off | working | on | fallback | failed | unsupported. `code` says why, in a form the screen turns into
// words (it can be translated): opening, checking, ok, no-router, cgnat, port-busy, refused, relay, timeout,
// lost, fallback. `detail` carries the relay's own message for code "relay".

const { EventEmitter } = require('events');
const { PortMapper } = require('./upnp');

const REPLY_TIMEOUT_MS = 25000;

const OFF = Object.freeze({ state: 'off', code: '', detail: '', ip: '', port: 0, address: '' });

class DirectMode extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {() => PortMapper} [o.createMapper]
   * @param {(line: string) => void} [o.log]
   * @param {number} [o.replyTimeoutMs]
   */
  constructor({ createMapper = () => new PortMapper({ log: () => {} }), log = () => {}, replyTimeoutMs = REPLY_TIMEOUT_MS } = {}) {
    super();
    this.createMapper = createMapper;
    this.log = log;
    this.replyTimeoutMs = replyTimeoutMs;
    this.status = OFF;
    this.mapper = null;
    this.tunnel = null;
    this.listeners = null;
    this.generation = 0; // bumped by every start and stop, so a slow earlier start can tell it was overtaken
    this.running = null; // the start in progress
  }

  _set(next) {
    this.status = { ...OFF, ...next };
    this.emit('status', this.status);
  }

  /**
   * Turns Direct mode on for the tunnel (which must be online). Resolves with the final status: on, failed or
   * unsupported. Calling it again while it is working returns the same attempt.
   */
  start(tunnel, { localPort }) {
    if (this.running) return this.running;
    this.running = this._start(tunnel, localPort).finally(() => { this.running = null; });
    return this.running;
  }

  async _start(tunnel, localPort) {
    const gen = ++this.generation;
    const overtaken = () => gen !== this.generation;
    this.tunnel = tunnel;
    this._set({ state: 'working', code: 'opening' });

    const mapper = this.createMapper();
    this.mapper = mapper;
    mapper.onLost = (err) => {
      if (overtaken()) return;
      this.log(`Direct mode: the router stopped forwarding the port (${err.message}).`);
      this._set({ state: 'failed', code: 'lost' });
      if (this.tunnel) this.tunnel.setDirect(null);
    };

    let opened;
    try {
      opened = await mapper.open({ internalPort: localPort, preferredExternalPort: localPort });
    } catch (err) {
      await mapper.close();
      if (overtaken()) return this.status;
      if (this.mapper === mapper) this.mapper = null;
      const code = err && err.code;
      this.log(`Direct mode: ${err && err.message}`);
      this._set(code === 'cgnat'
        ? { state: 'unsupported', code: 'cgnat' }
        : { state: 'failed', code: code === 'conflict' ? 'port-busy' : code === 'refused' ? 'refused' : 'no-router' });
      return this.status;
    }
    if (overtaken()) { await mapper.close(); return this.status; }

    this._set({ state: 'working', code: 'checking' });
    const outcome = await this._askRelay(tunnel, opened.externalPort, gen);
    if (overtaken()) return this.status;

    if (outcome.ok) {
      this._set({ state: 'on', code: 'ok', ip: outcome.ip, port: outcome.port, address: outcome.address });
      return this.status;
    }
    // It did not work: leave nothing open on the router, and stop asking the relay.
    this._detach();
    tunnel.setDirect(null);
    await mapper.close();
    if (this.mapper === mapper) this.mapper = null;
    this._set({ state: 'failed', code: outcome.code, detail: outcome.detail || '' });
    return this.status;
  }

  /** Sends the port to the relay and waits for its verdict; afterwards keeps following what the relay says. */
  _askRelay(tunnel, externalPort, gen) {
    return new Promise((resolve) => {
      let settled = false;
      let lastError = '';
      const settle = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => settle({ ok: false, code: 'timeout' }), this.replyTimeoutMs);

      const onDirect = (d) => {
        if (gen !== this.generation) return;
        if (d.port > 0) {
          if (!settled) { settle({ ok: true, ip: d.ip, port: d.port, address: d.address }); return; }
          this._set({ state: 'on', code: 'ok', ip: d.ip, port: d.port, address: d.address }); // direct resumed by itself
        } else if (settled && this.status.state === 'on') {
          // The relay found this PC unreachable and sent players back to it; it switches back by itself.
          this._set({ state: 'fallback', code: 'fallback', detail: lastError });
        }
      };
      const onError = (message) => {
        if (gen !== this.generation) return;
        lastError = message;
        if (!settled) settle({ ok: false, code: 'relay', detail: message });
      };
      this._detach();
      this.listeners = { tunnel, onDirect, onError };
      tunnel.on('direct', onDirect);
      tunnel.on('directError', onError);
      tunnel.setDirect(externalPort);
    });
  }

  _detach() {
    if (!this.listeners) return;
    const { tunnel, onDirect, onError } = this.listeners;
    tunnel.off('direct', onDirect);
    tunnel.off('directError', onError);
    this.listeners = null;
  }

  /** Turns Direct mode off: players use the relay again, and the router's port is closed. Safe to call any time. */
  async stop({ tunnelAlive = true } = {}) {
    this.generation++;
    this._detach();
    const mapper = this.mapper;
    const tunnel = this.tunnel;
    this.mapper = null;
    this.tunnel = null;
    if (tunnel && tunnelAlive) tunnel.setDirect(null);
    if (mapper) await mapper.close();
    if (this.status.state !== 'off') this._set({ state: 'off' });
  }
}

/**
 * What to do about Direct mode right now: 'start', 'stop' or 'keep'.
 * It only runs for a public server on VoxelPort's own relay, once the tunnel is online and the host turned it on.
 * An attempt that is already working (or on, or waiting to resume) is kept, so a tunnel reconnect doesn't redo it
 * (the tunnel asks the relay again by itself). A failed or unsupported one is not retried automatically.
 */
function directAction({ enabled, online, official, state }) {
  const active = state === 'working' || state === 'on' || state === 'fallback';
  if (!enabled || !online || !official) return active || state === 'failed' || state === 'unsupported' ? 'stop' : 'keep';
  return active ? 'keep' : (state === 'failed' || state === 'unsupported') ? 'keep' : 'start';
}

module.exports = { DirectMode, OFF, REPLY_TIMEOUT_MS, directAction };

'use strict';

// The WebRTC side of join codes. It runs in a hidden window (Electron's main process has no WebRTC), owns every
// RTCPeerConnection and data channel, and does nothing but move bytes: the main process (p2pHost.js, p2pJoin.js)
// owns the TCP sockets and decides what to connect to. Commands come in and events go out through the preload
// bridge (p2p-worker-preload.js); see the list below.
//
//   commands: peer-new {peer, role: 'host'|'join'}  signal {peer, signal}  open {peer, conn}  data {peer, conn, bytes}
//             end {peer, conn}  peer-close {peer}
//   events:   signal {peer, signal}  state {peer, state: connecting|connected|failed|closed, path?}  open {peer, conn}
//             data {peer, conn, bytes}  end {peer, conn}  flow {peer, conn, paused}
//
// One connection per player; each Minecraft TCP connection is one reliable, ordered data channel labelled "mc:<conn>".
// A channel labelled "ctl" is opened first by the joining side: when it is open, the two PCs are connected.

(function () {
  const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
  const CHUNK = 16 * 1024; // the size every browser accepts in one message
  const HIGH_WATER = 1024 * 1024; // pause the sender above this much queued data…
  const LOW_WATER = 256 * 1024; // …and resume below this
  const CONN_ID = /^[0-9]{1,9}$/;

  const bridge = window.p2pBridge;
  const peers = new Map(); // peer -> { pc, role, channels: Map(conn -> channel), pendingCandidates, remoteSet, reported }

  const emit = (evt) => bridge.emit(evt);

  function report(peer, state, extra) {
    const p = peers.get(peer);
    if (!p || p.reported === state) return;
    p.reported = state;
    emit({ evt: 'state', peer, state, ...(extra || {}) });
  }

  /** Where the connection goes: "lan" (same network) or "direct" (through the internet, past both routers). */
  async function pathOf(pc) {
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
      if (!pair) return 'direct';
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      if (local && remote && local.candidateType === 'host' && remote.candidateType === 'host') return 'lan';
    } catch { /* fall through */ }
    return 'direct';
  }

  function adoptChannel(peer, ch) {
    const p = peers.get(peer);
    if (!p) return;
    if (ch.label === 'ctl') {
      ch.onopen = async () => report(peer, 'connected', { path: await pathOf(p.pc) });
      ch.onclose = () => report(peer, 'closed');
      if (ch.readyState === 'open') ch.onopen();
      return;
    }
    const m = /^mc:([0-9]{1,9})$/.exec(ch.label);
    if (!m || !CONN_ID.test(m[1])) { ch.close(); return; }
    const conn = m[1];
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = LOW_WATER;
    p.channels.set(conn, ch);
    ch.onopen = () => emit({ evt: 'open', peer, conn });
    ch.onmessage = (e) => { if (e.data instanceof ArrayBuffer) emit({ evt: 'data', peer, conn, bytes: new Uint8Array(e.data) }); };
    ch.onbufferedamountlow = () => emit({ evt: 'flow', peer, conn, paused: false });
    ch.onclose = () => { p.channels.delete(conn); emit({ evt: 'end', peer, conn }); };
    ch.onerror = () => { /* followed by close */ };
    if (ch.readyState === 'open') ch.onopen();
  }

  function newPeer(peer, role) {
    closePeer(peer);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const p = { pc, role, channels: new Map(), pendingCandidates: [], remoteSet: false, reported: '' };
    peers.set(peer, p);
    pc.onicecandidate = (e) => {
      if (e.candidate) emit({ evt: 'signal', peer, signal: JSON.stringify({ candidate: e.candidate.toJSON() }) });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') report(peer, 'failed');
      else if (pc.connectionState === 'closed') report(peer, 'closed');
    };
    pc.ondatachannel = (e) => adoptChannel(peer, e.channel);
    report(peer, 'connecting');
    if (role === 'join') {
      adoptChannel(peer, pc.createDataChannel('ctl'));
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => emit({ evt: 'signal', peer, signal: JSON.stringify({ description: pc.localDescription.toJSON() }) }))
        .catch(() => report(peer, 'failed'));
    }
  }

  async function onSignal(peer, raw) {
    const p = peers.get(peer);
    if (!p) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.description && typeof msg.description.sdp === 'string' && (msg.description.type === 'offer' || msg.description.type === 'answer')) {
        await p.pc.setRemoteDescription({ type: msg.description.type, sdp: msg.description.sdp });
        p.remoteSet = true;
        for (const c of p.pendingCandidates.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
        if (msg.description.type === 'offer' && p.role === 'host') {
          await p.pc.setLocalDescription(await p.pc.createAnswer());
          emit({ evt: 'signal', peer, signal: JSON.stringify({ description: p.pc.localDescription.toJSON() }) });
        }
      } else if (msg.candidate && typeof msg.candidate.candidate === 'string') {
        if (p.remoteSet) await p.pc.addIceCandidate(msg.candidate).catch(() => {});
        else p.pendingCandidates.push(msg.candidate);
      }
    } catch {
      report(peer, 'failed');
    }
  }

  function send(peer, conn, bytes) {
    const p = peers.get(peer);
    const ch = p && p.channels.get(String(conn));
    if (!ch || ch.readyState !== 'open') return;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < data.length; i += CHUNK) ch.send(data.subarray(i, i + CHUNK));
    if (ch.bufferedAmount > HIGH_WATER) emit({ evt: 'flow', peer, conn: String(conn), paused: true });
  }

  function closePeer(peer) {
    const p = peers.get(peer);
    if (!p) return;
    peers.delete(peer);
    for (const ch of p.channels.values()) { ch.onclose = null; try { ch.close(); } catch { /* already closed */ } }
    p.pc.onconnectionstatechange = null;
    try { p.pc.close(); } catch { /* already closed */ }
  }

  bridge.onCommand((cmd) => {
    if (!cmd || typeof cmd.op !== 'string') return;
    switch (cmd.op) {
      case 'peer-new': newPeer(cmd.peer, cmd.role === 'join' ? 'join' : 'host'); break;
      case 'signal': onSignal(cmd.peer, cmd.signal); break;
      case 'open': {
        const p = peers.get(cmd.peer);
        if (p && CONN_ID.test(String(cmd.conn))) adoptChannel(cmd.peer, p.pc.createDataChannel(`mc:${cmd.conn}`));
        break;
      }
      case 'data': send(cmd.peer, cmd.conn, cmd.bytes); break;
      case 'end': {
        const p = peers.get(cmd.peer);
        const ch = p && p.channels.get(String(cmd.conn));
        if (ch) { p.channels.delete(String(cmd.conn)); ch.onclose = null; ch.close(); }
        break;
      }
      case 'peer-close': closePeer(cmd.peer); break;
      default: break;
    }
  });
})();

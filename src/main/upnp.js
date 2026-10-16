'use strict';

// A small UPnP (Internet Gateway Device) client: it finds the router on the local network and asks it
// to forward one TCP port to this PC, so players can reach a Minecraft server without the relay
// ("Direct mode"). No dependencies, and it only ever talks to the router that answered on the LAN.
//
// What it does, in order:
//   1. SSDP: send a multicast search from each network interface and collect the routers that answer.
//   2. Read the router's description (XML) and find its WAN connection service.
//   3. SOAP: GetExternalIPAddress, AddPortMapping (with a lease that is renewed), DeletePortMapping.
//
// Safety: only a router whose answer comes from a private LAN address (and whose description and
// control URL are on that same address) is used, so a reply from elsewhere can't make this app send
// requests to another host.

const dgram = require('dgram');
const http = require('http');
const os = require('os');

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
];
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const HTTP_TIMEOUT_MS = 4000;
const MAX_XML_BYTES = 256 * 1024;
const LEASE_SECONDS = 3600;
const DESCRIPTION = 'VoxelPort';

class UpnpError extends Error {
  /** @param {string} code a short code the app maps to words: no-gateway, cgnat, conflict, refused, bad-reply */
  constructor(code, message, soapCode) {
    super(message);
    this.name = 'UpnpError';
    this.code = code;
    this.soapCode = soapCode; // the router's own error number (718, 725…), when it sent one
  }
}

// ─── Addresses ──────────────────────────────────────────────────────────────

function parseV4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** A LAN address: private, or link-local. This is where a home router lives. */
function isLanV4(ip) {
  const p = parseV4(ip);
  if (!p) return false;
  const [a, b] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** An address players on the internet could reach: not private, shared (CGNAT), loopback or reserved. Same rules as the relay's. */
function isPublicV4(ip) {
  const p = parseV4(ip);
  if (!p) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c <= 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function lanInterfaces() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && isLanV4(a.address)) out.push(a.address);
    }
  }
  return out;
}

// ─── Finding the router ─────────────────────────────────────────────────────

function parseSsdpHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/**
 * Asks the local network for routers. Resolves with [{ location, localAddress }] (possibly empty), where
 * localAddress is this PC's address on the network that router is on.
 * Options (for tests): ssdpHost, ssdpPort, interfaces, timeoutMs, allowLoopback.
 */
function discover({ ssdpHost = SSDP_HOST, ssdpPort = SSDP_PORT, interfaces = lanInterfaces(), timeoutMs = 2500, allowLoopback = false } = {}) {
  return new Promise((resolve) => {
    const found = new Map(); // location -> { location, localAddress }
    const sockets = [];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const s of sockets) { try { s.close(); } catch { /* already closed */ } }
      resolve([...found.values()]);
    };
    if (!interfaces.length) { resolve([]); return; }

    for (const localAddress of interfaces) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(sock);
      sock.on('error', () => { /* an interface that can't send is just skipped */ });
      sock.on('message', (buf, rinfo) => {
        const h = parseSsdpHeaders(buf.toString('utf8', 0, Math.min(buf.length, 2048)));
        if (!h.location) return;
        let url;
        try { url = new URL(h.location); } catch { return; }
        if (url.protocol !== 'http:') return;
        // The router must answer from the address it says it lives at, and that must be on the LAN.
        const lan = isLanV4(rinfo.address) || (allowLoopback && rinfo.address === '127.0.0.1');
        if (!lan || url.hostname !== rinfo.address) return;
        if (!found.has(h.location)) found.set(h.location, { location: h.location, localAddress });
      });
      sock.bind(0, localAddress, () => {
        try {
          if (ssdpHost === SSDP_HOST) sock.setMulticastInterface(localAddress);
          for (const st of SEARCH_TARGETS) {
            const msg = Buffer.from(
              'M-SEARCH * HTTP/1.1\r\n' +
              `HOST: ${SSDP_HOST}:${SSDP_PORT}\r\n` +
              'MAN: "ssdp:discover"\r\nMX: 2\r\n' +
              `ST: ${st}\r\n\r\n`,
            );
            sock.send(msg, ssdpPort, ssdpHost, () => { /* best effort */ });
          }
        } catch { /* skip this interface */ }
      });
    }
    setTimeout(finish, timeoutMs);
  });
}

// ─── HTTP / XML helpers ─────────────────────────────────────────────────────

function httpRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_XML_BYTES) { req.destroy(new UpnpError('bad-reply', 'The router sent too much data.')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new UpnpError('no-gateway', 'The router did not answer in time.')));
    req.on('error', (err) => reject(err instanceof UpnpError ? err : new UpnpError('no-gateway', `Could not talk to the router: ${err.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
}

/** Reads the router's description and finds its WAN connection service: { serviceType, controlUrl }. */
async function describe(location) {
  const res = await httpRequest(location);
  if (res.status !== 200) throw new UpnpError('bad-reply', `The router's description answered HTTP ${res.status}.`);
  const base = tagText(res.text, 'URLBase') || location;
  const services = [];
  const re = /<service>([\s\S]*?)<\/service>/gi;
  let m;
  while ((m = re.exec(res.text))) {
    const serviceType = tagText(m[1], 'serviceType');
    const controlURL = tagText(m[1], 'controlURL');
    if (serviceType && controlURL) services.push({ serviceType, controlURL });
  }
  const origin = new URL(location).hostname;
  for (const want of SERVICE_TYPES) {
    const s = services.find((x) => x.serviceType === want);
    if (!s) continue;
    let controlUrl;
    try { controlUrl = new URL(s.controlURL, base); } catch { continue; }
    // The control URL has to be on the router that answered, never somewhere else.
    if (controlUrl.protocol !== 'http:' || controlUrl.hostname !== origin) continue;
    return { serviceType: want, controlUrl: controlUrl.toString() };
  }
  throw new UpnpError('no-gateway', 'The router has no port-forwarding service.');
}

/** Calls one SOAP action; returns the reply's XML text. A router error becomes an UpnpError with soapCode. */
async function soap({ controlUrl, serviceType }, action, args = {}) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const res = await httpRequest(controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${serviceType}#${action}"` },
    body,
  });
  if (res.status === 200) return res.text;
  const code = Number(tagText(res.text, 'errorCode'));
  const desc = tagText(res.text, 'errorDescription') || `HTTP ${res.status}`;
  throw new UpnpError(code === 718 ? 'conflict' : 'refused', `The router refused ${action}: ${desc}${code ? ` (${code})` : ''}`, code || undefined);
}

// ─── The port mapper ────────────────────────────────────────────────────────

class PortMapper {
  /**
   * @param {object} [o]
   * @param {(line: string) => void} [o.log]
   * @param {object} [o.discoverOptions] passed to discover() (tests point it at a fake router)
   * @param {number} [o.renewMs] how often the lease is renewed (default: half the lease)
   * @param {() => number[]} [o.randomPorts] alternative external ports to try when the preferred one is taken
   */
  constructor({ log = () => {}, discoverOptions = {}, renewMs = (LEASE_SECONDS * 1000) / 2, randomPorts = defaultAlternatives } = {}) {
    this.log = log;
    this.discoverOptions = discoverOptions;
    this.renewMs = renewMs;
    this.randomPorts = randomPorts;
    this.gateway = null; // { serviceType, controlUrl, localAddress }
    this.mapping = null; // { internalPort, externalPort, lease }
    this.timer = null;
    this.onLost = null; // called with an Error if renewing fails
  }

  async _gatewayInfo() {
    if (this.gateway) return this.gateway;
    const routers = await discover(this.discoverOptions);
    if (!routers.length) throw new UpnpError('no-gateway', 'No router answered. UPnP may be switched off on it.');
    let lastErr = null;
    for (const r of routers) {
      try {
        const d = await describe(r.location);
        this.gateway = { ...d, localAddress: r.localAddress };
        return this.gateway;
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new UpnpError('no-gateway', 'No usable router found.');
  }

  /**
   * Forwards a TCP port to this PC. Tries `preferredExternalPort`, then a few other ports if the router says
   * it is taken. Resolves with { externalIp, externalPort, localAddress }. Throws UpnpError, with code
   * no-gateway | cgnat | conflict | refused | bad-reply.
   */
  async open({ internalPort, preferredExternalPort = internalPort }) {
    const gw = await this._gatewayInfo();
    let externalIp = '';
    try {
      externalIp = tagText(await soap(gw, 'GetExternalIPAddress'), 'NewExternalIPAddress') || '';
    } catch (err) {
      this.log(`UPnP: could not read the router's external address (${err.message})`);
    }
    // A router whose own outside address is private or shared (CGNAT) can't be reached from the internet.
    if (externalIp && externalIp !== '0.0.0.0' && !isPublicV4(externalIp)) {
      throw new UpnpError('cgnat', 'Your internet provider shares one public address between many customers, so players can\'t connect to this PC directly.');
    }
    const candidates = [preferredExternalPort, ...this.randomPorts().filter((p) => p !== preferredExternalPort)];
    let lastErr = null;
    for (const externalPort of candidates.slice(0, 6)) {
      try {
        await this._add(gw, externalPort, internalPort);
        this.mapping = { internalPort, externalPort };
        this._startRenew();
        this.log(`UPnP: forwarded port ${externalPort} to this PC.`);
        return { externalIp, externalPort, localAddress: gw.localAddress };
      } catch (err) {
        lastErr = err;
        if (err.code !== 'conflict') throw err; // only "that port is taken" is worth trying another port for
      }
    }
    throw lastErr || new UpnpError('refused', 'The router would not forward a port.');
  }

  async _add(gw, externalPort, internalPort) {
    const args = (lease) => ({
      NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: 'TCP', NewInternalPort: internalPort,
      NewInternalClient: gw.localAddress, NewEnabled: 1, NewPortMappingDescription: DESCRIPTION, NewLeaseDuration: lease,
    });
    try {
      await soap(gw, 'AddPortMapping', args(LEASE_SECONDS));
    } catch (err) {
      // 725: this router only accepts permanent mappings. Ask for one (it is still removed when we close).
      if (err.soapCode === 725) await soap(gw, 'AddPortMapping', args(0));
      else throw err;
    }
  }

  _startRenew() {
    this._stopRenew();
    this.timer = setInterval(async () => {
      if (!this.mapping || !this.gateway) return;
      try {
        await this._add(this.gateway, this.mapping.externalPort, this.mapping.internalPort);
      } catch (err) {
        this.log(`UPnP: could not renew the port forwarding (${err.message})`);
        if (this.onLost) this.onLost(err);
      }
    }, this.renewMs);
    if (this.timer.unref) this.timer.unref();
  }

  _stopRenew() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Removes the forwarding (best effort: a router that is gone or has forgotten it is fine). */
  async close() {
    this._stopRenew();
    const m = this.mapping;
    this.mapping = null;
    if (!m || !this.gateway) return;
    try {
      await soap(this.gateway, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.externalPort, NewProtocol: 'TCP' });
      this.log(`UPnP: closed port ${m.externalPort} on the router.`);
    } catch (err) {
      this.log(`UPnP: could not close port ${m.externalPort} (${err.message}); it expires by itself.`);
    }
  }
}

function defaultAlternatives() {
  // A few ports near Minecraft's own, in a random order, for when the router already uses the first choice.
  const out = [];
  while (out.length < 5) {
    const p = 25570 + Math.floor(Math.random() * 400);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

module.exports = { PortMapper, UpnpError, discover, describe, soap, isLanV4, isPublicV4, lanInterfaces, LEASE_SECONDS };

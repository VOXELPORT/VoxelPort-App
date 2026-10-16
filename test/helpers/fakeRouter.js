'use strict';

// A pretend home router for tests: answers the SSDP search, serves a device description, and handles the
// UPnP SOAP calls the app makes (GetExternalIPAddress, AddPortMapping, DeletePortMapping). It listens on
// 127.0.0.1 only. Every call it gets is recorded in `calls`, and the port forwardings it holds in `mappings`.

const dgram = require('dgram');
const http = require('http');

const IGD = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';

function arg(body, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? m[1] : null;
}

function soapFault(code, description) {
  return '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
    `<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError><errorCode>${code}</errorCode>` +
    `<errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}

async function startFakeRouter(opts = {}) {
  const o = {
    externalIp: '83.45.12.9',
    conflictPorts: [],        // external ports that are "already in use" (error 718)
    onlyPermanent: false,     // refuse leases (error 725)
    noService: false,         // a description with no WAN connection service
    controlOnOtherHost: false, // a description whose control URL points elsewhere
    spoofLocationHost: null,  // answer the search with a LOCATION on this host instead of our own
    hugeDescription: false,
    serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    ...opts,
  };
  const mappings = new Map(); // external port -> { internalPort, internalClient, protocol, lease }
  const calls = [];
  const state = { failAdd: false, failAddCode: 501 };

  // A second "host" (127.0.0.2) that a hostile description could point the control URL at: it must never be contacted.
  const stray = { requests: 0, port: 0, server: null };
  if (o.controlOnOtherHost) {
    stray.server = http.createServer((req, res) => { stray.requests++; res.end(); });
    await new Promise((r) => stray.server.listen(0, '127.0.0.2', r));
    stray.port = stray.server.address().port;
  }

  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/desc.xml') {
        if (o.hugeDescription) { res.end('<root>' + 'x'.repeat(400 * 1024) + '</root>'); return; }
        const control = o.controlOnOtherHost ? `http://127.0.0.2:${stray.port}/ctl/IPConn` : '/ctl/IPConn';
        const service = o.noService ? '' :
          `<service><serviceType>${o.serviceType}</serviceType><serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId><controlURL>${control}</controlURL></service>`;
        res.setHeader('Content-Type', 'text/xml');
        res.end(
          '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>' + IGD + '</deviceType>' +
          '<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType><deviceList><device>' +
          '<deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>' +
          `<serviceList>${service}</serviceList></device></deviceList></device></deviceList></device></root>`,
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/ctl/IPConn') {
        const action = /#(\w+)"?$/.exec(req.headers.soapaction || '')?.[1];
        calls.push({ action, body });
        const ok = (inner) => {
          res.setHeader('Content-Type', 'text/xml');
          res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${o.serviceType}">${inner}</u:${action}Response></s:Body></s:Envelope>`);
        };
        const fault = (code, text) => { res.statusCode = 500; res.end(soapFault(code, text)); };
        if (action === 'GetExternalIPAddress') return ok(`<NewExternalIPAddress>${o.externalIp}</NewExternalIPAddress>`);
        if (action === 'AddPortMapping') {
          const port = Number(arg(body, 'NewExternalPort'));
          const lease = Number(arg(body, 'NewLeaseDuration'));
          if (state.failAdd) return fault(state.failAddCode, 'Action Failed');
          if (o.conflictPorts.includes(port) && !mappings.has(port)) return fault(718, 'ConflictInMappingEntry');
          if (o.onlyPermanent && lease !== 0) return fault(725, 'OnlyPermanentLeasesSupported');
          mappings.set(port, {
            internalPort: Number(arg(body, 'NewInternalPort')), internalClient: arg(body, 'NewInternalClient'),
            protocol: arg(body, 'NewProtocol'), lease, description: arg(body, 'NewPortMappingDescription'),
          });
          return ok('');
        }
        if (action === 'DeletePortMapping') {
          const port = Number(arg(body, 'NewExternalPort'));
          if (!mappings.delete(port)) return fault(714, 'NoSuchEntryInArray');
          return ok('');
        }
        return fault(401, 'Invalid Action');
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const httpPort = httpServer.address().port;

  const udp = dgram.createSocket('udp4');
  udp.on('message', (buf, rinfo) => {
    const text = buf.toString();
    if (!/^M-SEARCH/i.test(text) || !/InternetGatewayDevice/.test(text)) return;
    const host = o.spoofLocationHost || '127.0.0.1';
    const reply = Buffer.from(
      'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\n' +
      `LOCATION: http://${host}:${httpPort}/desc.xml\r\nST: ${IGD}\r\nUSN: uuid:fake-router::${IGD}\r\n\r\n`,
    );
    udp.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  const ssdpPort = udp.address().port;

  return {
    ssdpPort, httpPort, mappings, calls, state, stray,
    /** Options for discover() / new PortMapper({ discoverOptions }) that point at this router. */
    discoverOptions: { ssdpHost: '127.0.0.1', ssdpPort, interfaces: ['127.0.0.1'], allowLoopback: true, timeoutMs: 300 },
    countCalls: (action) => calls.filter((c) => c.action === action).length,
    close: async () => {
      try { udp.close(); } catch { /* already closed */ }
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(r));
      if (stray.server) {
        stray.server.closeAllConnections?.();
        await new Promise((r) => stray.server.close(r));
      }
    },
  };
}

module.exports = { startFakeRouter };

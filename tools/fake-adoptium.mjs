// A stand-in for the Adoptium API and its download host, for testing the Java install without the internet.
//   import { startAdoptium } from './fake-adoptium.mjs'
// It serves a real zip whose bin/java.exe is whatever file you give it (the test stand-in server), so the "installed Java"
// can actually be run. `mode.bad = true` makes it advertise a wrong checksum; `hits` counts requests.
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/** A zip with every entry stored (no compression), built by hand so the tools need no dependencies. */
export function storedZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name), crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

export function startAdoptium(port, javaExePath, { delayMs = 0 } = {}) {
  const exe = fs.readFileSync(javaExePath);
  const state = { hits: 0, downloads: 0, mode: { bad: false } };
  // The stand-in reads its Java major from java-major.txt next to it, so each installed copy reports its own version.
  const archive = (major) => storedZip([[`jdk-${major}.0.4+7-jre/bin/java.exe`, exe], [`jdk-${major}.0.4+7-jre/bin/java-major.txt`, Buffer.from(String(major))], [`jdk-${major}.0.4+7-jre/release`, Buffer.from(`JAVA_VERSION="${major}.0.4"\n`)]]);
  const server = http.createServer((req, res) => {
    state.hits++;
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const api = u.pathname.match(/^\/v3\/assets\/latest\/(\d+)\/hotspot$/);
    if (api) {
      if (u.searchParams.get('image_type') !== 'jre') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
      const major = Number(api[1]), zip = archive(major);
      const checksum = state.mode.bad ? '0'.repeat(64) : crypto.createHash('sha256').update(zip).digest('hex');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ binary: { package: { link: `http://127.0.0.1:${port}/download/${major}.zip`, name: `OpenJDK${major}U-jre_x64_windows_hotspot_${major}.0.4_7.zip`, size: zip.length, checksum } } }]));
    }
    const dl = u.pathname.match(/^\/download\/(\d+)\.zip$/);
    if (dl) {
      state.downloads++;
      const zip = archive(Number(dl[1]));
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length }); res.end(zip); }, delayMs);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ state, close: () => server.close() })));
}

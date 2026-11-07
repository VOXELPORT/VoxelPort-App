// A stand-in for the Mojang, Paper and Fabric services, for testing server install without the internet.
//   import { startFakeMc } from './fake-mc.mjs'
// It serves real zips whose version.json says the version asked for (Fabric's has none), with the checksums the real
// services publish. `mode.wrongVersion = true` serves a jar that claims another Minecraft version.
import http from 'node:http';
import crypto from 'node:crypto';
import { storedZip } from './fake-adoptium.mjs';

const hex = (algo, b) => crypto.createHash(algo).update(b).digest('hex');

export function startFakeMc(port) {
  const base = `http://127.0.0.1:${port}`;
  const state = { hits: 0, mode: { wrongVersion: false, noAuthMe: false } };
  const AUTHME = Buffer.from('AuthMe jar bytes'), SKINS = Buffer.from('SkinsRestorer jar bytes');
  const jar = (version) => storedZip([['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n')], ...(version ? [['version.json', Buffer.from(JSON.stringify({ id: version, name: version }))]] : [])]);
  const claimed = (v) => (state.mode.wrongVersion ? '9.9.9' : v);
  const json = (res, v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  const server = http.createServer((req, res) => {
    state.hits++;
    const p = new URL(req.url, base).pathname;
    let m;
    if (p === '/mojang/version_manifest_v2.json') return json(res, { versions: [
      { id: '24w01a', type: 'snapshot', url: `${base}/mojang/v/24w01a.json` },
      { id: '1.21.4', type: 'release', url: `${base}/mojang/v/1.21.4.json` },
      { id: '1.20.1', type: 'release', url: `${base}/mojang/v/1.20.1.json` },
    ] });
    if ((m = p.match(/^\/mojang\/v\/(.+)\.json$/))) { const z = jar(claimed(m[1])); return json(res, { downloads: { server: { url: `${base}/dl/vanilla-${m[1]}.jar`, sha1: hex('sha1', z) } } }); }
    if ((m = p.match(/^\/dl\/vanilla-(.+)\.jar$/))) { res.writeHead(200); return res.end(jar(claimed(m[1]))); }
    if (p === '/paper') return json(res, { versions: { '1.21': ['1.21.4', '1.21.3'], '1.20': ['1.20.6'] } });
    if ((m = p.match(/^\/paper\/versions\/(.+)\/builds$/))) {
      const z = jar(claimed(m[1])), dl = (id) => ({ 'server:default': { url: `${base}/dl/paper-${m[1]}.jar`, checksums: { sha256: id === 90 ? hex('sha256', z) : '0'.repeat(64) } } });
      return json(res, [{ id: 100, channel: 'ALPHA', downloads: dl(100) }, { id: 90, channel: 'STABLE', downloads: dl(90) }, { id: 80, channel: 'STABLE', downloads: dl(80) }]);
    }
    if ((m = p.match(/^\/dl\/paper-(.+)\.jar$/))) { res.writeHead(200); return res.end(jar(claimed(m[1]))); }
    if (p === '/fabric/versions/game') return json(res, [{ version: '1.21.4', stable: true }, { version: '24w01a', stable: false }]);
    if (p.match(/^\/fabric\/versions\/loader\/[^/]+$/)) return json(res, [{ loader: { version: '0.16.9', stable: false } }, { loader: { version: '0.16.8', stable: true } }]);
    if (p === '/fabric/versions/installer') return json(res, [{ version: '1.0.1', stable: true }]);
    if (p.match(/^\/fabric\/versions\/loader\/.+\/server\/jar$/)) { res.writeHead(200); return res.end(jar(null)); }
    // Modrinth: the login and skins plugins, for Paper.
    if ((m = p.match(/^\/v2\/project\/(3IEZ9vol|TsLS8Py5)\/version$/))) {
      const authme = m[1] === '3IEZ9vol';
      if (authme && state.mode.noAuthMe) return json(res, []);
      const jarBytes = authme ? AUTHME : SKINS;
      return json(res, [{ version_type: 'release', files: [{ primary: true, url: `${base}/data/${authme ? 'authme' : 'skins'}.jar`, filename: authme ? 'AuthMe-5.7.0.jar' : 'SkinsRestorer.jar', hashes: { sha512: hex('sha512', jarBytes) } }] }]);
    }
    if ((m = p.match(/^\/v2\/project\/(3IEZ9vol|TsLS8Py5)$/))) return json(res, { icon_url: `https://cdn.modrinth.com/data/${m[1]}/icon.png` });
    if (p === '/data/authme.jar') { res.writeHead(200); return res.end(AUTHME); }
    if (p === '/data/skins.jar') { res.writeHead(200); return res.end(SKINS); }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ state, base, close: () => server.close() })));
}

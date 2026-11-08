// A stand-in for the Mojang, Paper and Fabric services, for testing server install without the internet.
//   import { startFakeMc } from './fake-mc.mjs'
// It also stands in for Modrinth (search, versions, file fingerprints) and GeyserMC's download API, for add-ons and Bedrock.
// It serves real zips whose version.json says the version asked for (Fabric's has none), with the checksums the real
// services publish. `mode.wrongVersion = true` serves a jar that claims another Minecraft version.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { storedZip } from './fake-adoptium.mjs';

const hex = (algo, b) => crypto.createHash(algo).update(b).digest('hex');

// `opts.bedrockExe`: the file served as bedrock_server.exe inside the Bedrock Dedicated Server archive (the test stand-in server).
let bedrockVersion = '1.26.63.1';
let bedrockBroken = false;

export function startFakeMc(port, opts = {}) {
  const base = `http://127.0.0.1:${port}`;
  const state = { hits: 0, mode: { wrongVersion: false, noAuthMe: false } };
  const AUTHME = Buffer.from('AuthMe jar bytes'), SKINS = Buffer.from('SkinsRestorer jar bytes');
  const jar = (version) => storedZip([['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n')], ...(version ? [['version.json', Buffer.from(JSON.stringify({ id: version, name: version }))]] : [])]);
  const claimed = (v) => (state.mode.wrongVersion ? '9.9.9' : v);
  const json = (res, v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  const BYTES = { cool: Buffer.from("Cool Plugin bytes"), lib: Buffer.from("Library bytes"), fabmod: Buffer.from("Fabric mod bytes"), geyserSpigot: Buffer.from("Geyser-Spigot bytes"), geyserFabric: Buffer.from("Geyser-Fabric bytes"), floodSpigot: Buffer.from("floodgate-spigot bytes"), floodFabric: Buffer.from("Floodgate-Fabric bytes"), fabricApi: Buffer.from("Fabric API bytes"), voice: Buffer.from("Simple Voice Chat bytes") };
  const fileOf = (name, key) => ({ primary: true, url: `${base}/data/${key}.jar`, filename: name, hashes: { sha512: hex("sha512", BYTES[key]) } });
  const MODRINTH = {
    AAAAAAAA: { for: "paper", file: fileOf("CoolPlugin-1.0.jar", "cool"), deps: ["BBBBBBBB"] },
    BBBBBBBB: { for: "paper", file: fileOf("Lib-2.jar", "lib"), deps: [] },
    EEEEEEEE: { for: "fabric", file: fileOf("cool-mod-3.jar", "fabmod"), deps: [] },
    geyser: { for: "any", file: (loaders) => (loaders.includes("fabric") ? fileOf("geyser-fabric-2.9.jar", "geyserFabric") : fileOf("Geyser-Spigot.jar", "geyserSpigot")), deps: [] },
    floodgate: { for: "fabric", file: fileOf("Floodgate-Fabric-2.2.jar", "floodFabric"), deps: [] },
    "fabric-api": { for: "fabric", file: fileOf("fabric-api-0.100.jar", "fabricApi"), deps: [] },
    "9eGKb6K1": { for: "paper", file: fileOf("voicechat-bukkit-2.5.jar", "voice"), deps: [] }, // Simple Voice Chat
  };
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
    // Mojang's download-link service and the Bedrock Dedicated Server archive it names. A test can publish a newer release
    // (/__bedrock/version?v=1.26.70.2) and make the archive unavailable (/__bedrock/break?on=1).
    if (p === '/__bedrock/version') { bedrockVersion = new URL(req.url, base).searchParams.get('v') || bedrockVersion; return json(res, { version: bedrockVersion }); }
    if (p === '/__bedrock/break') { bedrockBroken = new URL(req.url, base).searchParams.get('on') === '1'; return json(res, { broken: bedrockBroken }); }
    if (p === '/api/links') return json(res, { result: { links: [
      { downloadType: 'serverBedrockLinux', downloadUrl: `${base}/bedrockdedicatedserver/bin-linux/bedrock-server-${bedrockVersion}.zip` },
      { downloadType: 'serverBedrockWindows', downloadUrl: `${base}/bedrockdedicatedserver/bin-win/bedrock-server-${bedrockVersion}.zip` },
    ] } });
    if (p === `/bedrockdedicatedserver/bin-win/bedrock-server-${bedrockVersion}.zip` && opts.bedrockExe && bedrockBroken) { res.writeHead(404); return res.end('gone'); }
    if (p === `/bedrockdedicatedserver/bin-win/bedrock-server-${bedrockVersion}.zip` && opts.bedrockExe) {
      const newer = bedrockVersion !== '1.26.63.1';
      const zip = storedZip([
        ...(newer ? [['new_in_this_version.txt', Buffer.from(bedrockVersion)], ['worlds/Bedrock level/level.dat', Buffer.from('from the archive')], ['allowlist.json', Buffer.from('[]')]] : []),
        ['bedrock_server.exe', fs.readFileSync(opts.bedrockExe)],
        ['server.properties', Buffer.from('# Mojang defaults\nserver-name=Dedicated Server\ngamemode=survival\ndifficulty=easy\nmax-players=10\nserver-port=19132\nserver-portv6=19133\nlevel-name=Bedrock level\nallow-list=false\nonline-mode=true\n')],
        ['behavior_packs/vanilla/manifest.json', Buffer.from('{}')],
      ]);
      res.writeHead(200, { 'content-type': 'application/x-zip-compressed' });
      return res.end(zip);
    }
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
    // Modrinth: search, per-project versions (1.21.4 only), titles, and the fingerprint lookup (nothing is recognised).
    if (p === "/v2/search") {
      const u = new URL(req.url, base), facets = u.searchParams.get("facets") || "";
      const hits = facets.includes("categories:fabric")
        ? [{ project_id: "EEEEEEEE", slug: "cool-mod", title: "Cool Mod", description: "A mod", downloads: 10, author: "x", icon_url: "https://cdn.modrinth.com/data/EEEEEEEE/icon.png" }]
        : [{ project_id: "AAAAAAAA", slug: "cool-plugin", title: "Cool Plugin", description: "A plugin", downloads: 99, author: "y", icon_url: "https://cdn.modrinth.com/data/AAAAAAAA/icon.png" }, { project_id: "not-an-id", title: "Bad" }];
      state.lastSearch = u.search;
      return json(res, { hits });
    }
    if ((m = p.match(/^\/v2\/project\/([A-Za-z0-9-]+)\/version$/)) && MODRINTH[m[1]]) {
      const u = new URL(req.url, base), loaders = u.searchParams.get("loaders") || "", games = u.searchParams.get("game_versions") || "";
      const spec = MODRINTH[m[1]];
      if (!games.includes("1.21.4") || (spec.for !== "any" && !loaders.includes(spec.for))) return json(res, []);
      const file = typeof spec.file === "function" ? spec.file(loaders) : spec.file;
      return json(res, [{ version_type: "release", dependencies: spec.deps.map((d) => ({ project_id: d, dependency_type: "required" })), files: [file] }]);
    }
    if ((m = p.match(/^\/v2\/project\/(BBBBBBBB)$/))) return json(res, { title: "The Library" });
    if (p === "/v2/version_files" && req.method === "POST") { req.resume(); return json(res, {}); }
    if ((m = p.match(/^\/data\/(cool|lib|fabmod|geyserSpigot|geyserFabric|floodFabric|fabricApi|voice)\.jar$/))) { res.writeHead(200); return res.end(BYTES[m[1]]); }
    // GeyserMC: the latest Floodgate for Paper.
    if (p === "/geyser/floodgate/versions/latest/builds/latest") return json(res, { version: "2.2.4", build: 120, downloads: { spigot: { name: "floodgate-spigot.jar", sha256: hex("sha256", BYTES.floodSpigot) } } });
    if (p === "/geyser/floodgate/versions/2.2.4/builds/120/downloads/spigot") { res.writeHead(200); return res.end(BYTES.floodSpigot); }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ state, base, close: () => server.close() })));
}

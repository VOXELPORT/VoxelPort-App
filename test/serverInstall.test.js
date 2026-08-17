'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { writeServerProperties, downloadServerJar, updateServerPropertiesSafely, detectExistingServer, isOfficialDownloadHost } = require('../src/main/serverInstall');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-test-'));
}

test('writeServerProperties coerces port to a safe integer, cannot inject extra lines', () => {
  const dir = tmpDir();
  writeServerProperties(dir, { port: '25565\nenable-rcon=true\nrcon.password=pwned' });
  const content = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(content, /^server-port=25565$/m);
  assert.doesNotMatch(content, /enable-rcon/);
  assert.doesNotMatch(content, /rcon\.password/);
});

test('writeServerProperties falls back to the default port on invalid input', () => {
  const dir = tmpDir();
  writeServerProperties(dir, { port: -1 });
  const content = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(content, /^server-port=25565$/m);
});

test('downloadServerJar accepts a file matching its expected checksum', async () => {
  const payload = Buffer.from('hello server jar');
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const srv = http.createServer((req, res) => res.end(payload));
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  const dest = path.join(tmpDir(), 'server.jar');
  try {
    await downloadServerJar(`http://127.0.0.1:${port}/`, dest, null, { algorithm: 'sha256', expected: sha256 });
    assert.equal(fs.readFileSync(dest).toString(), payload.toString());
  } finally {
    srv.close();
  }
});

test('downloadServerJar rejects and deletes the file on a checksum mismatch', async () => {
  const payload = Buffer.from('tampered content');
  const srv = http.createServer((req, res) => res.end(payload));
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  const dest = path.join(tmpDir(), 'server.jar');
  try {
    await assert.rejects(
      downloadServerJar(`http://127.0.0.1:${port}/`, dest, null, {
        algorithm: 'sha256',
        expected: '0000000000000000000000000000000000000000000000000000000000000000',
      }),
      /checksum|verification/i
    );
    assert.equal(fs.existsSync(dest), false);
  } finally {
    srv.close();
  }
});

// ─── Item 22: atomic downloads ─────────────────────────────────────────────

test('an existing server.jar survives untouched when a new download fails checksum verification', async () => {
  const original = Buffer.from('the real, currently-installed server jar');
  const tampered = Buffer.from('a corrupted replacement');
  const srv = http.createServer((req, res) => res.end(tampered));
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  const dir = tmpDir();
  const dest = path.join(dir, 'server.jar');
  fs.writeFileSync(dest, original);
  try {
    await assert.rejects(
      downloadServerJar(`http://127.0.0.1:${port}/`, dest, null, {
        algorithm: 'sha256',
        expected: '0000000000000000000000000000000000000000000000000000000000000000',
      })
    );
    assert.equal(fs.readFileSync(dest).toString(), original.toString());
    // no leftover .download-* temp files
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.download-'));
    assert.deepEqual(leftovers, []);
  } finally {
    srv.close();
  }
});

test('an existing server.jar survives untouched when the download server errors mid-stream', async () => {
  const original = Buffer.from('the real, currently-installed server jar');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': '1000' });
    res.write('only-partial-data');
    req.socket.destroy(); // abrupt disconnect, no clean end
  });
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  const dir = tmpDir();
  const dest = path.join(dir, 'server.jar');
  fs.writeFileSync(dest, original);
  try {
    await assert.rejects(downloadServerJar(`http://127.0.0.1:${port}/`, dest, null));
    assert.equal(fs.readFileSync(dest).toString(), original.toString());
  } finally {
    srv.close();
  }
});

test('downloadServerJar writes to a temp file, never directly to destPath mid-download', async () => {
  let sawTempFileDuringDownload = false;
  const dir = tmpDir();
  const dest = path.join(dir, 'server.jar');
  const payload = Buffer.alloc(1024 * 64, 'x');
  const srv = http.createServer((req, res) => {
    res.write(payload.subarray(0, 1024));
    setTimeout(() => {
      const files = fs.readdirSync(dir);
      sawTempFileDuringDownload = files.some((f) => f.includes('.download-')) && !fs.existsSync(dest);
      res.end(payload.subarray(1024));
    }, 20);
  });
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  try {
    await downloadServerJar(`http://127.0.0.1:${port}/`, dest, null);
    assert.equal(sawTempFileDuringDownload, true);
    assert.equal(fs.readFileSync(dest).length, payload.length);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.download-'));
    assert.deepEqual(leftovers, []);
  } finally {
    srv.close();
  }
});

// ─── Item 23: redirect/host/scheme hardening ───────────────────────────────

test('isOfficialDownloadHost accepts official Mojang/Paper/Fabric hosts and their subdomains', () => {
  assert.equal(isOfficialDownloadHost('piston-data.mojang.com'), true);
  assert.equal(isOfficialDownloadHost('fill-data.papermc.io'), true);
  assert.equal(isOfficialDownloadHost('meta.fabricmc.net'), true);
  assert.equal(isOfficialDownloadHost('minecraft.net'), true);
});

test('isOfficialDownloadHost rejects lookalike and unrelated hosts', () => {
  assert.equal(isOfficialDownloadHost('mojang.com.evil.example'), false);
  assert.equal(isOfficialDownloadHost('evil-mojang.com'), false);
  assert.equal(isOfficialDownloadHost('attacker.example'), false);
});

test('downloadServerJar rejects a redirect to an untrusted public host', async () => {
  const dest = path.join(tmpDir(), 'server.jar');
  const evil = http.createServer((req, res) => res.end('should never be reached'));
  await new Promise((resolve) => evil.listen(0, resolve));
  const evilPort = evil.address().port;
  const srv = http.createServer((req, res) => {
    res.writeHead(302, { location: 'https://attacker.example/payload.jar' });
    res.end();
  });
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  try {
    await assert.rejects(downloadServerJar(`http://127.0.0.1:${port}/`, dest, null), /untrusted/i);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    srv.close();
    evil.close();
  }
});

test('downloadServerJar rejects a plain http:// URL to a public host (no downgrade)', async () => {
  const dest = path.join(tmpDir(), 'server.jar');
  await assert.rejects(
    downloadServerJar('http://piston-data.mojang.com/some.jar', dest, null),
    /untrusted/i
  );
  assert.equal(fs.existsSync(dest), false);
});

// ─── Item 24: size limit ───────────────────────────────────────────────────

test('downloadServerJar rejects an oversized download even without a declared content-length', async () => {
  const dest = path.join(tmpDir(), 'server.jar');
  const srv = http.createServer((req, res) => {
    res.writeHead(200); // no content-length — size must be enforced from actual bytes received
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    let sent = 0;
    const interval = setInterval(() => {
      if (res.writableEnded) { clearInterval(interval); return; }
      res.write(chunk);
      sent += chunk.length;
      if (sent > 600 * 1024 * 1024) { clearInterval(interval); res.end(); }
    }, 0);
  });
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  try {
    await assert.rejects(downloadServerJar(`http://127.0.0.1:${port}/`, dest, null), /too large|exceeded/i);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    srv.close();
  }
});

// ─── Item 26: safe server.properties updates for imported servers ─────────

test('updateServerPropertiesSafely preserves unrelated lines and only changes requested keys', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server.properties'), [
    'server-port=25565',
    'view-distance=12',
    'motd=My Custom SMP',
    'level-seed=abc123',
  ].join('\n'));

  updateServerPropertiesSafely(dir, { 'server-port': 25580 });

  const content = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(content, /^server-port=25580$/m);
  assert.match(content, /^view-distance=12$/m);
  assert.match(content, /^motd=My Custom SMP$/m);
  assert.match(content, /^level-seed=abc123$/m);
});

test('updateServerPropertiesSafely never lets a caller set dangerous keys', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25565\nonline-mode=true\n');

  updateServerPropertiesSafely(dir, { 'server-port': 25580, 'enable-rcon': 'true', 'online-mode': 'false' });

  const content = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.doesNotMatch(content, /enable-rcon/);
  assert.match(content, /^online-mode=true$/m);
});

// ─── Item 5/25: existing-server detection ──────────────────────────────────

test('detectExistingServer identifies an existing server and guesses its type', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25577\n');
  fs.mkdirSync(path.join(dir, 'plugins'));
  const info = detectExistingServer(dir);
  assert.equal(info.looksLikeServer, true);
  assert.equal(info.hasProperties, true);
  assert.equal(info.hasPlugins, true);
  assert.equal(info.guessedType, 'paper');
  assert.equal(info.guessedPort, 25577);
});

test('detectExistingServer reports nothing found for an empty folder', () => {
  const dir = tmpDir();
  const info = detectExistingServer(dir);
  assert.equal(info.looksLikeServer, false);
  assert.equal(info.guessedType, null);
});

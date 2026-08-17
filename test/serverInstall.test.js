'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { writeServerProperties, downloadServerJar } = require('../src/main/serverInstall');

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

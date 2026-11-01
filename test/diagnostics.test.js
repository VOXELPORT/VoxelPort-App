'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReport, redact } = require('../src/main/diagnostics');

test('reports shareable error codes without tokens, user paths or addresses', () => {
  const report = createReport({ version: 'test', platform: 'win32', arch: 'x64', status: 'crashed',
    server: { type: 'paper', version: '1.21', port: 25565, serverDir: 'private-folder', token: 'private-token' },
    lines: ['FAILED TO BIND TO PORT', 'token=my-secret', 'C:\\Users\\Alice\\server', '192.168.1.2'] });
  assert.match(report, /VP-PORT_IN_USE/);
  for (const secret of ['my-secret', 'Alice', '192.168.1.2', 'private-folder', 'private-token']) assert.ok(!report.includes(secret));
});
test('normal sessions do not invent an error and reports fit Discord limits', () => {
  const report = createReport({ version: 'test', status: 'online', lines: ['Done!'] });
  assert.match(report, /VP-NO_MATCH/);
  const large = createReport({ version: 'test', status: 'online', lines: ['界'.repeat(640000)] });
  assert.ok(Buffer.byteLength(large) < 1024 * 1024);
});
test('redacts credentials in URLs and multiline private keys', () => {
  const result = redact('https://alice:pass@example.com/path?token=hidden\n-----BEGIN RSA PRIVATE KEY-----\nhidden-key\n-----END RSA PRIVATE KEY-----');
  for (const secret of ['alice', 'pass', 'hidden']) assert.ok(!result.includes(secret));
});

test('matches the Geyser version-mismatch disconnect (the original failure)', () => {
  const report = createReport({ version: 'test', status: 'online', server: { type: 'paper', version: '26.2' },
    lines: [
      '[INFO] Geyser 2.12.1 build 1280',
      '[WARN] This server does not support Java Edition 26.3. Original disconnect message: Outdated server! I\'m still on 26.2',
    ] });
  assert.match(report, /VP-GEYSER_VERSION_MISMATCH/);
  assert.doesNotMatch(report, /VP-NO_MATCH/);
});

test('matches a staged plugin update as informational', () => {
  const report = createReport({ version: 'test', status: 'online',
    lines: ['[GeyserUpdater] Live jar was locked; staged the update in plugins/update/Geyser-Spigot.jar — will be applied on next restart.'] });
  assert.match(report, /VP-PLUGIN_UPDATE_STAGED/);
});

test('the build number is shown in the report when known', () => {
  const report = createReport({ version: 'test', status: 'online', server: { type: 'paper', version: '26.3', build: '236' }, lines: ['Done!'] });
  assert.match(report, /Minecraft: 26\.3 \(build 236\)/);
});

test('existing signatures still match (regression guard)', () => {
  const port = createReport({ version: 'test', status: 'crashed', lines: ['FAILED TO BIND TO PORT'] });
  assert.match(port, /VP-PORT_IN_USE/);
  const java = createReport({ version: 'test', status: 'crashed', lines: ['java.lang.UnsupportedClassVersionError: foo has been compiled by a more recent version'] });
  assert.match(java, /VP-JAVA_VERSION/);
});

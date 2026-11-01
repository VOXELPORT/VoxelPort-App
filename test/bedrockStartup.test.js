'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bedrockPort, bedrockJvmArgs } = require('../src/main/bedrock');

function fixture(t, config, type = 'paper') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-bedrock-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, ...(type === 'fabric' ? ['config', 'Geyser-Fabric'] : ['plugins', 'Geyser-Spigot']), 'config.yml');
  if (config !== undefined) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, config);
  }
  return { dir, configPath };
}

test('local selection avoids Java, query and voice ports in a deterministic order', (t) => {
  const { dir } = fixture(t);
  const ports = { javaPort: 19132, queryPort: 19133, voicePort: 19134 };
  assert.equal(bedrockPort(dir, ports), 19135);
  assert.equal(bedrockPort(dir, ports), 19135);
  assert.deepEqual(fs.readdirSync(dir), [], 'selection does not generate config files');
});

test('local selection retains a custom port and falls back to 19132 on a collision', (t) => {
  const config = '# Keep my settings\r\nbedrock:\r\n  address: 127.0.0.1\r\n  port: 19200\r\n  clone-remote-port: true\r\nremote:\r\n  auth-type: floodgate\r\n';
  for (const type of ['paper', 'fabric']) {
    const { dir, configPath } = fixture(t, config, type);
    assert.equal(bedrockPort(dir, { javaPort: 25565 }), 19200);
    assert.equal(bedrockPort(dir, { javaPort: 19200 }), 19132);
    assert.equal(bedrockPort(dir, { javaPort: 25565, voicePort: 19200 }), 19132);
    assert.equal(fs.readFileSync(configPath, 'utf8'), config);
  }
});

test('local selection reads enabled query settings without changing server.properties', (t) => {
  const { dir } = fixture(t);
  const file = path.join(dir, 'server.properties');
  const properties = '# Keep this file\nenable-query=true\nquery.port=19132\nserver-port=19133\n';
  fs.writeFileSync(file, properties);
  assert.equal(bedrockPort(dir, { javaPort: 19133, voicePort: 19134 }), 19135);
  assert.equal(fs.readFileSync(file, 'utf8'), properties);
  fs.writeFileSync(file, 'enable-query=false\nquery.port=19132\n');
  assert.equal(bedrockPort(dir, { javaPort: 25565 }), 19132);
});

test('legacy selection without options keeps its old config/default behavior', (t) => {
  const { dir } = fixture(t, 'bedrock:\n  port: 19200\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'enable-query=true\nquery.port=19200\n');
  assert.equal(bedrockPort(dir), 19200);
  assert.equal(bedrockPort(fixture(t).dir), 19132);
});

test('selection handles quoted ports and EOF without a newline while preserving the config', (t) => {
  for (const port of ['"19200"', "'19200'"]) {
    const config = `bedrock:\n  port: ${port} # Custom port`;
    const { dir, configPath } = fixture(t, config);
    assert.equal(bedrockPort(dir, { javaPort: 25565 }), 19200);
    assert.equal(fs.readFileSync(configPath, 'utf8'), config);
  }
});

test('selection infers the Java port and the enabled query default when options omit them', (t) => {
  const { dir } = fixture(t, 'bedrock:\n  port: 25565\n');
  const propertiesPath = path.join(dir, 'server.properties');
  fs.writeFileSync(propertiesPath, 'server-port=19132\nenable-query=true\n');
  assert.equal(bedrockPort(dir, {}), 19133);
  fs.writeFileSync(propertiesPath, 'server-port=19132\nenable-query=false\n');
  assert.equal(bedrockPort(dir, {}), 25565);
});

test('local selection rejects invalid option ports rather than silently coercing them', (t) => {
  const { dir } = fixture(t);
  for (const key of ['javaPort', 'queryPort', 'voicePort']) {
    for (const value of [0, -1, 65536, 19132.5, '19132', NaN, null]) {
      assert.throws(() => bedrockPort(dir, { [key]: value }), /port/i, `${key}: ${value}`);
    }
  }
});

test('NetherNet binds signaling and WebRTC to the same non-loopback local endpoint', () => {
  assert.deepEqual(bedrockJvmArgs({ localPort: 19135 }), [
    '-DgeyserTransport=nethernet',
    '-DgeyserUdpAddress=0.0.0.0',
    '-DgeyserUdpPort=19135',
    '-DgeyserSignalingPort=19135',
    '-DgeyserWebrtcPort=19135',
    '-DgeyserSignalingMode=builtin',
  ]);
});

test('public advertising uses the assigned public host and port, independently of the local port', () => {
  const options = Object.freeze({ localPort: 19132, publicHost: 'bedrock.example.org', publicPort: 31000 });
  assert.ok(bedrockJvmArgs(options).includes('-DgeyserAdvertiseAddresses=bedrock.example.org:31000'));
  assert.ok(bedrockJvmArgs({ ...options, publicHost: '203.0.113.5' }).includes('-DgeyserAdvertiseAddresses=203.0.113.5:31000'));
  for (const publicHost of ['2001:db8::5', '[2001:db8::5]']) {
    assert.ok(bedrockJvmArgs({ ...options, publicHost }).includes('-DgeyserAdvertiseAddresses=[2001:db8::5]:31000'));
  }
});

test('public advertising requires a complete assignment and valid numeric ports', () => {
  for (const options of [
    undefined, null, false, [], {},
    { localPort: 19132, publicHost: 'relay.example.org' },
    { localPort: 19132, publicPort: 31000 },
  ]) assert.throws(() => bedrockJvmArgs(options), /bedrock|port|host|assignment/i);
  for (const key of ['localPort', 'publicPort']) {
    for (const value of [0, -1, 65536, 19132.5, '19132', NaN, null]) {
      assert.throws(() => bedrockJvmArgs({ localPort: 19132, publicHost: 'relay.example.org', publicPort: 31000, [key]: value }), /port/i);
    }
  }
});

test('public host validation rejects URLs, lists, embedded ports and JVM argument text', () => {
  for (const publicHost of [
    '', ' relay.example.org', 'relay.example.org ', 'https://relay.example.org',
    'relay.example.org:31000', 'relay.example.org/path', 'one.example,two.example',
    'relay.example.org\n-Dfoo=bar', '-Dfoo=bar', 'relay..example', '999.999.999.999',
    '[2001:db8::5]:31000', 'a'.repeat(64) + '.example', 12,
    'relay.example.org\n', 'relay\n.example.org', 'fe80::1%ethernet',
  ]) assert.throws(() => bedrockJvmArgs({ localPort: 19132, publicHost, publicPort: 31000 }), /host/i, String(publicHost));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readBedrockEndpoint, rememberBedrockEndpoint, bedrockEndpointReady } = require('../src/main/bedrockEndpoint');

test('Bedrock public endpoint is remembered across restarts, scoped to profile and identity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-bedrock-endpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const endpoint = { publicHost: 'play.voxelport.in', publicPort: 26002 };
  assert.equal(readBedrockEndpoint(dir, 'profile', 'vp_identityone'), null);
  rememberBedrockEndpoint(dir, 'profile', 'vp_identityone', endpoint);
  assert.deepEqual(readBedrockEndpoint(dir, 'profile', 'vp_identityone'), endpoint);
  assert.equal(readBedrockEndpoint(dir, 'other-profile', 'vp_identityone'), null);
  assert.equal(readBedrockEndpoint(dir, 'profile', 'vp_otheridentity'), null);
  assert.ok(!fs.readFileSync(path.join(dir, 'bedrock-endpoints.json'), 'utf8').includes('vp_identityone'));
  assert.equal(bedrockEndpointReady({ ...endpoint, localPort: 19132 }, { ...endpoint, localPort: 19132 }), true);
  assert.equal(bedrockEndpointReady({ ...endpoint, localPort: 19132 }, { ...endpoint, publicPort: 26003, localPort: 19132 }), false);
  assert.equal(bedrockEndpointReady({ ...endpoint, localPort: 19132 }, { ...endpoint, publicHost: 'other.example', localPort: 19132 }), false);
  assert.equal(bedrockEndpointReady(null, { ...endpoint, localPort: 19132 }), false);
});

test('invalid or damaged endpoint cache never supplies JVM options', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-bedrock-endpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const endpoint of [{ publicHost: '-Doption=bad', publicPort: 26002 }, { publicHost: 'play.voxelport.in', publicPort: 0 }]) {
    assert.throws(() => rememberBedrockEndpoint(dir, 'profile', 'vp_identity', endpoint));
  }
  fs.writeFileSync(path.join(dir, 'bedrock-endpoints.json'), '{bad');
  assert.equal(readBedrockEndpoint(dir, 'profile', 'vp_identity'), null);
});

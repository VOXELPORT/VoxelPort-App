'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeRelayUrl, isPrivateOrLocalHost } = require('../src/main/relayUrlSafety');

test('wss:// is always allowed, any host', () => {
  assert.equal(isSafeRelayUrl('wss://relay.voxelport.in'), true);
  assert.equal(isSafeRelayUrl('wss://example.com'), true);
  assert.equal(isSafeRelayUrl('wss://203.0.113.5'), true);
});

test('plain ws:// is rejected against a remote/public host', () => {
  assert.equal(isSafeRelayUrl('ws://relay.voxelport.in'), false);
  assert.equal(isSafeRelayUrl('ws://example.com'), false);
  assert.equal(isSafeRelayUrl('ws://203.0.113.5'), false);
});

test('plain ws:// is allowed for loopback/private/link-local hosts', () => {
  assert.equal(isSafeRelayUrl('ws://127.0.0.1:8099'), true);
  assert.equal(isSafeRelayUrl('ws://localhost:8099'), true);
  assert.equal(isSafeRelayUrl('ws://10.0.0.5:8099'), true);
  assert.equal(isSafeRelayUrl('ws://172.16.0.1:8099'), true);
  assert.equal(isSafeRelayUrl('ws://192.168.1.20:8099'), true);
  assert.equal(isSafeRelayUrl('ws://169.254.1.1:8099'), true);
  assert.equal(isSafeRelayUrl('ws://[::1]:8099'), true);
});

test('non-ws(s) schemes and garbage are rejected', () => {
  assert.equal(isSafeRelayUrl('http://relay.voxelport.in'), false);
  assert.equal(isSafeRelayUrl('not a url'), false);
  assert.equal(isSafeRelayUrl(''), false);
});

test('isPrivateOrLocalHost correctly excludes similar-looking public ranges', () => {
  // 172.32.x.x is outside the 172.16.0.0/12 private block (16-31 only).
  assert.equal(isPrivateOrLocalHost('172.32.0.1'), false);
  // 192.169.x.x is not 192.168.0.0/16.
  assert.equal(isPrivateOrLocalHost('192.169.1.1'), false);
});

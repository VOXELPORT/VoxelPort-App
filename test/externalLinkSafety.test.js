'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isApprovedExternalUrl } = require('../src/main/externalLinkSafety');

test('approved https domains are allowed', () => {
  assert.equal(isApprovedExternalUrl('https://voxelport.in'), true);
  assert.equal(isApprovedExternalUrl('https://www.voxelport.in'), true);
  assert.equal(isApprovedExternalUrl('https://github.com/VOXELPORT/VoxelPort-App'), true);
  assert.equal(isApprovedExternalUrl('https://minecraft.net/eula'), true);
  assert.equal(isApprovedExternalUrl('https://adoptium.net/temurin/releases/'), true);
});

test('unapproved domains are rejected even over https', () => {
  assert.equal(isApprovedExternalUrl('https://evil.example'), false);
  assert.equal(isApprovedExternalUrl('https://voxelport.in.evil.example'), false);
  assert.equal(isApprovedExternalUrl('https://notgithub.com'), false);
});

test('dangerous schemes are always rejected', () => {
  assert.equal(isApprovedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isApprovedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isApprovedExternalUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isApprovedExternalUrl('ftp://voxelport.in/file'), false);
  assert.equal(isApprovedExternalUrl('custom-protocol://voxelport.in'), false);
});

test('plain http (not https) to an approved domain is rejected', () => {
  assert.equal(isApprovedExternalUrl('http://voxelport.in'), false);
});

test('malformed URLs are rejected, not thrown', () => {
  assert.doesNotThrow(() => isApprovedExternalUrl('not a url'));
  assert.equal(isApprovedExternalUrl('not a url'), false);
  assert.equal(isApprovedExternalUrl(''), false);
});

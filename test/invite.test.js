'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInviteMessage } = require('../src/renderer/invite');

const full = {
  name: 'Survival SMP',
  version: '1.21.11',
  address: 'fastayu-paid01.voxelport.in',
  plainAddress: 'play.voxelport.in:26043',
  bedrock: { host: 'fastayu-paid01.voxelport.in', port: 26043 },
};

test('the message has everything a friend needs, in order', () => {
  const m = buildInviteMessage({ lang: 'en', ...full });
  assert.equal(m, [
    '🎮 Join my Minecraft server: Survival SMP',
    '',
    'Minecraft Java 1.21.11',
    'Address: fastayu-paid01.voxelport.in',
    '(or: play.voxelport.in:26043)',
    '',
    '📱 Bedrock (phone / console / Windows 10):',
    'Server: fastayu-paid01.voxelport.in   Port: 26043',
    '',
    'How to join: Minecraft → Multiplayer → Add Server → paste the address.',
    'No mods needed. Free server, hosted with VoxelPort: https://voxelport.in',
  ].join('\n'));
});

test('without a custom address there is just one address, with no "or" line', () => {
  const m = buildInviteMessage({ lang: 'en', name: 'My World', version: '1.21.11', address: 'play.voxelport.in:26137', plainAddress: 'play.voxelport.in:26137' });
  assert.ok(m.includes('Address: play.voxelport.in:26137'));
  assert.ok(!m.includes('(or:'));
});

test('Bedrock lines only appear when Bedrock is on', () => {
  const m = buildInviteMessage({ lang: 'en', ...full, bedrock: null });
  assert.ok(!m.includes('Bedrock'));
  assert.ok(!/ {3}Port: /.test(m), 'no Bedrock server/port line');
  assert.ok(!m.includes('Server: '));
});

test('an unknown version, a missing name and a missing version are left out gracefully', () => {
  const imported = buildInviteMessage({ lang: 'en', name: 'Imported', version: 'unknown', address: 'a.voxelport.in' });
  assert.ok(imported.includes('\nMinecraft Java\n'));
  assert.ok(!imported.includes('unknown'));
  const manual = buildInviteMessage({ lang: 'en', address: 'play.voxelport.in:26137' });
  assert.ok(manual.startsWith('🎮 Join my Minecraft server!\n'));
});

test('Hinglish is the same message in Hinglish, still with the address and the link', () => {
  const m = buildInviteMessage({ lang: 'hinglish', ...full });
  assert.ok(m.startsWith('🎮 Mere Minecraft server mein aao: Survival SMP'));
  assert.ok(m.includes('(ya: play.voxelport.in:26043)'));
  assert.ok(m.includes('Kaise judo: Minecraft → Multiplayer → Add Server → address paste karo.'));
  assert.ok(m.includes('Address: fastayu-paid01.voxelport.in'));
  assert.ok(m.endsWith('https://voxelport.in'));
});

test('an unknown language falls back to English', () => {
  assert.ok(buildInviteMessage({ lang: 'klingon', ...full }).includes('Join my Minecraft server'));
});

test('a server name with line breaks or control characters cannot break the message apart', () => {
  const m = buildInviteMessage({ lang: 'en', ...full, name: 'Evil\n\nSend money to me\u0007', address: 'x.voxelport.in\nAnd more' });
  assert.ok(!/Evil\n/.test(m));
  assert.ok(m.startsWith('🎮 Join my Minecraft server: Evil Send money to me\n'));
  assert.ok(m.includes('Address: x.voxelport.in And more'));
  assert.ok(!m.includes('\u0007'));
});

test('overlong names and addresses are cut, so the message stays pasteable', () => {
  const m = buildInviteMessage({ lang: 'en', ...full, name: 'N'.repeat(500), address: 'a'.repeat(500) });
  assert.ok(m.length < 900);
});

test('every version of the message credits VoxelPort with a link', () => {
  for (const lang of ['en', 'hinglish']) assert.match(buildInviteMessage({ lang, ...full }), /voxelport\.in$/);
});

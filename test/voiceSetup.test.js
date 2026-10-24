'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const voiceSetup = require('../src/main/voiceSetup');

function server(t, type = 'paper') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-voice-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.mkdirSync(path.join(dir, type === 'paper' ? 'plugins' : 'mods'), { recursive: true });
  return { serverDir: dir, type, version: '1.21.1' };
}
const jar = (p, name) => fs.writeFileSync(path.join(p.serverDir, p.type === 'paper' ? 'plugins' : 'mods', name), 'x');

test('vanilla servers get no voice plan', (t) => {
  assert.equal(voiceSetup.voicePlan({ ...server(t), type: 'vanilla' }), null);
});

test('a new server plans Simple Voice Chat on 24454, skipping the Bedrock port', (t) => {
  const p = server(t);
  assert.equal(voiceSetup.voicePlan(p).plugin, 'simple');
  assert.equal(voiceSetup.voicePlan(p).port, 24454);
  assert.equal(voiceSetup.voicePlan(p, 24454).port, 24455);
});

test('an installed Plasmo Voice is kept, and two voice plugins are refused', (t) => {
  const p = server(t);
  jar(p, 'plasmovoice-paper-2.1.jar');
  const plan = voiceSetup.voicePlan(p);
  assert.equal(plan.plugin, 'plasmo');
  assert.equal(plan.installed, true);
  jar(p, 'voicechat-bukkit-2.5.jar');
  assert.throws(() => voiceSetup.voicePlan(p), /Two voice plugins/);
});

test('configuring writes the public address, keeps other settings and backs up once', async (t) => {
  const p = server(t);
  jar(p, 'voicechat-bukkit-2.5.jar');
  const plan = voiceSetup.voicePlan(p);
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, 'max_voice_distance=48.0\nport=1\n');
  const res = await voiceSetup.configureVoice({ profile: p, plan, host: 'play.voxelport.in', publicPort: 26001, running: false });
  assert.equal(res.changed, true);
  const text = fs.readFileSync(plan.file, 'utf8');
  assert.match(text, /max_voice_distance=48.0/);
  assert.match(text, /voice_host=play\.voxelport\.in:26001/);
  assert.match(text, /^port=24454$/m);
  assert.equal(fs.readFileSync(plan.file + '.voxelport-backup', 'utf8'), 'max_voice_distance=48.0\nport=1\n');
  const again = await voiceSetup.configureVoice({ profile: p, plan, host: 'play.voxelport.in', publicPort: 26001, running: false });
  assert.equal(again.changed, false, 'a second run changes nothing, so no restart is asked for');
});

test('a missing plugin is installed first; a bad relay address is refused', async (t) => {
  const p = server(t);
  const plan = voiceSetup.voicePlan(p);
  let installed = null;
  await voiceSetup.configureVoice({ profile: p, plan, host: 'play.voxelport.in', publicPort: 26001, running: false, install: async (o) => { installed = o.projectId; } });
  assert.equal(installed, 'simple-voice-chat');
  await assert.rejects(voiceSetup.configureVoice({ profile: p, plan, host: 'evil.com/x', publicPort: 26001, running: false }), /Invalid voice address/);
  await assert.rejects(voiceSetup.configureVoice({ profile: p, plan, host: 'a.b', publicPort: 70000, running: false }), /Invalid voice address/);
});

test('Plasmo config.toml keeps its other sections', () => {
  const out = voiceSetup.setTomlSection(voiceSetup.setTomlSection('[other]\nx = 1\n\n[host]\nport = 5\nzzz = 2\n', 'host', { ip: '127.0.0.1', port: 24454 }), 'host.public', { ip: 'h.example', port: 26001 });
  assert.match(out, /\[other\]\nx = 1/);
  assert.match(out, /zzz = 2/);
  assert.match(out, /\[host\.public\]\nip = "h\.example"\nport = 26001/);
});

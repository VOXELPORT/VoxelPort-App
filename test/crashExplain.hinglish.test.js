'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { explainCrash, RULES, GENERIC } = require('../src/main/crashExplain');
const HINGLISH = require('../src/main/crashExplain.hinglish');

// One console excerpt that triggers each rule.
const SAMPLES = {
  'port-in-use': ['**** FAILED TO BIND TO PORT!', 'java.net.BindException: Address already in use: bind'],
  'heap-too-big': ['Could not reserve enough space for 8388608KB object heap'],
  'out-of-memory': ['Exception in thread "Server thread" java.lang.OutOfMemoryError: Java heap space'],
  eula: ['You need to agree to the EULA in order to run the server. Go to eula.txt for more info.'],
  'mod-wrong-minecraft': ["\t - Mod 'Sodium' (sodium) 0.6.0 requires version 1.21.4 of 'minecraft', but only the wrong version is present: 26.2!"],
  'mod-missing-dependency': ["\t - Mod 'Lithium' (lithium) 0.15.0 requires any version of 'fabric-api', which is missing!", 'Incompatible mods found!'],
  mixin: ['MixinTransformerError: Mixin apply for mod coolmod failed coolmod.mixins.json'],
  'bad-jar': ['Error: Unable to access jarfile server.jar'],
  'world-locked': ['java.nio.file.FileSystemException: world\\session.lock: The process cannot access the file'],
  'no-permission': ['java.nio.file.AccessDeniedException: C:\\servers\\one\\logs'],
  'plugin-failed': ["Could not load 'plugins/Cool.jar' in folder 'plugins'"],
};

test('every rule has a Hinglish version, and nothing extra', () => {
  const ruleIds = [...RULES.map((r) => r.id), GENERIC.id].sort();
  assert.deepEqual(Object.keys(HINGLISH).sort(), ruleIds);
});

test('every rule has a sample here, so the Hinglish text is really exercised', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), RULES.map((r) => r.id).sort());
});

test('each explanation comes out in Hinglish when asked, with the same fix action', () => {
  for (const [id, lines] of Object.entries(SAMPLES)) {
    const en = explainCrash(lines, { port: 25565, crashed: true }).find((d) => d.id === id);
    const hi = explainCrash(lines, { port: 25565, crashed: true, lang: 'hinglish' }).find((d) => d.id === id);
    assert.ok(en && hi, `no diagnosis for ${id}`);
    assert.notEqual(hi.title, en.title, `${id}: title not translated`);
    assert.notEqual(hi.detail, en.detail, `${id}: detail not translated`);
    assert.deepEqual(hi.fix && hi.fix.action, en.fix && en.fix.action, `${id}: the fix must do the same thing`);
    if (en.fix) assert.notEqual(hi.fix.label, en.fix.label, `${id}: fix label not translated`);
    assert.doesNotMatch(`${hi.title} ${hi.detail}`, /undefined|\[object|NaN|\$\{/, `${id}: a value was not filled in`);
    assert.equal(hi.evidence, en.evidence, 'the console evidence is never translated');
  }
});

test('the Hinglish text still names the port, the mods and the plugin', () => {
  const d = (id, extra) => explainCrash(SAMPLES[id], { port: 25565, crashed: true, lang: 'hinglish', ...extra }).find((x) => x.id === id).detail;
  assert.match(d('port-in-use'), /25565/);
  assert.match(d('mod-missing-dependency'), /Lithium/);
  assert.match(d('mod-missing-dependency'), /fabric-api/);
  assert.match(d('mod-wrong-minecraft'), /Sodium/);
  assert.match(d('mixin'), /coolmod/);
  assert.match(d('plugin-failed'), /Cool\.jar/);
});

test('the generic crash message is translated too, with and without a description', () => {
  const withDesc = explainCrash(['Description: Exception ticking world'], { crashed: true, lang: 'hinglish' });
  assert.equal(withDesc[0].id, 'crashed');
  assert.match(withDesc[0].detail, /Exception ticking world/);
  assert.match(withDesc[0].title, /crash ho gaya/);
  const bare = explainCrash(['something odd'], { crashed: true, lang: 'hinglish' });
  assert.match(bare[0].detail, /achanak band/);
});

test('English stays the default, and an unknown language falls back to English', () => {
  const lines = SAMPLES.eula;
  assert.equal(explainCrash(lines, {})[0].title, "The Minecraft EULA hasn't been accepted");
  assert.equal(explainCrash(lines, { lang: 'klingon' })[0].title, "The Minecraft EULA hasn't been accepted");
});

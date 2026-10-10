'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { explainCrash } = require('../src/main/crashExplain');

const ids = (lines, extra) => explainCrash(lines, extra).map((d) => d.id);

test('port already in use', () => {
  const d = explainCrash([
    '[12:00:01] [Server thread/WARN]: **** FAILED TO BIND TO PORT!',
    '[12:00:01] [Server thread/WARN]: The exception was: java.net.BindException: Address already in use: bind',
  ], { port: 25565, crashed: true });
  assert.equal(d[0].id, 'port-in-use');
  assert.match(d[0].detail, /25565/);
  assert.equal(d[0].fix.action, 'settings');
});

test('RAM too high for the PC, and running out of RAM', () => {
  assert.deepEqual(ids(['Error occurred during initialization of VM', 'Could not reserve enough space for 8388608KB object heap'], { crashed: true }), ['heap-too-big']);
  assert.deepEqual(ids(['Exception in thread "Server thread" java.lang.OutOfMemoryError: Java heap space'], { crashed: true }), ['out-of-memory']);
});

test('EULA not accepted offers the EULA fix', () => {
  const d = explainCrash(['[Server thread/INFO]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.'], {});
  assert.equal(d[0].id, 'eula');
  assert.equal(d[0].fix.action, 'eula');
});

test('Fabric missing dependency names the mod and what it needs', () => {
  const d = explainCrash([
    '[main/ERROR]: Incompatible mods found!',
    "net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
    "\t - Mod 'Lithium' (lithium) 0.15.0 requires any version of 'fabric-api', which is missing!",
  ], { crashed: true });
  assert.equal(d[0].id, 'mod-missing-dependency');
  assert.match(d[0].detail, /Lithium/);
  assert.match(d[0].detail, /fabric-api/);
});

test('mod built for another Minecraft version', () => {
  const d = explainCrash([
    "\t - Mod 'Sodium' (sodium) 0.6.0 requires version 1.21.4 of 'minecraft', but only the wrong version is present: 26.2!",
  ], { crashed: true });
  assert.equal(d[0].id, 'mod-wrong-minecraft');
  assert.match(d[0].detail, /Sodium/);
});

test('mixin failure names the mod', () => {
  const d = explainCrash(['org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: Mixin apply for mod coolmod failed coolmod.mixins.json'], { crashed: true });
  assert.equal(d[0].id, 'mixin');
  assert.match(d[0].detail, /coolmod/);
});

test('broken jar, locked world, permissions, plugin', () => {
  assert.deepEqual(ids(['Error: Invalid or corrupt jarfile server.jar'], { crashed: true }), ['bad-jar']);
  assert.deepEqual(ids(['net.minecraft.world.level.storage.LevelStorageException: /world/session.lock: already locked (possibly by other Minecraft instance?)'], { crashed: true }), ['world-locked']);
  assert.deepEqual(ids(['java.nio.file.AccessDeniedException: C:\\OneDrive\\server\\world\\level.dat'], { crashed: true }), ['no-permission']);
  const d = explainCrash(["[Server thread/ERROR]: Could not load 'plugins/OldPlugin.jar' in folder 'plugins'"], { crashed: true });
  assert.equal(d[0].id, 'plugin-failed');
  assert.match(d[0].detail, /OldPlugin\.jar/);
});

test('generic crash quotes the crash report description', () => {
  const d = explainCrash([
    '---- Minecraft Crash Report ----',
    'Description: Exception in server tick loop',
    'java.lang.NullPointerException: Cannot invoke "Object.toString()"',
  ], { crashed: true });
  assert.equal(d[0].id, 'crashed');
  assert.match(d[0].detail, /Exception in server tick loop/);
});

test('a clean stop explains nothing', () => {
  assert.deepEqual(explainCrash(['[Server thread/INFO]: Stopping server', 'Saving worlds'], { crashed: false }), []);
});

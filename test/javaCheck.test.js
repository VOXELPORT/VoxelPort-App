'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredJavaMajor, requiredJavaFromLog } = require('../src/main/javaCheck');

test('requiredJavaMajor knows each Minecraft era', () => {
  assert.equal(requiredJavaMajor('26.1'), 25);
  assert.equal(requiredJavaMajor('26.2'), 25);
  assert.equal(requiredJavaMajor('26.1.2'), 25);
  assert.equal(requiredJavaMajor('1.21.8'), 21);
  assert.equal(requiredJavaMajor('1.20.5'), 21);
  assert.equal(requiredJavaMajor('1.20.4'), 17);
  assert.equal(requiredJavaMajor('1.18.2'), 17);
  assert.equal(requiredJavaMajor('1.17.1'), 16);
  assert.equal(requiredJavaMajor('1.16.5'), 8);
});

test('requiredJavaFromLog reads Paper’s message (as seen in the app console)', () => {
  assert.equal(requiredJavaFromLog(
    'Minecraft 26.1 and newer requires running the server with Java 25 or above. For information on how to update Java, see https://docs.papermc.io/misc/java-install'
  ), 25);
});

test('requiredJavaFromLog reads other common phrasings', () => {
  assert.equal(requiredJavaFromLog('Java 21 or higher is required to run this server'), 21);
  assert.equal(requiredJavaFromLog('This version of Minecraft requires Java 17'), 17);
  assert.equal(requiredJavaFromLog('Fabric Loader needs Java 25'), 25);
});

test('requiredJavaFromLog maps UnsupportedClassVersionError to a Java major', () => {
  assert.equal(requiredJavaFromLog(
    'Exception in thread "main" java.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0'
  ), 25);
  assert.equal(requiredJavaFromLog('UnsupportedClassVersionError: ... (class file version 65.0)'), 21);
});

test('requiredJavaFromLog ignores ordinary server output', () => {
  for (const line of [
    'Starting minecraft server version 26.1',
    'Done (4.213s)! For help, type "help"',
    'Steve joined the game',
    '<Steve> I need Java coffee',
    'Loading libraries, please wait...',
  ]) assert.equal(requiredJavaFromLog(line), null, line);
});

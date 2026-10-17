'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactCount, kind, words, hitMeta, installedLine, progressLine } = require('../src/renderer/addonsText');

const t = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

test('download counts are short and round sensibly', () => {
  const cases = [[0, '0'], [7, '7'], [950, '950'], [999, '999'], [1000, '1K'], [1200, '1.2K'], [9999, '10K'], [10400, '10K'], [48000, '48K'], [999999, '1000K'],
    [1000000, '1M'], [2300000, '2.3M'], [48000000, '48M'], [1500000000, '1.5B']];
  for (const [n, text] of cases) assert.equal(compactCount(n), text, String(n));
  for (const bad of [undefined, null, NaN, -5, 'x']) assert.equal(compactCount(bad), '0', String(bad));
});

test('Paper takes plugins, Fabric takes mods, Vanilla neither', () => {
  assert.equal(kind('paper'), 'plugins');
  assert.equal(kind('fabric'), 'mods');
  for (const other of ['vanilla', '', undefined, null, 'spigot']) assert.equal(kind(other), '', String(other));
});

test('the screen speaks of plugins for Paper and of mods for Fabric', () => {
  const paper = words('paper', t);
  const fabric = words('fabric', t);
  assert.equal(paper.title, 'PLUGINS');
  assert.equal(paper.button, 'Plugins');
  assert.match(paper.intro, /plugin/);
  assert.doesNotMatch(paper.intro, /\bmods?\b/);
  assert.equal(paper.search, 'Search plugins');
  assert.equal(paper.folder, 'Open plugins folder');
  assert.equal(fabric.title, 'MODS');
  assert.equal(fabric.button, 'Mods');
  assert.match(fabric.intro, /\bmod\b/);
  assert.doesNotMatch(fabric.intro, /plugin/);
  assert.equal(fabric.folder, 'Open mods folder');
  assert.match(paper.intro + fabric.intro, /only install ones you trust/, 'both warn that they run code');
});

test('a result says who made it and how popular it is', () => {
  assert.equal(hitMeta({ author: 'zed', downloads: 48000 }, t), 'by zed · 48K downloads');
  assert.equal(hitMeta({ author: '', downloads: 12 }, t), '12 downloads');
  assert.equal(hitMeta({}, t), '0 downloads');
  assert.equal(hitMeta(null, t), '0 downloads');
});

test('after an install it names what was added, and says to restart only if the server is running', () => {
  assert.equal(installedLine(['Fabric API', 'Lithium'], false, t), 'Installed: Fabric API, Lithium.');
  assert.equal(installedLine(['EssentialsX'], true, t), 'Installed: EssentialsX. Restart the server to use it.');
  assert.equal(installedLine(undefined, false, t), 'Installed: .');
});

test('the progress line follows the install', () => {
  assert.equal(progressLine({ stage: 'resolve', title: 'Lithium' }, t), 'Getting Lithium…');
  assert.equal(progressLine({ stage: 'download', title: 'Lithium', file: 'lithium-1.jar' }, t), 'Downloading Lithium…');
  assert.equal(progressLine({ stage: 'download', file: 'x.jar' }, t), 'Downloading x.jar…');
  assert.equal(progressLine({ stage: 'done' }, t), '');
  assert.equal(progressLine(null, t), '');
});

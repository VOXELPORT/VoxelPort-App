'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').replace(/\r\n/g, '\n'); // CI on Windows checks files out with CRLF

test('every public start goes through startTunnelInternal, which checks the Discord gate before it starts anything', () => {
  const begin = source.indexOf('async function startTunnelInternal');
  assert.ok(begin > 0, 'startTunnelInternal exists');
  const end = source.indexOf('\n}\n', begin);
  const body = source.slice(begin, end);
  const starts = [...source.matchAll(/\btunnel\.start\(/g)].map((m) => m.index);
  assert.equal(starts.length, 1, 'there must be exactly one place that starts the tunnel');
  assert.ok(starts[0] > begin && starts[0] < end, 'and it must be inside startTunnelInternal');
  const gateAt = body.indexOf('currentGate()');
  assert.ok(gateAt >= 0 && begin + gateAt < starts[0], 'the gate is consulted before the tunnel starts');
  assert.match(body, /discord_required/);
});

test('the install record is taken before the device token is created', () => {
  const record = source.indexOf('recordInstall(');
  const token = source.indexOf('loadOrCreateToken(userDataDir()');
  assert.ok(record > 0 && token > 0 && record < token);
});

test('the first-run wall only covers the app when the accounts service could be reached', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'discord-ui.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /reachable: !!snap\.config/);
  assert.match(ui, /state\.reachable/);
});

test('the main process hands the rank to the screen and the screen shows it', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'discord-ui.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /rank: snap\.standing/);
  assert.match(ui, /Your rank: \{rank\}/);
});

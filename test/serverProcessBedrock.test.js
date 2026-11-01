'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { ServerProcess } = require('../src/main/serverProcess');

const START = { serverDir: path.resolve(os.tmpdir()), minRamMb: 1024, maxRamMb: 2048 };

function processFixture(t) {
  const calls = [];
  const children = [];
  const proc = new ServerProcess({ spawnImpl: (java, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    children.push(child);
    calls.push({ java, args, options });
    return child;
  } });
  t.after(() => {
    for (const child of children) {
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
      child.emit('exit', 0);
    }
  });
  return { proc, calls, children };
}

test('ServerProcess supplies Geyser properties before -jar and keeps fixed safe argv', (t) => {
  const { proc, calls } = processFixture(t);
  proc.start({ ...START, bedrock: { localPort: 19135, publicHost: 'relay.example.org', publicPort: 31000 } });
  assert.equal(calls.length, 1);
  const { java, args, options } = calls[0];
  assert.equal(java, 'java');
  assert.deepEqual(options, { cwd: START.serverDir, shell: false });
  for (const flag of [
    '-DgeyserTransport=nethernet', '-DgeyserUdpAddress=0.0.0.0',
    '-DgeyserUdpPort=19135', '-DgeyserSignalingPort=19135',
    '-DgeyserWebrtcPort=19135', '-DgeyserSignalingMode=builtin',
    '-DgeyserAdvertiseAddresses=relay.example.org:31000',
    '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
    assert.ok(args.indexOf(flag) < args.indexOf('-jar'), `${flag} is a JVM option`);
  }
  assert.deepEqual(args.slice(-3), ['-jar', 'server.jar', 'nogui']);
});

test('first local Bedrock start works without a public assignment', (t) => {
  const { proc, calls } = processFixture(t);
  proc.start({ ...START, bedrock: { localPort: 19132 } });
  assert.ok(calls[0].args.includes('-DgeyserTransport=nethernet'));
  assert.ok(!calls[0].args.some((flag) => flag.startsWith('-DgeyserAdvertiseAddresses=')));
});

test('non-Bedrock startup has no Geyser overrides', (t) => {
  const { proc, calls } = processFixture(t);
  proc.start(START);
  assert.ok(!calls[0].args.some((flag) => flag.startsWith('-Dgeyser')));
});

test('the parent can pass null for a Java-only profile', (t) => {
  const { proc, calls } = processFixture(t);
  proc.start({ ...START, bedrock: null });
  assert.equal(calls.length, 1);
  assert.equal(proc.status, 'starting');
  assert.ok(!calls[0].args.some((flag) => flag.startsWith('-Dgeyser')));
});

test('invalid Bedrock options fail before spawning and leave a useful log', (t) => {
  for (const bedrock of [
    true, {}, { localPort: 25566, publicHost: 'https://relay.example.org', publicPort: 31000 },
    { localPort: 0 }, { localPort: 19132, publicPort: 31000 },
  ]) {
    const { proc, calls } = processFixture(t);
    const logs = [];
    proc.on('log', (line) => logs.push(line));
    assert.doesNotThrow(() => proc.start({ ...START, bedrock }));
    assert.equal(calls.length, 0);
    assert.equal(proc.child, null);
    assert.equal(proc.status, 'crashed');
    assert.match(logs.join('\n'), /Refusing to start:.*Bedrock/i);
  }
});

test('a newly assigned endpoint only takes effect on the next start and is not retained across profiles', (t) => {
  const { proc, calls, children } = processFixture(t);
  const bedrock = { localPort: 19132 };
  proc.start({ ...START, bedrock });
  bedrock.publicHost = 'relay.example.org';
  bedrock.publicPort = 31000;
  proc.start({ ...START, bedrock });
  assert.equal(calls.length, 1, 'an active Java process is not replaced or reloaded');
  assert.ok(!calls[0].args.some((flag) => flag.startsWith('-DgeyserAdvertiseAddresses=')));
  children[0].emit('exit', 0);
  proc.start({ ...START, bedrock });
  assert.ok(calls[1].args.includes('-DgeyserAdvertiseAddresses=relay.example.org:31000'));
  children[1].emit('exit', 0);
  proc.start(START);
  assert.ok(!calls[2].args.some((flag) => flag.startsWith('-Dgeyser')));
});

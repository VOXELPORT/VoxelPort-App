'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PortMapper, UpnpError, discover, isLanV4, isPublicV4 } = require('../src/main/upnp');
const { startFakeRouter } = require('./helpers/fakeRouter');

async function withRouter(opts, fn) {
  const router = await startFakeRouter(opts);
  try { await fn(router); } finally { await router.close(); }
}

const mapper = (router, extra = {}) => new PortMapper({ discoverOptions: router.discoverOptions, randomPorts: () => [25601, 25602, 25603], ...extra });

test('private and public addresses are told apart', () => {
  for (const ip of ['192.168.1.1', '10.0.0.1', '172.16.5.5', '172.31.255.255', '169.254.1.1']) assert.equal(isLanV4(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '127.0.0.1', '', 'nope', '300.1.1.1']) assert.equal(isLanV4(ip), false, ip);
  for (const ip of ['8.8.8.8', '83.45.12.9', '49.36.1.1', '172.32.0.1', '100.128.0.1']) assert.equal(isPublicV4(ip), true, ip);
  for (const ip of ['192.168.1.1', '10.1.1.1', '172.20.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '0.0.0.0', '224.0.0.1', '169.254.3.3', '198.18.0.1', '203.0.113.7', '', 'x'])
    assert.equal(isPublicV4(ip), false, ip);
});

test('it finds a router that answers the search', async () => {
  await withRouter({}, async (router) => {
    const found = await discover(router.discoverOptions);
    assert.equal(found.length, 1);
    assert.match(found[0].location, new RegExp(`^http://127\\.0\\.0\\.1:${router.httpPort}/desc\\.xml$`));
    assert.equal(found[0].localAddress, '127.0.0.1');
  });
});

test('an answer that points at a different host than the sender is ignored', async () => {
  // A device on the network must not be able to send this app off to talk to some other address.
  await withRouter({ spoofLocationHost: '10.9.9.9' }, async (router) => {
    assert.deepEqual(await discover(router.discoverOptions), []);
  });
});

test('an answer from a non-LAN address is ignored unless loopback is explicitly allowed (as in tests)', async () => {
  await withRouter({}, async (router) => {
    const strict = { ...router.discoverOptions, allowLoopback: false };
    assert.deepEqual(await discover(strict), []);
  });
});

test('it forwards a port to this PC and reports the outside address', async () => {
  await withRouter({}, async (router) => {
    const m = mapper(router);
    const out = await m.open({ internalPort: 25565 });
    assert.equal(out.externalIp, '83.45.12.9');
    assert.equal(out.externalPort, 25565);
    const held = router.mappings.get(25565);
    assert.ok(held, 'the router should hold the forwarding');
    assert.equal(held.protocol, 'TCP');
    assert.equal(held.internalPort, 25565);
    assert.equal(held.internalClient, '127.0.0.1');
    assert.equal(held.lease, 3600, 'a normal lease, so a crash does not leave the port open forever');
    assert.equal(held.description, 'VoxelPort');
    await m.close();
  });
});

test('it uses a different outside port when the router says the first is taken', async () => {
  await withRouter({ conflictPorts: [25565, 25601] }, async (router) => {
    const m = mapper(router);
    const out = await m.open({ internalPort: 25565 });
    assert.equal(out.externalPort, 25602);
    assert.equal(router.mappings.get(25602).internalPort, 25565, 'the new outside port still leads to the server\'s own port');
    assert.equal(router.mappings.has(25565), false);
    await m.close();
  });
});

test('it gives up with "conflict" when every port it tries is taken', async () => {
  await withRouter({ conflictPorts: [25565, 25601, 25602, 25603] }, async (router) => {
    await assert.rejects(mapper(router).open({ internalPort: 25565 }), (e) => e instanceof UpnpError && e.code === 'conflict');
  });
});

test('a router that only allows permanent forwardings is asked for one', async () => {
  await withRouter({ onlyPermanent: true }, async (router) => {
    const m = mapper(router);
    await m.open({ internalPort: 25565 });
    assert.equal(router.mappings.get(25565).lease, 0);
    await m.close();
    assert.equal(router.mappings.size, 0, 'it is still removed when we stop');
  });
});

test('a router behind the provider\'s shared address (CGNAT) is reported, and nothing is forwarded', async () => {
  for (const externalIp of ['100.72.1.9', '192.168.0.55', '10.20.30.40']) {
    await withRouter({ externalIp }, async (router) => {
      await assert.rejects(mapper(router).open({ internalPort: 25565 }), (e) => e.code === 'cgnat', externalIp);
      assert.equal(router.countCalls('AddPortMapping'), 0, 'no port should be opened when it cannot work');
    });
  }
});

test('a router that has no outside address yet (0.0.0.0) is not mistaken for CGNAT', async () => {
  await withRouter({ externalIp: '0.0.0.0' }, async (router) => {
    const m = mapper(router);
    const out = await m.open({ internalPort: 25565 });
    assert.equal(out.externalPort, 25565);
    await m.close();
  });
});

test('no router on the network means "no-gateway"', async () => {
  const dead = await startFakeRouter();
  const opts = dead.discoverOptions;
  await dead.close();
  await assert.rejects(new PortMapper({ discoverOptions: opts }).open({ internalPort: 25565 }), (e) => e.code === 'no-gateway');
});

test('a router with no port-forwarding service is reported as no-gateway', async () => {
  await withRouter({ noService: true }, async (router) => {
    await assert.rejects(mapper(router).open({ internalPort: 25565 }), (e) => e.code === 'no-gateway');
  });
});

test('a control address on another host is never used', async () => {
  await withRouter({ controlOnOtherHost: true }, async (router) => {
    await assert.rejects(mapper(router).open({ internalPort: 25565 }), (e) => e.code === 'no-gateway');
    assert.equal(router.countCalls('AddPortMapping'), 0);
    assert.equal(router.stray.requests, 0, 'nothing may be sent to a host other than the router that answered');
  });
});

test('a description that is far too large is refused', async () => {
  await withRouter({ hugeDescription: true }, async (router) => {
    await assert.rejects(mapper(router).open({ internalPort: 25565 }), (e) => e instanceof UpnpError);
  });
});

test('another router error is passed on once, without trying other ports', async () => {
  await withRouter({}, async (router) => {
    router.state.failAdd = true;
    router.state.failAddCode = 501;
    await assert.rejects(mapper(router).open({ internalPort: 25565 }), (e) => e.code === 'refused' && e.soapCode === 501);
    assert.equal(router.countCalls('AddPortMapping'), 1);
  });
});

test('closing removes the forwarding, and closing again or after the router is gone is harmless', async () => {
  const logs = [];
  await withRouter({}, async (router) => {
    const m = mapper(router, { log: (l) => logs.push(l) });
    await m.open({ internalPort: 25565 });
    await m.close();
    assert.equal(router.mappings.size, 0);
    await m.close(); // nothing left to remove
    assert.equal(router.countCalls('DeletePortMapping'), 1);
  });
  const router2 = await startFakeRouter();
  const m2 = new PortMapper({ discoverOptions: router2.discoverOptions, log: (l) => logs.push(l) });
  await m2.open({ internalPort: 25565 });
  await router2.close(); // the router vanishes (unplugged, rebooted)
  await m2.close(); // must not throw
  assert.ok(logs.some((l) => /could not close port/.test(l)));
});

test('the lease is renewed while open, and stops being renewed once closed', async () => {
  await withRouter({}, async (router) => {
    const m = mapper(router, { renewMs: 40 });
    await m.open({ internalPort: 25565 });
    const before = router.countCalls('AddPortMapping');
    await new Promise((r) => setTimeout(r, 200));
    const during = router.countCalls('AddPortMapping');
    assert.ok(during >= before + 2, `expected renewals, saw ${during - before}`);
    await m.close();
    const after = router.countCalls('AddPortMapping');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(router.countCalls('AddPortMapping'), after, 'no renewals after close');
  });
});

test('a failed renewal is reported so the app can tell the host', async () => {
  await withRouter({}, async (router) => {
    const lost = [];
    const m = mapper(router, { renewMs: 30 });
    m.onLost = (err) => lost.push(err);
    await m.open({ internalPort: 25565 });
    router.state.failAdd = true;
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(lost.length >= 1);
    await m.close();
  });
});

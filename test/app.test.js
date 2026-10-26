// -----------------------------------------------------------------------------
// SkyApp with the SDK's fake Gladys, the exact handlers of the container, a
// memory store, fake boxes and a virtual clock that moves (1 µs per read of
// the monotonic clock, `wait(ms)` for the rest).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, emptyData } from '../src/store.js';
import { HOST, OTHER_SERIAL, SERIAL } from './fixtures/sky.js';
import { createBox } from './helpers/fakeBox.js';
import { MINUTE, SECOND, T0, boxDevice, id, settle, setup } from './helpers/app.js';

const INTERVAL = 15 * SECOND;
const ROUND = '/as/system/information';
const IDENTITY = '/as/system/deviceinformation';

test('a typed address becomes a device; its states once created, read at once', async () => {
  const { gladys } = await setup({ created: [] });
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, id());
  assert.equal(device.name, 'Sky Q ES240');
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: HOST }]);
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  for (const key of ['power', 'online', 'wake', 'standby', 'channel', 'play', 'pause', 'key']) {
    assert.ok(keys.includes(key), key);
  }
  assert.equal(new Set(keys).size, keys.length, 'feature keys are unique');
  assert.ok(
    device.features.every((f) => f.type !== 'binary' || f.read_only),
    'no switch',
  );
  for (const f of device.features) {
    for (const option of f.supported_options ?? []) {
      assert.equal(typeof option.label, 'string', `${f.name}: label is a string`);
    }
  }
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');
});

test('a created box: power, channel, playback, disk', async () => {
  const { gladys } = await setup();
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('online')), 1);
  assert.equal(gladys.fake.lastState(id('channel')), 101);
  assert.equal(gladys.fake.lastState(id('channel_name')), 'BBC One HD');
  assert.equal(gladys.fake.lastState(id('recording')), '-');
  assert.equal(gladys.fake.lastState(id('playback')), 1);
  assert.equal(gladys.fake.lastState(id('disk')), '42 %');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a recording played, a paused one, then something else', async () => {
  const box = createBox({ uri: 'file://pvr/28E1A3C5', transport: 'PAUSED_PLAYBACK' });
  const { gladys, wait } = await setup({ boxes: [box] });
  assert.equal(gladys.fake.lastState(id('recording')), 'Planet Earth');
  assert.equal(gladys.fake.lastState(id('channel_name')), '-');
  assert.equal(gladys.fake.lastState(id('playback')), 0);
  box.uri = '';
  box.transport = 'NO_MEDIA_PRESENT';
  await wait(INTERVAL);
  assert.equal(gladys.fake.lastState(id('recording')), '-');
  assert.equal(gladys.fake.lastState(id('playback')), 2);
});

test('standby, then nothing answering: the states follow, the status too', async () => {
  const box = createBox();
  const { gladys, wait } = await setup({ boxes: [box] });
  box.standby = true;
  await wait(INTERVAL);
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.lastState(id('online')), 1);
  assert.equal(gladys.fake.lastState(id('channel_name')), '-');
  assert.equal(gladys.fake.lastState(id('playback')), 2);
  box.offline = true;
  await wait(INTERVAL);
  assert.equal(gladys.fake.lastState(id('online')), 0);
  assert.equal(gladys.fake.connectionStatus.connected, false, 'all boxes failing is not connected');
  assert.match(gladys.fake.connectionStatus.message.en, /No Sky Q box answers/);
});

test('an unknown answer publishes nothing (not off)', async () => {
  const box = createBox();
  const { gladys, wait } = await setup({ boxes: [box] });
  const before = gladys.fake.states.length;
  box.fail[IDENTITY] = 'timeout';
  await wait(INTERVAL);
  box.fail[IDENTITY] = 500;
  await wait(INTERVAL);
  box.fail[IDENTITY] = () => ({ status: 200, body: '{"serialNumber":"bad.serial"}' });
  await wait(INTERVAL);
  assert.equal(gladys.fake.states.length, before);
  delete box.fail[IDENTITY];
  box.fail['/as/system/information'] = () => ({ status: 200, body: '{"activeStandby":"yes"}' });
  box.offline = false;
  await wait(INTERVAL);
  assert.equal(gladys.fake.lastState(id('power')), 1, 'the power state is not published unknown');
});

test('pace: never sooner than the interval (rounds, check button, reconnection, restart)', async () => {
  const store = new MemoryStore();
  const { app, gladys, net, wait } = await setup({ store });
  assert.equal(net.count(ROUND), 1);
  await wait(INTERVAL - 1);
  await app.tick();
  assert.equal(net.count(ROUND), 1, 'a round asked 1 ms early reads nothing');
  await wait(1);
  assert.equal(net.count(ROUND), 2);
  // The check button and a reconnection of Gladys read nothing sooner.
  await gladys.fake.action('check_boxes');
  await app.connected();
  await settle();
  await wait(SECOND);
  assert.equal(net.count(ROUND), 2);
  await wait(INTERVAL);
  assert.equal(net.count(ROUND), 3);
  // The time of the last round is in /data before the round reads anything.
  assert.equal(typeof store.data.lastAttemptAt, 'number');
  await app.stop();

  // A restart 5 s after the last round waits the 10 s left.
  const again = await setup({ store, now: store.data.lastAttemptAt + 5 * SECOND });
  assert.equal(again.net.count(ROUND), 0);
  await again.wait(10 * SECOND - 2);
  assert.equal(again.net.count(ROUND), 0);
  await again.wait(2);
  assert.equal(again.net.count(ROUND), 1);
  await again.app.stop();
});

test('a date of last round in the future (clock set back) is brought to now', async () => {
  const data = { ...emptyData(), lastAttemptAt: T0 + 60 * MINUTE };
  const { net, wait } = await setup({ store: new MemoryStore(data) });
  assert.equal(net.count(ROUND), 0);
  await wait(INTERVAL);
  assert.equal(net.count(ROUND), 1, 'read at the interval, not an hour later');
});

test('a wall clock set forward or back does not change the pace', async () => {
  const { net, wait, wall } = await setup();
  wall.offset = 2 * 3600 * SECOND;
  await wait(INTERVAL);
  assert.equal(net.count(ROUND), 2);
  wall.offset = -3600 * SECOND;
  await wait(INTERVAL);
  assert.equal(net.count(ROUND), 3);
});

test('standby: the power key only on a box read on just now; follow-up reads', async () => {
  const box = createBox();
  const { gladys, net, command, wait } = await setup({ boxes: [box] });
  const ack = await command('standby');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(net.keyNames(), ['power']);
  assert.equal(box.standby, true);
  await wait(5 * SECOND);
  assert.equal(gladys.fake.lastState(id('power')), 0, 'read again 5 s later');
  // Already in standby: nothing sent (the key is a toggle).
  assert.equal((await command('standby')).success, true);
  assert.deepEqual(net.keyNames(), ['power']);
});

test('standby on an unknown state, an unreadable or another box: nothing sent', async () => {
  const box = createBox();
  const { net, command } = await setup({ boxes: [box] });
  box.fail['/as/system/information'] = 'timeout';
  let ack = await command('standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing sent/);
  delete box.fail['/as/system/information'];
  box.fail[IDENTITY] = () => ({ status: 200, body: '{"serialNumber":""}' });
  ack = await command('standby');
  assert.match(ack.error, /serial number unreadable: nothing sent/);
  delete box.fail[IDENTITY];
  box.serial = OTHER_SERIAL;
  ack = await command('standby');
  assert.match(ack.error, /another box answers at its address: nothing sent/);
  assert.deepEqual(net.keyNames(), []);
});

test('wake-up: "home" then "dismiss" from standby, never the power key', async () => {
  const box = createBox({ standby: true });
  const { gladys, net, command, wait } = await setup({ boxes: [box] });
  const ack = await command('wake');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(net.keyNames(), ['tvguide', 'backup']);
  const [first, second] = net.keys;
  assert.ok(second.at - first.at >= 300, 'the keys are 300 ms apart');
  await wait(5 * SECOND);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal((await command('wake')).success, true, 'already on');
  assert.deepEqual(net.keyNames(), ['tvguide', 'backup']);
});

test('a wake-up not applied is reported, never sent again', async () => {
  const box = createBox({ standby: true, applyKeys: false });
  const { net, command, wait, logs } = await setup({ boxes: [box] });
  await command('wake');
  await wait(25 * SECOND);
  assert.deepEqual(net.keyNames(), ['tvguide', 'backup']);
  assert.ok(
    logs.some((l) => /wake-up not applied/.test(l)),
    logs.join('\n'),
  );
});

test('channel: its digits 300 ms apart; checked against the channel list', async () => {
  const { gladys, net, command } = await setup();
  let ack = await command('channel', 102);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(net.keyNames(), ['1', '0', '2']);
  ack = await command('channel', 1001);
  assert.equal(ack.success, true, ack.error);
  ack = await command('channel', 555);
  assert.match(ack.error, /not in the channel list of the box: nothing sent/);
  ack = await command('channel', 1.5);
  assert.match(ack.error, /Invalid channel number: nothing sent/);
  assert.deepEqual(net.keyNames(), ['1', '0', '2', '1', '0', '0', '1']);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('buttons and the remote key dropdown', async () => {
  const { net, command } = await setup();
  assert.equal((await command('play')).success, true);
  assert.equal((await command('pause')).success, true);
  assert.equal((await command('fast_forward')).success, true);
  assert.equal((await command('key', 'red')).success, true);
  assert.equal((await command('key', 'sky')).success, true);
  const ack = await command('key', '__proto__');
  assert.match(ack.error, /Unknown key/);
  assert.deepEqual(net.keyNames(), ['play', 'pause', 'fastforward', 'red', 'sky']);
  assert.match((await command('power')).error, /Read-only or unknown feature/);
});

test('a key that may have left is "sent, without confirmation"; one refused is "nothing sent"', async () => {
  const box = createBox();
  const { command } = await setup({ boxes: [box] });
  box.fail.key = 'after';
  assert.match((await command('play')).error, /1 of 1 key\(s\) sent, without confirmation/);
  box.fail.key = 'unreachable';
  assert.match((await command('play')).error, /nothing sent/);
  box.fail.key = undefined;
  box.offline = true;
  assert.match((await command('play')).error, /identity not read.*nothing sent/);
});

test('a Sky Q Mini (IPSETTOPBOX) is read but takes no key', async () => {
  const box = createBox({ deviceType: 'IPSETTOPBOX' });
  const { gladys, net, command } = await setup({ boxes: [box] });
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('playback')), undefined, 'no SOAP transport on this type');
  assert.match((await command('play')).error, /takes no remote key/);
  assert.deepEqual(net.keyNames(), []);
});

test('a slow box: a sequence that cannot fit in the budget is not started', async () => {
  const box = createBox();
  const { net, command } = await setup({ boxes: [box] });
  box.latency = 2_000; // the identity read takes 2 s of the 3.5 s
  const ack = await command('channel', 1001);
  assert.match(ack.error, /no time left for 4 key\(s\): nothing sent/);
  assert.deepEqual(net.keyNames(), []);
});

test('commands are serialized per box, never across boxes; a scene on 5 slow boxes sets all', async () => {
  const hosts = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'];
  const serials = hosts.map((_, i) => `SERIAL000${i}`);
  const boxes = hosts.map((host, i) => createBox({ host, serial: serials[i] }));
  const devices = hosts.map((host, i) => boxDevice(serials[i], host));
  const { gladys, net, wait } = await setup({
    boxes,
    created: devices,
    config: { addresses: hosts.join(',') },
  });
  for (const box of boxes) box.latency = 300;
  const acks = devices.map((device) =>
    gladys.fake.setValue(
      device,
      device.features.find((f) => f.external_id.endsWith(':play')),
      1,
    ),
  );
  await wait(100);
  const results = await Promise.all(acks);
  assert.ok(
    results.every((r) => r.success),
    JSON.stringify(results),
  );
  assert.equal(net.keys.length, 5);
});

test('one box failing does not stop the reads of the others', async () => {
  const boxes = [createBox(), createBox({ host: '10.0.0.9', serial: OTHER_SERIAL })];
  boxes[1].fail[IDENTITY] = 503;
  const { gladys, wait } = await setup({
    boxes,
    created: [boxDevice(), boxDevice(OTHER_SERIAL, '10.0.0.9')],
    config: { addresses: `${HOST},10.0.0.9` },
  });
  // The second box was not identified (503): it is not known yet.
  assert.equal(gladys.fake.lastState(id('power')), 1);
  delete boxes[1].fail[IDENTITY];
  await wait(MINUTE);
  assert.equal(gladys.fake.lastState(id('power', OTHER_SERIAL)), 1);
});

test('another box at the address: nothing published for the first one, the other one offered', async () => {
  const box = createBox();
  const { gladys, wait, net, command } = await setup({ boxes: [box] });
  const before = gladys.fake.states.filter((s) =>
    s.device_feature_external_id.startsWith(id()),
  ).length;
  box.serial = OTHER_SERIAL;
  await wait(INTERVAL);
  const after = gladys.fake.states.filter((s) =>
    s.device_feature_external_id.startsWith(id()),
  ).length;
  assert.equal(after, before);
  assert.ok(
    gladys.fake.discoveredDevices.some((d) => d.external_id === id(undefined, OTHER_SERIAL)),
  );
  assert.match(gladys.fake.connectionStatus.message.en, /Another box answers at the address/);
  assert.match((await command('play')).error, /address unknown/);
  assert.deepEqual(net.keyNames(), []);
});

test('a box needing the Sky User-Agent: sent only to its description files, after a refusal', async () => {
  const box = createBox({ needsSkyUa: true });
  const { gladys, net, logs, wait } = await setup({ boxes: [box] });
  assert.equal(gladys.fake.lastState(id('playback')), 1);
  const sky = net.requests.filter((r) => r.ua === 'SKYPLUS_skyplus');
  assert.ok(sky.length > 0);
  for (const r of sky) {
    assert.equal(r.host, HOST);
    assert.equal(r.port, 49153);
    assert.equal(r.method, 'GET');
    assert.match(r.path, /^\/description\d+\.xml$/);
  }
  // Each file is asked with the own User-Agent first, the Sky one only after its refusal.
  for (const file of ['/description0.xml', '/description1.xml', '/description2.xml']) {
    assert.deepEqual(
      net.requests.filter((r) => r.path === file).map((r) => r.ua),
      ['gladys-sky-q', 'SKYPLUS_skyplus'],
      file,
    );
  }
  assert.equal(net.count('/description3.xml'), 0, 'found at the third file');
  // Once the control URL is known, no description file is asked again.
  const asked = net.requests.length;
  await wait(INTERVAL);
  assert.equal(
    net.requests.slice(asked).filter((r) => r.path.startsWith('/description')).length,
    0,
  );
  assert.ok(logs.some((l) => /User-Agent of the box's own software/.test(l)));
});

test('a box answering the own User-Agent never receives the Sky one', async () => {
  const { gladys, net } = await setup();
  assert.equal(gladys.fake.lastState(id('playback')), 1);
  assert.ok(net.requests.length > 0);
  assert.ok(net.requests.every((r) => r.ua !== 'SKYPLUS_skyplus'));
});

test('no SkyPlay service: looked for again only after 10 minutes', async () => {
  const box = createBox({ descriptionIndex: 99 });
  const { net, wait, logs } = await setup({ boxes: [box] });
  const asked = () =>
    net.requests.filter((r) => r.path === '/description0.xml' && r.ua === 'gladys-sky-q').length;
  assert.equal(asked(), 1);
  await wait(5 * MINUTE);
  assert.equal(asked(), 1);
  await wait(5 * MINUTE + INTERVAL);
  assert.equal(asked(), 2);
  assert.ok(logs.some((l) => /SkyPlay service was not found/.test(l)));
});

test('unreadable /data is never overwritten; a corrupt one is reported', async () => {
  const unreadable = new MemoryStore(emptyData(), { problem: 'unreadable' });
  const { gladys, wait } = await setup({ store: unreadable });
  await wait(INTERVAL * 2);
  assert.equal(unreadable.saves, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /cannot be read/);
  const corrupt = new MemoryStore(emptyData(), { problem: 'corrupt' });
  const second = await setup({ store: corrupt });
  assert.match(second.gladys.fake.connectionStatus.message.en, /sky-q.json.bad/);
  assert.ok(corrupt.saves > 0);
});

test('the configuration unreadable: status, retry every 30 s; boxes in /data take commands', async () => {
  let fail = false;
  const data = { ...emptyData(), boxes: { [SERIAL]: { serial: SERIAL, host: HOST } } };
  const { app, gladys, net, command, wait } = await setup({
    store: new MemoryStore(data),
    connect: false,
  });
  const getConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    if (fail) throw new Error('503');
    return getConfig();
  };
  await gladys.connect();
  await app.stop();
  fail = true;
  await app.connected();
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /configuration could not be read/);
  assert.equal((await command('standby')).success, true);
  assert.deepEqual(net.keyNames(), ['power']);
  fail = false;
  await wait(30 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('stop() cancels the follow-up reads and writes /data', async () => {
  const store = new MemoryStore();
  const { app, net, command, wait } = await setup({ store });
  await command('play');
  const count = net.count(ROUND);
  await app.stop();
  await wait(MINUTE);
  assert.equal(net.count(ROUND), count);
  assert.ok(store.data.boxes[SERIAL]);
});

test('invalid addresses are counted, never shown back', async () => {
  const { gladys } = await setup({
    config: { addresses: `${HOST}, <script>, 0.0.0.0, 224.0.0.1` },
  });
  const message = gladys.fake.connectionStatus.message.en;
  assert.match(message, /3 invalid address/);
  assert.doesNotMatch(message, /script|224\.0/);
});

test('find the boxes: SSDP answers asked at their address; known ones not asked again', async () => {
  const boxes = [createBox(), createBox({ host: '10.0.0.7', serial: OTHER_SERIAL })];
  const { gladys, net } = await setup({ boxes });
  gladys.fake.scanResults.ssdp = [
    { source_ip: '10.0.0.7', location: 'http://evil.example/desc.xml' },
    { source_ip: HOST },
    { source_ip: 'not an ip' },
  ];
  const before = net.count(IDENTITY);
  const ack = await gladys.fake.action('find_boxes');
  assert.match(ack.data.message.en, /2 box\(es\)/);
  assert.equal(net.count(IDENTITY), before, 'the known box is not asked again');
  assert.equal(net.count(IDENTITY, '10.0.0.7'), 1);
  assert.ok(net.requests.every((r) => r.host !== 'evil.example'));
});

test('/data lost: a created device is known again from its id, its address param only a hint', async () => {
  const box = createBox();
  const { gladys, net } = await setup({ boxes: [box], config: { addresses: '' } });
  assert.equal(gladys.fake.lastState(id('power')), 1, 'found at the address of its param');
  assert.ok(net.count(IDENTITY) >= 1);
  // A hint where another box answers does not give that address to this box.
  const other = createBox({ serial: OTHER_SERIAL });
  const second = await setup({ boxes: [other], config: { addresses: '' } });
  assert.equal(second.gladys.fake.lastState(id('power')), undefined);
  assert.ok(
    second.gladys.fake.discoveredDevices.some((d) => d.external_id === id(undefined, OTHER_SERIAL)),
  );
});

test('a power state of the wrong shape sends nothing, for standby and wake-up', async () => {
  const box = createBox();
  const { net, command } = await setup({ boxes: [box] });
  box.fail['/as/system/information'] = () => ({
    status: 200,
    body: '{"activeStandby":"false","deviceType":"GATEWAYSTB"}',
  });
  for (const key of ['standby', 'wake']) {
    const ack = await command(key);
    assert.match(ack.error, /power state unknown: nothing sent/, key);
  }
  assert.deepEqual(net.keyNames(), []);
});

test('two standby close together on a box slow to apply: one power key, the box stays in standby', async () => {
  const box = createBox({ applyDelay: 2 * SECOND });
  const { gladys, net, command, wait } = await setup({ boxes: [box] });
  const first = await command('standby', 1, { step: 100 });
  assert.equal(first.success, true, first.error);
  await wait(300);
  const second = await command('standby');
  assert.match(second.error, /not seen applied yet.*nothing sent/);
  // Sent at once (double click, scene, retry of Gladys): the same.
  const device = boxDevice();
  const feature = device.features.find((f) => f.external_id === id('standby'));
  const both = Promise.all([
    gladys.fake.setValue(device, feature, 1),
    gladys.fake.setValue(device, feature, 1),
  ]);
  await wait(100);
  await both;
  assert.deepEqual(net.keyNames(), ['power']);
  await wait(5 * SECOND);
  assert.equal(box.standby, true);
  assert.equal(gladys.fake.lastState(id('power')), 0);
  // Seen applied: the guard is lifted; a wake-up goes.
  assert.equal((await command('wake')).success, true);
  assert.deepEqual(net.keyNames(), ['power', 'tvguide', 'backup']);
});

test('a wake-up or standby never seen applied: the guard ends after 30 s', async () => {
  const box = createBox({ applyKeys: false });
  const { net, command, wait } = await setup({ boxes: [box] });
  assert.equal((await command('standby')).success, true);
  await wait(20 * SECOND);
  assert.match((await command('standby')).error, /not seen applied yet/);
  await wait(10 * SECOND);
  assert.equal((await command('standby')).success, true);
  assert.deepEqual(net.keyNames(), ['power', 'power']);
});

test('the guard ends by the follow-up read seeing the state changed, alone', async () => {
  const box = createBox({ applyDelay: 2 * SECOND });
  const { app, net, command, wait } = await setup({ boxes: [box] });
  assert.equal((await command('standby')).success, true);
  assert.ok(app.toggleGuards.has(SERIAL));
  await wait(4 * SECOND);
  assert.ok(app.toggleGuards.has(SERIAL), 'no read yet since the box applied the key');
  await wait(2 * SECOND); // the follow-up read at 5 s: no command read it
  assert.equal(app.toggleGuards.has(SERIAL), false);
  assert.deepEqual(app.data.toggleGuards, {});
  assert.deepEqual(net.keyNames(), ['power']);
});

test('the guard ends by the state read of a command seeing the state changed, alone', async () => {
  const box = createBox({ applyDelay: 2 * SECOND });
  const { app, net, command, wait } = await setup({ boxes: [box] });
  assert.equal((await command('standby')).success, true);
  await wait(3 * SECOND); // applied, before the follow-up read (5 s)
  assert.ok(app.toggleGuards.has(SERIAL));
  assert.equal((await command('wake')).success, true);
  assert.deepEqual(net.keyNames(), ['power', 'tvguide', 'backup']);
});

test('the guard ends by its time only: refused at 29 s, sent at 31 s', async () => {
  const box = createBox({ applyKeys: false });
  const { app, net, command, wait } = await setup({ boxes: [box] });
  assert.equal((await command('standby')).success, true);
  await wait(19 * SECOND); // before the follow-up read at 20 s
  await wait(10 * SECOND - 600);
  assert.match((await command('standby')).error, /not seen applied yet \(retry in up to 30 s\)/);
  await wait(2 * SECOND);
  assert.equal((await command('standby')).success, true);
  assert.deepEqual(net.keyNames(), ['power', 'power']);
  assert.deepEqual(Object.keys(app.data.toggleGuards), [SERIAL], 'the new guard is in /data');
});

test('a restart between two standby on a slow box: one power key only', async () => {
  const store = new MemoryStore();
  const first = await setup({ store, boxes: [createBox({ applyKeys: false })] });
  assert.equal((await first.command('standby')).success, true);
  await first.wait(3 * SECOND);
  await first.app.stop();
  assert.deepEqual(Object.keys(store.data.toggleGuards), [SERIAL]);
  const second = await setup({ store, boxes: [createBox()], now: first.clock.now + 2 * SECOND });
  assert.match((await second.command('standby')).error, /not seen applied yet.*nothing sent/);
  assert.deepEqual(second.net.keyNames(), []);
  await second.wait(30 * SECOND);
  assert.equal((await second.command('standby')).success, true);
  assert.deepEqual(second.net.keyNames(), ['power']);
});

test('a guard older than 30 s on the wall clock does not survive a restart', async () => {
  const store = new MemoryStore();
  const first = await setup({ store, boxes: [createBox({ applyKeys: false })] });
  assert.equal((await first.command('standby')).success, true);
  await first.app.stop();
  const second = await setup({ store, now: first.clock.now + 31 * SECOND });
  assert.equal((await second.command('standby')).success, true);
  assert.deepEqual(second.net.keyNames(), ['power']);
});

test('a restart with the wall clock set back: the guard stays alive for its duration', async () => {
  const store = new MemoryStore();
  const first = await setup({ store, boxes: [createBox({ applyKeys: false })] });
  assert.equal((await first.command('standby')).success, true);
  await first.app.stop();
  const second = await setup({ store, now: first.clock.now - 10 * MINUTE });
  assert.match((await second.command('standby')).error, /not seen applied yet/);
  await second.wait(31 * SECOND);
  assert.equal((await second.command('standby')).success, true);
});

test('/data unreadable: wake-up and standby refused until it is read again', async () => {
  const store = new MemoryStore(emptyData(), { problem: 'unreadable' });
  const { net, command, wait } = await setup({ store });
  assert.match((await command('standby')).error, /\/data cannot be read.*nothing sent/);
  await wait(60 * SECOND);
  assert.match((await command('wake')).error, /\/data cannot be read.*nothing sent/);
  assert.deepEqual(net.keyNames(), []);
  // Read again, with a guard on it: still guarded.
  const data = emptyData();
  data.toggleGuards[SERIAL] = { wallAt: T0 + 60 * SECOND, ms: 30 * SECOND, on: false };
  store.data = data;
  store.problem = undefined;
  assert.match((await command('standby')).error, /not seen applied yet/);
  await wait(31 * SECOND);
  assert.equal((await command('standby')).success, true);
  assert.deepEqual(net.keyNames(), ['power']);
});

test('the remote key dropdown never sends the power toggle', async () => {
  const { net, command } = await setup();
  const option = boxDevice().features.find((f) => f.external_id === id('key')).supported_options;
  assert.ok(option.every((o) => o.value !== 'power'));
  assert.match((await command('key', 'power')).error, /Unknown key.*nothing sent/);
  assert.deepEqual(net.keyNames(), []);
});

test('one box: commands one at a time; one still queued at its deadline is never sent late', async () => {
  const box = createBox({ latency: 450 });
  const { gladys, net, wait } = await setup({ boxes: [box] });
  const device = boxDevice();
  const feature = device.features.find((f) => f.external_id === id('play'));
  const acks = Array.from({ length: 6 }, () => gladys.fake.setValue(device, feature, 1));
  const results = [];
  acks.forEach((a, i) => a.then((r) => (results[i] = r)));
  for (let i = 0; i < 60; i += 1) await wait(100);
  await Promise.all(acks);
  // Each command: identity 450 ms + key 450 ms, one after the other.
  const at = net.keys.map((k) => k.at);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= 900, `${at}`);
  assert.ok(results.slice(0, 4).every((r) => r.success));
  assert.ok(results.slice(4).every((r) => !r.success && /nothing sent/.test(r.error)));
  const sent = net.keys.length;
  await wait(10 * SECOND);
  assert.equal(net.keys.length, sent, 'nothing sent late');
});

test('a SOAP error does not search the description files at every round', async () => {
  const box = createBox({ needsSkyUa: true });
  const { net, wait } = await setup({ boxes: [box] });
  box.fail[box.controlPath] = 500;
  const sky = () => net.requests.filter((r) => r.ua === 'SKYPLUS_skyplus').length;
  await wait(15 * SECOND);
  const after = sky();
  await wait(5 * MINUTE);
  assert.equal(sky(), after, 'no search for 10 minutes');
  await wait(6 * MINUTE);
  assert.ok(sky() > after);
});

test('a remote key from the dropdown is followed by a read', async () => {
  const { net, command, wait } = await setup();
  const before = net.count(ROUND);
  await command('key', 'red');
  await wait(5 * SECOND);
  assert.equal(net.count(ROUND), before + 1);
});

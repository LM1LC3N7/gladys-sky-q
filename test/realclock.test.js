// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTP server playing the box: the rounds really start, at 0, the
// interval and twice the interval, with a bounded number of timers. The time
// is sped up 20 times (the 15 s of the interval are 750 ms) but it is the real
// clock: it moves between any two reads of it. The pace is measured where it
// is decided (a spy on SkyApp#readBox, the read of a created box), never on
// the requests the server sees.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SkyApp } from '../src/app.js';
import { buildDevice } from '../src/model.js';
import { MemoryStore } from '../src/store.js';
import { SERIAL, deviceInformation, systemInformation } from './fixtures/sky.js';

const SPEED = 20;
const INTERVAL = 15_000;

test('real clock: rounds at 0, the interval and twice the interval; timers bounded', async () => {
  const server = createServer((req, res) => {
    const body =
      req.url === '/as/system/deviceinformation'
        ? deviceInformation()
        : req.url === '/as/system/information'
          ? systemInformation({ standby: true })
          : undefined;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const ids = createFakeGladys({ selector: 'sky-q' });
  const device = buildDevice(ids, { serial: SERIAL, host: '127.0.0.1' });
  const gladys = createFakeGladys({
    selector: 'sky-q',
    config: { addresses: '127.0.0.1' },
    devices: [device],
  });
  await gladys.connect();
  const quiet = () => {};
  const app = new SkyApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    store: new MemoryStore(),
    ports: { rest: port, soap: port, remote: port },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
  });
  const reads = [];
  const original = app.readBox.bind(app);
  app.readBox = (...args) => {
    reads.push(performance.now() * SPEED);
    return original(...args);
  };
  const started = performance.now() * SPEED;
  try {
    await app.connected();
    const deadline = started + INTERVAL;
    while (reads.length === 0 && performance.now() * SPEED < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const until = (reads[0] ?? started) + 2.5 * INTERVAL;
    while (performance.now() * SPEED < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await app.stop();
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  const at = reads.map((t) => Math.round(t - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.98 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap <= 1.5 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 12, `${timersSet} timers`);
  assert.equal(gladys.fake.lastState(ids.externalIds('box', SERIAL).feature('power')), 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

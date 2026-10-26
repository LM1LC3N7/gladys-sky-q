// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, fake boxes and a virtual clock,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SkyApp } from '../../src/app.js';
import { TIMINGS } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildDevice } from '../../src/model.js';
import { MemoryStore } from '../../src/store.js';
import { HOST, SERIAL } from '../fixtures/sky.js';
import { createFakeClock } from './fakeClock.js';
import { createBox, createFakeNet } from './fakeBox.js';

export const SELECTOR = 'sky-q';
export const T0 = Date.parse('2026-10-26T08:00:00Z');
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

const ids = createFakeGladys({ selector: SELECTOR });
export const id = (key, serial = SERIAL) =>
  key ? ids.externalIds('box', serial).feature(key) : ids.externalIds('box', serial).device;
export const boxDevice = (serial = SERIAL, host = HOST) =>
  buildDevice(ids, { serial, host, model: 'ES240' });

const tick = () => new Promise((resolve) => setImmediate(resolve));
export const settle = async () => {
  for (let i = 0; i < 20; i += 1) await tick();
};

export async function setup({
  config = { addresses: HOST },
  created = [boxDevice()],
  boxes = [createBox()],
  store = new MemoryStore(),
  now = T0,
  connect = true,
  timings = {},
  getConfig,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: created });
  if (getConfig) gladys.getConfig = getConfig;
  const { clock, timers, advance, pending } = createFakeClock(now);
  let drift = 0;
  const net = createFakeNet(clock, boxes);
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? String(a)).join(' ')}`),
    ]),
  );
  const wall = { offset: 0 };
  const app = new SkyApp({
    gladys,
    logger,
    store,
    request: net.request,
    sendKey: net.sendKey,
    now: () => clock.now + wall.offset,
    // A real monotonic clock moves between two reads of it: 1 µs per call
    // here, so that a decision reading the clock twice is caught.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    timings: { ...TIMINGS, ...timings },
  });
  registerHandlers(gladys, app, logger);
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  if (connect) {
    await gladys.connect();
    await settle();
    await wait(0);
  }
  /** A command, the virtual clock moving `step` ms at a time until it is acked. */
  const command = async (key, value = 1, { device = boxDevice(), step = 100 } = {}) => {
    const feature = device.features.find((f) => f.external_id === id(key));
    let done = false;
    const run = gladys.fake.setValue(device, feature, value).finally(() => {
      done = true;
    });
    for (let i = 0; i < 100 && !done; i += 1) {
      await wait(step);
    }
    return run;
  };
  return { app, gladys, net, clock, timers, pending, advance, wait, logs, store, wall, command };
}

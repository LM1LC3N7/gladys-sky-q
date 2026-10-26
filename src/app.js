// -----------------------------------------------------------------------------
// The integration: the Sky Q boxes it knows (typed addresses, SSDP search),
// the Gladys devices built from them, the read rounds (power, channel,
// playback, recording, disk), the commands (serialized per box, identity and
// state read again just before, everything within the time Gladys gives a
// command) and the configuration screen buttons. index.js only wires the SDK
// handlers to it.
//
// Two clocks: `now` (wall clock) only dates what /data keeps (the last round,
// so that a restart never reads sooner than the interval); `monotonic` paces
// the rounds, the budgets and the retries, so that a wall clock set back or
// forward never stops nor hurries them. One read of the monotonic clock per
// decision (`dueAt(mono)`).
//
// Power states: `online` false (nothing answers the REST port), `on` false
// (active standby), `on` true; any other answer is unknown: never published,
// never deciding a key.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseHost } from './config.js';
import {
  BUTTONS,
  DEVICE_TYPE,
  FEATURES,
  KEY_CODES,
  KEY_LABELS,
  LIMITS,
  PORTS,
  TIMINGS,
} from './constants.js';
import { T } from './i18n.js';
import { COMMANDS, buildDevice, deviceName, featureKey, stateList } from './model.js';
import { SkyClient } from './sky/client.js';
import { ERROR_KINDS, SkyError, request as defaultRequest } from './sky/http.js';
import { NO_TRANSPORT_TYPES } from './sky/parse.js';
import { sendKey as defaultSendKey } from './sky/remote.js';
import { FileStore, emptyData } from './store.js';

const BUTTON_BY_FEATURE = new Map(BUTTONS.map((b) => [b.feature, b]));
/** After these, the playback and channel are read again (follow-up reads). */
const FOLLOWED = new Set([
  FEATURES.KEY,
  FEATURES.WAKE,
  FEATURES.STANDBY,
  FEATURES.CHANNEL,
  'play',
  'pause',
  'stop',
  'channel_up',
  'channel_down',
]);

/** Runs `task` over `items`, `limit` at a time, results in order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** An error saying no key left the integration. */
const nothingSent = (message, kind = ERROR_KINDS.PROTOCOL) =>
  new SkyError(kind, `${message}: nothing sent`, { sent: false });

export class SkyApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'sky-q' }),
    store = new FileStore(),
    request = defaultRequest,
    sendKey = defaultSendKey,
    ports = PORTS,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.request = request;
    this.sendKey = sendKey;
    this.ports = ports;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.timings = timings;
    this.config = normalizeConfig();
    this.data = undefined;
    this.storeProblem = undefined;
    /** serial -> SkyClient of its current address */
    this.clients = new Map();
    /** serial -> { reading, at (monotonic) } of the last read */
    this.readings = new Map();
    /** serial -> { channels: Map sid -> channel, numbers: Set, at } */
    this.channelLists = new Map();
    /** serial -> { pvrid, title } */
    this.titles = new Map();
    /** serial -> monotonic time of the last disk read */
    this.diskAt = new Map();
    /** serial -> monotonic time from which the control URL may be searched again */
    this.descriptionNext = new Map();
    /** serial -> tail of the command queue */
    this.queues = new Map();
    /** serial -> { at (monotonic), on } of the last wake-up or standby sent */
    this.toggleGuards = new Map();
    /** /data was unreadable: a guard may exist there; toggles are refused until it is read */
    this.guardsUnknown = false;
    /** serial -> monotonic due times of the follow-up reads */
    this.followUps = new Map();
    /** serials of the devices created in Gladys */
    this.created = new Set();
    /** host -> monotonic time of the last identification */
    this.probes = new Map();
    /** serials whose address now answers with another serial number */
    this.moved = new Set();
    /** serial -> address param of a created device missing from /data (a hint only) */
    this.hints = new Map();
    /** hosts answering without a readable serial number */
    this.unidentified = new Set();
    this.backgroundTimers = new Set();
    this.generation = 0;
    this.running = false;
    this.timer = undefined;
    this.busy = undefined;
    this.lastRoundAt = undefined;
    this.lastStatus = undefined;
    this.addressesKey = undefined;
    this.lifecycle = Promise.resolve();
    this.persistTimer = undefined;
    this.configTimer = undefined;
    this.warned = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    const run = this.lifecycle.then(() => this.doStart(raw));
    this.lifecycle = run.catch(() => {});
    return run;
  }

  load() {
    if (this.data) {
      return;
    }
    let loaded;
    try {
      loaded = this.store.load();
    } catch {
      loaded = { data: emptyData(), problem: 'unreadable' };
    }
    this.data = loaded.data;
    this.storeProblem = loaded.problem;
    if (loaded.problem) {
      this.logger.warn(`/data/sky-q.json: ${loaded.problem}`);
    }
    this.guardsUnknown = loaded.problem === 'unreadable';
    // The last round before a restart: the next one never comes sooner than
    // the interval (a date in the future is brought to now).
    const at = this.now();
    const mono = this.monotonic();
    const last = this.data.lastAttemptAt;
    if (Number.isFinite(last)) {
      this.lastRoundAt = mono - (at - Math.min(last, at));
    }
  }

  /**
   * Gladys (re)connected: the configuration is read, again and again while
   * it fails (with a status saying so); the boxes in /data take commands
   * meanwhile.
   */
  async connected() {
    this.load();
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      this.logger.warn(`Could not read the configuration: ${err.message}`);
      try {
        await this.gladys.setConnectionStatus(false, T.configUnread);
        this.lastStatus = undefined;
      } catch {
        // Gladys is not reachable either: the next try says it.
      }
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connected().catch(() => {});
      }, this.timings.configRetry);
      return;
    }
    await this.start(config);
  }

  async doStart(raw) {
    this.config = normalizeConfig(raw);
    this.load();
    this.restoreGuards();
    this.running = true;
    // Republished after a (re)connection: Gladys may not hold it any more.
    this.lastStatus = undefined;
    // Whatever the state of the published values, they are read again: the
    // deduplication of the SDK starts over (reconnection, new configuration).
    await this.step('reset the published states', () => this.gladys.forgetPublishedStates?.());
    await this.step('read the Gladys devices', () => this.refreshCreated());
    const key = JSON.stringify(this.config.addresses);
    const changed = key !== this.addressesKey;
    this.addressesKey = key;
    await this.step('identify the addresses', () => this.probeAddresses(changed));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the status', () => this.updateStatus());
    this.schedule();
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  /** Stops the rounds and the background work; writes /data. */
  stop() {
    const run = this.lifecycle.then(async () => {
      this.running = false;
      this.generation += 1;
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
      for (const handle of this.backgroundTimers) {
        this.timers.clearTimeout(handle);
      }
      this.backgroundTimers.clear();
      this.followUps.clear();
      this.toggleGuards.clear();
      if (this.persistTimer) {
        this.timers.clearTimeout(this.persistTimer);
        this.persistTimer = undefined;
      }
      if (this.busy) {
        let handle;
        await Promise.race([
          this.busy.catch(() => {}),
          new Promise((resolve) => {
            handle = this.timers.setTimeout(resolve, this.timings.stopWait);
          }),
        ]);
        this.timers.clearTimeout(handle);
      }
      await this.save().catch(() => {});
    });
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** Resolves once the lifecycle and the round running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.busy;
  }

  async save() {
    if (!this.data || this.storeProblem === 'unreadable') {
      return;
    }
    await this.store.save(this.data);
  }

  persist() {
    if (this.persistTimer || this.storeProblem === 'unreadable') {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.save().catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  /** Background work, cancelled by stop(). */
  later(task, ms) {
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.backgroundTimers.delete(handle);
      if (generation === this.generation && this.running) {
        Promise.resolve()
          .then(task)
          .catch((err) => this.logger.debug?.(`Background task failed: ${err.message}`));
      }
    }, ms);
    this.backgroundTimers.add(handle);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  get boxes() {
    return Object.values(this.data?.boxes ?? {});
  }

  enqueue(serial, task) {
    const previous = this.queues.get(serial) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      serial,
      run.catch(() => {}),
    );
    return run;
  }

  // --- Pace --------------------------------------------------------------------

  interval() {
    return this.config.pollInterval * 1000;
  }

  /** The monotonic time from which the next round may start, from the caller's instant. */
  dueAt(mono) {
    return this.lastRoundAt === undefined ? mono : this.lastRoundAt + this.interval();
  }

  /** One timer: the next round when it is due. */
  schedule() {
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    const generation = this.generation;
    this.timer = this.timers.setTimeout(async () => {
      this.timer = undefined;
      await this.tick();
      if (generation === this.generation && this.running && this.timer === undefined) {
        this.schedule();
      }
    }, wait);
  }

  /** One round when it is due; a round running is never doubled. */
  tick() {
    if (this.busy) {
      return this.busy;
    }
    this.busy = this.round()
      .catch((err) => this.logger.warn(`Read round failed: ${err.message}`))
      .finally(() => {
        this.busy = undefined;
      });
    return this.busy;
  }

  async round() {
    if (!this.running || !this.data) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) {
      return;
    }
    const generation = this.generation;
    this.lastRoundAt = mono;
    // Kept BEFORE the requests: a restart during them never reads again sooner.
    this.data.lastAttemptAt = this.now();
    try {
      await this.save();
    } catch (err) {
      this.warnOnce('save', `Could not save /data: ${err.message}`);
    }
    if (generation !== this.generation) {
      return;
    }
    if (await this.probeAddresses(false)) {
      await this.publishDevices();
    }
    const budget = Math.min(10_000, Math.max(1_000, this.interval() * 0.8));
    await Promise.all(
      this.boxes
        .filter((box) => this.created.has(box.serial))
        .map((box) => this.readAndPublish(box, budget, generation)),
    );
    if (generation === this.generation) {
      await this.updateStatus();
    }
  }

  // --- Known boxes ---------------------------------------------------------------

  /** The client of a box, recreated when its address changes. */
  client(box) {
    let client = this.clients.get(box.serial);
    if (!client || client.host !== box.host) {
      client = new SkyClient({
        host: box.host,
        ports: this.ports,
        request: this.request,
        sendKey: this.sendKey,
        monotonic: this.monotonic,
        timings: this.timings,
        onUserAgent: () =>
          this.logger.info(
            `Sky Q ${box.serial}: its description files answer only to the User-Agent of the box's own software, sent to it alone`,
          ),
      });
      this.clients.set(box.serial, client);
      this.descriptionNext.delete(box.serial);
    }
    return client;
  }

  async refreshCreated() {
    const devices = await this.gladys.getDevices();
    const bySerial = new Map(
      this.boxes.map((box) => [
        this.gladys.externalIds(DEVICE_TYPE, box.serial).device,
        box.serial,
      ]),
    );
    this.created = new Set(devices.map((d) => bySerial.get(d.external_id)).filter(Boolean));
    // A device created before /data knew its box (data lost): its serial is in its id.
    const prefix = this.gladys.externalIds(DEVICE_TYPE, 'x').device.slice(0, -1);
    for (const device of devices) {
      const serial = String(device?.external_id ?? '').startsWith(prefix)
        ? device.external_id.slice(prefix.length)
        : '';
      if (/^[A-Za-z0-9-]{4,40}$/.test(serial) && !this.data.boxes[serial]) {
        const host = parseHost(device.params?.find((p) => p.name === 'IP_ADDRESS')?.value);
        this.data.boxes[serial] = { serial, host: '', model: undefined };
        this.created.add(serial);
        if (host) {
          // Only a hint: the address is used once the box answers there with this serial.
          this.hints.set(serial, host);
        }
      }
    }
  }

  boxOfDevice(device) {
    return this.boxes.find(
      (box) => this.gladys.externalIds(DEVICE_TYPE, box.serial).device === device?.external_id,
    );
  }

  /**
   * Asks the box at `host` who it is (its serial number) and remembers it.
   * Throws a SkyError when it does not answer or is not readable.
   */
  async identify(host) {
    const probe = new SkyClient({
      host,
      ports: this.ports,
      request: this.request,
      monotonic: this.monotonic,
      timings: this.timings,
    });
    const info = await probe.withBudget(this.timings.httpTimeout).deviceInformation();
    if (!info.serial) {
      this.unidentified.add(host);
      throw new SkyError(ERROR_KINDS.PROTOCOL, `${host}: no readable serial number`);
    }
    this.unidentified.delete(host);
    return this.remember(host, info);
  }

  remember(host, info) {
    const boxes = this.data.boxes;
    let box = boxes[info.serial];
    if (!box) {
      if (Object.keys(boxes).length >= LIMITS.boxes) {
        this.warnOnce('boxes', `More than ${LIMITS.boxes} boxes: the next ones are ignored`);
        return undefined;
      }
      box = { serial: info.serial, host: '', model: undefined };
      boxes[info.serial] = box;
    }
    // Another box that had this address lost it (DHCP): never commanded at an
    // address that is no longer its own; found again by the search.
    for (const other of this.boxes) {
      if (other.serial !== box.serial && other.host === host) {
        this.logger.warn(`Sky Q ${other.serial} no longer answers at ${host}`);
        other.host = '';
        this.clients.delete(other.serial);
        this.moved.add(other.serial);
      }
    }
    box.host = host;
    box.model = info.model ?? box.model;
    this.moved.delete(box.serial);
    this.hints.delete(box.serial);
    this.persist();
    return box;
  }

  /** The typed addresses (and the hints of devices without data): asked again every probeRetry while unknown. */
  async probeAddresses(force) {
    const hosts = new Set(this.config.addresses);
    for (const host of this.hints.values()) {
      hosts.add(host);
    }
    let changed = false;
    const mono = this.monotonic();
    await Promise.all(
      [...hosts].map(async (host) => {
        if (this.boxes.some((box) => box.host === host)) {
          return;
        }
        const last = this.probes.get(host);
        if (!force && last !== undefined && mono - last < this.timings.probeRetry) {
          return;
        }
        this.probes.set(host, mono);
        try {
          changed = Boolean(await this.identify(host)) || changed;
        } catch (err) {
          this.logger.debug?.(`${host}: ${err.message}`);
        }
      }),
    );
    return changed;
  }

  /** SSDP search through Gladys, then the typed addresses. */
  async scan() {
    let results = [];
    try {
      results = await this.gladys.scanNetwork('ssdp', { timeoutSeconds: this.timings.scanSeconds });
    } catch (err) {
      this.logger.warn(`SSDP search failed: ${err.message}`);
    }
    const seen = new Set();
    for (const result of Array.isArray(results) ? results.slice(0, 64) : []) {
      const host = result?.source_ip;
      if (typeof host !== 'string' || isIP(host) !== 4 || seen.has(host)) {
        continue;
      }
      seen.add(host);
      if (this.boxes.some((box) => box.host === host)) {
        continue;
      }
      try {
        // The LOCATION header is not followed: the box is asked at the address
        // that answered, on its REST port.
        await this.identify(host);
      } catch (err) {
        this.logger.debug?.(`${host} is not a Sky Q box: ${err.message}`);
      }
    }
    await this.probeAddresses(true);
    await this.publishDevices();
    return this.boxes;
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const devices = this.gladys.devices ?? [];
    await this.gladys.publishDiscoveredDevices(
      this.boxes.map((box) => {
        const id = this.gladys.externalIds(DEVICE_TYPE, box.serial).device;
        return buildDevice(
          this.gladys,
          box,
          devices.find((d) => d.external_id === id),
        );
      }),
    );
  }

  // --- Reads -----------------------------------------------------------------------

  /** Reads one box within `budget` and publishes what was read. */
  async readAndPublish(box, budget, generation = this.generation) {
    const client = box.host ? this.client(box) : undefined;
    const reading = await this.readBox(box, client, budget);
    // Another address, a stop, a new box at this address during the reads:
    // this late answer publishes nothing.
    if (generation !== this.generation || (client && this.clients.get(box.serial) !== client)) {
      return undefined;
    }
    this.readings.set(box.serial, { reading, at: this.monotonic() });
    this.checkToggleGuard(box, reading.on);
    await this.publishStates(box, reading);
    return reading;
  }

  /**
   * The guard of a wake-up or standby sent: while it lives, neither is sent
   * again (a box applies a key a few seconds later: a second toggle read on
   * the old state would undo the first). Lifted by a read showing the state
   * changed, or by time (`toggleGuard`, monotonic).
   */
  toggleGuardAlive(box, mono = this.monotonic()) {
    if (this.guardsUnknown && !this.rereadGuards()) {
      return true;
    }
    const guard = this.toggleGuards.get(box.serial);
    if (!guard) {
      return false;
    }
    if (mono - guard.at >= this.timings.toggleGuard) {
      this.dropGuard(box.serial);
      return false;
    }
    return true;
  }

  /** A read power state (`on`) that differs from the one the guard was set on lifts it. */
  checkToggleGuard(box, on) {
    const guard = this.toggleGuards.get(box.serial);
    if (guard && on !== undefined && on !== guard.on) {
      this.dropGuard(box.serial);
    }
  }

  /** The guard set before the first key byte, in memory and in /data (wall-clock time). */
  async setGuard(box, on) {
    this.toggleGuards.set(box.serial, { at: this.monotonic(), on });
    if (this.data) {
      this.data.toggleGuards ??= {};
      this.data.toggleGuards[box.serial] = {
        wallAt: this.now(),
        ms: this.timings.toggleGuard,
        on,
      };
      await this.save().catch((err) => {
        this.logger.warn(`Could not save /data: ${err.message}`);
      });
    }
  }

  dropGuard(serial) {
    this.toggleGuards.delete(serial);
    if (this.data?.toggleGuards?.[serial]) {
      delete this.data.toggleGuards[serial];
      this.persist();
    }
  }

  /**
   * The guards kept in /data, back after a restart. The monotonic clock does
   * not survive one: a guard younger than its duration on the wall clock is
   * alive, and so is one whose wall clock seems to have gone back (its age is
   * unknown: a whole duration from now).
   */
  restoreGuards() {
    const wall = this.now();
    const mono = this.monotonic();
    for (const [serial, saved] of Object.entries(this.data?.toggleGuards ?? {})) {
      if (this.toggleGuards.has(serial)) {
        continue;
      }
      const age = wall - saved.wallAt;
      if (age >= saved.ms) {
        delete this.data.toggleGuards[serial];
        continue;
      }
      this.toggleGuards.set(serial, { at: mono - Math.max(0, age), on: saved.on });
    }
  }

  /** /data read again after it was unreadable; true once it is. */
  rereadGuards() {
    let loaded;
    try {
      loaded = this.store.load();
    } catch {
      return false;
    }
    if (loaded.problem === 'unreadable') {
      return false;
    }
    this.data = loaded.data;
    this.storeProblem = loaded.problem;
    this.guardsUnknown = false;
    this.restoreGuards();
    return true;
  }

  /**
   * One read of a box: identity first (its serial number at its address),
   * then its power state, and, when on, what it shows.
   */
  async readBox(box, client, budget) {
    if (!client) {
      return { online: undefined };
    }
    const scoped = client.withBudget(budget);
    let info;
    try {
      info = await scoped.deviceInformation();
    } catch (err) {
      return { online: err.kind === ERROR_KINDS.UNREACHABLE ? false : undefined };
    }
    if (!info.serial) {
      // Unreadable is not another box: nothing concluded, nothing published.
      return { online: undefined };
    }
    if (info.serial !== box.serial) {
      this.addressTaken(box, info);
      return { online: undefined };
    }
    let system;
    try {
      system = await scoped.systemInformation();
    } catch {
      return { online: true };
    }
    box.deviceType = system.deviceType;
    const reading = {
      online: true,
      on: system.standby === undefined ? undefined : !system.standby,
    };
    await this.readDisk(box, scoped, reading);
    if (reading.on === true && !NO_TRANSPORT_TYPES.has(system.deviceType ?? '')) {
      await this.readMedia(box, scoped, info, reading);
    }
    return reading;
  }

  /** Another box answers at the address of `box` (positive proof: its serial number). */
  addressTaken(box, info) {
    const host = box.host;
    this.logger.warn(`Sky Q ${box.serial}: another box answers at ${host}`);
    box.host = '';
    this.clients.delete(box.serial);
    this.moved.add(box.serial);
    this.remember(host, info);
    this.publishDevices().catch(() => {});
  }

  async readDisk(box, client, reading) {
    const mono = this.monotonic();
    const last = this.diskAt.get(box.serial);
    if (last !== undefined && mono - last < this.timings.diskEvery) {
      return;
    }
    this.diskAt.set(box.serial, mono);
    try {
      reading.disk = await client.disk();
    } catch (err) {
      this.logger.debug?.(`Sky Q ${box.serial}: no disk information (${err.message})`);
    }
  }

  async readMedia(box, client, info, reading) {
    if (!client.controlPath) {
      const mono = this.monotonic();
      const next = this.descriptionNext.get(box.serial);
      if (next !== undefined && mono < next) {
        return;
      }
      let path;
      try {
        // Its own budget (descriptionBudget), not the rest of the round's.
        path = await (this.clients.get(box.serial) ?? client).findControlPath();
      } catch (err) {
        this.logger.debug?.(`Sky Q ${box.serial}: no UPnP description (${err.message})`);
      }
      if (!path) {
        this.descriptionNext.set(box.serial, this.monotonic() + this.timings.descriptionRetry);
        this.warnOnce(
          `control:${box.serial}`,
          `Sky Q ${box.serial}: the SkyPlay service was not found; playback and channel are not read`,
        );
        return;
      }
    }
    try {
      reading.playback = await client.transport();
    } catch (err) {
      this.soapFailed(box, client, err);
      return;
    }
    let media;
    try {
      media = await client.media();
    } catch (err) {
      this.soapFailed(box, client, err);
      return;
    }
    if (media.kind === 'live') {
      reading.media = { kind: 'live', channel: await this.channelOf(box, client, info, media.sid) };
    } else if (media.kind === 'pvr') {
      reading.media = { kind: 'pvr', title: await this.titleOf(box, client, media.pvrid) };
    } else {
      reading.media = { kind: 'other' };
    }
  }

  /**
   * A SOAP failure: on an HTTP error, the control URL is searched again,
   * but not before `descriptionRetry` (never a search at every round).
   */
  soapFailed(box, client, err) {
    if (err.kind === ERROR_KINDS.HTTP) {
      client.shared.controlPath = undefined;
      this.descriptionNext.set(box.serial, this.monotonic() + this.timings.descriptionRetry);
    }
    this.logger.debug?.(`Sky Q ${box.serial}: SOAP read failed (${err.message})`);
  }

  /** The channel of a service id, from the box's channel list (read once, again when a service is unknown). */
  async channelOf(box, client, info, sid) {
    const mono = this.monotonic();
    let list = this.channelLists.get(box.serial);
    const missing = !list || !list.bySid.has(sid);
    if (missing && info.bouquet && info.subbouquet) {
      if (!list || mono - list.at >= this.timings.channelsRetry) {
        try {
          const channels = await client.channels(info.bouquet, info.subbouquet);
          list = {
            at: mono,
            bySid: new Map(channels.map((c) => [c.sid, c])),
            numbers: new Set(channels.map((c) => c.number)),
          };
        } catch (err) {
          list = list ? { ...list, at: mono } : { at: mono, bySid: new Map(), numbers: new Set() };
          this.logger.debug?.(`Sky Q ${box.serial}: no channel list (${err.message})`);
        }
        this.channelLists.set(box.serial, list);
      }
    }
    return list?.bySid.get(sid);
  }

  async titleOf(box, client, pvrid) {
    const known = this.titles.get(box.serial);
    if (known?.pvrid === pvrid) {
      return known.title;
    }
    try {
      const title = await client.recordingTitle(pvrid);
      this.titles.set(box.serial, { pvrid, title });
      return title;
    } catch (err) {
      this.logger.debug?.(`Sky Q ${box.serial}: no recording title (${err.message})`);
      return undefined;
    }
  }

  async publishStates(box, reading) {
    const states = stateList(this.gladys, box, reading);
    if (!this.created.has(box.serial) || states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(`Could not publish the states of Sky Q ${box.serial}: ${err.message}`);
    }
  }

  /**
   * A follow-up read of one box, `ms` from now, unless one is already due
   * within 2 s of it (grouped).
   */
  followUp(box, ms, check) {
    const due = this.monotonic() + ms;
    const list = this.followUps.get(box.serial) ?? [];
    if (!check && list.some((at) => Math.abs(at - due) < 2_000)) {
      return;
    }
    list.push(due);
    this.followUps.set(box.serial, list);
    this.later(async () => {
      const left = (this.followUps.get(box.serial) ?? []).filter((at) => at !== due);
      this.followUps.set(box.serial, left);
      if (!this.created.has(box.serial)) {
        return;
      }
      const reading = await this.readAndPublish(box, this.timings.httpTimeout * 2);
      check?.(reading);
    }, ms);
  }

  // --- Commands --------------------------------------------------------------------

  async setValue(device, feature, value) {
    // Works before the configuration is read (the boxes come from /data).
    this.load();
    const box = this.boxOfDevice(device);
    if (!box) {
      throw new Error(`Unknown box ${String(device?.external_id).slice(0, 80)}`);
    }
    const key = featureKey(device.external_id, feature?.external_id);
    if (!COMMANDS.has(key)) {
      throw new Error(`Read-only or unknown feature "${String(key).slice(0, 32)}"`);
    }
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.monotonic();
    let late = false;
    const run = this.enqueue(box.serial, async () => {
      if (late || this.remaining(started) < 100) {
        // Gladys stopped waiting while this command was queued: dropped,
        // never sent late.
        late = true;
        throw nothingSent('No time left for this command', ERROR_KINDS.BUDGET);
      }
      return this.command(box, key, value, started);
    });
    // Real-time deadline (not the injectable timers): the ack Gladys waits for.
    let handle;
    const deadline = new Promise((resolve, reject) => {
      handle = setTimeout(
        () => {
          late = true;
          reject(new SkyError(ERROR_KINDS.BUDGET, 'No answer in time (box busy)'));
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(handle);
    }
  }

  /** What is left of the budget of a command started at `started`. */
  remaining(started) {
    return this.timings.commandBudget - (this.monotonic() - started);
  }

  async command(box, key, value, started) {
    if (!box.host) {
      throw nothingSent(`Sky Q ${box.serial}: address unknown, run a search`);
    }
    // Checked before reading anything: an invalid value never costs a request.
    let keys;
    if (key === FEATURES.CHANNEL) {
      keys = this.channelKeys(box, value);
    } else if (key === FEATURES.KEY) {
      const name = String(value ?? '');
      if (!Object.hasOwn(KEY_LABELS, name) || !Object.hasOwn(KEY_CODES, name)) {
        throw nothingSent(`Unknown key "${name.slice(0, 16)}"`);
      }
      keys = [name];
    } else if (BUTTON_BY_FEATURE.has(key)) {
      keys = [BUTTON_BY_FEATURE.get(key).key];
    }
    const client = this.client(box);
    const pre = client.withBudget(Math.min(this.timings.preRead, this.remaining(started)));
    let info;
    try {
      info = await pre.deviceInformation();
    } catch (err) {
      throw nothingSent(`Sky Q ${box.serial}: identity not read (${err.message})`, err.kind);
    }
    if (!info.serial) {
      throw nothingSent(`Sky Q ${box.serial}: serial number unreadable`);
    }
    if (info.serial !== box.serial) {
      this.addressTaken(box, info);
      throw nothingSent(
        `Sky Q ${box.serial}: another box answers at its address`,
        ERROR_KINDS.IDENTITY,
      );
    }
    let before;
    if (key === FEATURES.WAKE || key === FEATURES.STANDBY || box.deviceType === undefined) {
      let system;
      try {
        system = await pre.systemInformation();
      } catch (err) {
        throw nothingSent(`Sky Q ${box.serial}: state not read (${err.message})`, err.kind);
      }
      box.deviceType = system.deviceType;
      before = system.standby;
      if (before !== undefined) {
        this.checkToggleGuard(box, !before);
      }
    }
    if (NO_TRANSPORT_TYPES.has(box.deviceType ?? '')) {
      // pyskyqremote / the Home Assistant integration send no key to these types.
      throw nothingSent(
        `Sky Q ${box.serial}: this kind of box (${box.deviceType}) takes no remote key`,
      );
    }
    if ((key === FEATURES.WAKE || key === FEATURES.STANDBY) && this.toggleGuardAlive(box)) {
      throw nothingSent(
        this.guardsUnknown
          ? `Sky Q ${box.serial}: /data cannot be read, so a recent wake-up or standby cannot be ruled out (retry later)`
          : `Sky Q ${box.serial}: the previous wake-up or standby is not seen applied yet (retry in up to 30 s)`,
      );
    }
    if (key === FEATURES.WAKE) {
      if (before === false) {
        return; // Already on: nothing to send.
      }
      if (before !== true) {
        throw nothingSent(`Sky Q ${box.serial}: power state unknown`);
      }
      // As the Home Assistant integration: "home" then "dismiss" wakes the box
      // up from standby, and is not a toggle.
      keys = ['tvguide', 'backup'];
    } else if (key === FEATURES.STANDBY) {
      if (before === true) {
        return; // Already in standby: nothing to send.
      }
      if (before !== false) {
        throw nothingSent(`Sky Q ${box.serial}: power state unknown`);
      }
      // The power key is a toggle: sent only on a box read on just now.
      keys = ['power'];
    }
    const toggles = key === FEATURES.WAKE || key === FEATURES.STANDBY;
    if (toggles) {
      // Set before the first byte: a key that may have left is guarded.
      await this.setGuard(box, before === false);
    }
    try {
      await this.sendSequence(box, client, keys, started);
    } catch (err) {
      if (toggles && err.sent === false) {
        this.dropGuard(box.serial);
      }
      throw err;
    }
    this.afterCommand(box, key, value, before);
  }

  /** The digit keys of a channel number, checked against the box's channel list when known. */
  channelKeys(box, value) {
    const number = typeof value === 'number' ? value : Number(String(value ?? '').trim() || NaN);
    if (!Number.isInteger(number) || number < 1 || number > 9999) {
      throw nothingSent('Invalid channel number');
    }
    const list = this.channelLists.get(box.serial);
    if (list && list.numbers.size > 0 && !list.numbers.has(number)) {
      throw nothingSent(`Channel ${number} is not in the channel list of the box`);
    }
    return String(number).split('');
  }

  /**
   * The keys one after the other, `keyGap` apart, all within the budget: a
   * sequence that cannot fit is not started.
   */
  async sendSequence(box, client, keys, started) {
    const { keyEstimate, keyGap } = this.timings;
    const needed = keys.length * keyEstimate + (keys.length - 1) * keyGap;
    if (this.remaining(started) < needed) {
      throw nothingSent(
        `Sky Q ${box.serial}: no time left for ${keys.length} key(s)`,
        ERROR_KINDS.BUDGET,
      );
    }
    for (const [index, name] of keys.entries()) {
      if (index > 0) {
        await new Promise((resolve) => this.timers.setTimeout(resolve, keyGap));
      }
      try {
        await client.withBudget(this.remaining(started)).key(name);
      } catch (err) {
        if (index === 0 && err.sent === false) {
          throw nothingSent(`Sky Q ${box.serial}: ${err.message}`, err.kind);
        }
        throw new SkyError(
          err.kind ?? ERROR_KINDS.TIMEOUT,
          `Sky Q ${box.serial}: ${index + (err.sent === false ? 0 : 1)} of ${keys.length} key(s) sent, without confirmation`,
          { sent: true },
        );
      }
    }
  }

  /** Follow-up reads; for wake-up and standby, the state checked against the one before. */
  afterCommand(box, key, value, before) {
    if (!FOLLOWED.has(key)) {
      return;
    }
    const [first, last] = this.timings.followUps;
    if (key === FEATURES.WAKE || key === FEATURES.STANDBY) {
      const wanted = key === FEATURES.WAKE;
      this.followUp(box, first);
      this.followUp(box, last, (reading) => {
        if (reading?.on === undefined || reading.on === wanted) {
          return;
        }
        // Never sent again by itself (a toggle on a state misread would undo it).
        this.logger.warn(
          `${deviceName(box)} ${box.serial}: ${wanted ? 'wake-up' : 'standby'} not applied (state ${before ? 'standby' : 'on'} unchanged)`,
        );
      });
      return;
    }
    this.followUp(box, first);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(device) {
    const box = this.boxOfDevice(device);
    if (!box) {
      return;
    }
    this.created.add(box.serial);
    // Its states come with the next round (never sooner than the interval).
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    const box = this.boxOfDevice(device);
    if (box) {
      this.created.delete(box.serial);
      await this.updateStatus();
    }
  }

  // --- Configuration screen buttons -------------------------------------------------

  async findBoxes() {
    const boxes = await this.scan();
    await this.updateStatus();
    return T.found(boxes.map((box) => `${box.serial} (${box.host || '?'})`));
  }

  /**
   * The state of every known box from the last round (never a read sooner
   * than the interval: a round is started only when it is due).
   */
  async checkBoxes() {
    if (this.boxes.length === 0) {
      return T.checkNone;
    }
    await this.tick();
    const mono = this.monotonic();
    const lines = await mapLimit(this.boxes, this.timings.checkConcurrency, async (box) => {
      const last = this.readings.get(box.serial);
      const seconds = last ? Math.max(0, Math.floor((mono - last.at) / 1000)) : undefined;
      return T.checkLine(box, last?.reading, seconds);
    });
    return T.check(lines);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.running) {
      return;
    }
    const notes = [];
    if (this.storeProblem === 'unreadable') {
      notes.push(T.dataUnreadable);
    } else if (this.storeProblem === 'corrupt') {
      notes.push(T.dataCorrupt);
    }
    if (this.config.invalid > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const moved = [...this.moved].filter((serial) => this.created.has(serial));
    if (moved.length > 0) {
      notes.push(T.moved(moved));
    }
    if (this.unidentified.size > 0) {
      notes.push(T.unidentified([...this.unidentified].slice(0, 5)));
    }
    const created = this.boxes.filter((box) => this.created.has(box.serial));
    let connected = true;
    if (this.boxes.length === 0) {
      notes.unshift(T.noBox);
    } else if (created.length > 0) {
      const read = created.filter((box) => this.readings.has(box.serial));
      const answering = read.filter((box) => this.readings.get(box.serial).reading.online === true);
      if (read.length === created.length && answering.length === 0) {
        connected = false;
        notes.unshift(T.noneAnswers(created.map((box) => box.serial)));
      }
    }
    const message =
      notes.length > 0
        ? { en: notes.map((n) => n.en).join(' '), fr: notes.map((n) => n.fr).join(' ') }
        : undefined;
    const key = JSON.stringify({ connected, message });
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}

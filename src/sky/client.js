// -----------------------------------------------------------------------------
// One Sky Q box at one address: its REST API (port 9006), its SkyPlay SOAP
// service (port 49153, found through its UPnP description files) and its
// remote control port (49160). `withBudget(ms)` gives a view of the same box
// whose requests all end before a shared deadline (a command, a read round).
//
// The User-Agent "SKYPLUS_skyplus" (agreed by the maintainer for this module
// only, the box's own software sends it): the description files are first
// asked with this integration's own User-Agent. The box's one is sent only
// when the own one is refused: the same file again after an answer other
// than 200 and 404 (or no answer), and every file not asked so after a full
// pass where no file answered 200. Only to the box's own address, on its
// UPnP port, for these files: no other request ever carries it. Once one
// User-Agent got a 200, the other is not tried again for this box until the
// client is replaced (new address, restart).
// -----------------------------------------------------------------------------

import { KEY_CODES, LIMITS, PORTS, TIMINGS } from '../constants.js';
import {
  ERROR_KINDS,
  MAX_BODY,
  MAX_LARGE_BODY,
  OWN_USER_AGENT,
  SkyError,
  request as defaultRequest,
} from './http.js';
import {
  parseDescription,
  parseDeviceInformation,
  parseJson,
  parseMedia,
  parseRecordingTitle,
  parseServices,
  parseStorage,
  parseSystemInformation,
  parseTransport,
  soapAction,
  soapEnvelope,
} from './parse.js';
import { sendKey as defaultSendKey } from './remote.js';

/** The User-Agent the boxes expect on their description files (pyskyqremote `SOAP_USER_AGENT`). */
export const SKY_USER_AGENT = 'SKYPLUS_skyplus';

/** How the description files of a box are asked: unknown yet, own User-Agent, Sky's. */
export const UA_MODES = Object.freeze({ OWN: 'own', SKY: 'sky' });

export class SkyClient {
  constructor({
    host,
    ports = PORTS,
    request = defaultRequest,
    sendKey = defaultSendKey,
    monotonic = () => performance.now(),
    timings = TIMINGS,
    onUserAgent = () => {},
  }) {
    this.host = host;
    this.ports = ports;
    this.request = request;
    this.sendKeyImpl = sendKey;
    this.monotonic = monotonic;
    this.timings = timings;
    this.onUserAgent = onUserAgent;
    /** Shared by the budgeted views: what was learnt about the box. */
    this.shared = { uaMode: undefined, controlPath: undefined };
    this.deadline = undefined;
  }

  /** A view of this box whose requests end within `ms` from now. */
  withBudget(ms) {
    const view = Object.create(this);
    view.deadline = this.monotonic() + Math.max(0, ms);
    return view;
  }

  /** The time a request may take: its own timeout, cut to the deadline. */
  timeout(own) {
    if (this.deadline === undefined) {
      return own;
    }
    const left = this.deadline - this.monotonic();
    if (left < 50) {
      throw new SkyError(ERROR_KINDS.BUDGET, 'No time left');
    }
    return Math.min(own, left);
  }

  get uaMode() {
    return this.shared.uaMode;
  }

  get controlPath() {
    return this.shared.controlPath;
  }

  // --- REST --------------------------------------------------------------------

  async rest(path, maxBody = MAX_BODY) {
    const res = await this.request({
      host: this.host,
      port: this.ports.rest,
      path: `/as/${path}`,
      headers: { Accept: 'application/json' },
      timeoutMs: this.timeout(this.timings.httpTimeout),
      maxBody,
    });
    if (res.status !== 200) {
      throw new SkyError(ERROR_KINDS.HTTP, `HTTP ${res.status} on /as/${path}`, {
        status: res.status,
      });
    }
    try {
      return parseJson(res.body);
    } catch {
      throw new SkyError(ERROR_KINDS.PROTOCOL, `Unreadable answer on /as/${path}`);
    }
  }

  async deviceInformation() {
    return parseDeviceInformation(await this.rest('system/deviceinformation'));
  }

  async systemInformation() {
    return parseSystemInformation(await this.rest('system/information'));
  }

  async channels(bouquet, subbouquet) {
    return parseServices(await this.rest(`services/${bouquet}/${subbouquet}`, MAX_LARGE_BODY));
  }

  async disk() {
    return parseStorage(await this.rest('pvr/storage'));
  }

  async recordingTitle(pvrid) {
    if (!/^P[0-9A-Za-z]{1,16}$/.test(pvrid)) {
      return undefined;
    }
    return parseRecordingTitle(await this.rest(`pvr/details/${pvrid}`, MAX_LARGE_BODY));
  }

  // --- UPnP / SOAP ----------------------------------------------------------------

  /** One description file, asked with `userAgent`. */
  description(index, userAgent) {
    return this.request({
      host: this.host,
      port: this.ports.soap,
      path: `/description${index}.xml`,
      headers: { 'User-Agent': userAgent },
      timeoutMs: this.timeout(this.timings.descriptionTimeout),
    });
  }

  /** One description file with the Sky User-Agent: its body on a 200, else undefined. */
  async askWithSky(index, state) {
    state.skyAsked.add(index);
    let res;
    try {
      res = await this.description(index, SKY_USER_AGENT);
    } catch (err) {
      if (err.kind !== ERROR_KINDS.TIMEOUT && err.kind !== ERROR_KINDS.PROTOCOL) {
        throw err;
      }
      return undefined;
    }
    if (res.status !== 200) {
      return undefined;
    }
    if (this.shared.uaMode !== UA_MODES.SKY) {
      this.shared.uaMode = UA_MODES.SKY;
      this.onUserAgent();
    }
    return res.body;
  }

  /**
   * Asks one description file with the own User-Agent (unless the box is
   * known to need Sky's). Sky's is tried on the same file only after a
   * refusal of it: any answer but 200 and 404 ("no such file"), or no answer.
   * @returns {Promise<string | undefined>} the body of a 200 answer.
   */
  async describeOne(index, state) {
    const shared = this.shared;
    if (shared.uaMode === UA_MODES.SKY) {
      return this.askWithSky(index, state);
    }
    let res;
    try {
      res = await this.description(index, OWN_USER_AGENT);
    } catch (err) {
      if (err.kind !== ERROR_KINDS.TIMEOUT && err.kind !== ERROR_KINDS.PROTOCOL) {
        throw err;
      }
    }
    if (res?.status === 200) {
      shared.uaMode = UA_MODES.OWN;
      return res.body;
    }
    if (shared.uaMode === UA_MODES.OWN || res?.status === 404) {
      return undefined;
    }
    return this.askWithSky(index, state);
  }

  /**
   * The path of the SkyPlay control URL, from the description files 0 to 49
   * (as the library), within `descriptionBudget`. When no file at all
   * answered the own User-Agent, the files not asked with Sky's yet are
   * asked with it. Undefined when not found this time; throws when the port
   * does not answer at all.
   */
  async findControlPath() {
    if (this.shared.controlPath) {
      return this.shared.controlPath;
    }
    const scoped =
      this.deadline === undefined ? this.withBudget(this.timings.descriptionBudget) : this;
    const state = { skyAsked: new Set() };
    const found = (body) => {
      const path = body === undefined ? undefined : parseDescription(body);
      if (path) {
        this.shared.controlPath = path;
      }
      return path;
    };
    try {
      for (let index = 0; index < LIMITS.descriptions; index += 1) {
        const path = found(await scoped.describeOne(index, state));
        if (path) {
          return path;
        }
      }
      if (this.shared.uaMode !== undefined) {
        return undefined;
      }
      // Not one file answered the own User-Agent: the box refuses it.
      for (let index = 0; index < LIMITS.descriptions; index += 1) {
        if (!state.skyAsked.has(index)) {
          const path = found(await scoped.askWithSky(index, state));
          if (path) {
            return path;
          }
        }
      }
    } catch (err) {
      if (err.kind === ERROR_KINDS.BUDGET) {
        return undefined;
      }
      throw err;
    }
    return undefined;
  }

  async soap(action) {
    const path = this.shared.controlPath;
    if (!path) {
      throw new SkyError(ERROR_KINDS.PROTOCOL, 'SOAP control URL not found');
    }
    const res = await this.request({
      host: this.host,
      port: this.ports.soap,
      method: 'POST',
      path,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: soapAction(action),
      },
      body: soapEnvelope(action),
      timeoutMs: this.timeout(this.timings.httpTimeout),
    });
    if (res.status !== 200) {
      throw new SkyError(ERROR_KINDS.HTTP, `HTTP ${res.status} on ${action}`, {
        status: res.status,
      });
    }
    return res.body;
  }

  async transport() {
    const xml = await this.soap('GetTransportInfo');
    try {
      return parseTransport(xml);
    } catch {
      throw new SkyError(ERROR_KINDS.PROTOCOL, 'Unreadable GetTransportInfo answer');
    }
  }

  async media() {
    const xml = await this.soap('GetMediaInfo');
    try {
      return parseMedia(xml);
    } catch {
      throw new SkyError(ERROR_KINDS.PROTOCOL, 'Unreadable GetMediaInfo answer');
    }
  }

  // --- Remote ------------------------------------------------------------------------

  /** One remote key by name (KEY_CODES); `err.sent` tells whether it left. */
  async key(name) {
    if (!Object.hasOwn(KEY_CODES, name)) {
      throw new SkyError(ERROR_KINDS.PROTOCOL, 'Unknown key', { sent: false });
    }
    let timeoutMs;
    try {
      timeoutMs = this.timeout(this.timings.keyTimeout);
    } catch (err) {
      err.sent = false;
      throw err;
    }
    await this.sendKeyImpl({
      host: this.host,
      port: this.ports.remote,
      code: KEY_CODES[name],
      timeoutMs,
    });
  }
}

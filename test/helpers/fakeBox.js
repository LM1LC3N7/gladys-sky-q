// -----------------------------------------------------------------------------
// Fake Sky Q boxes behind the `request` and `sendKey` the app takes by
// injection: by address, the REST answers, the description files (one of
// them describes the SkyControl device; a box may answer them only to the
// User-Agent "SKYPLUS_skyplus"), the SOAP answers and the remote keys (the
// power key toggles the standby, "home" wakes the box up). Every request and
// key is recorded. `latency` moves the virtual clock by that much per request.
// -----------------------------------------------------------------------------

import { KEY_CODES, PORTS } from '../../src/constants.js';
import { ERROR_KINDS, SkyError } from '../../src/sky/http.js';
import {
  CONTROL_PATH,
  HOST,
  SERIAL,
  description,
  deviceInformation,
  mediaInfo,
  pvrDetails,
  services,
  storage,
  systemInformation,
  transportInfo,
} from '../fixtures/sky.js';

const CODE_NAMES = Object.fromEntries(
  Object.entries(KEY_CODES).map(([name, code]) => [code, name]),
);

export function createBox(options = {}) {
  return {
    host: HOST,
    serial: SERIAL,
    standby: false,
    deviceType: 'GATEWAYSTB',
    uri: 'xsi://869',
    transport: 'PLAYING',
    descriptionIndex: 2,
    controlPath: CONTROL_PATH,
    needsSkyUa: false,
    storage: storage(),
    title: 'Planet Earth',
    offline: false,
    /** path (or 'key') -> 'unreachable' | 'timeout' | status | (request) => answer */
    fail: {},
    latency: 0,
    ...options,
  };
}

export function createFakeNet(clock, boxes = [createBox()]) {
  const net = {
    boxes: new Map(boxes.map((box) => [box.host, box])),
    requests: [],
    keys: [],
  };
  const json = (value) => ({ status: 200, body: JSON.stringify(value) });

  net.add = (box) => net.boxes.set(box.host, box);

  net.request = async (req) => {
    const { host, port, method = 'GET', path, headers = {} } = req;
    const ua = headers['User-Agent'];
    net.requests.push({
      host,
      port,
      method,
      path,
      ua,
      soapAction: headers.SOAPACTION,
      at: clock.now,
    });
    const box = net.boxes.get(host);
    if (box?.latency) {
      clock.now += box.latency;
    }
    if (!box || box.offline) {
      throw new SkyError(ERROR_KINDS.UNREACHABLE, 'Box unreachable: ECONNREFUSED');
    }
    const failure = box.fail[path];
    if (failure === 'unreachable') {
      throw new SkyError(ERROR_KINDS.UNREACHABLE, 'Box unreachable: ECONNREFUSED');
    }
    if (failure === 'timeout') {
      throw new SkyError(ERROR_KINDS.TIMEOUT, 'Box connected but silent: timeout');
    }
    if (typeof failure === 'number') {
      return { status: failure, body: '' };
    }
    if (typeof failure === 'function') {
      return failure(req, box);
    }
    if (port === PORTS.rest) {
      if (path === '/as/system/deviceinformation')
        return json(deviceInformation({ serial: box.serial }));
      if (path === '/as/system/information') {
        return json(systemInformation({ standby: box.standby, deviceType: box.deviceType }));
      }
      if (path === '/as/services/4101/1') return json(services());
      if (path === '/as/pvr/storage') return json(box.storage);
      if (path.startsWith('/as/pvr/details/')) return json(pvrDetails(box.title));
      return { status: 404, body: '' };
    }
    if (port === PORTS.soap) {
      const match = /^\/description(\d+)\.xml$/.exec(path);
      if (method === 'GET' && match) {
        if (box.needsSkyUa && ua !== 'SKYPLUS_skyplus') {
          return { status: 403, body: '' };
        }
        return Number(match[1]) === box.descriptionIndex
          ? { status: 200, body: description({ controlURL: box.controlPath }) }
          : { status: 404, body: '' };
      }
      if (method === 'POST' && path === box.controlPath) {
        if (String(headers.SOAPACTION).includes('#GetTransportInfo')) {
          return { status: 200, body: transportInfo(box.transport) };
        }
        if (String(headers.SOAPACTION).includes('#GetMediaInfo')) {
          return { status: 200, body: mediaInfo(box.uri) };
        }
        return { status: 500, body: '' };
      }
      return { status: 404, body: '' };
    }
    throw new SkyError(ERROR_KINDS.UNREACHABLE, 'Box unreachable: ECONNREFUSED');
  };

  net.sendKey = async ({ host, port, code, timeoutMs }) => {
    const box = net.boxes.get(host);
    const name = CODE_NAMES[code];
    if (!box || box.offline || port !== PORTS.remote || box.fail.key === 'unreachable') {
      throw new SkyError(ERROR_KINDS.UNREACHABLE, 'Key not sent: ECONNREFUSED', { sent: false });
    }
    if (box.latency) {
      clock.now += box.latency;
    }
    net.keys.push({ host, name, timeoutMs, at: clock.now });
    if (box.fail.key === 'after') {
      throw new SkyError(ERROR_KINDS.TIMEOUT, 'Key sent, without confirmation', { sent: true });
    }
    if (box.applyKeys === false) {
      return;
    }
    if (name === 'power') {
      box.standby = !box.standby;
    } else if (name === 'tvguide' && box.standby) {
      box.standby = false;
    }
  };

  net.keyNames = (host = HOST) => net.keys.filter((k) => k.host === host).map((k) => k.name);
  net.count = (path, host = HOST) =>
    net.requests.filter((r) => r.path === path && r.host === host).length;
  return net;
}

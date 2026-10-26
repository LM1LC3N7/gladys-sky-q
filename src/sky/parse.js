// -----------------------------------------------------------------------------
// What a box answers, read strictly (pure functions): the REST JSON of
// `/as/system/...`, `/as/services/...` and `/as/pvr/...`, the UPnP
// description and the SOAP answers of the SkyPlay service. A field that is
// missing or of the wrong shape is "unknown" (undefined), never a default
// value. No XML library: the answers are a few flat elements, read with a
// linear `tagText`.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

/** The serial number: the stable id of a box (no `.`, `:` nor control character). */
const SERIAL = /^[A-Za-z0-9-]{4,40}$/;
const BOUQUET = /^\d{1,6}$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

const text = (value, max = 64) =>
  typeof value === 'string'
    ? value.replace(CONTROL, ' ').trim().slice(0, max) || undefined
    : undefined;

/** The JSON of an answer body; throws on anything but a JSON object. */
export function parseJson(body) {
  const value = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('not a JSON object');
  }
  return value;
}

/**
 * `/as/system/deviceinformation`: the serial number (undefined when missing
 * or invalid: the box cannot be identified), the model and what the channel
 * list needs (bouquet, sub-bouquet).
 */
export function parseDeviceInformation(json) {
  const serial = typeof json?.serialNumber === 'string' ? json.serialNumber.trim() : '';
  const bouquet = String(json?.bouquet ?? '');
  const subbouquet = String(json?.subbouquet ?? '');
  return {
    serial: SERIAL.test(serial) ? serial : undefined,
    model: text(json?.hardwareName) ?? text(json?.modelNumber),
    country: text(json?.countryCode, 8),
    bouquet: BOUQUET.test(bouquet) ? bouquet : undefined,
    subbouquet: BOUQUET.test(subbouquet) ? subbouquet : undefined,
  };
}

/**
 * `/as/system/information`: `standby` true (active standby), false (on) or
 * undefined (the field is not a boolean: unknown), and the device type
 * (the transport state is not served by the IPSETTOPBOX and TV types).
 */
export function parseSystemInformation(json) {
  const standby = json?.activeStandby;
  return {
    standby: typeof standby === 'boolean' ? standby : undefined,
    deviceType: text(json?.deviceType, 32),
    hardwareModel: text(json?.hardwareModel, 32),
  };
}

/** Device types whose UPnP transport state the library does not ask. */
export const NO_TRANSPORT_TYPES = new Set(['IPSETTOPBOX', 'TV']);

/**
 * `/as/services/<bouquet>/<subbouquet>`: the channels, `[{ number, name, sid }]`,
 * at most LIMITS.channels; entries of the wrong shape are left out.
 */
export function parseServices(json) {
  const services = Array.isArray(json?.services) ? json.services : [];
  const channels = [];
  for (const service of services) {
    if (channels.length >= LIMITS.channels) {
      break;
    }
    const number = String(service?.c ?? '');
    const sid = String(service?.sid ?? '');
    const name = text(service?.t);
    if (/^\d{1,5}$/.test(number) && /^\d{1,7}$/.test(sid) && name) {
      channels.push({ number: Number(number), name, sid: Number(sid) });
    }
  }
  return channels;
}

/** `/as/pvr/storage`: the share of the recordings disk in use (0-100, integer), or undefined. */
export function parseStorage(json) {
  const max = json?.userQuotaMax;
  const used = json?.userQuotaUsed;
  if (
    typeof max !== 'number' ||
    typeof used !== 'number' ||
    !Number.isFinite(max) ||
    !Number.isFinite(used) ||
    max <= 0 ||
    used < 0
  ) {
    return undefined;
  }
  return Math.min(100, Math.round((used / max) * 100));
}

/** `/as/pvr/details/<pvrid>`: the title of a recording, or undefined. */
export function parseRecordingTitle(json) {
  return text(json?.details?.t, 200);
}

// --- XML ----------------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the five XML entities and the numeric ones. */
export function decodeXml(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const NAME_CHAR = /[\w.-]/;
const SPACE = /\s/;
const MAX_PREFIX = 64;

/** Index of the `<` of `<name` or `<prefix:name` ending right before `index`, or -1. */
function tagOpenBefore(text, index, slash) {
  let i = index - 1;
  if (text[i] === ':') {
    let length = 0;
    i -= 1;
    while (i >= 0 && length <= MAX_PREFIX && NAME_CHAR.test(text[i])) {
      i -= 1;
      length += 1;
    }
    if (length === 0 || length > MAX_PREFIX) {
      return -1;
    }
  }
  if (slash) {
    if (text[i] !== '/') {
      return -1;
    }
    i -= 1;
  }
  return text[i] === '<' ? i : -1;
}

/**
 * The text of the first element named `name`, whatever its namespace prefix,
 * entities decoded; undefined when absent. Linear in the size of the answer
 * (indexOf for the opening tag, then for the closing one).
 */
export function tagText(xml, name) {
  const text = String(xml ?? '');
  const length = name.length;
  let nextGt = -1;
  let from = 0;
  for (;;) {
    const index = text.indexOf(name, from);
    if (index === -1) {
      return undefined;
    }
    from = index + 1;
    const after = text[index + length];
    if ((after !== '>' && !SPACE.test(after ?? '')) || tagOpenBefore(text, index, false) === -1) {
      continue;
    }
    let gt = index + length;
    if (after !== '>') {
      if (nextGt < gt) {
        nextGt = text.indexOf('>', gt);
      }
      if (nextGt === -1) {
        return undefined;
      }
      gt = nextGt;
      if (text[gt - 1] === '/') {
        return '';
      }
    }
    const start = gt + 1;
    let search = start;
    for (;;) {
      const close = text.indexOf(name, search);
      if (close === -1) {
        return undefined;
      }
      search = close + 1;
      let end = close + length;
      let spaces = 0;
      while (spaces < 16 && SPACE.test(text[end] ?? '')) {
        end += 1;
        spaces += 1;
      }
      if (text[end] === '>') {
        const open = tagOpenBefore(text, close, true);
        if (open !== -1) {
          return decodeXml(text.slice(start, open)).trim();
        }
      }
    }
  }
}

// --- UPnP / SOAP ------------------------------------------------------------------

export const SKY_PLAY_SERVICE_ID = 'urn:nds-com:serviceId:SkyPlay';
const SKY_PLAY_URN = 'urn:schemas-nds-com:service:SkyPlay:2';
const MAX_SERVICES = 32;
const CONTROL_PATH = /^\/(?!\/)[A-Za-z0-9._~/-]{0,200}$/;

/**
 * A description file (`/description<N>.xml`): the path of the SkyPlay control
 * URL when it describes the SkyControl device, else undefined. The path is
 * used on the box's own address and port only, never as a full URL.
 */
export function parseDescription(xml) {
  const body = String(xml ?? '');
  const deviceType = tagText(body, 'deviceType');
  if (!deviceType || !deviceType.includes('SkyControl')) {
    return undefined;
  }
  let from = 0;
  for (let i = 0; i < MAX_SERVICES; i += 1) {
    const start = body.indexOf('<service>', from);
    if (start === -1) {
      return undefined;
    }
    const end = body.indexOf('</service>', start);
    if (end === -1) {
      return undefined;
    }
    from = end + 10;
    const block = body.slice(start, end);
    if (tagText(block, 'serviceId') === SKY_PLAY_SERVICE_ID) {
      const path = tagText(block, 'controlURL');
      if (path && CONTROL_PATH.test(path) && !path.split('/').includes('..')) {
        return path;
      }
      return undefined;
    }
  }
  return undefined;
}

/** The SOAP envelope of a SkyPlay action (pyskyqremote `SOAP_PAYLOAD`). */
export function soapEnvelope(action) {
  return (
    "<s:Envelope xmlns:s='http://schemas.xmlsoap.org/soap/envelope/'" +
    " s:encodingStyle='http://schemas.xmlsoap.org/soap/encoding/'>" +
    `<s:Body><u:${action} xmlns:u="${SKY_PLAY_URN}">` +
    `<InstanceID>0</InstanceID></u:${action}></s:Body></s:Envelope>`
  );
}

export const soapAction = (action) => `"${SKY_PLAY_URN}#${action}"`;

/** The answer element of `action`, or throws (another service, a fault...). */
export function soapResponse(xml, action) {
  const inner = tagText(xml, `${action}Response`);
  if (inner === undefined) {
    throw new Error(`no ${action}Response`);
  }
  return xml;
}

/** MUSIC_PLAYBACK_STATE of the Gladys core: 1 playing, 0 paused, 2 idle. */
export const PLAYBACK = Object.freeze({ PLAYING: 1, PAUSED: 0, IDLE: 2 });

/**
 * `GetTransportInfo`: the playback state (pyskyqremote `TransportInfo`), or
 * undefined for a state it does not know.
 */
export function parseTransport(xml) {
  const state = tagText(soapResponse(xml, 'GetTransportInfo'), 'CurrentTransportState');
  switch (state) {
    case 'PLAYING':
    case 'TRANSITIONING':
      return PLAYBACK.PLAYING;
    case 'PAUSED_PLAYBACK':
      return PLAYBACK.PAUSED;
    case 'NO_MEDIA_PRESENT':
    case 'STOPPED':
      return PLAYBACK.IDLE;
    default:
      return undefined;
  }
}

/**
 * `GetMediaInfo`: what is shown, from its `CurrentURI` —
 * `{ kind: 'live', sid }` (`xsi://<hex service id>`), `{ kind: 'pvr', pvrid }`
 * (`file://pvr/<id>`), `{ kind: 'other' }` (anything else, empty included).
 */
export function parseMedia(xml) {
  const uri = tagText(soapResponse(xml, 'GetMediaInfo'), 'CurrentURI') ?? '';
  const live = /^xsi:\/\/([0-9A-Fa-f]{1,8})$/.exec(uri);
  if (live) {
    return { kind: 'live', sid: parseInt(live[1], 16) };
  }
  const pvr = /^file:\/\/pvr\/([0-9A-Za-z]{1,16})$/.exec(uri);
  if (pvr) {
    return { kind: 'pvr', pvrid: `P${pvr[1]}` };
  }
  return { kind: 'other' };
}

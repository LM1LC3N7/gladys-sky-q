// -----------------------------------------------------------------------------
// Boxes -> Gladys devices and states (pure). One device per box, keyed by its
// serial number: the address may change, the serial number does not.
//
// No switch, nothing an "everything on / off" (voice assistants, scenes
// `switch.*`) could turn into a command: the power state is read only, wake-up
// and standby are two push buttons. Play, pause, the channel keys... are the
// `television` types, which Gladys shows as push buttons. No volume: the box
// has no volume the network can read or set. No unit: the core lists none for
// these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { BUTTONS, DEVICE_TYPE, FEATURES, KEY_LABELS, NOTHING } from './constants.js';
import { PLAYBACK } from './sky/parse.js';

const readOnly = { read_only: true, has_feedback: false };
const button = (category, type, name) => ({ name, category, type, min: 0, max: 1 });
const readText = (name) => ({
  name,
  category: C.TEXT,
  type: T.TEXT.TEXT,
  min: 0,
  max: 0,
  ...readOnly,
});

/** The feature definitions, by frozen key, in the order they are published. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    keep_history: true,
    ...readOnly,
  },
  [FEATURES.ONLINE]: {
    name: 'Reachable',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    keep_history: true,
    ...readOnly,
  },
  [FEATURES.WAKE]: button(C.BUTTON, T.BUTTON.PUSH, 'Wake up'),
  [FEATURES.STANDBY]: button(C.BUTTON, T.BUTTON.PUSH, 'Standby'),
  [FEATURES.CHANNEL]: {
    name: 'Channel',
    category: C.TELEVISION,
    type: T.TELEVISION.CHANNEL,
    min: 1,
    max: 9999,
    has_feedback: true,
  },
  ...Object.fromEntries(
    BUTTONS.map((b) => [b.feature, button(C.TELEVISION, T.TELEVISION[b.type], b.name)]),
  ),
  [FEATURES.KEY]: {
    name: 'Remote key',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    supported_options: Object.entries(KEY_LABELS).map(([value, label]) => ({ value, label })),
  },
  [FEATURES.CHANNEL_NAME]: readText('Channel name'),
  [FEATURES.RECORDING]: readText('Recording played'),
  [FEATURES.DISK]: readText('Recordings disk used'),
  [FEATURES.PLAYBACK]: {
    name: 'Playback',
    category: C.MUSIC,
    type: T.MUSIC.PLAYBACK_STATE,
    min: 0,
    max: 3,
    ...readOnly,
  },
});

/** The keys a command may target. */
export const COMMANDS = new Set([
  FEATURES.WAKE,
  FEATURES.STANDBY,
  FEATURES.CHANNEL,
  FEATURES.KEY,
  ...BUTTONS.map((b) => b.feature),
]);

export const deviceName = (box) => (box.model ? `Sky Q ${box.model}` : 'Sky Q');

/**
 * The Gladys device of a box. `created` (the device as Gladys has it, from
 * `gladys.devices`) adds back any feature of the created device this list
 * would not have: a device published again never loses a feature.
 */
export function buildDevice(gladys, box, created = undefined) {
  const ids = gladys.externalIds(DEVICE_TYPE, box.serial);
  const features = Object.entries(FEATURE_SPECS).map(([key, spec]) => ({
    external_id: ids.feature(key),
    read_only: false,
    has_feedback: false,
    keep_history: false,
    ...spec,
    ...(spec.supported_options
      ? { supported_options: spec.supported_options.map((o) => ({ ...o })) }
      : {}),
  }));
  const known = new Set(features.map((f) => f.external_id));
  for (const feature of Array.isArray(created?.features) ? created.features : []) {
    if (feature && typeof feature.external_id === 'string' && !known.has(feature.external_id)) {
      known.add(feature.external_id);
      features.push({ ...feature });
    }
  }
  return {
    name: deviceName(box),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: box.host || '' }],
    features,
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a reading `{ online, on?, playback?, channel?, recording?, disk? }`:
 * - `online` false: not answering (power 0, reachable 0, nothing shown);
 * - `on` undefined: the box answers but its power state is unknown (only
 *   "reachable" is published);
 * - `on` false: standby (nothing shown);
 * - `on` true: what was read this time (an undefined field publishes nothing).
 * An unknown reading (`online` undefined) publishes nothing.
 */
export function stateList(gladys, box, reading) {
  if (reading?.online !== true && reading?.online !== false) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, box.serial);
  const id = (key) => ids.feature(key);
  const states = [
    { device_feature_external_id: id(FEATURES.ONLINE), state: reading.online ? 1 : 0 },
  ];
  if (reading.online && reading.disk !== undefined) {
    states.push({ device_feature_external_id: id(FEATURES.DISK), text: `${reading.disk} %` });
  }
  if (reading.online && reading.on === undefined) {
    return states;
  }
  states.push({ device_feature_external_id: id(FEATURES.POWER), state: reading.on ? 1 : 0 });
  if (!reading.on) {
    states.push(
      { device_feature_external_id: id(FEATURES.CHANNEL_NAME), text: NOTHING },
      { device_feature_external_id: id(FEATURES.RECORDING), text: NOTHING },
      { device_feature_external_id: id(FEATURES.PLAYBACK), state: PLAYBACK.IDLE },
    );
    return states;
  }
  if (reading.playback !== undefined) {
    states.push({ device_feature_external_id: id(FEATURES.PLAYBACK), state: reading.playback });
  }
  if (reading.media) {
    const { kind, channel, title } = reading.media;
    if (kind === 'live' && channel) {
      states.push(
        { device_feature_external_id: id(FEATURES.CHANNEL), state: channel.number },
        { device_feature_external_id: id(FEATURES.CHANNEL_NAME), text: channel.name },
        { device_feature_external_id: id(FEATURES.RECORDING), text: NOTHING },
      );
    } else if (kind === 'pvr') {
      states.push({ device_feature_external_id: id(FEATURES.CHANNEL_NAME), text: NOTHING });
      if (title) {
        states.push({ device_feature_external_id: id(FEATURES.RECORDING), text: title });
      }
    } else if (kind === 'other') {
      states.push(
        { device_feature_external_id: id(FEATURES.CHANNEL_NAME), text: NOTHING },
        { device_feature_external_id: id(FEATURES.RECORDING), text: NOTHING },
      );
    }
  }
  return states;
}

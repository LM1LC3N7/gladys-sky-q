// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), the ports and remote
// key codes of the boxes, limits and timings. Every key here is stored by
// Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <serial number of the box>)`. */
export const DEVICE_TYPE = 'box';

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 in standby or not answering. */
  POWER: 'power',
  /** Read only: 1 the box answers on the network (on or in standby), 0 not. */
  ONLINE: 'online',
  /** Push buttons, sent only on a state read just before, guarded until seen applied. */
  WAKE: 'wake',
  STANDBY: 'standby',
  /** The channel number: read back while live TV is shown; writing it types the digits. */
  CHANNEL: 'channel',
  /** Read only texts. */
  CHANNEL_NAME: 'channel_name',
  RECORDING: 'recording',
  DISK: 'disk',
  /** Read only: MUSIC_PLAYBACK_STATE (1 playing, 0 paused, 2 idle). */
  PLAYBACK: 'playback',
  /** Dropdown of the remote keys, never the power key. */
  KEY: 'key',
});

/**
 * Remote key codes (pyskyqremote `COMMANDS`): a key event `0xE000 + code` of
 * the RFB-like remote control protocol on port 49160.
 */
export const KEY_CODES = Object.freeze({
  power: 0,
  select: 1,
  backup: 2,
  channelup: 6,
  channeldown: 7,
  interactive: 8,
  help: 9,
  services: 10,
  tvguide: 11,
  i: 14,
  text: 15,
  up: 16,
  down: 17,
  left: 18,
  right: 19,
  red: 32,
  green: 33,
  yellow: 34,
  blue: 35,
  0: 48,
  1: 49,
  2: 50,
  3: 51,
  4: 52,
  5: 53,
  6: 54,
  7: 55,
  8: 56,
  9: 57,
  play: 64,
  pause: 65,
  stop: 66,
  record: 67,
  fastforward: 69,
  rewind: 71,
  boxoffice: 240,
  sky: 241,
});

/**
 * Labels of the "Remote key" dropdown, in the order shown. Never the power
 * key: that toggle leaves only through the guarded Standby button.
 */
export const KEY_LABELS = Object.freeze({
  sky: 'Sky',
  tvguide: 'TV guide / Home',
  services: 'Services / Search',
  interactive: 'Interactive / Sidebar',
  i: 'i (info)',
  help: 'Help',
  text: 'Text',
  boxoffice: 'Box Office',
  select: 'Select',
  backup: 'Back / Dismiss',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  channelup: 'Channel up',
  channeldown: 'Channel down',
  play: 'Play',
  pause: 'Pause',
  stop: 'Stop',
  record: 'Record',
  rewind: 'Rewind',
  fastforward: 'Fast forward',
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  0: '0',
  1: '1',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
});

/**
 * One-shot buttons with a Gladys television type (shown as push buttons):
 * feature key (frozen), type key in DEVICE_FEATURE_TYPES.TELEVISION, remote
 * key, name.
 */
export const BUTTONS = Object.freeze([
  { feature: 'play', type: 'PLAY', key: 'play', name: 'Play' },
  { feature: 'pause', type: 'PAUSE', key: 'pause', name: 'Pause' },
  { feature: 'stop', type: 'STOP', key: 'stop', name: 'Stop' },
  { feature: 'record', type: 'RECORD', key: 'record', name: 'Record' },
  { feature: 'rewind', type: 'REWIND', key: 'rewind', name: 'Rewind' },
  { feature: 'fast_forward', type: 'FORWARD', key: 'fastforward', name: 'Fast forward' },
  { feature: 'channel_up', type: 'CHANNEL_UP', key: 'channelup', name: 'Channel up' },
  { feature: 'channel_down', type: 'CHANNEL_DOWN', key: 'channeldown', name: 'Channel down' },
  { feature: 'up', type: 'UP', key: 'up', name: 'Up' },
  { feature: 'down', type: 'DOWN', key: 'down', name: 'Down' },
  { feature: 'left', type: 'LEFT', key: 'left', name: 'Left' },
  { feature: 'right', type: 'RIGHT', key: 'right', name: 'Right' },
  { feature: 'select', type: 'ENTER', key: 'select', name: 'Select' },
  { feature: 'back', type: 'RETURN', key: 'backup', name: 'Back' },
  { feature: 'sky', type: 'MENU', key: 'sky', name: 'Sky' },
  { feature: 'guide', type: 'GUIDE', key: 'tvguide', name: 'TV guide' },
  { feature: 'info', type: 'INFO', key: 'i', name: 'Info' },
]);

export const ACTIONS = Object.freeze({
  FIND: 'find_boxes',
  CHECK: 'check_boxes',
});

/** The fixed ports of a box (pyskyqremote). */
export const PORTS = Object.freeze({
  /** REST API: `/as/system/...`, `/as/services/...`, `/as/pvr/...`. */
  rest: 9006,
  /** UPnP descriptions and SOAP control. */
  soap: 49153,
  /** Remote control (key events). */
  remote: 49160,
});

/** The SSDP search target of the boxes' control device. */
export const SSDP_ST = 'urn:schemas-nds-com:device:SkyControl:2';

/** In seconds. */
export const POLL_INTERVAL = Object.freeze({ min: 5, max: 300, default: 15 });

export const TIMINGS = Object.freeze({
  /** One HTTP exchange with a box (REST or SOAP) outside a command. */
  httpTimeout: 3_000,
  /** One description file while looking for the SOAP control URL. */
  descriptionTimeout: 2_000,
  /** The whole search of the SOAP control URL (up to 50 description files). */
  descriptionBudget: 20_000,
  /** A failed search of the SOAP control URL is tried again after this. */
  descriptionRetry: 10 * 60_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (the wait
   * in the per-box queue, the identity and state read, every key) gets this.
   */
  commandBudget: 3_500,
  /** The state read just before a power key, within the command budget. */
  preRead: 1_500,
  /** One key press on the remote port (connection, handshake, key down and up). */
  keyTimeout: 1_500,
  /** Between two keys of a sequence (the channel digits). */
  keyGap: 300,
  /** The time one key of a sequence is counted for before it is started. */
  keyEstimate: 250,
  /** A wake-up or standby sent blocks the next one until the state is seen changed, or this long. */
  toggleGuard: 30_000,
  /** The follow-up reads after a command (state confirmation). */
  followUps: Object.freeze([5_000, 20_000]),
  /** The channel list is read again (at most) this often when a channel is unknown. */
  channelsRetry: 10 * 60_000,
  /** The recordings disk is read this often. */
  diskEvery: 10 * 60_000,
  /** A typed address that did not answer is asked again after this. */
  probeRetry: 60_000,
  /** Boxes asked at once by "Check the boxes". */
  checkConcurrency: 4,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** SSDP listening time of a search. */
  scanSeconds: 5,
  /** stop() waits this long at most for the read running. */
  stopWait: 3_000,
  /** A configuration Gladys could not give is asked again after this. */
  configRetry: 30_000,
});

export const LIMITS = Object.freeze({
  boxes: 10,
  addresses: 10,
  channels: 3_000,
  /** Description files tried (description0.xml ... description49.xml, as the library). */
  descriptions: 50,
});

/** Shown in a text state when there is nothing (Gladys keeps the last text otherwise). */
export const NOTHING = '-';

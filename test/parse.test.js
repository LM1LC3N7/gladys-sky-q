// -----------------------------------------------------------------------------
// The strict reading of what a box answers (pure functions).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBACK,
  parseDescription,
  parseDeviceInformation,
  parseJson,
  parseMedia,
  parseRecordingTitle,
  parseServices,
  parseStorage,
  parseSystemInformation,
  parseTransport,
  soapEnvelope,
  tagText,
} from '../src/sky/parse.js';
import { keyEvent } from '../src/sky/remote.js';
import {
  CONTROL_PATH,
  SERIAL,
  description,
  deviceInformation,
  mediaInfo,
  services,
  systemInformation,
  transportInfo,
} from './fixtures/sky.js';

test('device information: the serial number strictly, the bouquet as digits', () => {
  assert.deepEqual(parseDeviceInformation(deviceInformation()), {
    serial: SERIAL,
    model: 'ES240',
    country: 'GBR',
    bouquet: '4101',
    subbouquet: '1',
  });
  for (const serial of ['', 'a.b.c.d', 'ab:cd:ef', '../../x', 'abc', 'x'.repeat(41), 42, null]) {
    assert.equal(
      parseDeviceInformation({ serialNumber: serial }).serial,
      undefined,
      String(serial),
    );
  }
  const odd = parseDeviceInformation({ serialNumber: SERIAL, bouquet: '1/../2', subbouquet: '' });
  assert.equal(odd.bouquet, undefined);
  assert.equal(odd.subbouquet, undefined);
});

test('system information: standby only from a boolean', () => {
  assert.equal(parseSystemInformation(systemInformation({ standby: true })).standby, true);
  assert.equal(parseSystemInformation(systemInformation({ standby: false })).standby, false);
  for (const value of ['true', 1, 0, null, undefined]) {
    assert.equal(parseSystemInformation({ activeStandby: value }).standby, undefined);
  }
});

test('JSON: only an object; no prototype pollution', () => {
  assert.throws(() => parseJson('[]'));
  assert.throws(() => parseJson('null'));
  assert.throws(() => parseJson('<html>'));
  const value = parseJson('{"__proto__":{"polluted":1},"serialNumber":"0123456789A"}');
  assert.equal({}.polluted, undefined);
  assert.equal(parseDeviceInformation(value).serial, SERIAL);
});

test('channels: well-formed entries only, bounded', () => {
  const channels = parseServices({
    services: [
      ...services().services,
      { c: '1x', t: 'Bad number', sid: '1' },
      { c: '5', t: '', sid: '2' },
      { c: '6', t: 'No sid' },
      { c: '7', t: 'Control\u0000 char', sid: '3' },
    ],
  });
  assert.deepEqual(channels.slice(0, 3), [
    { number: 101, name: 'BBC One HD', sid: 2153 },
    { number: 102, name: 'BBC Two HD', sid: 2154 },
    { number: 1001, name: 'Radio One', sid: 3001 },
  ]);
  assert.equal(channels.length, 4);
  assert.equal(channels[3].name, 'Control  char');
  const many = {
    services: Array.from({ length: 5000 }, (_, i) => ({ c: `${i + 1}`, t: 'x', sid: `${i}` })),
  };
  assert.equal(parseServices(many).length, 3000);
  assert.deepEqual(parseServices({}), []);
});

test('disk: a share of the quota, never from strings or zero', () => {
  assert.equal(parseStorage({ userQuotaMax: 1000, userQuotaUsed: 420 }), 42);
  assert.equal(parseStorage({ userQuotaMax: 1000, userQuotaUsed: 2000 }), 100);
  assert.equal(parseStorage({ userQuotaMax: 0, userQuotaUsed: 0 }), undefined);
  assert.equal(parseStorage({ userQuotaMax: '1000', userQuotaUsed: '1' }), undefined);
  assert.equal(parseStorage({ userQuotaMax: 1000, userQuotaUsed: -1 }), undefined);
  assert.equal(parseStorage({}), undefined);
});

test('recording title: bounded text', () => {
  assert.equal(parseRecordingTitle({ details: { t: 'Planet Earth' } }), 'Planet Earth');
  assert.equal(parseRecordingTitle({ details: { t: 'x'.repeat(500) } }).length, 200);
  assert.equal(parseRecordingTitle({ details: {} }), undefined);
});

test('description: the SkyPlay control path of the SkyControl device only', () => {
  assert.equal(parseDescription(description()), CONTROL_PATH);
  assert.equal(parseDescription(description({ sky: false })), undefined);
  for (const bad of [
    'http://evil.example/x',
    '//evil.example/x',
    '/a/../../b',
    '/x?y=1',
    'relative',
    `/${'a'.repeat(300)}`,
  ]) {
    assert.equal(parseDescription(description({ controlURL: bad })), undefined, bad);
  }
  assert.equal(parseDescription('<deviceType>SkyControl</deviceType><service>'), undefined);
});

test('SOAP: the envelope of the library; transport and media answers', () => {
  const envelope = soapEnvelope('GetTransportInfo');
  assert.match(envelope, /<u:GetTransportInfo xmlns:u="urn:schemas-nds-com:service:SkyPlay:2">/);
  assert.match(envelope, /<InstanceID>0<\/InstanceID>/);
  assert.equal(parseTransport(transportInfo('PLAYING')), PLAYBACK.PLAYING);
  assert.equal(parseTransport(transportInfo('TRANSITIONING')), PLAYBACK.PLAYING);
  assert.equal(parseTransport(transportInfo('PAUSED_PLAYBACK')), PLAYBACK.PAUSED);
  assert.equal(parseTransport(transportInfo('STOPPED')), PLAYBACK.IDLE);
  assert.equal(parseTransport(transportInfo('NO_MEDIA_PRESENT')), PLAYBACK.IDLE);
  assert.equal(parseTransport(transportInfo('WEIRD')), undefined);
  assert.throws(() => parseTransport('<html>error</html>'));
  assert.deepEqual(parseMedia(mediaInfo('xsi://869')), { kind: 'live', sid: 0x869 });
  assert.deepEqual(parseMedia(mediaInfo('file://pvr/28E1A3C5')), {
    kind: 'pvr',
    pvrid: 'P28E1A3C5',
  });
  assert.deepEqual(parseMedia(mediaInfo('')), { kind: 'other' });
  assert.deepEqual(parseMedia(mediaInfo('xsi://zz')), { kind: 'other' });
  assert.deepEqual(parseMedia(mediaInfo('file://pvr/../x')), { kind: 'other' });
});

test('tagText is linear on a hostile answer', () => {
  const hostile = '<a'.repeat(30_000) + '<CurrentURI'.repeat(3_000);
  const started = performance.now();
  assert.equal(tagText(hostile, 'CurrentURI'), undefined);
  assert.ok(performance.now() - started < 500, 'bounded time');
  assert.equal(tagText('<x:A>1 &amp; 2</x:A>', 'A'), '1 & 2');
});

test('key events: pressed and released, as the library builds them', () => {
  assert.deepEqual([...keyEvent(0, true)], [4, 1, 0, 0, 0, 0, 224, 0]);
  assert.deepEqual([...keyEvent(0, false)], [4, 0, 0, 0, 0, 0, 224, 0]);
  assert.deepEqual([...keyEvent(64, true)], [4, 1, 0, 0, 0, 0, 228, 0]);
  assert.deepEqual([...keyEvent(241, true)], [4, 1, 0, 0, 0, 0, 239, 1]);
});

test('hostile XML is refused: DOCTYPE, ENTITY, comment, CDATA, stylesheet, reference floods', () => {
  const laughs =
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>' +
    transportInfo('PLAYING').replace(/^<\?xml[^>]*>/, '');
  const xxe = '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + mediaInfo('&xxe;');
  const comment = transportInfo('NO_MEDIA_PRESENT').replace(
    '<CurrentTransportState>',
    '<!-- <CurrentTransportState>PLAYING</CurrentTransportState> --><CurrentTransportState>',
  );
  const cdata = transportInfo('X').replace('X', '<![CDATA[PLAYING]]>');
  const stylesheet = '<?xml-stylesheet href="x"?>' + transportInfo('PLAYING');
  const flood = mediaInfo('xsi://869' + '&#48;'.repeat(300));
  for (const [name, xml] of Object.entries({ laughs, comment, cdata, stylesheet })) {
    assert.throws(() => parseTransport(xml), /refused/, name);
  }
  assert.throws(() => parseMedia(xxe), /refused/);
  assert.throws(() => parseMedia(flood), /too many/);
  assert.equal(parseDescription('<!DOCTYPE x>' + description()), undefined);
  assert.equal(
    parseDescription(description().replace('<serviceList>', '<!-- x --><serviceList>')),
    undefined,
  );
  // A numeric reference in the URI and in the path is decoded once, then checked.
  assert.deepEqual(parseMedia(mediaInfo('xsi://&#56;69')), { kind: 'live', sid: 0x869 });
  assert.equal(parseDescription(description({ controlURL: '/&#46;&#46;/x' })), undefined);
});

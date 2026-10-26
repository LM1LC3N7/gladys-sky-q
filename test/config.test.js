// -----------------------------------------------------------------------------
// The configuration normalized, and the /data file kept safe.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, parseHost } from '../src/config.js';
import { FileStore, MemoryStore } from '../src/store.js';

test('addresses: IPv4 or host names, deduplicated, bounded; the bad ones counted', () => {
  assert.equal(parseHost('192.168.1.50'), '192.168.1.50');
  assert.equal(parseHost('http://192.168.1.50:9006/as'), '192.168.1.50');
  assert.equal(parseHost('Sky-Box.local'), 'sky-box.local');
  for (const bad of ['0.0.0.0', '255.255.255.255', '224.0.0.251', '1.2.3', 'a b', 'x\r\ny', '']) {
    assert.equal(parseHost(bad), undefined, bad);
  }
  const config = normalizeConfig({
    addresses: '192.168.1.50, 192.168.1.50; bad_host!, 10.0.0.2',
    poll_interval: '2',
  });
  assert.deepEqual(config.addresses, ['192.168.1.50', '10.0.0.2']);
  assert.equal(config.invalid, 1);
  assert.equal(config.pollInterval, 5);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 15);
  assert.equal(normalizeConfig({ poll_interval: 'abc' }).pollInterval, 15);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, 300);
  const many = Array.from({ length: 30 }, (_, i) => `10.0.0.${i + 1}`).join(',');
  assert.equal(normalizeConfig({ addresses: many }).addresses.length, 10);
});

test('/data: missing is empty; invalid JSON moved aside; unreadable never overwritten', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sky-q-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore({ dir });
  assert.deepEqual(store.load(), {
    data: { boxes: {}, lastAttemptAt: undefined, toggleGuards: {} },
  });
  await store.save({
    boxes: { ABCD1234: { serial: 'ABCD1234', host: '10.0.0.1' } },
    lastAttemptAt: 5,
  });
  const saved = store.load();
  assert.equal(saved.data.boxes.ABCD1234.host, '10.0.0.1');
  assert.equal(saved.data.lastAttemptAt, 5);

  await writeFile(join(dir, 'sky-q.json'), '{not json');
  assert.equal(store.load().problem, 'corrupt');
  assert.equal(await readFile(join(dir, 'sky-q.json.bad'), 'utf8'), '{not json');

  if (process.getuid?.() !== 0) {
    await writeFile(join(dir, 'sky-q.json'), '{"boxes":{}}');
    await chmod(join(dir, 'sky-q.json'), 0o000);
    assert.equal(store.load().problem, 'unreadable');
    await chmod(join(dir, 'sky-q.json'), 0o600);
  }
});

test('/data: entries of the wrong shape are dropped', () => {
  const raw = {
    boxes: {
      ABCD1234: { serial: 'ABCD1234', host: '10.0.0.1', model: 'ES240' },
      'a.b': { serial: 'a.b' },
      WXYZ9876: { serial: 'OTHER' },
    },
    lastAttemptAt: 'yesterday',
  };
  const { data } = new MemoryStore(raw).load();
  assert.deepEqual(Object.keys(data.boxes), ['ABCD1234']);
  assert.equal(data.lastAttemptAt, undefined);
});

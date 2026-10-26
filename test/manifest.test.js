// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, POLL_INTERVAL, SSDP_ST } from '../src/constants.js';
import { buildDevice } from '../src/model.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; the version set by hand everywhere, never frozen here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined, 'keywords need a newer gladys_version (TODO.md)');
  assert.equal(manifest.countries, undefined);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-sky-q:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-sky-q');
  assert.equal(lock.name, 'gladys-sky-q');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['multimedia']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated with Sky/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien avec Sky/);
  assert.match(read('docs/en.md'), /never been tested[\s>]+with a real box/i);
  assert.match(read('docs/fr.md'), /jamais été[\s>]+testée avec un vrai décodeur/i);
});

test('the User-Agent agreement is written down; the online guide is not used', () => {
  for (const file of ['docs/en.md', 'docs/fr.md', 'TODO.md', 'README.md']) {
    assert.match(read(file), /SKYPLUS_skyplus/, file);
  }
  assert.match(read('TODO.md'), /## Decisions[\s\S]*SKYPLUS_skyplus/);
  for (const file of ['src/app.js', 'src/sky/client.js', 'src/sky/http.js', 'src/constants.js']) {
    assert.doesNotMatch(read(file), /epgsky|imageservice\.sky\.com|https?:\/\//, file);
  }
});

test('the license and the notices ship in the image; no person named in LICENSE', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  assert.match(read('THIRD_PARTY_NOTICES.md'), /pyskyqremote[\s\S]*MIT License[\s\S]*RogerSelwyn/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('the configuration matches the code; no secret, no gladys_ key', () => {
  assert.deepEqual(keys(manifest.config_schema), ['intro', 'addresses', 'poll_interval']);
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max],
    [POLL_INTERVAL.min, POLL_INTERVAL.max],
  );
  assert.ok(manifest.config_schema.every((f) => f.type !== 'secret'));
  assert.ok(!manifest.config_schema.some((f) => f.key.startsWith('gladys_')));
  assert.doesNotMatch(JSON.stringify(manifest), /chiffré|encrypted/i);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required ?? section.default ?? section.placeholder, undefined);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the actions and the discovery are the ones the code handles', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.deepEqual(manifest.network_discovery, [{ type: 'ssdp', st: SSDP_ST }]);
  assert.equal(manifest.network_wake, undefined);
  for (const absent of ['scene_actions', 'scene_triggers', 'widgets', 'containers']) {
    assert.equal(manifest[absent], undefined, absent);
  }
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('features: no unit, no switch, option labels are strings, min/max set', () => {
  const gladys = createFakeGladys({ selector: 'sky-q' });
  const device = buildDevice(gladys, { serial: 'ABCD1234', host: '10.0.0.1' });
  for (const feature of device.features) {
    assert.equal(feature.unit, undefined, feature.name);
    assert.notEqual(feature.category, 'switch', feature.name);
    assert.ok(Number.isFinite(feature.min) && Number.isFinite(feature.max), feature.name);
    if (feature.type === 'binary') {
      assert.equal(feature.read_only, true, `${feature.name}: a binary is read only`);
    }
    for (const option of feature.supported_options ?? []) {
      assert.equal(typeof option.label, 'string');
      assert.equal(typeof option.value, 'string');
    }
  }
});

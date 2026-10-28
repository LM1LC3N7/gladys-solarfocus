// -----------------------------------------------------------------------------
// The select options of the device must satisfy the Gladys core, which refuses
// the WHOLE publication (externalIntegration.setDiscoveredDevices) when one
// option breaks its rules: Discovery then lists nothing. The SDK's fake Gladys
// never checks them (tado, victron, automower… were published broken).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ROLES, buildDevice } from '../src/devices.js';

// The core's own validator of supported_options, when a Gladys clone is at hand
// (not on GitHub CI): the rules below are its schema, this is the proof.
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

// The core's rules (server/utils/normalizeSupportedOptions.js), copied so that
// GitHub CI, which has no Gladys clone, applies them too: a non-blank trimmed
// string label, a non-blank trimmed string (text/select only) or integer
// value, an integer sort_order, no other key, no two values alike in string form.
const OPTION_KEYS = ['id', 'value', 'label', 'sort_order'];
function checkOptions(options, where, allowStringValues) {
  assert.ok(Array.isArray(options) && options.length > 0, `${where}: options`);
  for (const [i, option] of options.entries()) {
    const at = `${where}[${i}]`;
    assert.equal(typeof option.label, 'string', `${at}.label must be a string`);
    assert.ok(option.label.trim().length > 0, `${at}.label is blank`);
    assert.equal(option.label, option.label.trim(), `${at}.label has surrounding whitespace`);
    assert.ok(
      Number.isInteger(option.value) ||
        (allowStringValues &&
          typeof option.value === 'string' &&
          option.value.length > 0 &&
          option.value === option.value.trim()),
      `${at}.value`,
    );
    assert.ok(
      option.sort_order === undefined || Number.isInteger(option.sort_order),
      `${at}.sort_order`,
    );
    assert.deepEqual(
      Object.keys(option).filter((k) => !OPTION_KEYS.includes(k)),
      [],
      `${at}: unknown key`,
    );
  }
  const values = options.map((o) => `${o.value}`);
  assert.equal(new Set(values).size, values.length, `${where}: duplicate values`);
  if (normalizeSupportedOptions) {
    assert.doesNotThrow(() => normalizeSupportedOptions(options, { allowStringValues }), where);
  }
}

const isSelectText = (feature) =>
  feature.category === DEVICE_FEATURE_CATEGORIES.TEXT &&
  feature.type === DEVICE_FEATURE_TYPES.TEXT.SELECT;

/** Applies the rules to every feature of `devices` that has options; returns how many. */
function checkDevices(devices) {
  let lists = 0;
  for (const device of devices) {
    for (const feature of device.features) {
      if (feature.supported_options === undefined) {
        continue;
      }
      lists += 1;
      checkOptions(
        feature.supported_options,
        `${device.external_id}/${feature.external_id}`,
        isSelectText(feature),
      );
    }
  }
  return lists;
}

test('the option rules reject what the core rejects (the regression guard itself)', () => {
  const bad = [{ value: 0, label: { en: 'Off', fr: 'Arrêt' }, sort_order: 0 }];
  assert.throws(() => checkOptions(bad, 'bad', false), /label must be a string/);
  assert.throws(() => checkOptions([{ value: 0 }], 'bad', false), /label must be a string/);
  assert.throws(() => checkOptions([{ value: 0, label: ' ' }], 'bad', false), /blank/);
  assert.throws(() => checkOptions([{ value: 0, label: 'a ' }], 'bad', false), /whitespace/);
  assert.throws(() => checkOptions([{ value: ' a', label: 'a' }], 'bad', true), /value/);
  assert.throws(
    () =>
      checkOptions(
        [
          { value: 1, label: 'a' },
          { value: '1', label: 'b' },
        ],
        'bad',
        true,
      ),
    /duplicate/,
  );
  if (normalizeSupportedOptions) {
    assert.throws(() => normalizeSupportedOptions(bad), /label/);
  }
});

test('every supported_options of the device, in both languages, is accepted by the core', () => {
  const gladys = createFakeGladys();
  for (const language of ['en', 'fr']) {
    const device = buildDevice(gladys, { language, roles: [...ROLES.keys()] });
    // 8 circuit modes and 4 hot water modes.
    assert.equal(checkDevices([device]), 12);
  }
});

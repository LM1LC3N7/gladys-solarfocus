import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countOf, dhwCapOf, normalizeConfig, parseAddress } from '../src/config.js';
import { normalizeMemory } from '../src/store.js';

test('addresses: IPv4 or host name, optional port; never broadcast, multicast nor 0.x', () => {
  assert.deepEqual(parseAddress('192.168.1.70'), { host: '192.168.1.70', port: 502 });
  assert.deepEqual(parseAddress(' ecomanager.local:1502 '), {
    host: 'ecomanager.local',
    port: 1502,
  });
  for (const bad of [
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.168.1.255',
    'a..b',
    'http://x',
    'x:0',
    'x:70000',
    'x\r\n',
    '',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('counts: whole numbers within the document, nothing guessed', () => {
  assert.deepEqual(countOf(3, 8, 1), { count: 3, bad: false });
  assert.deepEqual(countOf('2', 4, 1), { count: 2, bad: false });
  assert.deepEqual(countOf(0, 4, 1), { count: 0, bad: false });
  assert.deepEqual(countOf(9, 8, 1), { count: 1, bad: true });
  assert.deepEqual(countOf('', 8, 1), { count: 1, bad: true });
  assert.deepEqual(countOf(1.5, 8, 1), { count: 1, bad: true });
  assert.deepEqual(countOf(-1, 8, 1), { count: 1, bad: true });
});

test('hot water ceiling: 65 °C by default, 20 to 65 °C, rounded down', () => {
  assert.equal(dhwCapOf(undefined), 65);
  assert.equal(dhwCapOf(''), 65);
  assert.equal(dhwCapOf(null), 65);
  assert.equal(dhwCapOf(90), 65);
  assert.equal(dhwCapOf(65.5), 65);
  assert.equal(dhwCapOf('64.9'), 64);
  assert.equal(dhwCapOf(10), 20);
});

test('the configuration: commands off unless strictly true, unit id and generator checked', () => {
  const c = normalizeConfig({ host: '192.168.1.70', allow_commands: 'yes', unit_id: '' });
  assert.equal(c.allowCommands, false);
  assert.equal(c.address, undefined, 'no valid unit id: nothing read');
  assert.equal(normalizeConfig({ host: 'x', allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ host: 'not valid!' }).invalid, 10, 'only the length is kept');
  assert.equal(normalizeConfig({ host: '192.168.1.70\r\n' }).address, undefined, 'CR LF refused');
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  const d = normalizeConfig({});
  assert.deepEqual([d.generator, d.circuits, d.dhw, d.buffers], ['none', 1, 1, 0]);
  const g = normalizeConfig({ heat_generator: 'VAMPAIR' });
  assert.equal(g.generator, 'none');
  assert.equal(g.badGenerator, true);
  assert.equal(normalizeConfig({ heating_circuits: 12 }).badCounts, true);
});

test('/data: repaired and bounded; a stop clicked in the future is invalid', () => {
  const now = Date.UTC(2026, 9, 28);
  const target = { host: '192.168.1.70', port: 502, unitId: 1 };
  const m = normalizeMemory(
    {
      lastAttemptAt: now + 1e9,
      stops: [
        { ...target, register: 32603, at: now + 1000 },
        {
          ...target,
          register: 32603,
          at: now - 3 * 86_400_000,
          reasserts: 9,
          written: true,
          sticky: true,
          before: ['automatic', 'Bad Value', 'setback', 'always-on', 'automatic'],
        },
        { ...target, register: 32000, at: now },
        { ...target, host: 'evil\r\nhost', register: 32002, at: now },
        { ...target, register: 32002, at: now, before: ['always-on', 'automatic'] },
      ],
      target,
    },
    now,
  );
  assert.equal(m.lastAttemptAt, now);
  assert.equal(m.stops.length, 2, 'known stop registers, clean hosts, not in the future');
  assert.equal(m.stops[0].at, now - 3 * 86_400_000, 'never dropped by its age');
  assert.equal(m.stops[0].reasserts, 3);
  assert.equal(m.stops[0].written, true);
  assert.equal(m.stops[0].sticky, true);
  assert.deepEqual(m.stops[0].before, ['automatic', 'setback']);
  assert.deepEqual(m.stops[1].before, ['always-on'], 'values of its own table only');
  assert.deepEqual(m.target, target);
  assert.deepEqual(normalizeMemory('garbage', now), {
    target: null,
    lastAttemptAt: null,
    stops: [],
  });
});

// -----------------------------------------------------------------------------
// The integration end to end: fake Gladys, fake eco manager-touch, virtual clock.
// Circuit 1: input 1100, holding 32600 (flow setpoint), 32602 (cooling),
// 32603 (mode), 32605 (room setpoint), 32608 (heating mode). Hot water tank
// 1: input 500 (temperature), 502 (release mode applied), holding 32000 (setpoint),
// 32002 (release mode written).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { memoryStore } from '../src/store.js';
import { guardKey } from '../src/app.js';
import { ALLOW, CFG, DEVICE, MINUTE, SECOND, feature, setup } from './helpers.js';
import { HOST, NOW, fakeSolarfocus } from './fixtures/fakeSolarfocus.js';
import { testClock } from './kit/clock.mjs';

const writes = (device, from = 0) =>
  device
    .writes()
    .slice(from)
    .map((w) => [w.address, w.words[0]]);
const writesTo = (device, address) => device.writes().filter((w) => w.address === address);
const holding = (ctx, address) => ctx.device.get('holding', address);

test('discovery: one device, the values read and published, special values left out', async (t) => {
  const ctx = await setup({ config: { ...CFG, heating_circuits: 2 } });
  t.after(ctx.stop);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      ['text/select', 'water-heater/target-temperature', 'thermostat/target-temperature'].includes(
        `${f.category}/${f.type}`,
      ),
      `${f.external_id} is writable`,
    );
  }
  const roles = device.features.map((f) => f.external_id.slice(DEVICE.length + 1));
  assert.ok(roles.includes('circuit-1-mode') && roles.includes('circuit-2-mode'));
  assert.ok(!roles.includes('circuit-3-mode'), 'two circuits configured');
  assert.ok(roles.includes('dhw-1-setpoint') && !roles.includes('dhw-2-setpoint'));
  assert.ok(!roles.includes('circuit-2-temperature-flow'), 'circuit 2 reads 0: not a measure');
  assert.ok(!roles.includes('boiler-temperature'), 'a vampair: no biomass boiler');
  const dhw = device.features.find((f) => f.external_id === feature('dhw-1-setpoint'));
  assert.equal(dhw.max, 65, 'hot water: the ceiling of the configuration (65 °C by default)');
  assert.equal(ctx.state('temperature-outdoor').state, 4.5);
  assert.equal(ctx.state('heatpump-temperature-flow').state, 35.2);
  assert.equal(ctx.state('heatpump-state').text, 'heating');
  assert.equal(ctx.state('heatpump-power').state, 1850);
  assert.equal(ctx.state('heatpump-evu-lock').state, 0);
  assert.equal(ctx.state('circuit-1-mode').text, 'automatic');
  assert.equal(ctx.state('circuit-1-setpoint').state, 21.5);
  assert.equal(ctx.state('circuit-1-temperature-room').state, 21.5);
  assert.equal(ctx.state('dhw-1-temperature').state, 48.3);
  assert.equal(ctx.state('dhw-1-setpoint').state, 48);
  assert.equal(ctx.state('dhw-1-mode').text, 'monday-sunday');
  assert.equal(ctx.state('buffer-1-temperature-top').state, 55.1);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  // Only mapped reads, one connection, closed after.
  assert.ok(!ctx.lines.some((l) => /failed|does not serve/.test(l)), ctx.lines.join('\n'));
  assert.equal(ctx.device.open.size, 0);
  assert.equal(ctx.device.maxOpen, 1);
  assert.ok(ctx.device.writes().length === 0, 'a read never writes');
});

test('an older firmware: no power, no heating mode, the rest read, never a shifted value', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers, modern: false, heatingMode: false });
  // In the older layout 2322 is inside an energy counter: never read as a power.
  device.set('input', 2322, 4242);
  const ctx = await setup({ clock, device });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.equal(ctx.state('heatpump-power'), undefined);
  assert.equal(ctx.state('heatpump-state'), undefined);
  assert.equal(ctx.state('circuit-1-mode').text, 'automatic');
  assert.ok(!device.reads().some((r) => r.address === 2322), 'never read');
  await ctx.advance(2 * MINUTE, 1000);
  assert.equal(
    device.reads().filter((r) => r.address === 2330).length,
    1,
    'absent: not asked again',
  );
});

test('a biomass boiler: its temperature, no heat pump register read', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.set('input', 2400, 712);
  const ctx = await setup({ clock, device, config: { ...CFG, heat_generator: 'biomass' } });
  t.after(ctx.stop);
  assert.equal(ctx.state('boiler-temperature').state, 71.2);
  assert.ok(!device.reads().some((r) => r.address >= 2300 && r.address < 2400));
});

test('special values: open channel, 0 of a missing sensor, unknown state: never published', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.set('input', 1101, 1300); // room sensor channel open
  device.set('input', 1901, 2700);
  device.set('input', 2330, 99); // a state the document does not list
  device.set('holding', 32605, 0); // no room setpoint from Modbus
  device.set('input', 2408, 0); // 0.0 °C outdoors is a temperature
  const ctx = await setup({ clock, device });
  t.after(ctx.stop);
  assert.equal(ctx.state('circuit-1-temperature-room'), undefined);
  assert.equal(ctx.state('buffer-1-temperature-bottom'), undefined);
  assert.equal(ctx.state('heatpump-state'), undefined, 'a text is never a number');
  assert.equal(ctx.state('circuit-1-setpoint'), undefined);
  assert.equal(ctx.state('temperature-outdoor').state, 0);
});

test('every read refused: never "Connected"', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.mapped[3].clear();
  device.mapped[4].clear();
  const ctx = await setup({ clock, device, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
});

test('one block refused: the others are read, the status says which', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.exceptions.set(1900, 4);
  const ctx = await setup({ clock, device });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Non lus cette fois : buffer-1/);
  assert.equal(ctx.state('circuit-1-mode').text, 'automatic');
});

// --- Commands --------------------------------------------------------------------

test('the commands are off by default: refused, nothing written; the stops still go', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const requests = ctx.device.log.length;
  const connections = ctx.device.connections;
  const ack = await ctx.fire('circuit-1-mode', 'continuous');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Autoriser les commandes/);
  assert.equal(ctx.device.log.length, requests, 'refused on arrival: not even a read');
  assert.equal(ctx.device.connections, connections);
  assert.equal((await ctx.press('dhw-1-setpoint', 50)).success, false);
  assert.equal((await ctx.press('circuit-1-setpoint', 21)).success, false);
  assert.equal((await ctx.press('dhw-1-mode', 'always-on')).success, false);
  assert.deepEqual(ctx.device.writes(), []);
  const stop = await ctx.press('circuit-1-mode', 'off');
  assert.equal(stop.success, true, String(stop.error));
  // § 6.2.3 of the document, the mode first; the heating mode as last read (0).
  assert.deepEqual(writes(ctx.device), [
    [32603, 3],
    [32600, 0],
    [32602, 0],
    [32608, 0],
  ]);
  assert.equal(holding(ctx, 32603), 3);
  const dhw = await ctx.press('dhw-1-mode', 'always-off');
  assert.equal(dhw.success, true, String(dhw.error));
  assert.equal(holding(ctx, 32002), 0);
  assert.equal(ctx.state('dhw-1-mode').text, 'always-off');
});

test('a circuit mode: decided on a fresh read, all its registers written, the mode last', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.set('holding', 32608, 2);
  const from = ctx.device.log.length;
  const ack = await ctx.press('circuit-1-mode', 'setback');
  assert.equal(ack.success, true, String(ack.error));
  const log = ctx.device.log.slice(from).map((r) => [r.fc, r.address, r.words?.[0]]);
  assert.deepEqual(log.slice(0, 7), [
    [3, 32600, undefined],
    [3, 32602, undefined],
    [3, 32608, undefined],
    [16, 32600, 0],
    [16, 32602, 0],
    [16, 32608, 2],
    [16, 32603, 1],
  ]);
  assert.equal(holding(ctx, 32603), 1);
  assert.equal(ctx.state('circuit-1-mode').text, 'setback');
});

test('a circuit mode read back with a flow setpoint written meanwhile: not confirmed', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  const apply = ctx.device.apply;
  ctx.device.apply = (address, word) => {
    apply(address, word);
    // Another Modbus client writes a flow setpoint as the mode lands.
    if (address === 32603) apply(32600, 450);
  };
  const ack = await ctx.press('circuit-1-mode', 'continuous');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
});

test('a firmware without heating mode (before 22.090): the mode written without it', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers, heatingMode: false });
  const ctx = await setup({ clock, device, config: ALLOW });
  t.after(ctx.stop);
  const ack = await ctx.press('circuit-1-mode', 'continuous');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writes(device), [
    [32600, 0],
    [32602, 0],
    [32603, 0],
  ]);
  const stop = await ctx.press('circuit-1-mode', 'off');
  assert.equal(stop.success, true, String(stop.error));
  assert.ok(!device.writes().some((w) => w.address === 32608), 'never written');
});

test('a stop before any read: the heating mode read after the mode, written back as it is', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.down = true;
  const ctx = await setup({ clock, device, create: false });
  t.after(ctx.stop);
  device.down = false;
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writes(device), [
    [32603, 3],
    [32600, 0],
    [32602, 0],
    [32608, 0],
  ]);
  assert.ok(
    device.log.findIndex((r) => r.fc === 3 && r.address === 32608) >
      device.log.findIndex((r) => r.fc === 16 && r.address === 32603),
    'read after the mode was written',
  );
});

test('a flow setpoint of another Modbus client: never overridden by a mode, a stop still goes', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.set('holding', 32600, 450);
  await ctx.advance(61 * SECOND, 500);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.fr,
    /consigne de départ écrite par un autre/,
  );
  const ack = await ctx.press('circuit-1-mode', 'continuous');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /autre client Modbus/);
  assert.deepEqual(ctx.device.writes(), []);
  const stop = await ctx.press('circuit-1-mode', 'off');
  assert.equal(stop.success, true, String(stop.error));
  assert.equal(holding(ctx, 32600), 0);
  assert.equal(holding(ctx, 32603), 3);
});

test('hot water: bounded by the ceiling, never above 65 °C, whatever the configuration', async (t) => {
  const ctx = await setup({ config: { ...ALLOW, dhw_max_temperature: 90 } });
  t.after(ctx.stop);
  for (const value of [65.5, 66, 70, 80, 19.5, 50.3, '', null, 'abc', '55.0.1']) {
    const ack = await ctx.press('dhw-1-setpoint', value, 200);
    assert.equal(ack.success, false, `${value} refused`);
  }
  assert.deepEqual(ctx.device.writes(), []);
  const ack = await ctx.press('dhw-1-setpoint', 65);
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(holding(ctx, 32000), 650);
  const half = await ctx.press('dhw-1-setpoint', 52.5);
  assert.equal(half.success, true, String(half.error));
  assert.equal(holding(ctx, 32000), 525);
  await ctx.app.configUpdated({ ...ALLOW, dhw_max_temperature: 50 });
  const capped = await ctx.press('dhw-1-setpoint', 52);
  assert.match(String(capped.error), /plafond/);
  assert.equal(holding(ctx, 32000), 525);
});

test('room setpoint: 10 to 30 °C by 0.5, written in tenths; set even when none was', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.set('holding', 32605, 0);
  const ctx = await setup({ clock, device, config: ALLOW });
  t.after(ctx.stop);
  for (const value of [9.5, 30.5, 21.3, 45]) {
    assert.equal((await ctx.press('circuit-1-setpoint', value, 200)).success, false, `${value}`);
  }
  const ack = await ctx.press('circuit-1-setpoint', 20.5);
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writes(device), [[32605, 205]]);
  assert.equal(ctx.state('circuit-1-setpoint').state, 20.5);
});

test('a hot water mode: written and confirmed', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  const ack = await ctx.press('dhw-1-mode', 'always-on');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writes(ctx.device), [[32002, 1]]);
  const bad = await ctx.press('dhw-1-mode', 'Always-on');
  assert.equal(bad.success, false, 'never re-cased');
});

test('a write not applied: "sent, without confirmation", then spaced reads', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  const reads = ctx.device.reads().length;
  const ack = await ctx.press('dhw-1-setpoint', 50);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  await ctx.advance(30 * SECOND, 100);
  assert.ok(ctx.device.reads().length >= reads + 2 + 10, 'follow-up reads');
});

test('already so: nothing written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  assert.equal((await ctx.press('circuit-1-mode', 'automatic')).success, true);
  assert.equal((await ctx.press('dhw-1-setpoint', 48)).success, true);
  assert.deepEqual(ctx.device.writes(), []);
});

test('the option turned off while a command waits: not written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.delay = 400;
  const ack = ctx.fire('dhw-1-setpoint', 50);
  await ctx.advance(200, 10);
  await ctx.app.configUpdated(CFG);
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, false);
  assert.deepEqual(ctx.device.writes(), []);
});

test('the option turned off between two writes of a circuit: the mode is not written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.delay = 300;
  const ack = ctx.fire('circuit-1-mode', 'continuous');
  for (let i = 0; i < 300 && ctx.device.writes().length === 0; i += 1) await ctx.advance(10, 10);
  await ctx.app.configUpdated(CFG);
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, false);
  assert.ok(!ctx.device.writes().some((w) => w.address === 32603), 'the mode never written');
  assert.equal(holding(ctx, 32603), 2);
});

test('the current value unreadable: the command is not sent', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.set('holding', 32000, 0xffff);
  const ack = await ctx.press('dhw-1-setpoint', 50);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /n’a pas pu être relue/);
  assert.deepEqual(ctx.device.writes(), []);
});

test('a scene setting five values on a slow controller sets them all', async (t) => {
  const ctx = await setup({ config: { ...ALLOW, heating_circuits: 3, dhw_tanks: 2 } });
  t.after(ctx.stop);
  ctx.device.set('holding', 32703, 2);
  ctx.device.set('holding', 32050, 400);
  ctx.device.delay = 600;
  const acks = [
    ctx.fire('circuit-1-setpoint', 21),
    ctx.fire('circuit-2-setpoint', 21.5),
    ctx.fire('circuit-3-mode', 'continuous'),
    ctx.fire('dhw-1-setpoint', 50),
    ctx.fire('dhw-2-setpoint', 45),
  ];
  await ctx.advance(40 * SECOND, 50);
  // A circuit mode is ten requests (6 s here): its answer at 3.5 s says it goes on.
  await Promise.all(acks);
  assert.equal(holding(ctx, 32605), 210);
  assert.equal(holding(ctx, 32655), 215);
  assert.equal(holding(ctx, 32703), 0);
  assert.equal(holding(ctx, 32000), 500);
  assert.equal(holding(ctx, 32050), 450);
  assert.equal(ctx.device.maxOpen, 1);
});

test('a target refused by the controller does not stop the others of a scene', async (t) => {
  const ctx = await setup({ config: { ...ALLOW, heating_circuits: 2 } });
  t.after(ctx.stop);
  ctx.device.exceptions.set(32605, 4);
  const acks = [
    ctx.fire('circuit-1-setpoint', 21),
    ctx.fire('circuit-2-setpoint', 21.5),
    ctx.fire('dhw-1-setpoint', 50),
  ];
  await ctx.advance(10 * SECOND, 50);
  const [a, b, dhw] = await Promise.all(acks);
  assert.equal(a.success, false);
  assert.equal(b.success, true, String(b.error));
  assert.equal(dhw.success, true, String(dhw.error));
  assert.equal(holding(ctx, 32655), 215);
  assert.equal(holding(ctx, 32000), 500);
});

// --- Stops -----------------------------------------------------------------------

test('a stop takes the line from a read stuck on the controller', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.delay = 1900;
  ctx.app.tick();
  await ctx.advance(300, 10);
  assert.equal(ctx.device.open.size, 1, 'a read is waiting for its answer');
  ctx.device.delay = 10;
  const ack = await ctx.press('circuit-1-mode', 'off', 1000);
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(holding(ctx, 32603), 3);
  assert.equal(ctx.device.maxOpen, 1, 'never two connections');
});

test('a stop is tried again while the connection is refused, within 3.5 s', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.down = true;
  const ack = ctx.fire('dhw-1-mode', 'always-off');
  await ctx.advance(1200, 50);
  ctx.device.down = false;
  await ctx.advance(4 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
  assert.ok(ctx.device.refused >= 2);
  assert.equal(holding(ctx, 32002), 0);
});

test('a stop goes during a backoff, before any successful read, without the option', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.down = true;
  const ctx = await setup({ clock, device, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  device.down = false;
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(holding(ctx, 32603), 3);
});

test('a stop not confirmed: in /data, sent again 3 times at most, never lifted by the time', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store });
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  assert.equal(store.data.stops.length, 1);
  assert.equal(store.data.stops[0].register, 32603);
  await ctx.advance(4 * MINUTE, 200);
  const sent = writesTo(ctx.device, 32603).length;
  assert.equal(sent, 4, 'the click and three resends');
  assert.equal(writesTo(ctx.device, 32600).length, 4, 'the whole group each time');
  await ctx.advance(30 * MINUTE, 2000);
  assert.equal(writesTo(ctx.device, 32603).length, sent, 'no more resends');
  assert.equal(store.data.stops.length, 1, 'still guarded after 30 minutes');
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Arrêt non confirmé/);
  // The controller applies it at last: the guard ends on the read that shows it.
  ctx.device.set('holding', 32603, 3);
  await ctx.advance(6 * MINUTE, 2000);
  assert.deepEqual(store.data.stops, []);
});

test('a value set elsewhere after a stop: lifted once read twice in a row, never overridden', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store });
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  await ctx.press('dhw-1-mode', 'always-off');
  ctx.device.set('input', 502, 1); // always on, set at the panel
  // The check at 15 s is too early (the time to apply it); the follow-up read at 25 s
  // reads it once, the check at 30 s twice.
  await ctx.advance(21 * SECOND, 200);
  assert.equal(store.data.stops.length, 1, 'read once: not yet');
  await ctx.advance(5 * SECOND, 200);
  assert.deepEqual(store.data.stops, [], 'read twice in a row: lifted');
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(writesTo(ctx.device, 32002).length, 1, 'never written over it');
  assert.deepEqual(store.data.stops, []);
});

test('a newer command that left lifts the guard of a stop', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  await ctx.press('dhw-1-mode', 'always-off');
  ctx.device.ignoreWrites = false;
  const ack = ctx.fire('dhw-1-mode', 'always-on');
  await until(ctx, () => writesTo(ctx.device, 32002).length === 2, 5 * SECOND);
  assert.equal(ctx.app.stopGuards.size, 0, 'lifted as the command leaves');
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
  await ctx.advance(3 * MINUTE, 200);
  assert.deepEqual(
    writesTo(ctx.device, 32002).map((w) => w.words[0]),
    [0, 1],
  );
});

test('a stop drops the commands that arrived before it and have not left', async (t) => {
  const ctx = await setup({ config: { ...ALLOW, heating_circuits: 3 } });
  t.after(ctx.stop);
  ctx.device.delay = 300;
  const acks = [
    ctx.fire('dhw-1-setpoint', 50),
    ctx.fire('circuit-2-mode', 'continuous'),
    ctx.fire('circuit-3-mode', 'setback'),
  ];
  await ctx.advance(350, 10);
  const stop = ctx.fire('circuit-1-mode', 'off');
  await ctx.advance(8 * SECOND, 50);
  assert.equal((await stop).success, true, String((await stop).error));
  const order = ctx.device.writes().map((w) => w.address);
  const at = order.indexOf(32603);
  assert.ok(at >= 0);
  assert.deepEqual(order.slice(at), [32603, 32600, 32602, 32608], `nothing after: ${order}`);
  const results = await Promise.all(acks);
  assert.ok(results.some((r) => /arrêt a été envoyé entre-temps/.test(String(r.error))));
});

test('a stop goes while 16 commands wait (queue full)', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.delay = 500;
  const acks = [];
  for (let i = 0; i < 17; i += 1) acks.push(ctx.fire('dhw-1-setpoint', 40 + (i % 10)));
  await ctx.advance(200, 10);
  const stop = ctx.fire('dhw-1-mode', 'always-off');
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await stop).success, true, String((await stop).error));
  await ctx.advance(20 * SECOND, 100);
  await Promise.all(acks);
  const order = ctx.device.writes().map((w) => w.address);
  assert.deepEqual(order.slice(order.indexOf(32002) + 1), [], `nothing after the stop: ${order}`);
});

test('after a restart, a stop kept in /data is checked and sent before the configuration is read', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    stops: [{ host: HOST, port: 502, unitId: 1, register: 32603, at: NOW - MINUTE, before: [] }],
  });
  const ctx = await setup({ clock, device, store, boot: true, getConfigFails: 100, create: false });
  t.after(ctx.stop);
  assert.deepEqual(
    writesTo(device, 32603).map((w) => w.words[0]),
    [3],
  );
  assert.equal(holding(ctx, 32603), 3);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /configuration n’a pas pu être lue/);
});

test('a stop kept in /data with a click in the future is never replayed', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  const store = memoryStore({
    stops: [{ host: HOST, port: 502, unitId: 1, register: 32603, at: NOW + MINUTE, before: [] }],
  });
  const ctx = await setup({ clock, device, store, boot: true, create: false });
  t.after(ctx.stop);
  assert.deepEqual(device.writes(), []);
});

test('before the configuration is read, a stop goes to the last controller read', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  const store = memoryStore({
    lastAttemptAt: NOW,
    stops: [],
    target: { host: HOST, port: 502, unitId: 1 },
  });
  device.set('holding', 32608, 1);
  const ctx = await setup({ clock, device, store, boot: true, getConfigFails: 100, create: false });
  t.after(ctx.stop);
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(holding(ctx, 32603), 3);
  assert.equal(holding(ctx, 32608), 1, 'the heating mode read and written back as it is');
});

// --- Configuration, reads, restarts, /data ----------------------------------------

test('getConfig failing at a reconnection: tried again, then the integration resumes', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  let calls = 0;
  const getConfig = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Gladys unreachable');
    return { ...CFG, poll_interval: 120 };
  };
  await ctx.app.onConnected(getConfig);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /configuration n’a pas pu être lue/);
  await ctx.advance(31 * SECOND, 500);
  assert.equal(calls, 2);
  assert.equal(ctx.app.config.pollInterval, 120);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('configurations saved back to back are applied one by one, the last one wins', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const saves = [
    ctx.app.configUpdated({ ...CFG, heating_circuits: 3 }),
    ctx.app.configUpdated({ ...CFG, heating_circuits: 2, dhw_tanks: 0 }),
    ctx.app.configUpdated({ ...CFG, heating_circuits: 4, allow_commands: true }),
  ];
  await ctx.advance(2 * SECOND, 50);
  await Promise.all(saves);
  assert.equal(ctx.app.config.circuits, 4);
  assert.equal(ctx.app.config.allowCommands, true);
  assert.equal(ctx.app.config.dhw, 1);
});

test('configurations saved back to back: each one applied in turn, never skipped half-way', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const statuses = [];
  const original = ctx.gladys.setConnectionStatus.bind(ctx.gladys);
  ctx.gladys.setConnectionStatus = async (connected, message) => {
    statuses.push(message?.en ?? '');
    return original(connected, message);
  };
  const saves = [
    ctx.app.configUpdated({ ...CFG, host: 'not valid!' }),
    ctx.app.configUpdated({ ...CFG, heating_circuits: 2 }),
  ];
  await ctx.advance(2 * SECOND, 50);
  await Promise.all(saves);
  const invalid = statuses.findIndex((m) => /Invalid address/.test(m));
  assert.ok(invalid >= 0, `the first one was applied: ${statuses.join(' | ')}`);
  assert.ok(statuses.length > invalid + 1, 'then the second one');
  assert.equal(ctx.app.config.circuits, 2);
  assert.ok(ctx.app.config.address);
});

test('a configuration saved again for the same controller never reads sooner than the interval', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const reads = ctx.device.reads().length;
  await ctx.app.configUpdated({ ...CFG, heating_circuits: 2 });
  await ctx.advance(10 * SECOND, 100);
  assert.equal(ctx.device.reads().length, reads);
  await ctx.advance(60 * SECOND, 500);
  assert.ok(ctx.device.reads().length > reads);
});

test('a restart never reads sooner than the interval after the last read', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({ lastAttemptAt: NOW - 20 * SECOND, stops: [] });
  const ctx = await setup({ clock, store, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.device.reads().length, 0);
  await ctx.advance(95 * SECOND, 500);
  assert.ok(ctx.device.reads().length > 0);
});

test('/data unreadable: never overwritten, the first read waits a whole interval', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore(null, { unreadable: true });
  const ctx = await setup({ clock, store, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.device.reads().length, 0);
  await ctx.advance(61 * SECOND, 500);
  assert.ok(ctx.device.reads().length > 0);
  assert.equal(store.saves, 0);
});

test('/data that cannot be saved: a stop still goes', async (t) => {
  const store = memoryStore(null, { failSave: true });
  const ctx = await setup({ store });
  t.after(ctx.stop);
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(holding(ctx, 32603), 3);
});

test('nothing stale republished: a reconnection to Gladys long after the last read', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.down = true;
  await ctx.advance(3 * MINUTE, 1000);
  const count = ctx.gladys.fake.states.length;
  await ctx.app.connected(CFG);
  await ctx.advance(2 * SECOND, 100);
  assert.equal(ctx.gladys.fake.states.length, count);
});

test('an answer longer than a Modbus frame ends the read before it is all received', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const original = ctx.device.handle;
  ctx.device.handle = (socket) => {
    socket.emit('data', Buffer.alloc(300, 1));
  };
  await ctx.advance(61 * SECOND, 500);
  ctx.device.handle = original;
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.ok(
    ctx.lines.some((l) => /longer than a frame/.test(l)),
    ctx.lines.join('\n'),
  );
});

// --- The cases of the earlier reviews (iDM, same machinery) ------------------------

const firstWriteAfter = (device, from) => device.log.slice(from).find((r) => r.fc === 16);

for (const readInFlight of [false, true]) {
  test(`a command and a stop in the same turn (${readInFlight ? 'read in flight' : 'line idle'}): one connection, the stop first`, async (t) => {
    const ctx = await setup({ config: ALLOW });
    t.after(ctx.stop);
    ctx.device.delay = 30;
    if (readInFlight) {
      ctx.app.tick();
      await ctx.advance(20, 5);
    }
    const from = ctx.device.log.length;
    const acks = [
      ctx.fire('dhw-1-setpoint', 50),
      ctx.fire('circuit-1-mode', 'off'),
      ctx.fire('dhw-1-setpoint', 52),
    ];
    await ctx.advance(6 * SECOND, 20);
    const [before, stop, after] = await Promise.all(acks);
    assert.equal(stop.success, true, String(stop.error));
    assert.equal(ctx.device.maxOpen, 1, 'never two connections');
    assert.equal(firstWriteAfter(ctx.device, from).address, 32603, 'the stop is written first');
    assert.equal(before.success, false, 'the command before the stop is dropped');
    assert.equal(after.success, true, String(after.error));
    assert.equal(holding(ctx, 32603), 3);
    assert.equal(holding(ctx, 32000), 520);
  });
}

test('a single-client slow controller: the stop goes within 3.5 s, before newer commands', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.singleClient = true;
  ctx.device.delay = 600;
  const from = ctx.device.log.length;
  const acks = [
    ctx.fire('dhw-1-setpoint', 50),
    ctx.fire('dhw-1-mode', 'always-off'),
    ctx.fire('dhw-1-setpoint', 52),
    ctx.fire('circuit-1-setpoint', 21),
  ];
  await ctx.advance(3500, 20);
  assert.equal(holding(ctx, 32002), 0, 'stopped within 3.5 s');
  assert.equal(firstWriteAfter(ctx.device, from).address, 32002);
  await ctx.advance(30 * SECOND, 50);
  await Promise.all(acks);
  assert.equal(ctx.device.refused, 0, 'never a second connection');
});

for (const interval of [300, 3600]) {
  test(`a stop that could not leave is tried again within 20 s (interval ${interval} s)`, async (t) => {
    const ctx = await setup({ config: { ...CFG, poll_interval: interval } });
    t.after(ctx.stop);
    ctx.device.down = true;
    const ack = ctx.fire('dhw-1-mode', 'always-off');
    await ctx.advance(5 * SECOND, 50);
    assert.equal((await ack).success, false);
    ctx.device.down = false;
    await ctx.advance(16 * SECOND, 100);
    assert.equal(holding(ctx, 32002), 0);
    assert.equal(writesTo(ctx.device, 32002).length, 1);
  });

  test(`a stop written, not applied, is sent again by the checks (interval ${interval} s)`, async (t) => {
    const ctx = await setup({ config: { ...CFG, poll_interval: interval } });
    t.after(ctx.stop);
    ctx.device.ignoreWrites = true;
    await ctx.press('circuit-1-mode', 'off');
    await ctx.advance(40 * SECOND, 200);
    assert.ok(writesTo(ctx.device, 32603).length >= 2, 'sent again');
    await ctx.advance(10 * MINUTE, 500);
    assert.equal(writesTo(ctx.device, 32603).length, 4, 'three times at most');
  });
}

test('after a restart, a value set at the panel meanwhile is never overridden', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.set('holding', 32603, 0); // continuous, set at the panel after the stop
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    stops: [
      {
        host: HOST,
        port: 502,
        unitId: 1,
        register: 32603,
        at: NOW - MINUTE,
        reasserts: 1,
        written: true,
        before: ['automatic'],
      },
    ],
  });
  const ctx = await setup({ clock, device, store, boot: true, create: false });
  t.after(ctx.stop);
  await ctx.advance(2 * MINUTE, 500);
  assert.deepEqual(writesTo(device, 32603), []);
  assert.deepEqual(store.data.stops, []);
});

test('a stop clicked before any value is known: the first value read counts as before', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    stops: [
      {
        host: HOST,
        port: 502,
        unitId: 1,
        register: 32603,
        at: NOW - MINUTE,
        written: true,
        before: [],
      },
    ],
  });
  device.ignoreWrites = true;
  const ctx = await setup({ clock, device, store, boot: true, create: false });
  t.after(ctx.stop);
  assert.equal(writesTo(device, 32603).length, 1, 'an unknown value of before: sent again');
  device.set('holding', 32603, 1);
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(writesTo(device, 32603).length, 1, 'never over the panel');
});

test('a value read while Gladys was unreachable is not published 10 minutes later', async (t) => {
  const ctx = await setup({ config: { ...CFG, poll_interval: 600 } });
  t.after(ctx.stop);
  const publish = ctx.gladys.publishChangedStates.bind(ctx.gladys);
  let down = true;
  ctx.gladys.publishChangedStates = async (...args) => {
    if (down) throw new Error('Gladys unreachable');
    return publish(...args);
  };
  ctx.device.set('input', 2408, 123);
  await ctx.advance(13 * MINUTE, 1000);
  ctx.device.down = true;
  down = false;
  await ctx.advance(5 * SECOND, 100);
  assert.notEqual(ctx.state('temperature-outdoor').state, 12.3);
});

test('the hot water ceiling lowered while a command waits: not written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.delay = 400;
  const ack = ctx.fire('dhw-1-setpoint', 54);
  await ctx.advance(200, 10);
  await ctx.app.configUpdated({ ...ALLOW, dhw_max_temperature: 50 });
  await ctx.advance(5 * SECOND, 50);
  assert.match(String((await ack).error), /plafond/);
  assert.deepEqual(ctx.device.writes(), []);
});

test('the time of a read is in /data before the read', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store, create: false });
  t.after(ctx.stop);
  const first = store.data.lastAttemptAt;
  ctx.device.silent.add(2408);
  for (let i = 0; i < 700 && ctx.device.open.size === 0; i += 1) await ctx.advance(100, 100);
  assert.equal(ctx.device.open.size, 1, 'the next read is waiting for its answer');
  assert.ok(store.data.lastAttemptAt > first, 'already in /data');
});

test('an old read is not republished at connected, the controller online', async (t) => {
  const ctx = await setup({ config: { ...CFG, poll_interval: 600 } });
  t.after(ctx.stop);
  await ctx.advance(3 * MINUTE, 1000);
  const count = ctx.gladys.fake.states.length;
  await ctx.app.connected({ ...CFG, poll_interval: 600 });
  await ctx.app.deviceCreated(ctx.gladys.fake.discoveredDevices[0]);
  await ctx.advance(2 * SECOND, 100);
  assert.equal(ctx.gladys.fake.states.length, count);
});

for (const [role, value] of [
  ['dhw-1-setpoint', 50],
  ['circuit-1-mode', 'off'],
]) {
  test(`a write answered by something else than its echo is not confirmed (${role})`, async (t) => {
    const ctx = await setup({ config: ALLOW });
    t.after(ctx.stop);
    ctx.device.badEcho = true;
    const ack = await ctx.press(role, value);
    assert.equal(ack.success, false);
    assert.match(String(ack.error), /sans confirmation/);
  });
}

for (const flag of ['wrongTransaction', 'wrongUnit']) {
  test(`an answer to another request (${flag}) is never taken`, async (t) => {
    const clock = testClock({ start: NOW });
    const device = fakeSolarfocus({ timers: clock.timers });
    device[flag] = true;
    const ctx = await setup({ clock, device, create: false });
    t.after(ctx.stop);
    assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
    assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  });
}

/** Advances until `cond()` holds (10 ms steps), at most `max` ms. */
async function until(ctx, cond, max = 60 * SECOND) {
  for (let e = 0; e < max && !cond(); e += 10) await ctx.advance(10, 10);
  assert.ok(cond(), 'condition reached');
}

const checkRunning = (ctx, register) =>
  ctx.app.checking === guardKey(ctx.app.target(), register) && ctx.app.active?.kind === 'check';

for (const kase of ['panel value', 'resends used up']) {
  test(`a click during a running check is written and read back (${kase})`, async (t) => {
    const ctx = await setup();
    t.after(ctx.stop);
    ctx.device.ignoreWrites = true;
    await ctx.press('dhw-1-mode', 'always-off');
    if (kase === 'panel value') ctx.device.set('input', 502, 4);
    else ctx.app.guardOf(32002).reasserts = 2;
    ctx.device.delay = 1000;
    await until(ctx, () => checkRunning(ctx, 32002));
    ctx.device.ignoreWrites = false;
    const from = ctx.device.log.length;
    const ack = ctx.fire('dhw-1-mode', 'always-off');
    await ctx.advance(4 * SECOND, 20);
    assert.equal((await ack).success, true, String((await ack).error));
    const after = ctx.device.log.slice(from);
    assert.ok(
      after.some((r) => r.fc === 16 && r.address === 32002),
      'written',
    );
    assert.ok(
      after.some((r) => r.fc === 4 && r.address === 502),
      'read back',
    );
    assert.equal(holding(ctx, 32002), 0);
  });
}

test('a check never interrupts a newer command, nor sends the stop over it', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  await ctx.press('dhw-1-mode', 'always-off');
  ctx.device.ignoreWrites = false;
  ctx.device.delay = 600;
  // The command arrives 1 s before the next check (15 s after the stop).
  await ctx.advance(9 * SECOND, 50);
  const ack = ctx.fire('dhw-1-mode', 'always-on');
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
  await ctx.advance(3 * MINUTE, 500);
  assert.deepEqual(
    writesTo(ctx.device, 32002).map((w) => w.words[0]),
    [0, 1],
  );
  assert.equal(holding(ctx, 32002), 1);
});

test('a click never waits behind the check of another stop', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  await ctx.press('circuit-1-mode', 'off');
  ctx.device.ignoreWrites = false;
  ctx.device.delay = 1400;
  await until(ctx, () => checkRunning(ctx, 32603));
  const from = ctx.device.log.length;
  const ack = ctx.fire('dhw-1-mode', 'always-off');
  await ctx.advance(100, 10);
  assert.ok(
    ctx.device.log.slice(from).some((r) => r.fc === 16 && r.address === 32002),
    'written at once',
  );
  await ctx.advance(4 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
});

test('a stop ends a session still closing at once', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.closeDelay = 2000;
  const ends = ctx.device.ends;
  ctx.app.tick();
  await until(ctx, () => ctx.device.ends > ends);
  const from = ctx.device.log.length;
  ctx.fire('dhw-1-mode', 'always-off');
  await ctx.advance(100, 10);
  assert.ok(ctx.device.log.slice(from).some((r) => r.fc === 16 && r.address === 32002));
  assert.equal(ctx.device.maxOpen, 1);
});

test('a stop not applied is sent again only 20 s after it was written', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  ctx.fire('dhw-1-mode', 'always-off');
  await ctx.advance(29 * SECOND, 100);
  assert.equal(writesTo(ctx.device, 32002).length, 1, 'not at the 15 s check');
  await ctx.advance(6 * SECOND, 100);
  assert.equal(writesTo(ctx.device, 32002).length, 2, 'at the 30 s check');
});

test('sessions end gracefully (FIN, then the controller closes)', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  assert.ok(ctx.device.ends > 0);
  assert.equal(ctx.device.clientDestroys, 0);
});

test('a stop is answered at 3.5 s on a controller that answers late', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  // Written at 1.9 s, read back at 3.8 s: the answer cannot wait for it.
  ctx.device.delay = 1900;
  const start = ctx.clock.elapsed;
  let at;
  ctx.fire('dhw-1-mode', 'always-off').then(() => {
    at = ctx.clock.elapsed - start;
  });
  await until(ctx, () => at !== undefined, 10 * SECOND);
  assert.ok(at >= 3400 && at <= 3600, `${at} ms`);
});

test('a stop is tried for 3 s, not longer', async (t) => {
  const ctx = await setup({ config: { ...CFG, poll_interval: 3600 } });
  t.after(ctx.stop);
  ctx.device.now = () => ctx.clock.elapsed;
  ctx.device.down = true;
  const start = ctx.clock.elapsed;
  ctx.fire('dhw-1-mode', 'always-off');
  await ctx.advance(10 * SECOND, 50);
  const tries = ctx.device.connectAt.map((x) => x - start).filter((x) => x < 10 * SECOND);
  assert.ok(tries.length >= 5, `${tries.length} tries`);
  assert.ok(Math.max(...tries) >= 2500 && Math.max(...tries) <= 3000, `${tries.at(-1)} ms`);
});

// --- Solarfocus specifics ---------------------------------------------------------

test('a stop during the writes of a circuit mode: the rest of the mode never follows it', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.device.delay = 300;
  const ack = ctx.fire('circuit-1-mode', 'continuous');
  await until(ctx, () => ctx.device.writes().length > 0, 10 * SECOND);
  const stop = ctx.fire('circuit-1-mode', 'off');
  await ctx.advance(8 * SECOND, 50);
  assert.equal((await stop).success, true, String((await stop).error));
  assert.equal((await ack).success, false);
  const order = writes(ctx.device);
  const at = order.findIndex(([a, v]) => a === 32603 && v === 3);
  assert.ok(at > 0, JSON.stringify(order));
  assert.ok(!order.slice(at).some(([a, v]) => a === 32603 && v !== 3), JSON.stringify(order));
  assert.equal(holding(ctx, 32603), 3);
});

test('a stop over a command sent without confirmation: guarded until confirmed twice', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ config: ALLOW, store });
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  const sent = await ctx.press('dhw-1-mode', 'always-on');
  assert.match(String(sent.error), /sans confirmation/);
  ctx.device.ignoreWrites = false;
  const stop = await ctx.press('dhw-1-mode', 'always-off');
  assert.equal(stop.success, true, String(stop.error));
  assert.equal(store.data.stops[0]?.sticky, true, 'the command may still land');
  // One read of the stop after the time to apply it (the follow-up read at 25 s): still guarded.
  await ctx.advance(21 * SECOND, 200);
  assert.equal(store.data.stops.length, 1, 'one confirmation is not enough');
  // The command lands late: the check at 30 s sends the stop again over it.
  ctx.device.apply(32002, 1);
  await ctx.advance(6 * SECOND, 200);
  assert.equal(holding(ctx, 32002), 0);
  assert.equal(writesTo(ctx.device, 32002).filter((w) => w.words[0] === 0).length, 2);
  await ctx.advance(2 * MINUTE, 500);
  assert.deepEqual(store.data.stops, [], 'confirmed by two reads in a row');
});

test('the heating mode refused by the firmware during a stop: the stop still goes', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers, heatingMode: false });
  device.down = true;
  const ctx = await setup({ clock, device, create: false });
  t.after(ctx.stop);
  device.down = false;
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(
    device.writes().map((w) => w.address),
    [32603, 32600, 32602],
  );
  assert.equal(holding(ctx, 32603), 3);
  // Refused once: this firmware has none, it is not asked again.
  assert.equal((await ctx.press('circuit-1-mode', 'off')).success, true);
  assert.equal(device.reads().filter((r) => r.address === 32608).length, 1);
});

// --- Review r1 (lot 18) -------------------------------------------------------------

test('r1-I1 a stop answered "busy" (exception 6) is tried again within its 3 s', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  let busy = 1;
  ctx.device.exceptions.set(32603, (r) => (r.fc === 16 && busy-- > 0 ? 6 : undefined));
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(writesTo(ctx.device, 32603).length, 2);
  assert.equal(holding(ctx, 32603), 3);
});

test('r1-I1 a stop write without an answer is tried again within its 3 s', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.silent.add(32603);
  const ack = ctx.fire('circuit-1-mode', 'off');
  await ctx.advance(2100, 20);
  ctx.device.silent.delete(32603);
  await ctx.advance(3 * SECOND, 50);
  assert.equal(holding(ctx, 32603), 3, 'applied within the budget');
  assert.equal(writesTo(ctx.device, 32603).length, 2);
  await ack;
});

test('r1-I1 a stop queued behind another one has its own 3 s', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.down = true;
  const first = ctx.fire('circuit-1-mode', 'off');
  await ctx.advance(100, 10);
  const second = ctx.fire('dhw-1-mode', 'always-off');
  // The first one tries until 3 s; the controller is back at 3.2 s, during the second's turn.
  await ctx.advance(3100, 20);
  ctx.device.down = false;
  await ctx.advance(5 * SECOND, 50);
  await Promise.all([first, second]);
  assert.equal(holding(ctx, 32002), 0, 'the second stop went');
});

test('r1-I1 a controller busy for 2 minutes: the refused resends do not count, the stop goes', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const until = ctx.clock.elapsed + 2 * MINUTE;
  ctx.device.exceptions.set(32603, (r) =>
    r.fc === 16 && ctx.clock.elapsed < until ? 6 : undefined,
  );
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /exception Modbus 6/, 'the reason in French');
  await ctx.advance(10 * MINUTE, 1000);
  assert.equal(holding(ctx, 32603), 3);
  assert.equal(ctx.app.stopGuards.size, 0);
});

test('r1-I2 a circuit stop cut after its mode is completed later, never confirmed on the mode alone', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store });
  t.after(ctx.stop);
  ctx.device.set('holding', 32600, 450); // another client's flow setpoint
  ctx.device.silent.add(32600);
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, false);
  ctx.device.silent.delete(32600);
  assert.equal(holding(ctx, 32603), 3);
  assert.equal(holding(ctx, 32600), 450, 'cut after the mode');
  assert.equal(store.data.stops.length, 1, 'not confirmed by the mode alone');
  await ctx.advance(40 * SECOND, 200);
  assert.equal(holding(ctx, 32600), 0, 'the group written again by a check');
  assert.equal(holding(ctx, 32602), 0);
  await ctx.advance(30 * SECOND, 200);
  assert.deepEqual(store.data.stops, []);
});

test('r1-I2 a register of the group refused and still wrong: the group is written again in the 3 s', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.set('holding', 32602, 1);
  let refused = 1;
  ctx.device.exceptions.set(32602, (r) => (r.fc === 16 && refused-- > 0 ? 6 : undefined));
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(holding(ctx, 32602), 0);
  assert.equal(writesTo(ctx.device, 32602).length, 2);
});

test('r1-I3 a stop of a controller no longer configured: never checked nor written, shown', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  const hosts = [];
  device.connectFn = (host) => {
    hosts.push(host);
    return device.connect();
  };
  const store = memoryStore();
  const ctx = await setup({ clock, device, store });
  t.after(ctx.stop);
  device.ignoreWrites = true;
  await ctx.press('circuit-1-mode', 'off');
  device.ignoreWrites = false;
  const other = { ...CFG, host: '192.168.1.71' };
  const saved = ctx.app.configUpdated(other);
  await ctx.advance(2 * SECOND, 50);
  await saved;
  const from = hosts.length;
  const written = device.writes().length;
  // The new controller shows another mode, read twice and more: not the old controller's.
  device.set('holding', 32603, 0);
  await ctx.advance(5 * MINUTE, 1000);
  assert.deepEqual([...new Set(hosts.slice(from))], ['192.168.1.71'], 'never the old address');
  assert.equal(device.writes().length, written, 'nothing written');
  assert.equal(store.data.stops.length, 1, 'kept for the old controller');
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /plus configurée.*192\.168\.1\.70/);
  // The old controller configured again: its stop is checked and sent again.
  device.set('holding', 32603, 2);
  const back = ctx.app.configUpdated(CFG);
  await ctx.advance(30 * SECOND, 100);
  await back;
  assert.equal(holding(ctx, 32603), 3);
});

test('r1-I4 a block without an answer: the others read, connected, the block named', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.silent.add(32608);
  const ctx = await setup({ clock, device });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.fr,
    /Non lus cette fois : circuit-1-heating-mode/,
  );
  assert.equal(ctx.state('temperature-outdoor').state, 4.5);
  assert.equal(ctx.state('buffer-1-temperature-top').state, 55.1, 'read after it');
  assert.equal(ctx.device.maxOpen, 1);
});

test('r1-I4 two blocks without an answer: what was read is kept, the rest skipped', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.silent.add(32608);
  device.silent.add(32605);
  const ctx = await setup({ clock, device });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.equal(ctx.state('heatpump-temperature-flow').state, 35.2);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /buffer-1/);
});

test('r1-I5 a scene of three circuit modes and two more on a slow controller sets them all', async (t) => {
  const ctx = await setup({ config: { ...ALLOW, heating_circuits: 4, dhw_tanks: 2 } });
  t.after(ctx.stop);
  for (const h of [32603, 32653, 32703]) ctx.device.set('holding', h, 2);
  ctx.device.set('holding', 32050, 450);
  let i = 0;
  ctx.device.delay = () => 500 + ((i++ * 137) % 400);
  const acks = [
    ctx.fire('circuit-1-mode', 'continuous'),
    ctx.fire('circuit-2-mode', 'setback'),
    ctx.fire('circuit-3-mode', 'continuous'),
    ctx.fire('dhw-1-setpoint', 55),
    ctx.fire('dhw-2-mode', 'always-on'),
  ];
  await ctx.advance(70 * SECOND, 50);
  await Promise.all(acks);
  assert.equal(holding(ctx, 32603), 0);
  assert.equal(holding(ctx, 32653), 1);
  assert.equal(holding(ctx, 32703), 0);
  assert.equal(holding(ctx, 32000), 550);
  assert.equal(holding(ctx, 32052), 1);
});

test('r1-I6 the hot water mode is decided and confirmed on the mode applied (502)', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ config: ALLOW, store });
  t.after(ctx.stop);
  ctx.device.istFrozen = true;
  const ack = await ctx.press('dhw-1-mode', 'always-on');
  assert.equal(ack.success, false, '32002 took it, 502 did not move');
  assert.match(String(ack.error), /sans confirmation/);
  const stop = await ctx.press('dhw-1-mode', 'always-off');
  assert.equal(stop.success, false, 'a stop not applied is not confirmed');
  assert.equal(store.data.stops.length, 1);
  // Written as 0 already: not "already so" while 502 still shows 2.
  ctx.device.set('holding', 32002, 0);
  ctx.device.istFrozen = false;
  await ctx.press('dhw-1-mode', 'always-off');
  assert.equal(ctx.device.get('input', 502), 0);
  assert.equal(ctx.state('dhw-1-mode').text, 'always-off');
});

test('r1-m2 a block answered once then refused as "illegal address" is not taken as absent', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.exceptions.set(32608, 2);
  await ctx.advance(61 * SECOND, 500);
  ctx.device.exceptions.delete(32608);
  const reads = ctx.device.reads().filter((r) => r.address === 32608).length;
  await ctx.advance(61 * SECOND, 500);
  assert.equal(ctx.device.reads().filter((r) => r.address === 32608).length, reads + 1);
});

test('r1-m4 the status names the stops not confirmed plainly', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.ignoreWrites = true;
  await ctx.press('circuit-1-mode', 'off');
  await ctx.press('dhw-1-mode', 'always-off');
  assert.match(
    ctx.gladys.fake.connectionStatus.message.fr,
    /Arrêt non confirmé par la régulation : circuit de chauffage 1, ballon d’eau chaude 1\./,
  );
});

test('r1-m5 the guard of a click is in /data before its first write', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store });
  t.after(ctx.stop);
  ctx.device.down = true;
  ctx.fire('circuit-1-mode', 'off');
  await ctx.advance(100, 10);
  assert.deepEqual(
    store.data.stops.map((s) => [s.register, s.written]),
    [[32603, false]],
  );
  ctx.device.down = false;
  await ctx.advance(5 * SECOND, 50);
});

test('r1-m1 a heating mode without an answer never keeps a circuit stop from its confirmation', async (t) => {
  const clock = testClock({ start: NOW });
  const device = fakeSolarfocus({ timers: clock.timers });
  device.silent.add(32608);
  const ctx = await setup({ clock, device });
  t.after(ctx.stop);
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(holding(ctx, 32603), 3);
  assert.equal(ctx.app.stopGuards.size, 0);
});

test('r1-I1 a stop whose read back is refused is "without confirmation", never "refused"', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.device.exceptions.set(32600, (r) => (r.fc === 3 ? 3 : undefined));
  const ack = await ctx.press('circuit-1-mode', 'off');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  assert.equal(holding(ctx, 32603), 3);
});

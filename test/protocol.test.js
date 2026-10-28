// -----------------------------------------------------------------------------
// The Modbus PDUs (pure): the blocks against the Solarfocus document, the
// read compaction of the controller, the special values, the write requests
// and their bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  circuitControlBlocks,
  circuitHolding,
  dhwControlBlock,
  pollBlocks,
  writableKind,
} from '../src/constants.js';
import { interpret } from '../src/model.js';
import {
  decodeBlock,
  int16,
  isWriteEcho,
  parseRead,
  readRequest,
  spanOf,
  writeRequest,
} from '../src/modbus/protocol.js';
import { holdingMap, inputMap } from './fixtures/fakeSolarfocus.js';

const LAYOUTS = ['none', 'vampair', 'biomass'].map((generator) => ({
  generator,
  circuits: 8,
  dhw: 4,
  buffers: 4,
}));

test('every block is a run of addresses the document maps, without a hole (no compaction)', () => {
  // The older firmware maps less: a block read there is one the older layout maps too,
  // or an optional/probed one.
  const maps = {
    3: holdingMap({ heatingMode: true }),
    4: inputMap({ modern: true }),
  };
  const old = { 3: holdingMap({ heatingMode: false }), 4: inputMap({ modern: false }) };
  for (const layout of LAYOUTS) {
    for (const block of pollBlocks(layout)) {
      const { address, count } = spanOf(block);
      assert.equal(count, block.points.length, `${block.key}: one register per point`);
      assert.ok(count <= LIMITS.registersPerRead, block.key);
      block.points.forEach(([at], i) => assert.equal(at, address + i, `${block.key} contiguous`));
      for (const [at] of block.points) {
        assert.ok(maps[block.fc].has(at), `${block.key}: ${at} is in the document`);
        if (!block.optional && !block.probe) {
          assert.ok(old[block.fc].has(at), `${block.key}: ${at} is mapped by older firmware`);
        }
      }
    }
  }
});

test('the Solarfocus addresses (DR-0180-DE v14-260212, aiosolarfocus 0.3.0)', () => {
  const at = Object.fromEntries(
    pollBlocks(LAYOUTS[1]).flatMap((b) => b.points.map(([a, t, k]) => [k, [b.fc, a, t]])),
  );
  assert.deepEqual(at.outdoor, [4, 2408, 't']);
  assert.deepEqual(at.hpFlow, [4, 2300, 't']);
  assert.deepEqual(at.hpEvuLock, [4, 2304, 'u']);
  assert.deepEqual(at.hpPower, [4, 2322, 's']);
  assert.deepEqual(at.hpState, [4, 2330, 'u']);
  assert.deepEqual(at['circuit.1.flow'], [4, 1100, 't']);
  assert.deepEqual(at['circuit.8.room'], [4, 1451, 't']);
  assert.deepEqual(at['circuit.1.mode'], [3, 32603, 'u']);
  assert.deepEqual(at['circuit.1.setpoint'], [3, 32605, 't']);
  assert.deepEqual(at['circuit.1.heatingMode'], [3, 32608, 'u']);
  // Circuit 7: the document misprints 32750 (circuit 4's): its block starts at 32900.
  assert.deepEqual(at['circuit.7.flowSetpoint'], [3, 32900, 't']);
  assert.equal(circuitHolding(7), 32900);
  assert.deepEqual(at['dhw.1.temperature'], [4, 500, 't']);
  assert.deepEqual(at['dhw.4.setpoint'], [3, 32150, 't']);
  assert.deepEqual(at['dhw.2.mode'], [4, 552, 'u'], 'the mode applied (Ist)');
  assert.deepEqual(at['buffer.2.top'], [4, 1920, 't']);
  assert.deepEqual(at['buffer.4.bottom'], [4, 1961, 't']);
  const biomass = pollBlocks(LAYOUTS[2]).flatMap((b) => b.points.map(([a]) => a));
  assert.ok(biomass.includes(2400) && !biomass.includes(2300));
  const none = pollBlocks(LAYOUTS[0]).flatMap((b) => b.points.map(([a]) => a));
  assert.ok(!none.includes(2400) && !none.includes(2300));
  assert.equal(pollBlocks({}).length, 1, 'nothing configured: the outdoor temperature only');
  assert.deepEqual(
    circuitControlBlocks(1).map((b) => [b.key, b.optional === true]),
    [
      ['circuit-1-flow-setpoint', false],
      ['circuit-1-mode', false],
      ['circuit-1-heating-mode', true],
    ],
  );
  assert.deepEqual(dhwControlBlock(1).points, [[32000, 't', 'dhw.1.setpoint']]);
});

test('the fake compacts a read across a hole, as the controller does', async () => {
  const { fakeSolarfocus } = await import('./fixtures/fakeSolarfocus.js');
  const timers = { setTimeout: (fn) => (fn(), 0), clearTimeout() {} };
  const device = fakeSolarfocus({ timers });
  device.set('input', 1103, 1);
  device.set('input', 1105, 7);
  // 1104 is not mapped: 1103..1105 answers 1103, 1105, 1106 (shifted), never a padding.
  assert.deepEqual(device.answerWords(4, 1103, 3), [1, 7, 40]);
  assert.equal(device.answerWords(4, 1104, 1), undefined, 'refused at an unmapped start');
});

test('reads: function 3 or 4, the exact size, else nothing', () => {
  const block = pollBlocks(LAYOUTS[1]).find((b) => b.key === 'heatpump');
  assert.deepEqual([...readRequest(block)], [4, 0x08, 0xfc, 0, 5]);
  const holding = circuitControlBlocks(1)[1];
  assert.deepEqual([...readRequest(holding)], [3, 0x7f, 0x5a, 0, 2]);
  const pdu = Buffer.alloc(2 + 10);
  pdu[0] = 4;
  pdu[1] = 10;
  assert.equal(parseRead(block, pdu).length, 5);
  assert.equal(parseRead(block, pdu.subarray(0, pdu.length - 1)), undefined);
  assert.equal(parseRead(holding, pdu), undefined, 'another function');
  pdu[1] = 8;
  assert.equal(parseRead(block, pdu), undefined);
  assert.throws(() => readRequest({ key: 'x', fc: 16, points: [[1, 'u', 'x']] }), /function/);
  assert.throws(
    () =>
      readRequest({
        key: 'x',
        fc: 4,
        points: [
          [1, 'u', 'a'],
          [3, 'u', 'b'],
        ],
      }),
    /registers/,
    'a block with a hole is never sent',
  );
});

test('decoding: int16 in tenths, uint16 as is', () => {
  assert.equal(int16(0xffff), -1);
  assert.equal(int16(0x8000), -32768);
  const block = {
    key: 'x',
    fc: 4,
    points: [
      [1, 't', 'a'],
      [2, 's', 'b'],
      [3, 'u', 'c'],
    ],
  };
  assert.deepEqual(decodeBlock(block, [0xffec, 0xffff, 0xffff]), {
    a: { raw: 0xffec, value: -2 },
    b: { raw: 0xffff, value: -1 },
    c: { raw: 0xffff, value: 0xffff },
  });
  assert.deepEqual(decodeBlock(block, [1, 2]), {}, 'wrong size: nothing');
});

test('special values are not measures', () => {
  const e = (raw) => ({ raw, value: int16(raw) / 10 });
  const v = interpret({
    outdoor: e(0xffff),
    hpFlow: e(1300),
    hpReturn: e(0),
    hpState: { raw: 13, value: 13 },
    hpPower: { raw: 0xffff, value: -1 },
    'circuit.1.flow': e(2700),
    'circuit.1.room': e(3500),
    'circuit.2.room': e(214),
    'circuit.1.mode': { raw: 4, value: 4 },
    'circuit.2.mode': { raw: 3, value: 3 },
    'circuit.1.setpoint': e(0),
    'circuit.2.setpoint': e(500),
    'circuit.1.flowSetpoint': e(0),
    'dhw.1.setpoint': e(810),
    'dhw.1.mode': { raw: 5, value: 5 },
    'dhw.2.mode': { raw: 0, value: 0 },
    'buffer.1.top': e(0),
  });
  assert.equal(v.outdoor, -0.1, 'an outdoor temperature of -0.1 °C is real');
  assert.equal(v.hpFlow, undefined, 'open channel');
  assert.equal(v.hpReturn, undefined, '0: not installed');
  assert.equal(v.hpState, undefined, 'a state the document does not list');
  assert.equal(v.hpPower, undefined);
  assert.equal(v['circuit.1.flow'], undefined);
  assert.equal(v['circuit.1.room'], undefined);
  assert.equal(v['circuit.2.room'], 21.4);
  assert.equal(v['circuit.1.mode'], undefined);
  assert.equal(v['circuit.2.mode'], 'off');
  assert.equal(v['circuit.1.setpoint'], undefined, '0: no setpoint from Modbus');
  assert.equal(v['circuit.2.setpoint'], undefined, 'out of the document range');
  assert.equal(v['circuit.1.flowSetpoint'], 0, 'the heating curve rules');
  assert.equal(v['dhw.1.setpoint'], undefined);
  assert.equal(v['dhw.1.mode'], undefined);
  assert.equal(v['dhw.2.mode'], 'always-off');
  assert.equal(v['buffer.1.top'], undefined);
});

test('writes: one register, function 16, only the registers and values allowed', () => {
  const req = writeRequest(32000, 55);
  assert.deepEqual([...req], [16, 0x7d, 0x00, 0, 1, 2, 0x02, 0x26]);
  assert.deepEqual([...writeRequest(32000, 65)].slice(6), [0x02, 0x8a]);
  for (const bad of [65.5, 66, 80, 19.5, 50.25, Number.NaN]) {
    assert.throws(() => writeRequest(32000, bad), /out of bounds/, `hot water ${bad}`);
  }
  assert.throws(() => writeRequest(32150, 66), /out of bounds/, 'every tank');
  assert.throws(() => writeRequest(32600, 45), /out of bounds/, 'never a flow setpoint');
  assert.deepEqual([...writeRequest(32600, 0)].slice(6), [0, 0]);
  assert.throws(() => writeRequest(32602, 1), /out of bounds/, 'never cooling');
  assert.throws(() => writeRequest(32603, 4), /out of bounds/);
  assert.throws(() => writeRequest(32608, 3), /out of bounds/);
  assert.throws(() => writeRequest(32605, 30.5), /out of bounds/);
  assert.throws(() => writeRequest(32605, 9.5), /out of bounds/);
  assert.deepEqual([...writeRequest(32605, 21.5)].slice(6), [0, 215]);
  assert.throws(() => writeRequest(32002, 5), /out of bounds/);
  assert.throws(() => writeRequest(32001, 1), /never written/, 'one-time charge');
  assert.throws(() => writeRequest(33404, 1), /never written/, 'EVU lock');
  assert.throws(() => writeRequest(32606, 21), /never written/, 'external room temperature');
  assert.equal(writableKind(32903), 'circuitMode');
  assert.equal(writableKind(32900), 'circuitFlowSetpoint');
  assert.ok(isWriteEcho(req, req.subarray(0, 5)));
  assert.ok(!isWriteEcho(req, Buffer.from([16, 0x7d, 0x00, 0, 2])));
  assert.ok(!isWriteEcho(req, req));
});

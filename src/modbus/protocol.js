// -----------------------------------------------------------------------------
// The Modbus PDUs of the eco manager-touch (pure): the read requests of the
// blocks, what their answers mean, and the write requests. Every decoder
// returns undefined when the answer has not the exact size asked: an unknown
// value is never a value. Every write is checked here once more against the
// registers and values the integration may ever write (constants.js
// writableKind): anything else throws before a byte is built.
// -----------------------------------------------------------------------------

import {
  BOUNDS,
  CIRCUIT_MODES,
  DHW_CAP,
  DHW_MODES,
  FC,
  LIMITS,
  writableKind,
} from '../constants.js';

/** The first register and the count of a block (one register per point). */
export function spanOf(block) {
  const [first] = block.points[0];
  const [last] = block.points.at(-1);
  return { address: first, count: last + 1 - first };
}

/** The read request of a block (function 3 or 4). */
export function readRequest(block) {
  const { address, count } = spanOf(block);
  if (count < 1 || count > LIMITS.registersPerRead || count !== block.points.length) {
    throw new RangeError(`block ${block.key}: ${count} registers`);
  }
  if (block.fc !== FC.READ_INPUT && block.fc !== FC.READ_HOLDING) {
    throw new RangeError(`block ${block.key}: function ${block.fc}`);
  }
  const pdu = Buffer.alloc(5);
  pdu[0] = block.fc;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** The words of a read answer, or undefined when it is not exactly what was asked. */
export function parseRead(block, pdu) {
  const { count } = spanOf(block);
  if (!Buffer.isBuffer(pdu) || pdu.length < 2 || pdu[0] !== block.fc) return undefined;
  const bytes = pdu[1];
  if (bytes !== count * 2 || pdu.length !== 2 + bytes) return undefined;
  const words = [];
  for (let i = 0; i < count; i += 1) words.push(pdu.readUInt16BE(2 + i * 2));
  return words;
}

/** A signed 16-bit register. */
export const int16 = (word) =>
  Number.isInteger(word) && word >= 0 && word <= 0xffff
    ? word >= 0x8000
      ? word - 0x10000
      : word
    : undefined;

/**
 * The raw values of a block, by key: `{ raw, value }` where `raw` is the
 * register as received (unsigned) and `value` the number it means (tenths
 * scaled for a temperature).
 */
export function decodeBlock(block, words) {
  const values = {};
  if (!Array.isArray(words)) return values;
  const { address: start, count } = spanOf(block);
  if (words.length !== count) return values;
  for (const [address, type, key] of block.points) {
    const word = words[address - start];
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) continue;
    let value;
    if (type === 't') value = int16(word) / 10;
    else if (type === 's') value = int16(word);
    else value = word;
    values[key] = { raw: word, value };
  }
  return values;
}

/** The raw word of a temperature in tenths, or undefined when not a whole number of tenths. */
export function tenths(celsius) {
  if (!Number.isFinite(celsius)) return undefined;
  const raw = Math.round(celsius * 10);
  return Math.abs(raw - celsius * 10) < 1e-6 ? raw : undefined;
}

/**
 * The write request of one holding register (function 16, one register).
 * `value`: the value meant (°C for a setpoint, the code for a mode). Throws
 * when the register is not one the integration writes, or the value is out
 * of its bounds: the hot water setpoint is never above DHW_CAP.max (65 °C),
 * the flow setpoint and the cooling flag are only ever 0.
 */
export function writeRequest(address, value) {
  const kind = writableKind(address);
  let word;
  const code = (max) => {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new RangeError(`register ${address}: ${value} out of bounds`);
    }
    return value;
  };
  const celsius = (min, max) => {
    const raw = tenths(value);
    if (raw === undefined || value < min || value > max) {
      throw new RangeError(`register ${address}: ${value} out of bounds`);
    }
    return raw;
  };
  switch (kind) {
    case 'circuitFlowSetpoint':
    case 'circuitCooling':
      word = code(0);
      break;
    case 'circuitMode':
      word = code(Object.keys(CIRCUIT_MODES).length - 1);
      break;
    case 'circuitHeatingMode':
      word = code(2);
      break;
    case 'circuitSetpoint':
      word = celsius(BOUNDS.roomSetpoint.min, BOUNDS.roomSetpoint.max);
      break;
    case 'dhwSetpoint':
      word = celsius(BOUNDS.dhwSetpoint.min, Math.min(DHW_CAP.max, BOUNDS.dhwSetpoint.max));
      break;
    case 'dhwMode':
      word = code(Object.keys(DHW_MODES).length - 1);
      break;
    default:
      throw new RangeError(`register ${address} is never written`);
  }
  const pdu = Buffer.alloc(8);
  pdu[0] = FC.WRITE_MULTIPLE;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(1, 3);
  pdu[5] = 2;
  pdu.writeUInt16BE(word, 6);
  return pdu;
}

/** A write multiple is answered by its function, address and count, exactly. */
export const isWriteEcho = (request, answer) =>
  Buffer.isBuffer(answer) && answer.length === 5 && request.subarray(0, 5).equals(answer);

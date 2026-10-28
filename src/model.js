// -----------------------------------------------------------------------------
// What the raw values of a poll mean (pure): plausibility ranges, the special
// values of the eco manager-touch that are not measures, the texts of the
// modes and states.
//
// Special values (never published as measures):
//   - a temperature register of an open or unconfigured sensor channel reads
//     130.0, 270.0 or 350.0 °C (OPEN_CHANNEL, aiosolarfocus);
//   - a component not installed answers 0 (the register map follows the
//     firmware, not the installation): a temperature of exactly 0.0 °C is
//     unknown, except outdoors (a real 0.0 °C there; the outdoor sensor is
//     always fitted);
//   - room setpoint 0: "ignored" (no setpoint from Modbus), unknown;
//   - a mode or a state outside the document's list: unknown, never a code;
//   - anything outside its plausible range: unknown.
// -----------------------------------------------------------------------------

import { CIRCUIT_MODES, DHW_MODES, HEATPUMP_STATES, LIMITS, OPEN_CHANNEL } from './constants.js';

const within = (value, [min, max]) =>
  Number.isFinite(value) && value >= min && value <= max ? value : undefined;

const lookup = (table, value) =>
  Number.isInteger(value) && Object.hasOwn(table, value) ? table[value] : undefined;

const flag = (value) => (value === 0 || value === 1 ? value : undefined);

/** A temperature: never an open channel; 0.0 °C unknown unless `zeroIsReal`. */
function temperature(entry, { zeroIsReal = false } = {}) {
  if (!entry || OPEN_CHANNEL.has(entry.raw)) return undefined;
  if (entry.raw === 0 && !zeroIsReal) return undefined;
  const t = within(entry.value, LIMITS.temperature);
  return t === undefined ? undefined : Math.round(t * 10) / 10;
}

/**
 * The values of a poll, by key: only those known this time. `raw`: what the
 * blocks gave (src/modbus/protocol.js decodeBlock), keyed alike.
 */
export function interpret(raw) {
  const values = {};
  const put = (key, value) => {
    if (value !== undefined) values[key] = value;
  };
  const value = (key) => raw[key]?.value;
  put('outdoor', temperature(raw.outdoor, { zeroIsReal: true }));
  put('hpFlow', temperature(raw.hpFlow));
  put('hpReturn', temperature(raw.hpReturn));
  put('hpEvuLock', flag(value('hpEvuLock')));
  put('hpState', lookup(HEATPUMP_STATES, value('hpState')));
  put('hpPower', within(value('hpPower'), LIMITS.powerW));
  put('boilerTemperature', temperature(raw.boilerTemperature));
  for (const [key, entry] of Object.entries(raw)) {
    const match = /^(circuit|dhw|buffer)\.(\d)\.([A-Za-z]+)$/.exec(key);
    if (!match) continue;
    const [, kind, , field] = match;
    if (kind === 'buffer' || field === 'flow' || field === 'room' || field === 'temperature') {
      put(key, temperature(entry));
    } else if (kind === 'circuit' && field === 'mode') {
      put(key, lookup(CIRCUIT_MODES, entry.value));
    } else if (kind === 'circuit' && field === 'cooling') {
      put(key, flag(entry.value));
    } else if (kind === 'circuit' && field === 'heatingMode') {
      put(
        key,
        Number.isInteger(entry.value) && entry.value >= 0 && entry.value <= 2
          ? entry.value
          : undefined,
      );
    } else if (kind === 'circuit' && field === 'flowSetpoint') {
      // 0: no flow setpoint from Modbus (the heating curve rules); else the one set.
      put(key, within(entry.value, [0, 100]));
    } else if (kind === 'circuit' && field === 'setpoint') {
      put(key, entry.raw === 0 ? undefined : within(entry.value, [5, 45]));
    } else if (kind === 'dhw' && field === 'setpoint') {
      put(key, within(entry.value, [20, 80]));
    } else if (kind === 'dhw' && field === 'mode') {
      put(key, lookup(DHW_MODES, entry.value));
    }
  }
  return values;
}

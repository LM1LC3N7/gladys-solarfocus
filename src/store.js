// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
//   - the time of the last read of the controller (written at most once a
//     minute, BEFORE the read), so a restart never reads it sooner than the
//     interval;
//   - the controller of the last read (address, port, unit id): where a stop
//     goes while the configuration is not read;
//   - the stops not confirmed yet (a heating circuit off, a hot water tank
//     always off): their target, register, when they were clicked, the
//     values read before them, how many times they were sent again. They are
//     never dropped by the time: a restart checks them again at once, before
//     the configuration is even read.
// No secret (the Modbus interface has none), no personal data. The file is
// readable by the container user only (0600), bounded and repaired when read.
// A file that cannot be read is not an empty one: `load()` says so, and the
// app then never overwrites it with a guess.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  CIRCUIT_MODES,
  DHW_MODES,
  MAX_COUNTS,
  TIMINGS,
  UNIT_ID,
  circuitHolding,
  dhwHolding,
} from './constants.js';

export const STATE_FILE = '/data/solarfocus-state.json';
const MAX_BYTES = 16 * 1024;
const MAX_STOPS = MAX_COUNTS.circuits + MAX_COUNTS.dhw;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }`. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      if (text.length > MAX_BYTES) return { unreadable: true };
      try {
        return { data: JSON.parse(text) };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { unreadable = false, failSave = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    unreadable,
    failSave,
    async load() {
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.failSave) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x21-\x7e]*$/.test(value)
    ? value
    : undefined;

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** The registers a stop writes its value to, with the table of their values. */
export const STOP_REGISTERS = new Map([
  ...Array.from({ length: MAX_COUNTS.circuits }, (_, i) => [
    circuitHolding(i + 1) + 3,
    CIRCUIT_MODES,
  ]),
  ...Array.from({ length: MAX_COUNTS.dhw }, (_, i) => [dhwHolding(i + 1) + 2, DHW_MODES]),
]);

function normalizeTarget(raw) {
  const target = raw && typeof raw === 'object' ? raw : {};
  const host = shortText(target.host, 253);
  const port = intIn(target.port, 1, 65535);
  const unitId = intIn(target.unitId, UNIT_ID.min, UNIT_ID.max);
  return host && /^[a-z0-9.-]+$/.test(host) && port && unitId ? { host, port, unitId } : null;
}

function normalizeStop(raw, now) {
  if (!raw || typeof raw !== 'object') return undefined;
  const target = normalizeTarget(raw);
  const register = intIn(raw.register, 0, 0xffff);
  if (!target || !STOP_REGISTERS.has(register)) {
    return undefined;
  }
  // Clicked in the future: the clock was set back, or the file is not ours: never replayed.
  if (!Number.isFinite(raw.at) || raw.at > now) {
    return undefined;
  }
  const table = Object.values(STOP_REGISTERS.get(register));
  return {
    ...target,
    register,
    at: raw.at,
    written: raw.written === true,
    // The values read before the stop: another one read later was set elsewhere.
    before: Array.isArray(raw.before)
      ? [...new Set(raw.before.filter((v) => typeof v === 'string' && table.includes(v)))].slice(
          0,
          3,
        )
      : [],
    reasserts: Number.isInteger(raw.reasserts)
      ? Math.min(TIMINGS.stopReasserts, Math.max(0, raw.reasserts))
      : 0,
    sticky: raw.sticky === true,
  };
}

/**
 * The persisted state, repaired and bounded:
 * - `lastAttemptAt`: wall time of the last read, or null (a time in the
 *   future counts as now: never a longer wait than the interval);
 * - `target`: the controller of the last read;
 * - `stops`: the stops not confirmed.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const stops = Array.isArray(data.stops)
    ? data.stops
        .slice(0, MAX_STOPS)
        .map((s) => normalizeStop(s, now))
        .filter(Boolean)
    : [];
  const target = normalizeTarget(data.target);
  return {
    target,
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    stops,
  };
}

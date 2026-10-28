// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. No secret: the
// Modbus TCP interface of the eco manager-touch has no password.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import {
  DEFAULT_PORT,
  DHW_CAP,
  GENERATORS,
  MAX_COUNTS,
  POLL_INTERVAL,
  UNIT_ID,
} from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  unit_id: UNIT_ID.default,
  heat_generator: 'none',
  heating_circuits: 1,
  dhw_tanks: 1,
  buffers: 0,
  allow_commands: false,
  dhw_max_temperature: DHW_CAP.default,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** An IPv4 address a controller can have: never 0.x, multicast (224-239) nor reserved/broadcast. */
function unicastIPv4(host) {
  const parts = host.split('.').map(Number);
  return parts[0] !== 0 && parts[0] < 224 && parts[3] !== 255;
}

/**
 * The address of the eco manager-touch typed by the user: an IPv4 address or
 * a host name, with an optional port (502 otherwise).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  // A control character anywhere (CR, LF pasted along) is refused, never trimmed away.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(String(raw ?? ''))) {
    return undefined;
  }
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unicastIPv4(host) ? { host, port } : undefined;
  }
  if (/^[\d.]+$/.test(host) || host.includes('..')) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A whole number typed or sent: a number, or digits only ('' and ' ' are not 0). */
function strictInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * A count of components: a whole number from 0 to `max`; anything else is
 * `bad` and counts as the default (nothing guessed beyond).
 */
export function countOf(value, max, fallback) {
  const n = strictInteger(value);
  if (n === undefined || n < 0 || n > max) return { count: fallback, bad: true };
  return { count: n, bad: false };
}

/**
 * The hot water ceiling: whole degrees between DHW_CAP.min and DHW_CAP.max
 * (65 °C), else the default (65 °C). Rounded down: never above what was typed.
 */
export function dhwCapOf(value) {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d{1,3}(\.\d+)?\s*$/.test(value)
        ? Number(value)
        : undefined;
  if (!Number.isFinite(number)) return DHW_CAP.default;
  return Math.min(DHW_CAP.max, Math.max(DHW_CAP.min, Math.floor(number)));
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = typeof c.host === 'string' ? c.host.trim() : '';
  const address = typeof c.host === 'string' ? parseAddress(c.host) : undefined;
  const interval = strictInteger(c.poll_interval);
  const unitId = strictInteger(c.unit_id);
  const unitIdValid = unitId !== undefined && unitId >= UNIT_ID.min && unitId <= UNIT_ID.max;
  const circuits = countOf(
    c.heating_circuits,
    MAX_COUNTS.circuits,
    DEFAULT_CONFIG.heating_circuits,
  );
  const dhw = countOf(c.dhw_tanks, MAX_COUNTS.dhw, DEFAULT_CONFIG.dhw_tanks);
  const buffers = countOf(c.buffers, MAX_COUNTS.buffers, DEFAULT_CONFIG.buffers);
  const generator = GENERATORS.includes(c.heat_generator) ? c.heat_generator : 'none';
  return {
    /** Undefined when the address or the unit id is invalid: nothing is read nor sent. */
    address: unitIdValid ? address : undefined,
    /**
     * The length of what was typed, when it is not a valid address: the text
     * itself is never shown again (something else may have been pasted there).
     */
    invalid: typed !== '' && !address ? typed.length : undefined,
    unitId: unitIdValid ? unitId : undefined,
    badUnitId: !unitIdValid,
    generator,
    badGenerator: generator !== c.heat_generator,
    circuits: circuits.count,
    dhw: dhw.count,
    buffers: buffers.count,
    badCounts: circuits.bad || dhw.bad || buffers.bad,
    allowCommands: strictTrue(c.allow_commands),
    dhwCap: dhwCapOf(c.dhw_max_temperature),
    pollInterval:
      interval === undefined
        ? POLL_INTERVAL.default
        : Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, interval)),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What the poll reads (src/constants.js pollBlocks). */
export const layoutOf = (config) => ({
  generator: config.generator,
  circuits: config.circuits,
  dhw: config.dhw,
  buffers: config.buffers,
});

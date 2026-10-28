// -----------------------------------------------------------------------------
// The controller -> one Gladys device, its features, its commands and its
// states (pure).
//
// `ext:<selector>:solarfocus:controller`: one device per integration. FROZEN
// RULE: the Modbus map of the eco manager-touch gives no serial number, so
// the device is keyed by the integration, never by its IP address (a new
// address keeps the device and its history). The feature roles (the last
// part of their external ids) are published forever: never rename them.
// Heating circuits are `circuit-<1..8>-<suffix>`, hot water tanks
// `dhw-<1..4>-<suffix>`, buffer tanks `buffer-<1..4>-<suffix>`.
//
// Features built: the commands of the configured circuits and tanks always;
// a sensor once a value of it was read, or when the created device already
// has it (a republished device never loses a feature).
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) never reaches the heating. The commands
// are `text/select` features (modes) and target temperatures (hot water,
// room setpoint of a circuit).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  BOUNDS,
  BUFFER_FEATURES as BF,
  CIRCUIT_FEATURES as CF,
  CIRCUIT_MODES,
  DHW_CAP,
  DHW_FEATURES as DF,
  DHW_MODES,
  FEATURES as F,
  MAX_COUNTS,
  bufferRole,
  circuitControlBlocks,
  circuitHolding,
  circuitRole,
  dhwHolding,
  dhwInput,
  dhwRole,
} from './constants.js';
import {
  CIRCUIT_MODE_NAMES,
  DEVICE_NAME,
  DHW_MODE_NAMES,
  FEATURE_NAMES,
  componentFeatureName,
  word,
} from './i18n.js';

export const SERVICE = 'solarfocus';
export const PLATFORM_ID = 'controller';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -50,
  max: 120,
});
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};

/** The device features (not per component), by role, in display order; `value`: the key read. */
const DEVICE_FEATURES = [
  [F.TEMP_OUTDOOR, temperature, 'outdoor'],
  [F.HP_STATE, text, 'hpState'],
  [F.HP_TEMP_FLOW, temperature, 'hpFlow'],
  [F.HP_TEMP_RETURN, temperature, 'hpReturn'],
  [F.HP_EVU_LOCK, binary, 'hpEvuLock'],
  [
    F.HP_POWER,
    sensor({
      category: C.ENERGY_SENSOR,
      type: T.ENERGY_SENSOR.POWER,
      unit: U.WATT,
      min: 0,
      max: 30000,
    }),
    'hpPower',
  ],
  [F.BOILER_TEMP, temperature, 'boilerTemperature'],
];

/** Per component: `[suffix, definition, value field, always]`. */
const CIRCUIT_DEFS = [
  [CF.MODE, select, 'mode', true],
  [
    CF.SETPOINT,
    {
      category: C.THERMOSTAT,
      type: T.THERMOSTAT.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min: BOUNDS.roomSetpoint.min,
      max: BOUNDS.roomSetpoint.max,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    'setpoint',
    true,
  ],
  [CF.TEMP_FLOW, temperature, 'flow'],
  [CF.TEMP_ROOM, temperature, 'room'],
];

const DHW_DEFS = [
  [DF.MODE, select, 'mode', true],
  [
    DF.SETPOINT,
    {
      category: C.WATER_HEATER,
      type: T.WATER_HEATER.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min: BOUNDS.dhwSetpoint.min,
      max: DHW_CAP.max,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    'setpoint',
    true,
  ],
  [DF.TEMP, temperature, 'temperature'],
];

const BUFFER_DEFS = [
  [BF.TEMP_TOP, temperature, 'top'],
  [BF.TEMP_BOTTOM, temperature, 'bottom'],
];

const COMPONENTS = [
  ['circuit', MAX_COUNTS.circuits, CIRCUIT_DEFS, circuitRole],
  ['dhw', MAX_COUNTS.dhw, DHW_DEFS, dhwRole],
  ['buffer', MAX_COUNTS.buffers, BUFFER_DEFS, bufferRole],
];

/** Every known role: { definition, value key, always, kind?, n?, suffix? }, in display order. */
export const ROLES = new Map([
  ...DEVICE_FEATURES.map(([role, definition, value]) => [
    role,
    { definition, value, always: false },
  ]),
  ...COMPONENTS.flatMap(([kind, max, defs, roleOf]) =>
    Array.from({ length: max }, (_, i) => i + 1).flatMap((n) =>
      defs.map(([suffix, definition, value, always = false]) => [
        roleOf(n, suffix),
        { definition, value: `${kind}.${n}.${value}`, always, kind, n, suffix },
      ]),
    ),
  ),
]);

export const ids = (gladys) => gladys.externalIds(SERVICE, PLATFORM_ID);

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') return undefined;
  const match = new RegExp(`:${SERVICE}:${PLATFORM_ID}:([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.has(match[1]) ? match[1] : undefined;
}

const holdingPoint = (key, address) => ({ key, fc: 3, points: [[address, 't', key]] });

/**
 * The commands, by role: `kind` (circuitMode, room, dhw, dhwMode), the
 * component, the register written with the value (`register`), the value
 * key decided on and read back (`read`) and the blocks it is read from
 * (`blocks`); a select has its `table` and its `protective` choice (the one
 * that stops), and the blocks that confirm a stop (`stopBlocks`).
 */
export function commandOf(role) {
  const entry = ROLES.get(role);
  if (!entry?.kind) return undefined;
  const { kind, n, suffix } = entry;
  if (kind === 'circuit' && suffix === CF.MODE) {
    const blocks = circuitControlBlocks(n);
    return {
      kind: 'circuitMode',
      component: 'circuit',
      n,
      register: circuitHolding(n) + 3,
      read: entry.value,
      blocks,
      // A circuit off is confirmed by its mode, flow setpoint and cooling (§ 6.2.3).
      stopBlocks: blocks.filter((b) => !b.optional),
      table: CIRCUIT_MODES,
      protective: 'off',
    };
  }
  if (kind === 'circuit' && suffix === CF.SETPOINT) {
    const register = circuitHolding(n) + 5;
    return {
      kind: 'room',
      component: 'circuit',
      n,
      register,
      read: entry.value,
      blocks: [holdingPoint(entry.value, register)],
    };
  }
  if (kind === 'dhw' && suffix === DF.SETPOINT) {
    const register = dhwHolding(n);
    return {
      kind: 'dhw',
      component: 'dhw',
      n,
      register,
      read: entry.value,
      blocks: [holdingPoint(entry.value, register)],
    };
  }
  if (kind === 'dhw' && suffix === DF.MODE) {
    // Written to 32002 ("Soll"), read from 502 ("Ist"): what the controller applies.
    const blocks = [{ key: `dhw-${n}-mode`, fc: 4, points: [[dhwInput(n) + 2, 'u', entry.value]] }];
    return {
      kind: 'dhwMode',
      component: 'dhw',
      n,
      register: dhwHolding(n) + 2,
      read: entry.value,
      blocks,
      stopBlocks: blocks,
      table: DHW_MODES,
      protective: 'always-off',
    };
  }
  return undefined;
}

const OPTIONS = {
  circuit: [CIRCUIT_MODES, CIRCUIT_MODE_NAMES],
  dhw: [DHW_MODES, DHW_MODE_NAMES],
};

function nameOf(role, language) {
  const entry = ROLES.get(role);
  return word(
    entry.kind ? componentFeatureName(entry.kind, entry.n, entry.suffix) : FEATURE_NAMES[role],
    language,
  );
}

/** Whether the component of a role is in the configuration. */
function configured(entry, counts) {
  if (!entry.kind) return true;
  const count = { circuit: counts.circuits, dhw: counts.dhw, buffer: counts.buffers }[entry.kind];
  return entry.n <= (count ?? 0);
}

/**
 * The roles the device shows: the `always` ones (of the configured
 * components), those seen with a value in this run, and those of the created
 * device.
 */
export function rolesToBuild({ counts, seen = new Set(), created = new Set() }) {
  const roles = [];
  for (const [role, entry] of ROLES) {
    if ((entry.always && configured(entry, counts)) || seen.has(role) || created.has(role)) {
      roles.push(role);
    }
  }
  return roles;
}

/** The Gladys device of the controller. */
export function buildDevice(gladys, { language, roles, dhwCap = DHW_CAP.default }) {
  const i = ids(gladys);
  return {
    name: word(DEVICE_NAME, language),
    external_id: i.device,
    model: 'Solarfocus eco manager-touch',
    should_poll: false,
    features: roles.map((role) => {
      const entry = ROLES.get(role);
      const options = entry.suffix === 'mode' ? OPTIONS[entry.kind] : undefined;
      return {
        name: nameOf(role, language),
        external_id: i.feature(role),
        ...entry.definition,
        // The hot water slider stops at the ceiling of the configuration (65 °C at most).
        ...(entry.kind === 'dhw' && entry.suffix === DF.SETPOINT
          ? { max: Math.min(DHW_CAP.max, dhwCap) }
          : {}),
        ...(options
          ? {
              supported_options: Object.values(options[0]).map((value, index) => ({
                value,
                label: word(options[1][value], language),
                sort_order: index,
              })),
            }
          : {}),
      };
    }),
    params: [{ name: 'protocol', value: 'Modbus TCP' }],
  };
}

/** The roles a set of values gives a value to. */
export function rolesWithValues(values) {
  const roles = [];
  for (const [role, entry] of ROLES) {
    if (values[entry.value] !== undefined) roles.push(role);
  }
  return roles;
}

/**
 * The states of the values given (a value not read this time is left out:
 * Gladys keeps its last one, never republished as new). Texts are stable
 * English keys, whatever the language (scenes keep working); a text is
 * never published as a number.
 */
export function deviceStates(i, values) {
  const states = [];
  for (const [role, entry] of ROLES) {
    const value = values[entry.value];
    if (value === undefined) continue;
    const id = i.feature(role);
    if (entry.definition.category === C.TEXT) {
      if (typeof value === 'string') states.push({ device_feature_external_id: id, text: value });
    } else if (Number.isFinite(value)) {
      states.push({ device_feature_external_id: id, state: value });
    }
  }
  return states;
}

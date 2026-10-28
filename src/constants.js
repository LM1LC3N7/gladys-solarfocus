// -----------------------------------------------------------------------------
// Solarfocus constants: the Modbus TCP map of the eco manager-touch, manifest
// keys, feature roles, limits and timings.
//
// The eco manager-touch answers Modbus TCP on port 502, unit id 1, without
// authentication, once "Modbus TCP" is activated in its menu "Customer menu >
// Installer (spanner) > Modbus TCP". The registers are those of Solarfocus's
// own document "Regelung ecomanager-touch: Modbus TCP - Registerdaten"
// (DR-0180-DE / v14-260212, the current firmware 26.020), cross-checked with
// aiosolarfocus 0.3.0 and home-assistant-solarfocus 7.0.1 (Apache-2.0), which
// record how the controller really answers (aiosolarfocus docs/protocol.md):
//   - a read that spans an address the firmware does not map is COMPACTED, not
//     padded: the values after the hole silently shift. Every block below is
//     a run of addresses the document maps on every firmware it covers, with
//     no hole (checked by test/protocol.test.js; the fake controller compacts
//     like the real one, so a block with a hole would read wrong values);
//   - a read that starts at an unmapped address is refused (exception 2);
//   - the register map follows the firmware, not the installation: a
//     component not installed answers values (0, or a sensor marker), hence
//     the counts of the configuration and the special values of src/model.js.
// Only these requests are ever sent:
//   - read input registers (function 4) and read holding registers (function
//     3) of the blocks below;
//   - write multiple registers (function 16), ONE register per request, at the
//     holding registers of WRITABLE only, each with its own bounds (checked
//     again in src/modbus/protocol.js writeRequest).
// Every value is one 16-bit register: int16 (temperatures in tenths of a
// degree) or uint16 (states, flags).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;

/** Modbus function codes used (nothing else is ever sent). */
export const FC = {
  READ_HOLDING: 0x03,
  READ_INPUT: 0x04,
  WRITE_MULTIPLE: 0x10,
};

/** The MBAP header (7 bytes) and the largest frame Modbus TCP allows (260 bytes). */
export const MBAP_SIZE = 7;
export const MAX_FRAME = 260;

/** How many of each repeated component the document numbers. */
export const MAX_COUNTS = { circuits: 8, dhw: 4, buffers: 4 };

/**
 * Register types: `t` int16 in tenths (a temperature), `s` int16, `u`
 * uint16. Every point is one register.
 */
export const TYPES = ['t', 's', 'u'];

/** The heat generator of the configuration (which input block is read). */
export const GENERATORS = ['none', 'vampair', 'biomass'];

/** Heating circuit n (1-8): input block 1100 + 50 (n-1), holding block 32600 + 50 (n-1). */
export const circuitInput = (n) => 1100 + 50 * (n - 1);
export const circuitHolding = (n) => 32600 + 50 * (n - 1);
/** Hot water tank ("Boiler") n (1-4): input 500 + 50 (n-1), holding 32000 + 50 (n-1). */
export const dhwInput = (n) => 500 + 50 * (n - 1);
export const dhwHolding = (n) => 32000 + 50 * (n - 1);
/** Buffer tank n (1-4): input 1900 + 20 (n-1). */
export const bufferInput = (n) => 1900 + 20 * (n - 1);

/**
 * The blocks read at each poll, for a configuration: `fc` the function,
 * `points` `[address, type, key]`, contiguous. `optional`: an "illegal data
 * address" before it was ever answered means the firmware does not have it
 * (not read again until a restart); `probe`: the block is read only when the
 * probe block was answered (a register whose address moved between firmware
 * versions is read only when the version that documents it is there).
 *
 * Heating circuit 7: the document prints its flow setpoint at 32750 (circuit
 * 4's address), a misprint (aiosolarfocus docs/register-document.md): 32900,
 * where its block starts and the stride of every other circuit puts it.
 */
export function pollBlocks({ generator = 'none', circuits = 0, dhw = 0, buffers = 0 } = {}) {
  const blocks = [{ key: 'outdoor', fc: 4, points: [[2408, 't', 'outdoor']] }];
  if (generator === 'vampair') {
    blocks.push(
      {
        key: 'heatpump',
        fc: 4,
        points: [
          [2300, 't', 'hpFlow'],
          [2301, 't', 'hpReturn'],
          [2302, 's', 'hpFlowRate'],
          [2303, 's', 'hpCompressor'],
          [2304, 'u', 'hpEvuLock'],
        ],
      },
      // 2330 "vampair Status" (since 20.110) is where the 25.030 layout puts
      // it: answered, the power registers 2322-2324 are those of the
      // document; refused, the firmware has the older layout (energy
      // counters there): the power is not read.
      { key: 'heatpump-state', fc: 4, optional: true, points: [[2330, 'u', 'hpState']] },
      {
        key: 'heatpump-power',
        fc: 4,
        optional: true,
        probe: 'heatpump-state',
        points: [
          [2322, 's', 'hpPower'],
          [2323, 's', 'hpThermalCooling'],
          [2324, 's', 'hpThermalHeating'],
        ],
      },
    );
  } else if (generator === 'biomass') {
    blocks.push({ key: 'boiler', fc: 4, points: [[2400, 't', 'boilerTemperature']] });
  }
  for (let n = 1; n <= circuits; n += 1) {
    const i = circuitInput(n);
    const h = circuitHolding(n);
    blocks.push(
      {
        key: `circuit-${n}`,
        fc: 4,
        points: [
          [i, 't', `circuit.${n}.flow`],
          [i + 1, 't', `circuit.${n}.room`],
        ],
      },
      ...circuitControlBlocks(n),
      { key: `circuit-${n}-setpoint`, fc: 3, points: [[h + 5, 't', `circuit.${n}.setpoint`]] },
    );
  }
  for (let n = 1; n <= dhw; n += 1) {
    blocks.push(dhwStateBlock(n), dhwControlBlock(n));
  }
  for (let n = 1; n <= buffers; n += 1) {
    const b = bufferInput(n);
    blocks.push({
      key: `buffer-${n}`,
      fc: 4,
      points: [
        [b, 't', `buffer.${n}.top`],
        [b + 1, 't', `buffer.${n}.bottom`],
      ],
    });
  }
  return blocks;
}

/**
 * The holding registers a circuit's operating state is made of (§ 6.2 of
 * the document: written together): 32600 flow setpoint, 32602 cooling,
 * 32603 operating mode, and 32608 heating mode, since 22.090 (optional: an
 * older firmware refuses it, then it is neither read nor written).
 */
export function circuitControlBlocks(n) {
  const h = circuitHolding(n);
  return [
    { key: `circuit-${n}-flow-setpoint`, fc: 3, points: [[h, 't', `circuit.${n}.flowSetpoint`]] },
    {
      key: `circuit-${n}-mode`,
      fc: 3,
      points: [
        [h + 2, 'u', `circuit.${n}.cooling`],
        [h + 3, 'u', `circuit.${n}.mode`],
      ],
    },
    {
      key: `circuit-${n}-heating-mode`,
      fc: 3,
      optional: true,
      points: [[h + 8, 'u', `circuit.${n}.heatingMode`]],
    },
  ];
}

/**
 * Input 500: temperature, 501 state (read, not shown yet), 502 release mode
 * as the controller applies it ("Freigabeart – Ist"): the mode shown, decided
 * on and confirmed. The mode is written to holding 32002 ("Soll").
 */
export function dhwStateBlock(n) {
  const i = dhwInput(n);
  return {
    key: `dhw-${n}`,
    fc: 4,
    points: [
      [i, 't', `dhw.${n}.temperature`],
      [i + 1, 'u', `dhw.${n}.state`],
      [i + 2, 'u', `dhw.${n}.mode`],
    ],
  };
}

/** Holding 32000: the hot water setpoint (read, written). */
export function dhwControlBlock(n) {
  return { key: `dhw-${n}-control`, fc: 3, points: [[dhwHolding(n), 't', `dhw.${n}.setpoint`]] };
}

/** Register 32603 + 50 (n-1), "Heizkreisbetriebsart" (document: 0 to 3). */
export const CIRCUIT_MODES = {
  0: 'continuous',
  1: 'setback',
  2: 'automatic',
  3: 'off',
};

/** Registers 502 + 50 (n-1) (read) and 32002 + 50 (n-1) (written), "Boiler – Freigabeart" (0 to 4). */
export const DHW_MODES = {
  0: 'always-off',
  1: 'always-on',
  2: 'monday-sunday',
  3: 'block-wise',
  4: 'day-wise',
};

/** Register 2330, "vampair Status" (document: 0 to 12). */
export const HEATPUMP_STATES = {
  0: 'standby',
  1: 'heating',
  2: 'heating-dhw',
  3: 'cooling',
  4: 'manual',
  5: 'evu-lock',
  6: 'no-time-release',
  7: 'outdoor-lockout',
  8: 'electric-heater',
  9: 'external-boiler',
  10: 'cooling-request',
  11: 'manual-power',
  12: 'off',
};

/**
 * What an unconfigured or open sensor channel reports instead of a
 * temperature (raw tenths: 130.0, 270.0, 350.0 °C; aiosolarfocus
 * OPEN_CHANNEL, seen on real controllers).
 */
export const OPEN_CHANNEL = new Set([1300, 2700, 3500]);

/**
 * The holding registers ever written, by kind, with the raw values allowed
 * (src/modbus/protocol.js refuses anything else):
 *   - circuit 32600 flow setpoint: 0 only ("ignored: the heating curve of the
 *     controller rules"; the integration never sends a flow setpoint, so the
 *     dew point monitoring of the controller is never switched off);
 *   - circuit 32602 cooling: 0 only (the integration never cools);
 *   - circuit 32603 operating mode: 0-3; 32605 room setpoint: 10-30 °C;
 *     32608 heating mode: 0-2;
 *   - hot water 32000 setpoint: 20 °C to 65 °C (DHW_CAP.max); 32002 mode 0-4.
 */
export function writableKind(address) {
  for (let n = 1; n <= MAX_COUNTS.circuits; n += 1) {
    const h = circuitHolding(n);
    if (address === h) return 'circuitFlowSetpoint';
    if (address === h + 2) return 'circuitCooling';
    if (address === h + 3) return 'circuitMode';
    if (address === h + 5) return 'circuitSetpoint';
    if (address === h + 8) return 'circuitHeatingMode';
  }
  for (let n = 1; n <= MAX_COUNTS.dhw; n += 1) {
    const h = dhwHolding(n);
    if (address === h) return 'dhwSetpoint';
    if (address === h + 2) return 'dhwMode';
  }
  return undefined;
}

/**
 * Modbus exception codes that mean the request was not applied (illegal
 * function, address, value). Any other code (4 device failure, 5
 * acknowledge, 6 busy…) may come from a write applied anyway: "sent, without
 * confirmation".
 */
export const NOT_APPLIED_EXCEPTIONS = new Set([1, 2, 3]);

/** Modbus exception code 2: the register is not served by this firmware. */
export const ILLEGAL_DATA_ADDRESS = 2;

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  TEMP_OUTDOOR: 'temperature-outdoor',
  HP_TEMP_FLOW: 'heatpump-temperature-flow',
  HP_TEMP_RETURN: 'heatpump-temperature-return',
  HP_EVU_LOCK: 'heatpump-evu-lock',
  HP_STATE: 'heatpump-state',
  HP_POWER: 'heatpump-power',
  BOILER_TEMP: 'boiler-temperature',
};

/** The roles of a heating circuit: `circuit-<n>-<suffix>`. */
export const CIRCUIT_FEATURES = {
  MODE: 'mode',
  SETPOINT: 'setpoint',
  TEMP_FLOW: 'temperature-flow',
  TEMP_ROOM: 'temperature-room',
};

/** The roles of a hot water tank: `dhw-<n>-<suffix>`. */
export const DHW_FEATURES = {
  MODE: 'mode',
  SETPOINT: 'setpoint',
  TEMP: 'temperature',
};

/** The roles of a buffer tank: `buffer-<n>-<suffix>`. */
export const BUFFER_FEATURES = {
  TEMP_TOP: 'temperature-top',
  TEMP_BOTTOM: 'temperature-bottom',
};

export const circuitRole = (n, suffix) => `circuit-${n}-${suffix}`;
export const dhwRole = (n, suffix) => `dhw-${n}-${suffix}`;
export const bufferRole = (n, suffix) => `buffer-${n}-${suffix}`;

/**
 * The bounds of the values written. The document allows a room setpoint of
 * 5-45 °C and a hot water setpoint of 20-80 °C; the integration stays inside:
 * room 10-30 °C by 0.5, hot water 20 °C to the ceiling of the configuration,
 * never above 65 °C (DHW_CAP), by 0.5.
 */
export const BOUNDS = {
  dhwSetpoint: { min: 20, max: 80, step: 0.5 },
  roomSetpoint: { min: 10, max: 30, step: 0.5 },
};

/** The hot water ceiling of the configuration, in °C: never above 65 °C. */
export const DHW_CAP = { min: 20, max: 65, default: 65 };

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

/** The Modbus unit id (slave id) of the configuration (the document: 1). */
export const UNIT_ID = { min: 1, max: 247, default: 1 };

export const LIMITS = {
  /** Gladys: 300 states per minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Registers in one read (Modbus: 125 at most). */
  registersPerRead: 8,
  /** Plausible ranges: a value outside is not a measure. */
  temperature: [-50, 120],
  powerW: [0, 30000],
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection of a poll. */
  connectTimeout: 3 * SECOND,
  /** A session closed gracefully waits this long for the controller to close its side. */
  closeWait: 500,
  /** One answer. */
  requestTimeout: 2 * SECOND,
  /** A refused connection of a stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Gladys waits 5 s for the ack: every click is answered by 3.5 s (a command
   * or a stop still running goes on, and the answer says what is known);
   * a stop is tried (connection refused, closed, timeout) until 3 s after
   * its start.
   */
  commandSendBy: 3_000,
  commandAnswerBy: 3_500,
  commandConnectMax: 2_000,
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /**
   * A command waiting its turn (a scene setting several values) starts within
   * 15 s of the start of its turn and 60 s of its arrival, or never.
   */
  queueWindow: 15 * SECOND,
  queueMax: MINUTE,
  /** A poll goes on after this many blocks without an answer (each on a new connection), then stops. */
  readTimeouts: 2,
  /** The configuration could not be read from Gladys: tried again this often. */
  configRetry: 30 * SECOND,
  /**
   * The time the controller is given to show a change. Reads after a
   * command: 5 s, 25 s and 60 s later.
   */
  applyDelay: 20 * SECOND,
  followUps: [5 * SECOND, 25 * SECOND, 60 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 2 min. */
  guard: 2 * MINUTE,
  /** A stop not confirmed is sent again three times at most (never lifted by the time). */
  stopReasserts: 3,
  /** A stop guard still sending is checked this often (read, then written again if needed). */
  stopRetry: 15 * SECOND,
  /** A check that gave its turn up to a click or a command is tried again this soon. */
  checkYield: SECOND,
  /** Last values older than this are never sent again to Gladys (connected, device created). */
  freshFor: 2 * MINUTE,
};

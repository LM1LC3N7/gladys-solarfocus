// -----------------------------------------------------------------------------
// The integration: the eco manager-touch typed in the configuration (its IP
// address and Modbus unit id), one read of its registers every poll interval
// over one Modbus TCP connection, the Gladys device and its states, the
// transport badge, the "Test the connection" button, and the commands.
// index.js only wires the SDK handlers to it (src/handlers.js).
//
// One Modbus connection at a time (the "line"), one request at a time on it:
// a poll is one session of a few reads, closed after; the commands take the
// line from a poll (the poll is dropped, nothing of it published); a stop
// takes it from anything.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read);
//   - a block refused leaves its values unknown and never stops the others;
//     every block refused is a failed read, never "Connected";
//   - an answer for an old configuration (generation) publishes nothing; a
//     read begun before a command left is not applied; a value not read this
//     time is never republished as new, nor values older than 2 minutes.
//
// Commands (circuit mode, room setpoint, hot water setpoint and mode):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before each write (nothing runs in between);
//   - bounded on arrival and right before the write: hot water 20 °C to the
//     ceiling of the configuration (65 °C by default, 65 °C at most), room
//     10-30 °C, by 0.5;
//   - decided on a fresh read of the registers written, in the same session,
//     never on the state in memory; refused when they cannot be read; not
//     written when already so (unless a guard says a previous command may
//     not show yet);
//   - a circuit mode is written as the document asks (§ 6.2: all the
//     registers of the circuit): flow setpoint 0 (the heating curve of the
//     controller), cooling 0, the heating mode as read (since 22.090, read
//     first: an older firmware has none), then the mode; refused while a
//     flow setpoint written by another Modbus client is active (never
//     overridden by a mode change);
//   - one at a time, in their order of arrival (a scene setting several
//     values sets them all, one after the other on the same connection);
//     confirmed only by the echo of every write and a read back equal to the
//     value asked; else "sent, without confirmation" and spaced reads;
//   - answered to Gladys by 3.5 s; a command still waiting its turn then goes
//     on (15 s at most after its arrival), and the answer says so;
//   - the ack never waits for a publication to Gladys.
// Stops (a heating circuit "off", a hot water tank "always off") protect:
// never held back by the option, the bounds, a command or a read in
// progress, a failed read, a backoff, a device never read, nor a
// configuration not read yet (after a restart, a stop kept in /data is
// checked again before it); every command that arrived before a stop and has
// not left is dropped; a refused connection is tried again every 250 ms for
// 3 s. A circuit off writes § 6.2.3 of the document, the mode first:
// mode 3, flow setpoint 0, cooling 0, and the heating mode last read (2, as
// in the document, when never read; not written on a firmware without it).
// A stop not confirmed is kept in /data with the values read before it and
// checked every 15 s: written again (three times at most) while the
// controller shows a value of before or an unknown one. Its guard is never
// lifted by the time: only by a read showing the stop, a newer command to
// the same register that left (a click, with the option), or another value
// read twice in a row (set elsewhere, never overridden; a value of before
// that was unknown never counts as one). One lock for the line: a session
// opens only once the previous one is closed.
//
// In-memory times (deadlines, guards, the time of the last read) are on a
// monotonic clock (`clock`); the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, layoutOf, normalizeConfig } from './config.js';
import {
  BOUNDS,
  DHW_CAP,
  ILLEGAL_DATA_ADDRESS,
  MAX_COUNTS,
  MINUTE,
  NOT_APPLIED_EXCEPTIONS,
  SECOND,
  TIMINGS,
  circuitHolding,
  dhwHolding,
  pollBlocks,
} from './constants.js';
import {
  buildDevice,
  commandOf,
  deviceStates,
  ids,
  parseFeatureId,
  rolesToBuild,
  rolesWithValues,
} from './devices.js';
import { ERRORS, T, age, componentName, join, reasonOf, word } from './i18n.js';
import { interpret } from './model.js';
import { ERROR_KINDS, ModbusError, errorReason, openSession, tcpConnect } from './modbus/client.js';
import {
  decodeBlock,
  isWriteEcho,
  parseRead,
  readRequest,
  writeRequest,
} from './modbus/protocol.js';
import { StatePublisher } from './publisher.js';
import { STOP_REGISTERS, fileStore, normalizeMemory } from './store.js';

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time), and when it started. */
  values: undefined,
  readAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  /** The blocks that failed in the last read. */
  failed: [],
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

const sameTarget = (a, b) =>
  Boolean(a && b) && a.host === b.host && a.port === b.port && a.unitId === b.unitId;

/**
 * What a read shows of a circuit stopped by halves: mode 3 without its flow
 * setpoint and cooling at 0 (§ 6.2.3 not complete). Never a mode key.
 */
const PARTIAL = 'off-incomplete';

/** The key of a stop guard: its controller and its register. */
export const guardKey = (target, register) =>
  `${target.host}:${target.port}:${target.unitId}:${register}`;

/** The heating circuit (1-8) of a holding register of its block, else undefined. */
const circuitOf = (register) => {
  for (let n = 1; n <= MAX_COUNTS.circuits; n += 1) {
    const h = circuitHolding(n);
    if (register >= h && register < h + 50) return n;
  }
  return undefined;
};

/** The hot water tank (1-4) of a holding register of its block, else undefined. */
const dhwOf = (register) => {
  for (let n = 1; n <= MAX_COUNTS.dhw; n += 1) {
    const h = dhwHolding(n);
    if (register >= h && register < h + 50) return n;
  }
  return undefined;
};

/** The role whose command writes `register` as its decisive value (a mode). */
function stopRole(register) {
  const circuit = circuitOf(register);
  if (circuit && register === circuitHolding(circuit) + 3) return `circuit-${circuit}-mode`;
  const dhw = dhwOf(register);
  if (dhw && register === dhwHolding(dhw) + 2) return `dhw-${dhw}-mode`;
  return undefined;
}

export class SolarfocusApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'solarfocus' }),
    connect = tcpConnect,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: never overwritten (a guess would lose what it holds). */
    this.memoryUnreadable = false;
    this.memoryLoaded = undefined;
    this.unit = freshUnit();
    this.generation = 0;
    this.started = false;
    /** The configurations saved, applied one after the other (the last one wins). */
    this.configChain = Promise.resolve();
    /** The time of the last read sent to the controller (monotonic). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Roles that had a value during this run (their features are built). */
    this.seen = new Set();
    /** Optional blocks the firmware does not serve (until a restart), and those answered once. */
    this.absent = new Set();
    this.answered = new Set();
    /** The session on the line: { kind: 'read' | 'command' | 'protect' | 'check', abort(), done }. */
    this.active = undefined;
    /** Commands and stops waiting for the line (a poll does not start meanwhile). */
    this.reserved = 0;
    /** The commands waiting, in order, and the worker running them. */
    this.queue = [];
    this.worker = undefined;
    /** The stops waiting, and their worker. */
    this.stops = [];
    this.stopWorker = undefined;
    /** The register whose stop guard is being checked, if any. */
    this.checking = undefined;
    /** Counts the stops: a command that arrived before the current count gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** Value key -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** Register -> a stop not confirmed (see protect). */
    this.stopGuards = new Map();
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  /** The controller of the configuration: { host, port, unitId }, or undefined. */
  target() {
    const a = this.config.address;
    return a ? { host: a.host, port: a.port, unitId: this.config.unitId } : undefined;
  }

  // --- /data ----------------------------------------------------------------

  /** Loads /data once (the stops kept there belong to the whole run). */
  loadMemory() {
    if (!this.memoryLoaded) {
      this.memoryLoaded = (async () => {
        let result;
        try {
          result = await this.store.load();
        } catch {
          result = { unreadable: true };
        }
        if (result?.unreadable) {
          this.memoryUnreadable = true;
          this.logger.warn(
            'Solarfocus: /data/solarfocus-state.json cannot be read: it is never overwritten',
          );
          this.memory = normalizeMemory(null, this.now());
          return;
        }
        this.memory = normalizeMemory(result?.data ?? null, this.now());
      })();
    }
    return this.memoryLoaded;
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      return false;
    }
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`Solarfocus: saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /** The stops not confirmed, in /data. */
  /** The stops not confirmed, in /data. */
  persistStops() {
    const stops = [];
    for (const g of this.stopGuards.values()) {
      stops.push({
        ...g.target,
        register: g.register,
        at: g.at,
        written: g.written,
        reasserts: g.reasserts,
        sticky: g.sticky,
        before: g.before.slice(0, 3),
      });
    }
    if (JSON.stringify(stops) === JSON.stringify(this.memory.stops ?? [])) {
      return;
    }
    this.memory.stops = stops;
    this.saveMemory().catch(() => {});
    // The status lists the stops not confirmed.
    if (this.started) this.updateStatus().catch(() => {});
  }

  /** The heating mode (32608) last read on circuit `n` of `target`: 0-2, 'absent' or undefined. */
  /** Keeps the heating modes read (and those the firmware has not) for the stops. */
  /**
   * At the start of the container, before the configuration is read: the
   * stops kept in /data (not confirmed before the restart) are checked at
   * once on the controller they were sent to, and sent again unless it shows
   * the stop or another value set there meanwhile; then checked until
   * confirmed or lifted (never by the time).
   */
  async boot() {
    await this.loadMemory();
    for (const kept of this.memory.stops ?? []) {
      const plan = this.stopPlan(kept.register);
      if (!plan) {
        continue;
      }
      const target = { host: kept.host, port: kept.port, unitId: kept.unitId };
      const guard = this.ensureStopGuard(plan, target);
      Object.assign(guard, {
        at: kept.at,
        before: [...kept.before],
        written: kept.written,
        reasserts: kept.reasserts,
        sticky: kept.sticky,
        // The controller had the time to apply it: no delay before the check.
        sentAt: undefined,
      });
      this.logger.warn(
        `Solarfocus: a stop kept in /data (register ${kept.register}) is checked again after the restart`,
      );
      this.runCheck(guard.key).catch((err) =>
        this.logger.warn(`Solarfocus: check after the restart: ${err.message}`),
      );
    }
    this.persistStops();
  }

  /** The plan of a stop of `register` (a circuit mode "off", a tank "always off"). */
  stopPlan(register) {
    const role = STOP_REGISTERS.has(register) ? stopRole(register) : undefined;
    const command = role ? commandOf(role) : undefined;
    if (!command?.protective) {
      return undefined;
    }
    const written = Number(
      Object.entries(command.table).find(([, key]) => key === command.protective)[0],
    );
    return { role, command, written, expected: command.protective };
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new configuration while running (a read may go
   * at once for another controller, after the interval for the same one); otherwise (container start) the first read waits for the
   * interval after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    const before = this.target();
    this.stop();
    // Set at once: a `connected` or a configuration saved during this start
    // compares with it (never a restart, never a read before the interval).
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.unit.running;
    await this.loadMemory();
    if (generation !== this.generation) {
      return;
    }
    this.unit = freshUnit();
    this.absent.clear();
    this.answered.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    this.wakeGuards();
    if (!this.config.address) {
      // The device already created is shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    // A new controller may be read at once; the same one never sooner than the interval.
    const wait = !fresh
      ? this.firstWait()
      : sameTarget(before, this.target())
        ? Math.max(0, this.due - this.mono())
        : 0;
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: a whole interval.
      return this.interval;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    // A read or a command of this configuration ends; a stop or a check has its own target.
    if (this.active && ['read', 'command'].includes(this.active.kind)) {
      this.active.abort('stopped');
    }
    this.publisher.stop();
    // Guards of commands belong to this configuration only (stops keep theirs: their own target).
    this.guards.clear();
  }

  /** The container stops: every timer, the checks of the stops too (they are in /data). */
  shutdown() {
    this.stop();
    for (const guard of this.stopGuards.values()) {
      if (guard.timer) this.timers.clearTimeout(guard.timer);
      guard.timer = undefined;
    }
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge) and the
   * recent states, without reading the controller.
   */
  connected(raw = {}) {
    return this.applyConfig(async () => {
      this.configRead = true;
      if (!this.started) {
        this.started = true;
        await this.start(raw);
        return;
      }
      if (this.needsRestart(raw)) {
        await this.start(raw, { fresh: true });
        return;
      }
      const previous = this.config;
      this.config = normalizeConfig(raw);
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
      this.rescheduleOnNewInterval(previous);
      await this.publishAll();
    });
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), then `connected`. Every `connected`
   * (the first one and each reconnection) goes through here.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`Solarfocus: reading the configuration failed: ${err.message}`);
      await this.setStatus(false, T.configUnreadable);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected(getConfig).catch(() => {});
      }, TIMINGS.configRetry);
      return;
    }
    await this.connected(raw);
  }

  /** Configurations are applied one at a time, in their order (the last one wins). */
  applyConfig(fn) {
    const run = this.configChain.then(fn);
    this.configChain = run.catch((err) =>
      this.logger.warn(`Solarfocus: applying the configuration failed: ${err.message}`),
    );
    return run;
  }

  /** A new address, unit id, generator or count restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid ||
      next.unitId !== this.config.unitId ||
      JSON.stringify(layoutOf(next)) !== JSON.stringify(layoutOf(this.config))
    );
  }

  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  configUpdated(raw = {}) {
    return this.applyConfig(async () => {
      this.configRead = true;
      if (this.needsRestart(raw)) {
        await this.start(raw, { fresh: true });
        return;
      }
      const previous = this.config;
      this.config = normalizeConfig(raw);
      this.rescheduleOnNewInterval(previous);
      if (this.config.allowCommands !== previous.allowCommands) {
        this.logger.info(
          `Solarfocus commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`,
        );
      }
      if (this.config.language !== previous.language || this.config.dhwCap !== previous.dhwCap) {
        this.published = undefined;
      }
      await this.publishAll();
    });
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- The line (one Modbus connection at a time) ------------------------------

  /**
   * Runs `fn(session)` on its own connection to `target`; the line is held
   * until it ends. The only lock of the line: a session opens only once no
   * other holds it (a stop ends any other session first and waits for its
   * end). `yieldTo()`: checked right before the line is taken, with no
   * `await` in between; true gives the turn up (a command or a read before
   * a stop waiting). `retryUntil`: a refused connection is tried again every
   * 250 ms until then (nothing is sent before the connection, so this never
   * repeats a write).
   */
  async useLine(kind, target, timeoutMs, fn, { retryUntil, yieldTo } = {}) {
    while (this.active) {
      if (kind === 'protect' && this.active.kind !== 'protect') {
        this.active.abort('line taken');
      }
      await this.active.done;
    }
    if (yieldTo?.()) {
      throw Object.assign(new ModbusError(ERROR_KINDS.ABORTED, 'turn given up'), {
        yielded: true,
      });
    }
    let finish;
    const record = {
      kind,
      aborted: false,
      opener: undefined,
      session: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.opener?.abort();
        record.session?.abort(message);
      },
    };
    this.active = record;
    try {
      let session;
      for (;;) {
        const attemptMs =
          retryUntil === undefined
            ? timeoutMs
            : Math.min(timeoutMs, Math.max(100, retryUntil - this.mono()));
        record.opener = openSession({
          host: target.host,
          port: target.port,
          unitId: target.unitId,
          connect: this.connect,
          timeoutMs: attemptMs,
          timers: this.timers,
          now: () => this.mono(),
        });
        try {
          session = await record.opener.promise;
          break;
        } catch (err) {
          const again =
            err.kind === ERROR_KINDS.UNREACHABLE &&
            !record.aborted &&
            retryUntil !== undefined &&
            this.mono() + TIMINGS.connectRetry < retryUntil;
          if (!again) {
            throw err;
          }
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
        if (record.aborted) {
          throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
        }
      }
      record.session = session;
      if (record.aborted) {
        session.abort();
        throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
      }
      return await fn(session, record);
    } finally {
      // The line is free only once the connection is closed (never two at once).
      await record.session?.close();
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      await current.done;
    }
  }

  /** One block read in `session`: its raw words decoded (src/modbus/protocol.js). */
  async readBlock(session, block, options) {
    const pdu = await session.request(readRequest(block), options);
    const words = parseRead(block, pdu);
    if (words === undefined) {
      // An answer of the wrong size: the session is not trusted any more.
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size', { sent: true });
    }
    return decodeBlock(block, words);
  }

  /**
   * The values of `blocks` read now in `session` (interpreted), for a
   * command. An optional block refused with "illegal data address" is not
   * served by this firmware (marked absent); any other refusal throws.
   */
  async readFresh(session, blocks, options) {
    const raw = {};
    for (const block of blocks) {
      if (block.optional && this.absent.has(block.key)) continue;
      try {
        Object.assign(raw, await this.readBlock(session, block, options));
      } catch (err) {
        if (
          block.optional &&
          err.kind === ERROR_KINDS.REFUSED &&
          err.code === ILLEGAL_DATA_ADDRESS &&
          !this.answered.has(block.key)
        ) {
          this.absent.add(block.key);
          continue;
        }
        throw err;
      }
      this.answered.add(block.key);
    }
    return { raw, values: interpret(raw) };
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval; never sooner than the interval after the last read. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    let wait = delay ?? (u.online === false ? u.wait : this.interval);
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - this.mono()), 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('Solarfocus refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /** Keeps the time of this read; in /data BEFORE the read, at most once a minute. */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  async run() {
    const generation = this.generation;
    const target = this.target();
    if (!target) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // A command or a stop holds the line: the poll waits for the next turn.
      this.schedule();
      return;
    }
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      this.schedule();
      return;
    }
    const startedAt = this.mono();
    const read = {
      blocks: pollBlocks(layoutOf(this.config)),
      index: 0,
      current: undefined,
      raw: {},
      failed: [],
      answeredNow: new Set(),
      timeouts: 0,
    };
    let result;
    let failure;
    for (;;) {
      try {
        await this.useLine(
          'read',
          target,
          TIMINGS.connectTimeout,
          (session) => this.readBlocks(session, read),
          { yieldTo: () => this.reserved > 0 || this.stops.length > 0 },
        );
        result = this.readResult(read);
      } catch (err) {
        failure = err;
        if (
          err.kind === ERROR_KINDS.TIMEOUT &&
          read.current &&
          generation === this.generation &&
          this.timedOut(read)
        ) {
          // That block on a new connection is skipped; the next ones are read.
          failure = undefined;
          continue;
        }
      }
      break;
    }
    if (failure?.kind === ERROR_KINDS.TIMEOUT && read.answeredNow.size > 0) {
      // Too many blocks without an answer: what was read is kept, the rest is not read this time.
      read.failed.push(...read.blocks.slice(read.index).map((b) => b.key));
      result = this.readResult(read);
      failure = undefined;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      this.logger.debug('Solarfocus: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      // Begun before a command left: it may show the state before it.
      this.logger.debug('Solarfocus: read begun before a command, not applied');
    } else {
      this.applyRead(result, startedAt, target);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * A block of a poll left without an answer: noted, skipped, and the poll
   * goes on with the next block on a new connection, TIMINGS.readTimeouts
   * times at most. True when the poll goes on.
   */
  timedOut(read) {
    const block = read.current;
    read.current = undefined;
    read.failed.push(block.key);
    read.index += 1;
    read.timeouts += 1;
    this.logger.warn(`Solarfocus: no answer for the ${block.key} registers`);
    return read.timeouts < TIMINGS.readTimeouts;
  }

  /**
   * The blocks of a poll from `read.index`, one after the other. A block
   * refused leaves its values unknown this time (an optional one refused
   * with "illegal data address" before it was ever answered is not served
   * by this firmware: not read again until a restart); a block whose probe
   * was not answered this time is not read. A closed connection or a wrong
   * answer fails the whole read; a block without an answer is skipped by
   * `run` (`timedOut`).
   */
  async readBlocks(session, read) {
    for (; read.index < read.blocks.length; read.index += 1) {
      const block = read.blocks[read.index];
      if (this.absent.has(block.key) || (block.probe && !read.answeredNow.has(block.probe))) {
        continue;
      }
      read.current = block;
      let values;
      try {
        values = await this.readBlock(session, block, { timeoutMs: TIMINGS.requestTimeout });
      } catch (err) {
        if (err.kind !== ERROR_KINDS.REFUSED) {
          throw err;
        }
        read.current = undefined;
        if (block.optional && err.code === ILLEGAL_DATA_ADDRESS && !this.answered.has(block.key)) {
          this.absent.add(block.key);
          this.logger.info(`Solarfocus: this firmware does not serve the ${block.key} registers`);
        } else {
          read.failed.push(block.key);
          this.logger.warn(
            `Solarfocus: reading the ${block.key} registers failed (${errorReason(err)})`,
          );
        }
        continue;
      }
      read.current = undefined;
      this.answered.add(block.key);
      read.answeredNow.add(block.key);
      Object.assign(read.raw, values);
    }
  }

  /** The values of a poll; every block refused or silent is a failed read. */
  readResult(read) {
    if (read.answeredNow.size === 0) {
      throw new ModbusError(
        read.timeouts > 0 ? ERROR_KINDS.TIMEOUT : ERROR_KINDS.REFUSED,
        'every read refused or unanswered',
        { sent: true },
      );
    }
    return { values: interpret(read.raw), failed: read.failed };
  }

  /** A read: the values of this read only (a value not read is unknown). */
  applyRead({ values, failed }, startedAt, target) {
    const u = this.unit;
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    u.values = values;
    u.readAt = startedAt;
    u.failed = failed;
    for (const role of rolesWithValues(values)) {
      this.seen.add(role);
    }
    if (!sameTarget(target, this.memory.target)) {
      this.memory.target = target;
      this.saveMemory().catch(() => {});
    }
    this.observe(values, startedAt);
  }

  /** A failed read: the delay before the next one. */
  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = err?.kind;
    u.reason = reasonOf(err);
    this.logger.warn(
      `Solarfocus: ${err?.message ?? errorReason(err)}; next try in ${Math.round(wait / 1000)} s`,
    );
    return wait;
  }

  /** The connection status of the configuration screen. */
  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    const notes = (text) => {
      let out = text;
      if (c.badCounts) out = join(out, T.badCounts);
      if (c.badGenerator) out = join(out, T.badGenerator);
      // Every stop not confirmed, whatever its controller.
      const here = [];
      const elsewhere = [];
      for (const g of this.stopGuards.values()) {
        const name = componentName(g.plan.command.component, g.plan.command.n);
        if (sameTarget(g.target, this.target())) here.push(name);
        else elsewhere.push([addressKey(g.target), name]);
      }
      if (here.length > 0) out = join(out, T.stopsPending(here));
      if (elsewhere.length > 0) out = join(out, T.stopsElsewhere(elsewhere));
      return out;
    };
    if (!c.address) {
      const text = c.invalid ? T.invalid(c.invalid) : c.badUnitId ? T.badUnitId : T.noHost;
      return notes(text);
    }
    if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      return notes(
        [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(u.error)
          ? T.unreachable(addressKey(c.address), wait)
          : T.failing(u.reason ?? reasonOf(undefined), wait),
      );
    }
    if (u.online === undefined) {
      return notes(
        u.timer && this.due > this.mono() ? T.waiting(age(this.due - this.mono())) : T.connecting,
      );
    }
    let text = T.connected(T.summary(u.values ?? {}));
    if (u.failed.length > 0) {
      text = join(text, T.missingBlocks(u.failed.join(', ')));
    }
    const forced = [];
    for (let n = 1; n <= c.circuits; n += 1) {
      if ((u.values?.[`circuit.${n}.flowSetpoint`] ?? 0) > 0) forced.push(n);
    }
    if (forced.length > 0) {
      text = join(text, T.flowSetpoints(forced.join(', ')));
    }
    return notes(text);
  }

  async updateStatus() {
    await this.setStatus(this.unit.online === true && Boolean(this.config.address), this.status());
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice() {
    const id = ids(this.gladys).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The roles of the created device (a republished device never loses one). */
  createdRoles() {
    const roles = new Set();
    for (const f of this.createdDevice()?.features ?? []) {
      const role = parseFeatureId(f?.external_id);
      if (role) roles.add(role);
    }
    return roles;
  }

  /** The device, once the controller answered. */
  async publishDevices() {
    if (this.unit.online !== true) {
      return;
    }
    const roles = rolesToBuild({
      counts: layoutOf(this.config),
      seen: this.seen,
      created: this.createdRoles(),
    });
    const devices = [
      buildDevice(this.gladys, {
        language: this.config.language,
        roles,
        dhwCap: this.config.dhwCap,
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features. */
  queueValues(values, created = this.createdFeatures(), at = this.mono()) {
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      ids(this.gladys),
      values,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value, at);
      }
    }
  }

  /** The last values, only when recent (never an old read republished as new). */
  queueStates(created) {
    const u = this.unit;
    if (u.online === true && u.values && this.mono() - u.readAt <= TIMINGS.freshFor) {
      this.queueValues(u.values, created, u.readAt);
    }
  }

  async publishBadge() {
    const device = this.createdDevice();
    const online = this.unit.online;
    if (!device || (online === undefined && this.config.address)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport: online === true ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its recent values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    const u = this.unit;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status();
    if (u.running) {
      await u.running;
      return current();
    }
    if (this.mono() < this.due) {
      const waited = T.waiting(age(this.due - this.mono()));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(current(), T.lastRead(age(this.mono() - this.lastAttemptAt))), waited)
        : waited;
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  /** The value of a command, checked strictly; returns `{ written, expected }`. */
  parseValue(command, value) {
    if (command.table) {
      // Strictly one of the keys of the select: never trimmed, re-cased nor a number.
      const known = Object.entries(command.table).find(([, key]) => key === value);
      if (typeof value !== 'string' || !known) {
        throw this.refusal(ERRORS.badValue);
      }
      return { written: Number(known[0]), expected: value };
    }
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^-?\d{1,3}(\.\d{1,3})?$/.test(value)
          ? Number(value)
          : undefined;
    if (!Number.isFinite(number)) {
      throw this.refusal(ERRORS.badNumber);
    }
    const bounds = command.kind === 'dhw' ? BOUNDS.dhwSetpoint : BOUNDS.roomSetpoint;
    if (Math.abs(number / bounds.step - Math.round(number / bounds.step)) > 1e-9) {
      throw this.refusal(ERRORS.badStep(bounds.step));
    }
    if (command.kind === 'dhw') {
      this.checkDhw(number);
    } else if (number < bounds.min || number > bounds.max) {
      throw this.refusal(ERRORS.outOfRange(bounds.min, bounds.max));
    }
    return { written: number, expected: number };
  }

  /** The hot water bounds, on the configuration of now: 20 °C to the ceiling (65 °C at most). */
  checkDhw(number) {
    const top = Math.min(DHW_CAP.max, BOUNDS.dhwSetpoint.max);
    if (number < BOUNDS.dhwSetpoint.min || number > top) {
      throw this.refusal(ERRORS.outOfRange(BOUNDS.dhwSetpoint.min, top));
    }
    if (number > this.config.dhwCap || number > DHW_CAP.max) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
  }

  /** Whether the circuit or tank of a command is in the configuration. */
  configured(command) {
    const count = command.component === 'circuit' ? this.config.circuits : this.config.dhw;
    return command.n <= count;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const role = parseFeatureId(feature?.external_id);
    const command = role ? commandOf(role) : undefined;
    if (!command) {
      throw this.refusal(ERRORS.readOnly);
    }
    const { written, expected } = this.parseValue(command, value);
    const plan = { role, command, written, expected };
    if (command.protective && expected === command.protective) {
      // A stop: never held back by the option, the configuration of circuits or a read;
      // before the configuration is read (Gladys unreachable), to the last controller read.
      const target = this.target() ?? (this.configRead ? undefined : this.memory.target);
      if (!target) {
        throw this.refusal(ERRORS.noHost);
      }
      return this.protect(plan, received, target);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (!this.configured(command)) {
      throw this.refusal(ERRORS.noComponent);
    }
    if (!this.target()) {
      throw this.refusal(ERRORS.noHost);
    }
    if (this.queue.length >= 16) {
      throw this.refusal(ERRORS.busy);
    }
    return this.enqueue(plan, received);
  }

  /**
   * Queues a command; answers by 3.5 s after its arrival: its outcome, or,
   * when it is still waiting its turn or its answer, what is known then (it
   * goes on in the background).
   */
  async enqueue(plan, received) {
    const job = {
      plan,
      received,
      seq: this.protectSeq,
      generation: this.generation,
      target: this.target(),
      state: { written: false },
    };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.queue.push(job);
    this.runQueue();
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      job.done.then((o) => {
        if (o.error) this.logger.warn(`Solarfocus: ${plan.role} after the ack: ${o.error.message}`);
      });
      if (!job.state.written) {
        throw this.refusal(ERRORS.queued);
      }
      throw this.refusal(ERRORS.sentUnconfirmed(ERRORS.noAnswerYet));
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /** The worker of the commands: one session, the jobs one after the other. */
  runQueue() {
    if (this.worker) {
      return;
    }
    this.reserved += 1;
    this.worker = (async () => {
      try {
        while (this.queue.length > 0) {
          // The stops first, all of them.
          while (this.stopWorker) {
            await this.stopWorker;
          }
          await this.takeLine(['read']);
          if (this.queue.length === 0) break;
          const job = this.queue[0];
          if (!sameTarget(job.target, this.target()) || job.generation !== this.generation) {
            this.queue.shift();
            job.resolve({ error: this.refusal(ERRORS.configChanged) });
            continue;
          }
          try {
            await this.useLine(
              'command',
              job.target,
              TIMINGS.commandConnectMax,
              (session) => this.drain(session, job.target),
              // Checked right before the line is taken: a stop arrived meanwhile goes first.
              { yieldTo: () => this.stops.length > 0 || Boolean(this.stopWorker) },
            );
          } catch (err) {
            if (err.yielded) {
              continue;
            }
            // The connection failed or was taken: the job in front answers it.
            const front = this.queue[0];
            if (front && front === job && !job.started) {
              this.queue.shift();
              job.resolve({ error: this.commandError(err, job) });
            }
          }
        }
      } finally {
        this.reserved -= 1;
        this.worker = undefined;
      }
    })();
  }

  /** Runs the queued jobs for `target` on one session. */
  async drain(session, target) {
    while (this.queue.length > 0) {
      if (this.stops.length > 0) {
        // A stop waits: the session ends, the stop goes, the queue after it.
        return;
      }
      const job = this.queue[0];
      if (!sameTarget(job.target, target)) {
        return;
      }
      this.queue.shift();
      job.started = true;
      // Its turn: the window of a scene's command runs from here (src/constants.js queueWindow).
      job.turnAt = this.mono();
      let outcome;
      try {
        await this.commandSession(session, job);
        outcome = {};
      } catch (err) {
        outcome = { error: this.commandError(err, job) };
        if ((!(err instanceof Refusal) || err.sessionDead) && !err?.beforeSend) {
          // The session failed: the next jobs open a new one.
          job.resolve(outcome);
          return;
        }
      }
      job.resolve(outcome);
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, job) {
    if (err instanceof Refusal || err?.beforeSend) {
      return err;
    }
    const { plan, state } = job;
    const reason = reasonOf(err);
    const what = `${plan.role} ${plan.written}`;
    if (!state.written) {
      this.logger.warn(`Solarfocus: command NOT sent (${what}): ${errorReason(err)}`);
      if (err?.kind === ERROR_KINDS.LATE) {
        return this.refusal(ERRORS.tooSlow);
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          job.seq !== this.protectSeq ? ERRORS.protectMeanwhile : ERRORS.configChanged,
        );
      }
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      this.logger.warn(
        `Solarfocus: command refused by the controller (${what}): ${errorReason(err)}`,
      );
      return this.refusal(ERRORS.refused(reason));
    }
    return this.unconfirmed(plan, state, reason);
  }

  /** A command that may have reached the controller: guard, spaced reads, "sent, without confirmation". */
  unconfirmed(plan, state, reason) {
    this.guards.set(plan.command.read, {
      from: state.from,
      expected: plan.expected,
      moved: false,
      until: this.mono() + TIMINGS.guard,
    });
    this.followUp();
    this.logger.warn(`Solarfocus: command sent, NOT confirmed (${plan.role}): ${reason.en}`);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /** The checks before each write, on the latest configuration. */
  checkCommand(job) {
    const { plan } = job;
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (job.generation !== this.generation || !sameTarget(job.target, this.target())) {
      throw this.refusal(ERRORS.configChanged);
    }
    if (job.seq !== this.protectSeq) {
      throw this.refusal(ERRORS.protectMeanwhile);
    }
    if (!this.configured(plan.command)) {
      throw this.refusal(ERRORS.noComponent);
    }
    if (plan.command.kind === 'dhw') {
      // The ceiling may have been lowered since the command arrived.
      this.checkDhw(plan.written);
    }
  }

  /** What a command reads first and reads back (a circuit mode: its whole operating state, § 6.2). */
  commandBlocks(command) {
    return command.blocks;
  }

  /**
   * The value a command decides on, from a fresh read: a room setpoint of 0
   * ("none from Modbus") counts as 0, never as unknown.
   */
  decisive(command, fresh) {
    if (command.kind === 'room' && fresh.raw[command.read]?.raw === 0) {
      return 0;
    }
    return fresh.values[command.read];
  }

  /**
   * The writes of a command, in order: `[register, value]`. A circuit mode
   * prepares the circuit as the document asks (flow setpoint 0, cooling 0,
   * the heating mode as read) and writes the mode last.
   */
  commandWrites(plan, fresh) {
    const { command } = plan;
    if (command.kind !== 'circuitMode') {
      return [[command.register, plan.written]];
    }
    const h = circuitHolding(command.n);
    const writes = [
      [h, 0],
      [h + 2, 0],
    ];
    const heatingMode = fresh.values[`circuit.${command.n}.heatingMode`];
    if (heatingMode !== undefined) {
      writes.push([h + 8, heatingMode]);
    }
    writes.push([h + 3, plan.written]);
    return writes;
  }

  /** Whether a fresh read shows what the command asked (all of it, for a circuit mode). */
  showsAsked(plan, fresh) {
    const { command } = plan;
    if (this.decisive(command, fresh) !== plan.expected) {
      return false;
    }
    if (command.kind !== 'circuitMode') {
      return true;
    }
    const v = fresh.values;
    const n = command.n;
    return v[`circuit.${n}.flowSetpoint`] === 0 && v[`circuit.${n}.cooling`] === 0;
  }

  /** One write of one register in `session`: its echo, else the session is not trusted. */
  async writeOne(session, address, value, options) {
    const request = writeRequest(address, value);
    const echo = await session.request(request, { timeoutMs: TIMINGS.requestTimeout, ...options });
    if (!isWriteEcho(request, echo)) {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
    }
  }

  async commandSession(session, job) {
    const { plan, state } = job;
    const { command } = plan;
    // A queued command starts within 15 s of its turn and 60 s of its arrival, or never.
    const startBy = Math.min(
      job.received + TIMINGS.queueMax,
      (job.turnAt ?? job.received) + TIMINGS.queueWindow,
    );
    const readMs = Math.min(TIMINGS.commandReadMax, startBy - this.mono());
    if (readMs < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.checkCommand(job);
    const blocks = this.commandBlocks(command);
    // The values just before acting, read now in this session, never the ones in memory.
    let fresh;
    try {
      fresh = await this.readFresh(session, blocks, { timeoutMs: readMs });
    } catch (err) {
      if (err.kind === ERROR_KINDS.ABORTED) {
        throw err;
      }
      const sessionDead = err.kind !== ERROR_KINDS.REFUSED;
      const refusal = this.refusal(ERRORS.unknownState(reasonOf(err)));
      if (sessionDead) {
        refusal.sessionDead = true;
      }
      throw refusal;
    }
    const from = this.decisive(command, fresh);
    if (from === undefined) {
      throw this.refusal(ERRORS.unknownValue);
    }
    if (command.kind === 'circuitMode') {
      const n = command.n;
      if (
        fresh.values[`circuit.${n}.flowSetpoint`] === undefined ||
        fresh.values[`circuit.${n}.cooling`] === undefined
      ) {
        throw this.refusal(ERRORS.unknownValue);
      }
      if (fresh.values[`circuit.${n}.flowSetpoint`] !== 0) {
        // Another Modbus client drives this circuit: never overridden by a mode change.
        throw this.refusal(ERRORS.flowSetpoint);
      }
    }
    this.checkCommand(job);
    this.noteValues(fresh.values);
    state.from = from;
    // A guard (a command or a stop not seen yet) makes it written anyway: the
    // value read may not show the previous one yet, and a stop kept for
    // this register is lifted only by a newer command that left.
    if (
      this.showsAsked(plan, fresh) &&
      !this.guardActive(command.read) &&
      !this.stopGuards.has(guardKey(job.target, command.register))
    ) {
      this.logger.info(`Solarfocus: ${plan.role} already so, nothing sent`);
      return;
    }
    const writes = this.commandWrites(plan, fresh);
    this.logger.info(`Solarfocus: ${plan.role} (${plan.written})`);
    const sendBy = this.mono() + TIMINGS.commandMinSend + TIMINGS.commandMinRead;
    for (const [index, [address, value]] of writes.entries()) {
      try {
        await this.writeOne(session, address, value, {
          // The first write leaves in time or not at all; the others complete the group.
          ...(index === 0 ? { startBy: Math.min(sendBy, startBy + TIMINGS.commandMinSend) } : {}),
          beforeSend: () => {
            // The option, the configuration, the bounds and a stop, right before each write.
            this.checkCommand(job);
            state.written = true;
            this.lastSentAt = this.mono();
            if (address === command.register) {
              // A newer command for this register left: an older stop is never sent again after it.
              this.dropStopGuard(guardKey(job.target, command.register));
            }
          },
        });
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED && NOT_APPLIED_EXCEPTIONS.has(err.code)) {
          state.refused = true;
        }
        throw err;
      }
    }
    // Confirmed only by the values read back equal to the values asked.
    // A circuit: its mode, flow setpoint and cooling (the heating mode was written as read).
    const back = await this.readFresh(session, command.stopBlocks ?? blocks, {
      timeoutMs: TIMINGS.requestTimeout,
    });
    this.noteValues(back.values);
    if (!this.showsAsked(plan, back)) {
      throw Object.assign(
        new ModbusError(ERROR_KINDS.PROTOCOL, 'the value read back is not the one asked', {
          sent: true,
        }),
        { reason: ERRORS.readBackDiffers },
      );
    }
    this.guards.delete(command.read);
    this.logger.info(`Solarfocus: ${plan.role} confirmed by the controller`);
  }

  /** The values a command read or confirmed: in memory and to Gladys in the background. */
  noteValues(values) {
    if (this.unit.online !== true || !this.unit.values) {
      return;
    }
    Object.assign(this.unit.values, values);
    this.queueValues(values);
    this.flush().catch(() => {});
  }

  // --- The stops (protective) ---------------------------------------------------

  /**
   * The writes of a stop, in order, without any read first. A circuit off is
   * § 6.2.3 of the document, the mode first (the rest can only follow it):
   * mode 3, flow setpoint 0, cooling 0; then its heating mode is read and
   * written back as it is (`rewriteHeatingMode`). A tank always off: its
   * mode, 0.
   */
  stopWrites(plan) {
    const { command } = plan;
    if (command.kind !== 'circuitMode') {
      return [[command.register, plan.written]];
    }
    const h = circuitHolding(command.n);
    return [
      [h + 3, plan.written],
      [h, 0],
      [h + 2, 0],
    ];
  }

  /**
   * Writes the group of a stop in `session`. The first write (the mode) is
   * the stop: its failure fails the stop; `echoed()` runs once the controller
   * acknowledged it. A refusal of another register of the group is logged
   * and the next one written; the result counts them (the read back then
   * shows whether the group is complete).
   */
  async writeStop(session, plan, { beforeSend, echoed, timeoutMs } = {}) {
    let refusals = 0;
    for (const [index, [address, value]] of this.stopWrites(plan).entries()) {
      try {
        await this.writeOne(session, address, value, {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(index === 0 ? { beforeSend } : {}),
        });
        if (index === 0) echoed?.();
      } catch (err) {
        if (index === 0 || err.kind !== ERROR_KINDS.REFUSED) {
          throw err;
        }
        refusals += 1;
        this.logger.warn(
          `Solarfocus: ${plan.role}: register ${address} of the stop refused (${errorReason(err)})`,
        );
      }
    }
    return { refusals };
  }

  /**
   * The heating mode of a circuit stopped (32608, § 6.2.3 writes it too):
   * read now, after the mode, and written back as it is; nothing when this
   * firmware has none or it is refused. Without an answer (the session is
   * lost), the next tries of this stop (`holder`) go without it.
   */
  async rewriteHeatingMode(session, plan, holder) {
    const { command } = plan;
    if (command.kind !== 'circuitMode' || holder.skipHeatingMode) return;
    const block = command.blocks.find((b) => b.optional);
    if (this.absent.has(block.key)) return;
    try {
      const fresh = await this.readFresh(session, [block], { timeoutMs: TIMINGS.requestTimeout });
      const value = fresh.values[`circuit.${command.n}.heatingMode`];
      if (value !== undefined) {
        await this.writeOne(session, block.points[0][0], value);
      }
    } catch (err) {
      this.logger.warn(
        `Solarfocus: ${plan.role}: heating mode not written back (${errorReason(err)})`,
      );
      if (err.kind !== ERROR_KINDS.REFUSED) {
        // The session is lost with it: the next tries of this stop go without it.
        holder.skipHeatingMode = true;
        throw err;
      }
    }
  }

  /**
   * What a read shows of a stop: the mode (a tank: the mode it applies, 502);
   * a circuit read "off" whose flow setpoint or cooling is not 0 is PARTIAL;
   * undefined when unknown.
   */
  stopValueOf(plan, values) {
    const { command } = plan;
    const mode = values[command.read];
    if (command.kind !== 'circuitMode' || mode !== command.protective) return mode;
    const flow = values[`circuit.${command.n}.flowSetpoint`];
    const cooling = values[`circuit.${command.n}.cooling`];
    if (flow === undefined || cooling === undefined) return undefined;
    return flow === 0 && cooling === 0 ? mode : PARTIAL;
  }

  /** Reads what confirms a stop, in `session`: `{ value, values }`. */
  async readStop(session, plan, options) {
    const { values } = await this.readFresh(session, plan.command.stopBlocks, options);
    return { value: this.stopValueOf(plan, values), values };
  }

  /**
   * Whether the stops of `target` may be checked and written now: always
   * before the configuration is read (a restart), then only on the
   * controller of the configuration.
   */
  mayWrite(target) {
    return !this.configRead || sameTarget(target, this.target());
  }

  /** The guard of a stop of `register` on the controller of the configuration. */
  guardOf(register, target = this.target()) {
    return target ? this.stopGuards.get(guardKey(target, register)) : undefined;
  }

  /** The guards of the controller of the configuration, put aside before, are checked again. */
  wakeGuards() {
    for (const guard of this.stopGuards.values()) {
      if (guard.dormant && this.mayWrite(guard.target)) {
        guard.dormant = false;
        this.armStopCheck(guard.key, 0);
      }
    }
  }

  /**
   * A stop clicked: queued with the other clicks (never behind a command, a
   * read or a check: it ends them), answered by 3.5 s after the click. A
   * second press of the same stop while one waits joins it.
   */
  async protect(plan, received, target) {
    // Every command that arrived before this stop and has not left gives way.
    this.protectSeq += 1;
    const job = this.queueStop({
      plan,
      register: plan.command.register,
      target,
      received,
    });
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      if (!job.state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(ERRORS.sentUnconfirmed(ERRORS.noAnswerYet));
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /**
   * Queues a click of a stop: before every check, in the order of the clicks.
   * A click of the same register and target still waiting is joined (never
   * a check: a click is always written and read back). The poll, a command
   * or a check on the line is ended at once (synchronously); a check is
   * done again at its next turn.
   */
  queueStop({ plan, register, target, received }) {
    let job = this.stops.find(
      (j) => !j.running && j.register === register && sameTarget(j.target, target),
    );
    if (job) {
      return job;
    }
    job = { plan, register, target, received, state: { written: false, sentAt: undefined } };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    if (this.active && this.active.kind !== 'protect') {
      this.active.abort('line taken');
    }
    this.runStops();
    return job;
  }

  /** The worker of the clicks of stops: before anything else on the line. */
  runStops() {
    if (this.stopWorker) {
      return;
    }
    this.reserved += 1;
    this.stopWorker = (async () => {
      try {
        while (this.stops.length > 0) {
          const job = this.stops[0];
          job.running = true;
          try {
            await this.sendStop(job);
          } catch (err) {
            this.logger.warn(`Solarfocus: stop failed: ${err.message}`);
            job.resolve({ error: this.refusal(ERRORS.notSent(reasonOf(err))) });
          }
          this.stops.shift();
        }
      } finally {
        this.reserved -= 1;
        this.stopWorker = undefined;
        if (this.queue.length > 0) this.runQueue();
      }
    })();
  }

  /**
   * What a value read says of a stop guard: 'done' (the stop shows; a sticky
   * guard, a command sent before it may still land, needs two such reads in
   * a row, both after the time to apply it), 'wait', 'drop' (another value
   * than those of before, read twice in a row: set elsewhere, never
   * overridden) or 'resend'. When the values of before are unknown (a stop
   * clicked before any read), the first value read after the stop is taken
   * as one: an unknown value of before never counts as set elsewhere. A
   * circuit read off without its flow setpoint and cooling at 0 (PARTIAL) is
   * sent again. A stop written is sent again only once the controller had
   * the time to apply it (20 s), three times at most (a resend counts once
   * the controller acknowledged it); a stop that never left is tried again
   * at every check. Never decided by the time alone.
   */
  decideStop(stop, value, readStartedAt) {
    if (value === undefined) {
      return 'wait';
    }
    const applied = stop.sentAt === undefined || readStartedAt >= stop.sentAt + TIMINGS.applyDelay;
    if (value === stop.stopValue) {
      stop.changed = undefined;
      if (!stop.sticky) {
        return 'done';
      }
      stop.confirms = applied ? (stop.confirms ?? 0) + 1 : 0;
      return stop.confirms >= 2 ? 'done' : 'wait';
    }
    stop.confirms = 0;
    if (!applied) {
      return 'wait';
    }
    if (value !== PARTIAL) {
      if (stop.before.length === 0) {
        stop.before.push(value);
      } else if (!stop.before.includes(value)) {
        const count = stop.changed?.value === value ? stop.changed.count + 1 : 1;
        stop.changed = { value, count };
        return count >= 2 ? 'drop' : 'wait';
      }
    }
    stop.changed = undefined;
    if (stop.written && stop.reasserts >= TIMINGS.stopReasserts) {
      return 'wait';
    }
    return 'resend';
  }

  /**
   * One click of a stop: its writes without a fresh read, then the read back
   * that alone confirms it (a circuit: mode 3, flow setpoint 0 and cooling 0
   * read back). Tried again every 250 ms until 3 s after the start of its
   * turn (the writes are idempotent) when the connection is refused or
   * closed, an answer is late or wrong, the controller answers a Modbus
   * exception other than 1-3 (busy, failure: not applied), or a register of
   * the group was refused and the read back shows it. A new click renews the
   * guard of its register: three resends again, the current value as a value
   * of before. The guard is in /data before the first write.
   */
  async sendStop(job) {
    const { plan, target, state } = job;
    // The budget runs from the start of its turn: a stop queued behind another one has it whole.
    const retryUntil = Math.max(job.received, this.mono()) + TIMINGS.commandSendBy;
    const known = sameTarget(target, this.target())
      ? this.unit.values?.[plan.command.read]
      : undefined;
    // A command to this register, sent and not confirmed, may still land after the stop.
    const pending = this.guardActive(plan.command.read)
      ? this.guards.get(plan.command.read)
      : undefined;
    const guard = this.ensureStopGuard(plan, target);
    for (const value of [pending?.expected, known]) {
      if (value !== undefined && value !== plan.expected && !guard.before.includes(value)) {
        guard.before.push(value);
      }
    }
    guard.sticky = guard.sticky || Boolean(pending);
    guard.reasserts = 0;
    guard.confirms = 0;
    guard.changed = undefined;
    guard.dormant = false;
    guard.at = this.now();
    // In /data before the first write: a restart during the 3 s keeps it.
    this.persistStops();
    let back;
    let values;
    const attempt = async (session) => {
      const timeoutMs = Math.max(250, Math.min(TIMINGS.requestTimeout, retryUntil - this.mono()));
      const { refusals } = await this.writeStop(session, plan, {
        timeoutMs,
        beforeSend: () => {
          state.written = true;
          state.sentAt = this.mono();
          this.lastSentAt = state.sentAt;
          const current = this.stopGuards.get(guard.key);
          if (current) {
            current.written = true;
            current.sentAt = state.sentAt;
          }
        },
      });
      state.groupWritten = true;
      await this.rewriteHeatingMode(session, plan, job);
      ({ value: back, values } = await this.readStop(session, plan, {
        timeoutMs: TIMINGS.requestTimeout,
      }));
      if (back === PARTIAL && refusals > 0) {
        // A register of the group was refused and it shows: the group is written again.
        throw Object.assign(
          new ModbusError(ERROR_KINDS.PROTOCOL, 'stop not complete', { sent: true }),
          { reason: ERRORS.stopIncomplete },
        );
      }
    };
    const again = (err) =>
      [ERROR_KINDS.CLOSED, ERROR_KINDS.TIMEOUT, ERROR_KINDS.PROTOCOL].includes(err?.kind) ||
      (err?.kind === ERROR_KINDS.REFUSED && !NOT_APPLIED_EXCEPTIONS.has(err.code));
    let failure;
    this.logger.info(`Solarfocus: stop ${plan.role}`);
    for (;;) {
      try {
        await this.useLine('protect', target, TIMINGS.connectTimeout, attempt, { retryUntil });
        failure = undefined;
        break;
      } catch (err) {
        failure = err;
        if (!again(err) || this.mono() + TIMINGS.connectRetry >= retryUntil) {
          break;
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
      }
    }
    const confirmed = back === plan.expected;
    const current = this.stopGuards.get(guard.key);
    if (current) {
      if (confirmed && !current.sticky) {
        this.dropStopGuard(guard.key);
      } else {
        this.persistStops();
        this.armStopCheck(guard.key);
      }
    }
    if (state.written) {
      this.followUp();
    }
    if (sameTarget(target, this.target()) && values) {
      this.noteValues(values);
    }
    let result;
    if (confirmed) {
      this.logger.info(`Solarfocus: stop ${plan.role} confirmed by the controller`);
      result = {};
    } else if (failure) {
      this.logger.warn(`Solarfocus: stop ${plan.role} failed (${errorReason(failure)})`);
      const reason = reasonOf(failure);
      if (!state.written) {
        result = { error: this.refusal(ERRORS.notSent(reason)) };
      } else if (
        failure.kind === ERROR_KINDS.REFUSED &&
        NOT_APPLIED_EXCEPTIONS.has(failure.code) &&
        !state.groupWritten
      ) {
        // The mode itself refused (a read back refused after it is "without confirmation").
        result = { error: this.refusal(ERRORS.refused(reason)) };
      } else {
        result = { error: this.refusal(ERRORS.sentUnconfirmed(reason)) };
      }
    } else {
      result = {
        error: this.refusal(
          ERRORS.sentUnconfirmed(back === PARTIAL ? ERRORS.stopIncomplete : ERRORS.readBackDiffers),
        ),
      };
    }
    job.resolve(result);
  }

  /** Whether a click or a command waits or runs: a check gives way to them (they are newer). */
  checkMustYield() {
    return (
      this.stops.length > 0 ||
      Boolean(this.stopWorker) ||
      this.queue.length > 0 ||
      Boolean(this.worker)
    );
  }

  /**
   * The periodic check of a stop guard: reads what confirms it, then writes
   * the stop again only when `decideStop` says so. Never on a controller
   * that is not the configured one once the configuration is read: the
   * guard is then put aside (shown in the status, nothing sent there) until
   * that controller is configured again. Never ends another session: it
   * waits for the line, and gives its turn up (tried again a second later)
   * to a click or a command waiting or running, which are newer; a click
   * ends it. Right before its write, it gives way again if a click or a
   * command arrived meanwhile. Not answered to anyone: no ack.
   */
  async runCheck(key) {
    const guard = this.stopGuards.get(key);
    if (!guard) return;
    if (!this.mayWrite(guard.target)) {
      if (!guard.dormant) {
        guard.dormant = true;
        this.logger.warn(
          `Solarfocus: a stop on ${addressKey(guard.target)}, not the configured controller, is no longer checked nor sent`,
        );
        this.updateStatus().catch(() => {});
      }
      return;
    }
    if (this.checkMustYield() || this.checking !== undefined) {
      this.armStopCheck(key, TIMINGS.checkYield);
      return;
    }
    const { plan } = guard;
    const outcome = { decision: undefined, back: undefined, values: undefined, written: false };
    this.checking = key;
    try {
      await this.useLine(
        'check',
        guard.target,
        TIMINGS.connectTimeout,
        async (session) => {
          const startedAt = this.mono();
          const read = await this.readStop(session, plan);
          if (this.stopGuards.get(key) !== guard) return;
          outcome.back = read.value;
          outcome.values = read.values;
          outcome.decision = this.decideStop(guard, read.value, startedAt);
          if (outcome.decision !== 'resend') return;
          let resend = false;
          await this.writeStop(session, plan, {
            beforeSend: () => {
              if (
                this.checkMustYield() ||
                this.stopGuards.get(key) !== guard ||
                !this.mayWrite(guard.target)
              ) {
                throw Object.assign(new Error('a newer click or command'), { yielded: true });
              }
              this.logger.warn(
                `Solarfocus: ${plan.role} still ${read.value} after a stop: stop sent again`,
              );
              outcome.written = true;
              resend = guard.written;
              guard.written = true;
              guard.sentAt = this.mono();
              this.lastSentAt = guard.sentAt;
            },
            // A resend counts once the controller acknowledged it (not when it refused it).
            echoed: () => {
              if (resend) guard.reasserts += 1;
            },
          });
          await this.rewriteHeatingMode(session, plan, guard);
          const back = await this.readStop(session, plan);
          outcome.back = back.value;
          outcome.values = back.values;
        },
        { yieldTo: () => this.checkMustYield() },
      );
    } catch (err) {
      if (!err?.yielded && err?.kind !== ERROR_KINDS.ABORTED) {
        this.logger.warn(`Solarfocus: check of the stop ${plan.role} failed (${errorReason(err)})`);
      }
    } finally {
      this.checking = undefined;
    }
    if (this.stopGuards.get(key) !== guard) return;
    if (outcome.decision === 'done' || (outcome.back === guard.stopValue && !guard.sticky)) {
      this.dropStopGuard(key);
    } else if (outcome.decision === 'drop') {
      this.logger.info(
        `Solarfocus: ${plan.role} changed after the stop (not by Gladys): the stop is not sent again`,
      );
      this.dropStopGuard(key);
    } else {
      this.persistStops();
      if (outcome.written) this.followUp();
      this.armStopCheck(key);
    }
    if (sameTarget(guard.target, this.target()) && outcome.values) {
      this.noteValues(outcome.values);
    }
  }

  /** The guard of a stop of `register` (created when none runs for this target). */
  /** The guard of the stop of `plan` on `target` (created when none runs). */
  ensureStopGuard(plan, target) {
    const register = plan.command.register;
    const key = guardKey(target, register);
    let guard = this.stopGuards.get(key);
    if (!guard) {
      guard = {
        key,
        register,
        plan,
        readKey: plan.command.read,
        stopValue: plan.expected,
        target,
        at: this.now(),
        before: [],
        written: false,
        sentAt: undefined,
        reasserts: 0,
        sticky: false,
        confirms: 0,
        changed: undefined,
        dormant: false,
        timer: undefined,
      };
      this.stopGuards.set(key, guard);
    }
    return guard;
  }

  dropStopGuard(key) {
    const guard = this.stopGuards.get(key);
    if (!guard) return;
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    this.stopGuards.delete(key);
    this.persistStops();
  }

  /**
   * The next check of a stop guard: every 15 s while it may still be sent
   * (never left, or fewer than three resends), whatever the refresh interval
   * and even when the reads fail; every 5 minutes after (a read only, until
   * it is confirmed or lifted).
   */
  armStopCheck(key, delay) {
    const guard = this.stopGuards.get(key);
    if (!guard) return;
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    const sending = !guard.written || guard.reasserts < TIMINGS.stopReasserts;
    const wait = delay ?? (sending ? TIMINGS.stopRetry : 5 * MINUTE);
    guard.timer = this.timers.setTimeout(() => {
      guard.timer = undefined;
      if (this.stopGuards.get(key) !== guard) return;
      this.runCheck(key).catch((err) => this.logger.warn(`Solarfocus: check: ${err.message}`));
    }, wait);
  }

  // --- Guards --------------------------------------------------------------------

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A read through the guards. A command guard lifts when the value moved
   * from the start value to the one asked (never on an unknown value). A
   * stop guard of the controller read: lifted when the read shows the stop
   * (decideStop), or when another value is read twice in a row (set
   * elsewhere: never overridden); the resending is the job of the checks.
   * The guards of other controllers are never decided on this read.
   */
  observe(values, readStartedAt) {
    for (const key of [...this.guards.keys()]) {
      if (!this.guardActive(key) || values[key] === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (values[key] !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && values[key] === guard.expected) {
        this.guards.delete(key);
      }
    }
    for (const [key, stop] of [...this.stopGuards]) {
      if (!sameTarget(stop.target, this.target())) {
        continue;
      }
      const value = this.stopValueOf(stop.plan, values);
      if (value === undefined) {
        continue;
      }
      const decision = this.decideStop(stop, value, readStartedAt);
      if (decision === 'done') {
        this.dropStopGuard(key);
      } else if (decision === 'drop') {
        this.logger.info(
          `Solarfocus: ${stop.readKey} changed after the stop (not by Gladys): the stop is not sent again`,
        );
        this.dropStopGuard(key);
      } else {
        this.persistStops();
        if (decision === 'resend' && !stop.timer) this.armStopCheck(key, 0);
      }
    }
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation && u === this.unit) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Solarfocus refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}

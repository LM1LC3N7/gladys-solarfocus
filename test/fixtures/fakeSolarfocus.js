// -----------------------------------------------------------------------------
// A fake eco manager-touch behind the injected `connect` (no network), on the
// timers of the test clock: Modbus TCP framing (MBAP), function 3 and 4 reads,
// function 16 writes, answers after a delay. Like the real controller as
// aiosolarfocus measured it (docs/protocol.md): a read that starts at an
// address the firmware does not map is refused (exception 2); a read that
// SPANS one is compacted (the values after the hole shift, the length is
// right): a block with a hole reads wrong values here too. The map is the
// document's (DR-0180-DE v14-260212) for the registers the integration
// uses, plus their neighbours. It counts the connections open at once (the
// integration must never open a second one). Values made up, never from a
// real controller.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.70';
export const NOW = Date.UTC(2026, 9, 28, 10, 0, 0);

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The input registers mapped (document v14), for the blocks the integration reads and around them. */
export function inputMap({ modern }) {
  const map = [];
  for (let n = 0; n < 8; n += 1) {
    const b = 1100 + 50 * n;
    map.push(b, b + 1, b + 2, b + 3, b + 5, b + 6, b + 7);
  }
  for (let n = 0; n < 4; n += 1) {
    map.push(500 + 50 * n, 501 + 50 * n, 502 + 50 * n);
    map.push(...range(1900 + 20 * n, 1905 + 20 * n));
  }
  map.push(...range(2300, 2304), 2306, 2307);
  if (modern) {
    map.push(...range(2310, 2324), ...range(2326, 2330));
  } else {
    // The older layout (aiosolarfocus HeatPump _V20): no 2330, counters up to 2325.
    map.push(...range(2308, 2326));
  }
  map.push(2400, 2401, ...range(2402, 2408), 2409, 2410);
  return new Set(map);
}

/** The holding registers mapped (document v14). */
export function holdingMap({ heatingMode }) {
  const map = [];
  for (let n = 0; n < 8; n += 1) {
    const h = 32600 + 50 * n;
    map.push(h, h + 2, h + 3, h + 5, h + 6, h + 7);
    if (heatingMode) map.push(h + 8);
  }
  for (let n = 0; n < 4; n += 1) {
    map.push(32000 + 50 * n, 32001 + 50 * n, 32002 + 50 * n, 32003 + 50 * n);
  }
  map.push(...range(33404, 33412));
  return new Set(map);
}

/** A vampair on 26.020: circuit 1 automatic, hot water tank 1 on its program, one buffer. */
export function defaultValues() {
  return {
    input: {
      2408: 45, // 4.5 °C
      2300: 352,
      2301: 301,
      2302: 1200,
      2303: 3200,
      2304: 0,
      2322: 1850,
      2323: 0,
      2324: 6100,
      2330: 1,
      1100: 330,
      1101: 215,
      1102: 0,
      1103: 1,
      1105: 1,
      1106: 40,
      1107: 2,
      500: 483,
      501: 1,
      502: 2,
      1900: 551,
      1901: 402,
      2400: 0,
    },
    holding: {
      32600: 0,
      32602: 0,
      32603: 2,
      32605: 215,
      32608: 0,
      32000: 480,
      32001: 0,
      32002: 2,
    },
  };
}

class FakeSocket extends EventEmitter {
  constructor(device) {
    super();
    this.device = device;
    this.destroyed = false;
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.device.handle(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.ending) this.device.clientDestroys += 1;
    if (this.closeTimer) this.device.timers.clearTimeout(this.closeTimer);
    // Like a real device, the controller sees the connection gone a moment later.
    setImmediate(() => {
      this.device.open.delete(this);
      this.emit('close');
    });
  }

  /** A FIN: the controller closes its side `closeDelay` ms later (then 'close'). */
  end() {
    if (this.destroyed || this.ended) return;
    this.ended = true;
    this.device.ends += 1;
    this.closeTimer = this.device.timers.setTimeout(() => {
      this.ending = true;
      this.destroy();
    }, this.device.closeDelay);
  }

  setNoDelay() {}
}

export function fakeSolarfocus({
  timers,
  values = defaultValues(),
  unitId = 1,
  modern = true,
  heatingMode = true,
} = {}) {
  const device = {
    unitId,
    mapped: { 4: inputMap({ modern }), 3: holdingMap({ heatingMode }) },
    input: new Map(),
    holding: new Map(),
    open: new Set(),
    maxOpen: 0,
    /** Every request: { fc, address, count, words? }. */
    log: [],
    connections: 0,
    refused: 0,
    down: false,
    connectDelay: 5,
    delay: 10,
    /** Addresses (start of a request) that never answer, or answer an exception. */
    silent: new Set(),
    exceptions: new Map(),
    /** Writes acknowledged but not applied, or applied after `applyDelay` ms. */
    ignoreWrites: false,
    applyDelay: 0,
    /** Writes applied even when their connection closed before the answer. */
    applyClosedWrites: false,
    badEcho: false,
    ends: 0,
    closeDelay: 0,
    clientDestroys: 0,
    connectAt: [],
    now: undefined,
    timers,
    singleClient: false,
    wrongTransaction: false,
    wrongUnit: false,
    /** A raw register (negative numbers as int16). */
    set(table, address, value) {
      device[table].set(address, value < 0 ? value + 0x10000 : value);
    },
    get(table, address) {
      return device[table].get(address);
    },
    /** The registers a read answers: the mapped ones from `address`, `count` of them (compacted). */
    answerWords(fc, address, count) {
      const mapped = device.mapped[fc];
      if (!mapped.has(address)) return undefined;
      const table = fc === 4 ? device.input : device.holding;
      const words = [];
      for (let at = address; words.length < count && at < address + count + 64; at += 1) {
        if (mapped.has(at)) words.push(table.get(at) ?? 0);
      }
      while (words.length < count) words.push(0);
      return words;
    },
    apply(address, word) {
      device.holding.set(address, word);
    },
    handle(socket, frame) {
      const tid = frame.readUInt16BE(0);
      const uid = frame[6];
      const pdu = frame.subarray(7);
      const fc = pdu[0];
      const address = pdu.readUInt16BE(1);
      const count = pdu.readUInt16BE(3);
      const words = [];
      if (fc === 16) {
        for (let i = 0; i < count; i += 1) words.push(pdu.readUInt16BE(6 + i * 2));
      }
      device.log.push(fc === 16 ? { fc, address, count, words } : { fc, address, count });
      if (device.silent.has(address)) return;
      timers.setTimeout(() => {
        if (socket.destroyed) {
          if (fc === 16 && device.applyClosedWrites && !device.ignoreWrites) {
            device.apply(address, words[0]);
          }
          return;
        }
        let answer;
        const exception = device.exceptions.get(address);
        if (exception) {
          answer = Buffer.from([fc | 0x80, exception]);
        } else if (fc === 3 || fc === 4) {
          const read = device.answerWords(fc, address, count);
          if (!read) {
            answer = Buffer.from([fc | 0x80, 2]);
          } else {
            answer = Buffer.alloc(2 + count * 2);
            answer[0] = fc;
            answer[1] = count * 2;
            read.forEach((w, i) => answer.writeUInt16BE(w, 2 + i * 2));
          }
        } else if (fc === 16) {
          if (!device.mapped[3].has(address) || count !== 1) {
            answer = Buffer.from([fc | 0x80, 2]);
          } else {
            if (!device.ignoreWrites) {
              if (device.applyDelay > 0) {
                timers.setTimeout(() => device.apply(address, words[0]), device.applyDelay);
              } else {
                device.apply(address, words[0]);
              }
            }
            answer = Buffer.from(pdu.subarray(0, 5));
            if (device.badEcho) answer[4] ^= 1;
          }
        } else {
          answer = Buffer.from([fc | 0x80, 1]);
        }
        const out = Buffer.alloc(7 + answer.length);
        out.writeUInt16BE(device.wrongTransaction ? (tid + 1) & 0xffff : tid, 0);
        out.writeUInt16BE(0, 2);
        out.writeUInt16BE(answer.length + 1, 4);
        out[6] = device.wrongUnit ? (uid + 1) & 0xff : uid;
        answer.copy(out, 7);
        socket.emit('data', out);
      }, device.delay);
    },
    connect() {
      const socket = new FakeSocket(device);
      device.connections += 1;
      if (device.now) device.connectAt.push(device.now());
      timers.setTimeout(() => {
        if (socket.destroyed) return;
        if (device.down || (device.singleClient && device.open.size > 0)) {
          device.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        device.open.add(socket);
        device.maxOpen = Math.max(device.maxOpen, device.open.size);
        socket.emit('connect');
      }, device.connectDelay);
      return socket;
    },
    writes: () => device.log.filter((r) => r.fc === 16),
    reads: () => device.log.filter((r) => r.fc === 3 || r.fc === 4),
  };
  for (const [address, value] of Object.entries(values.input ?? {})) {
    device.set('input', Number(address), value);
  }
  for (const [address, value] of Object.entries(values.holding ?? {})) {
    device.set('holding', Number(address), value);
  }
  device.connectFn = () => device.connect();
  return device;
}

# gladys-solarfocus

[Gladys Assistant](https://gladysassistant.com) external integration for the **Solarfocus eco
manager-touch** controller (vampair heat pumps, pellet and wood boilers, control centre), through its
**Modbus TCP** interface on the local network (port 502, no cloud, no password): outdoor temperature,
heat pump or boiler, heating circuits 1 to 8, hot water tanks 1 to 4, buffer tanks 1 to 4; mode and
setpoint commands behind an off-by-default option (hot water capped at 65 °C, 65 °C by default), a
circuit off and hot water "always off" never behind that option. **Never tested with a real device.
Not affiliated with Solarfocus.** Modbus TCP has no authentication: keep the controller on a trusted
network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SolarfocusApp)
                                  ├─ src/modbus/client.js    one Modbus TCP session at a time, bounded MBAP frames
                                  ├─ src/modbus/protocol.js  requests, int16/uint16 words, allowed writes (pure)
                                  ├─ src/model.js            special values, plausible ranges, mode texts (pure)
                                  ├─ src/devices.js          the device, its commands and states (pure)
                                  ├─ src/publisher.js        states within 300/min
                                  └─ src/store.js            /data/solarfocus-state.json (last read, heating modes, stops)
```

- **Reads**: one connection per poll (every 60 s, 30 s – 1 h), functions 3 and 4 on runs of
  registers the document maps without a hole (the controller compacts a read across a hole: the
  values after it would shift), then closed. The test button, Discovery, a reconnection, a
  configuration saved for the same controller and a restart never read sooner than the interval
  (time kept in `/data` before the read); only a command (its fresh read, its read back) and the
  reads 5 s, 25 s and 60 s after it do. A refused block leaves its values unknown; every block
  refused is a failure.
- **Device**: `ext:<selector>:solarfocus:controller` (no serial number over Modbus). Commands of the
  configured circuits and tanks always built; sensors once a value was read, or already created.
- **Commands** (`allow_commands`, off by default): circuit mode (32603+, with 32600 = 0, 32602 = 0
  and 32608 as read, § 6.2), room setpoint (32605+, 10-30 °C), hot water setpoint (32000+, 20 °C to
  the ceiling, 65 °C at most) and release mode (32002+). Fresh read, already-so check, function 16
  writes of one register (each checked against a whitelist and its bounds in `writeRequest`), echo
  and read back; one at a time in order on one session (a scene sets them all).
- **Stops** (protective): circuit off (§ 6.2.3, mode first) and hot water always off; never behind
  the option, the bounds, a read or a command; drop every command that arrived before; retried for
  3 s; kept in `/data` with the values of before, checked every 15 s whatever the interval (three
  resends at most), never lifted by the time (only a read showing it, a newer command that left, or
  another value read twice in a row), also at a restart before the configuration is read. One lock
  for the line: a session opens only once the previous one is closed (FIN, then the controller's
  close, 500 ms at most).

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
gi ci          # the whole CI locally (VM tooling)
```

Register map: Solarfocus "Regelung ecomanager-touch: Modbus TCP - Registerdaten" (DR-0180-DE /
v14-260212), cross-checked with [aiosolarfocus](https://github.com/LavermanJJ/aiosolarfocus) 0.3.0 and
[home-assistant-solarfocus](https://github.com/LavermanJJ/home-assistant-solarfocus) 7.0.1 (Apache-2.0,
see `THIRD_PARTY_NOTICES.md`).

## License

Apache-2.0, see [LICENSE](LICENSE).

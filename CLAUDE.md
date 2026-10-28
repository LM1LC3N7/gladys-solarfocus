# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16), its only
runtime dependency (Modbus TCP goes through `node:net`). It reads a Solarfocus
eco manager-touch controller over Modbus TCP (port 502, no cloud, no
authentication) and shows it as one Gladys device; commands behind an
off-by-default option, stops (circuit off, hot water always off) never behind
it. Never tested with a real device, not affiliated with Solarfocus.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
gi ci                                     # the whole CI locally (VM tooling)
```

## Architecture

```
index.js                  SDK bootstrap; app.boot() checks the stops kept in /data first
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                SolarfocusApp: the line (one session), polling, backoff, device,
                          states, badge, status, test button, command queue, stops, guards
src/modbus/client.js      Modbus TCP session: MBAP frames, error kinds, beforeSend/startBy
src/modbus/protocol.js    requests, int16/uint16 words, the writes allowed and their bounds (pure)
src/model.js              raw values -> values: special values, ranges, mode texts (pure)
src/devices.js            the Gladys device, its commands and states (pure)
src/publisher.js          states within 300/min
src/store.js              /data/solarfocus-state.json: last read, heating modes, stops not confirmed
src/config.js             config_schema normalized
src/constants.js          register map, blocks, feature roles, limits, timings
src/i18n.js               runtime texts (en/fr)
test/fixtures/fakeSolarfocus.js  the fake controller (compacts reads across a hole, like the real one)
test/kit/                 virtual and real clocks, fake TCP server (from gladys-testkit)
```

## Rules

- **External ids are forever**: device `solarfocus:controller` (no serial over
  Modbus: frozen rule), feature roles in `FEATURES` and the per-component
  suffixes of `src/constants.js`, manifest keys (`host`, `unit_id`,
  `heat_generator`, `heating_circuits`, `dhw_tanks`, `buffers`,
  `allow_commands`, `dhw_max_temperature`, `poll_interval`, `language`, the
  action `test_connection`).
- **Registers from Solarfocus's document only** (DR-0180-DE v14-260212),
  cross-checked with aiosolarfocus; a read covers a run the document maps
  without a hole, on every firmware it covers, or is optional/probed
  (`test/protocol.test.js`; the fake compacts like the controller).
- **One Modbus connection at a time, one request at a time**: everything goes
  through `useLine`; commands take the line from a poll, stops from anything.
- **Commands**: never a switch or a writable binary; refused unless
  `allow_commands` (checked on arrival and in `beforeSend` of every write);
  bounded on arrival and in `beforeSend`; hot water never above 65 °C (also in
  `writeRequest`, which refuses any register or value not allowed: never a
  flow setpoint other than 0, never cooling); decided on a fresh read;
  confirmed only by the echo and a read back equal to the value asked; never
  retried.
- **Stops** (circuit `off`, hot water `always-off`): never behind the option,
  bounds, a read, a command, a backoff, /data or a configuration not read;
  they drop the commands that arrived before them; their guard is never
  lifted by the time.
- Never read sooner than the interval (button, scan, reconnection, restart,
  configuration saved for the same controller); only the follow-up reads
  after a command (5 s, 25 s, 60 s).
- **Answers are hostile**: MBAP frames bounded and checked; special values
  and implausible values unknown; never log the bytes received.
- Monotonic clock for every in-memory time; the wall clock for /data only.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network (the real-clock test uses a local server).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.

# TODO — Solarfocus eco manager-touch v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No push, release, topic or forum post from a module session (lot 18).

## Status

- [x] **Milestone 1 — core** (2026-10-28, lot 18): the eco manager-touch by IP
      address and unit id, heat generator and counts in the configuration,
      documented blocks read every interval over one connection (never sooner,
      even after a restart or a configuration saved for the same controller),
      one device, commands behind `allow_commands` (off), § 6.2 circuit writes,
      stops never held back, kept in /data until confirmed or lifted (never by
      the time), test button, docs en/fr, cover. Tested against a fake
      controller only (virtual clock, compaction of reads across a hole, and a
      real-clock test x20 on a local TCP server).
- [x] **Review r1** (xhigh, REFUSÉ, 2026-10-28): fixed in "Fix r1 review": stops
      retried within their 3 s on exceptions 4-6 and counted as resends only
      when acknowledged (I1); a circuit stop confirmed by mode 3, flow setpoint
      0 and cooling 0, else written again (I2); guards of a controller no longer
      configured put aside, shown, never written (I3); a block without an
      answer skipped on a new connection (I4); a scene's commands get 15 s from
      their turn, 60 s from the click, and a circuit mode is 9 requests (I5);
      hot water mode read from 502 (Ist) (I6); 32608 read after the mode and
      written back as is, no more memory of it (m1); tests for the mutants
      (m2); reasons translated (m3); readable names in the status (m4); the
      guard in /data before the first write (m5). Tests named `r1-…`; the
      reviewer's scenarios S1-S13 pass.
- [x] **Review r2** (REFUSÉ, 2026-10-28): fixed in "Fix r2 review": a guard put
      aside is kept so in /data and neither read nor written at a restart (I7);
      after an acknowledged group a click only reads back (m6); tests for
      `wakeGuards` (now `sortGuards`), the 60 s cap and the stale read after a
      check (m7); duplicate JSDoc removed (m8).
- [ ] **Review r3**.
- [ ] **Milestone 2 — real controller**: run against a real eco manager-touch
      (see "To check").
- [ ] **Milestone 3 — more**: energy counters of the vampair (2310-2328, int32
      Wh, as lifetime counters behind the p1-monitor guard), states of the
      circuits (1107, two enumerations: from 0 and therminator from 200),
      tanks (501), buffers (1904) and biomass boiler (2401), solar circuits
      (2100+), fresh water modules (700+), circulation (900+), photovoltaic
      (2500+), one-time hot water charge (32001, a boost: its own option),
      external outdoor / room temperature from Gladys sensors (33406, 32606,
      written every 30 min), SG Ready (33405).

## To check on a real controller

- That every block is answered as the document maps it on 26.020 and on an
  older firmware (2330 refused before 25.030, 32608 before 22.090), and that
  the outdoor temperature 2408 is there on a vampair (aiosolarfocus reads it
  there; the document lists it under the boiler).
- What a circuit, tank or buffer not installed reads (0 assumed, from
  aiosolarfocus) and whether a real 0.0 °C could be lost (a tank never reads
  it in a heated house).
- That the read back of 32603, 32605, 32000 and 32002 shows the new value at
  once (else every command answers "sent, without confirmation" and the
  follow-up reads show it).
- That writing 32600 = 0 and 32602 = 0 with the mode leaves a circuit on its
  heating curve, as § 6.2 describes, and what 32608 reads before anyone wrote
  it.
- Whether the controller accepts two Modbus clients at once (Home Assistant
  and Gladys).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-solarfocus:0.1.0`).
  The manifest test checks the semver shape and that the four agree, never a
  pinned value.
- **SDK 0.16.0** (`dist-tags.latest` on npm on 2026-10-28, the template's).
- **Register map**: Solarfocus's own document "Regelung ecomanager-touch:
  Modbus TCP - Registerdaten" (DR-0180-DE / v14-260212, public PDF on
  solarfocus.com, read with `pdftotext`, kept in `~/code/ref/lot18/solarfocus-pdf`,
  not redistributed), cross-checked with aiosolarfocus 0.3.0 (its
  `registers.csv` is a transcription of the same PDF, its `docs/protocol.md`
  the behaviour measured on a 26.020 vampair) and home-assistant-solarfocus
  7.0.1 (`docs/modbus-registers.md`). Heating circuit 7's flow setpoint is at
  32900 (the PDF misprints 32750, aiosolarfocus errata).
- **References**: aiosolarfocus 0.3.0 (7b8ec1a) and home-assistant-solarfocus
  7.0.1 (2fee576), both Apache-2.0 (LICENSE read, no copyright line;
  aiosolarfocus `NOTICE` reproduced), cloned read only in
  `~/code/ref/lot18/`. Notices in `THIRD_PARTY_NOTICES.md`, copied in the
  image.
- **Neighbour modules**: gladys-eta and gladys-oekofen (heating boilers,
  listed by the lot), and gladys-idm (lot 16, Modbus TCP heat pump approved in
  r3): its line, session client, stop machinery, store and publisher were
  reused and adapted.
- **Reads without a hole** (aiosolarfocus `docs/protocol.md`: the controller
  compacts a read across an unmapped address, the values after it shift with
  no error): every block is a run the document maps on every firmware it
  covers (`test/protocol.test.js`, checked against the document's map; the
  fake compacts like the controller). Registers whose address moved with
  25.030 (heat pump power 2322-2324) are read only when the probe 2330 was
  answered in the same read; the heating mode 32608 (22.090) is optional.
  Circuit pump, mixer and state (1105-1107 since 25.030, 1104-1106 before)
  are not read in v1.
- **Generator and counts in the configuration**: the map follows the
  firmware, not the installation (every component answers, 0 when absent),
  so the user says what is there (`heat_generator`, `heating_circuits`,
  `dhw_tanks`, `buffers`) instead of a detection by values.
- **Special values**: 130.0, 270.0, 350.0 °C (open channel) and an exact
  0.0 °C (absent component) unknown, except outdoors (0.0 °C real; -0.1 °C,
  raw 0xFFFF, real too); room setpoint 0 = "none from Modbus" (unknown, but
  a command may set one); modes and states outside the document's lists
  unknown.
- **Commands**: circuit mode (continuous, setback, automatic; off = stop),
  room setpoint 10-30 °C by 0.5 (document 5-45), hot water release mode
  (always on, programs; always off = stop) and setpoint 20 °C to
  min(ceiling, 65 °C) by 0.5 (document 20-80). `text/select`,
  `water-heater/target-temperature`, `thermostat/target-temperature`: never a
  switch. No EEPROM quota (the document says nothing of one).
- **§ 6.2, a circuit's registers written together**: a mode is written as
  32600 = 0, 32602 = 0, 32608 = as read (when the firmware has it), then
  32603 = the mode (the mode last: a group cut short changes nothing), read
  back as mode, flow setpoint 0 and cooling 0; a stop as 32603 = 3 first,
  then 32600 = 0, 32602 = 0, then 32608 read at that moment and written back
  as it is (nothing when refused; without an answer the try ends and a
  click then only reads back), confirmed only by mode 3, flow setpoint 0 and cooling 0 read
  back (else PARTIAL: written again). The integration never writes a flow
  setpoint (the document: no timeout, and in cooling the dew point
  monitoring of the controller is off) nor cooling; a mode change is refused
  while another Modbus client's flow setpoint is active (never overridden;
  the stop writes 0 as the document does). `writeRequest` refuses any other
  register or value (whitelist with bounds, hot water ≤ 65 °C).
- **Hot water mode** (review r1): written to 32002 (Soll), shown, decided and
  confirmed on input 502 (Ist, what the controller applies), as
  home-assistant-solarfocus does. The circuit mode has no Ist register: to
  check on a real controller that 32603 follows a change at the display.
- **Stops** (the lot 17 rules): a click is its own job, always written then
  read back, queued before everything, ending any read, command or check on
  the line; commands that arrived before it and have not left are dropped.
  Not confirmed: guard in /data (target, register, click time, values of
  before, resends, written, sticky). Checks every 15 s while it may still be
  sent (never left, or fewer than three resends), every 5 minutes after (a
  read only). `decideStop`: done when the stop shows (sticky — a command sent
  before the stop may still land — needs two such reads in a row after the
  time to apply it); lifted by another value read twice in a row (the first
  value read is taken as a value of before when they are unknown: an unknown
  value never counts as "changed elsewhere"); sent again while a value of
  before shows (20 s after the last write). Never lifted by the time; a newer
  command to the same register lifts it as it leaves (`beforeSend`). At a
  restart, `boot()` checks it at once, before the configuration is read; a
  click dated in the future (clock set back) is invalid. A stop goes even
  when /data cannot be saved.
- **Configurations applied one at a time** (`applyConfig`, a promise chain):
  the last one wins and each one is applied in turn; a new controller is read
  at once, the same one never sooner than the interval.
- **Mutants left alive (equivalent, layered checks)**: the open-channel test
  of `temperature()` (130/270/350 °C are also above the plausible 120 °C), the
  "never sooner" clamp of `schedule` (every caller already waits the
  interval, `firstWait` or the due time). `startedAt <= lastSentAt` is no
  longer equivalent since a poll reopens a connection after a timeout (a
  check may write in between): tested (review r2). Every other mutant of
  the guards is killed by a test (scratchpad scripts of the lot 18 session:
  35 after r1, 8 more after r2).
- **Identity**: no serial or version register over Modbus: the device id is
  the integration's; another device at the same address is not detected
  (documented). `save()` in /data does not gate the commands: no command guard
  is persisted (only stops, which are never refused).
- **Blocks without an answer** (review r1): the session is closed (a late
  answer is never taken for the next request), the block noted in the
  status, and the poll goes on with the next block over a new connection,
  twice per poll at most; what was read is kept.
- **Guards of another controller** (review r1): keyed by controller and
  register; once a configuration names another controller, a guard of the
  former one is put aside (no connection, no write, shown in the status) and
  resumes if it is configured again. Being put aside is kept in /data
  (review r2): a restart, before the configuration is read, neither reads
  nor writes such a guard; only the active ones are checked. A click whose
  group was acknowledged only reads back on its next tries.
- **Scenes** (review r1): a command starts within 15 s of the start of its
  turn and 60 s of its arrival.
- No `keywords` or `countries` in the manifest (AT, DE would fit; left out
  per the lot rules). Category: `climate`.

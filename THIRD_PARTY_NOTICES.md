# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the two projects below, both under
the Apache License, Version 2.0, whose full text is the `LICENSE` file of this
repository (the same license, word for word). The ported parts were
rewritten, not copied; the changes are described below.

## aiosolarfocus

<https://github.com/LavermanJJ/aiosolarfocus> (Python library for the
Solarfocus eco manager-touch, version 0.3.0 of 2026-09-18, commit 7b8ec1a),
by Jeroen Laverman. Apache License, Version 2.0. Its `NOTICE` file reads:

```
aiosolarfocus
Copyright 2026 Jeroen Laverman

Portions of this work are derived from pysolarfocus
(https://github.com/lavermanjj/pysolarfocus), Copyright Jeroen Laverman,
licensed under the Apache License, Version 2.0. In particular the Modbus
register map, the component base addressing, and the recorded behaviour of the
Solarfocus eco manager-touch controller originate there.

This product is not affiliated with, endorsed by, or supported by
Solarfocus GmbH. "Solarfocus", "eco manager-touch", "vampair", "therminator",
"ecotop", "octoplus" and "Pellet Elegance" are trademarks of their respective
owners.
```

Ported in `src/constants.js`, `src/modbus/protocol.js` and `src/model.js`:
the base addresses and strides of the components (heating circuits 1100 /
32600 by 50, hot water tanks 500 / 32000 by 50, buffers 1900 by 20), the
correction of heating circuit 7's flow setpoint address (32900, misprinted
32750 in the document), the recorded behaviour of the controller
(`docs/protocol.md`: a read spanning an unmapped address is compacted, one
starting there is refused, the map follows the firmware and not the
installation), the markers of an open sensor channel (130.0, 270.0 and
350.0 °C), the layout probe of the heat pump block (register 2330) and the
registers of a heating circuit written together (§ 6.2 of the document).

## home-assistant-solarfocus

<https://github.com/LavermanJJ/home-assistant-solarfocus> (Home Assistant
custom integration "Solarfocus", version 7.0.1, commit 2fee576), by Jeroen
Laverman. Apache License, Version 2.0 (no `NOTICE` file).

Ported: the choice of the values shown and of the commands offered (heating
circuit mode, room setpoint, hot water setpoint and release mode), the
transcription of the register document (`docs/modbus-registers.md`) used to
cross-check the addresses and the state lists, and the setup instructions
(activating Modbus TCP on the display).

## Changed

Every address, type, scale and range was checked against Solarfocus's own
document "Regelung ecomanager-touch: Modbus TCP - Registerdaten"
(DR-0180-DE / v14-260212; facts only, the document is not redistributed).
The integration reads fewer registers than the references (no energy
counters, no solar or fresh water module yet), only in runs the document
maps without a hole; it never writes a flow setpoint, never switches a
circuit to cooling, writes a heating circuit's mode with the other
registers the document asks for (§ 6.2), keeps the room setpoint within
10-30 °C and the hot water setpoint at 65 °C at most, sends the stops (a
circuit off, a tank always off) whatever the option, and treats a
temperature of exactly 0.0 °C (a component not installed) as unknown except
outdoors.

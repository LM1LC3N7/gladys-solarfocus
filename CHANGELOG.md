# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- Solarfocus eco manager-touch over local Modbus TCP: outdoor temperature; vampair heat pump flow and
  return temperatures, utility lock, state and electrical power (software 25.030 or newer); pellet or
  wood boiler temperature; heating circuits 1 to 8 (mode, room setpoint, flow and room temperatures);
  hot water tanks 1 to 4 (release mode applied, setpoint, temperature); buffer tanks 1 to 4 (top and
  bottom). A block of registers without an answer is skipped, the others are read.
- Commands behind "Allow the commands" (off by default): circuit mode (written with the registers the
  document asks for, never a flow setpoint nor cooling), room setpoint (10-30 °C), hot water release
  mode and setpoint (20 °C to the configured ceiling, 65 °C by default, 65 °C at most), confirmed by a
  read back.
- Turning a circuit off and hot water "always off" never depend on that option; retried for 3 s when
  the controller is busy or a register of the group is refused; confirmed only when the whole stop
  shows; a stop not confirmed is sent again (three acknowledged resends at most) and kept in /data
  until it shows or is lifted, also after a restart, never sent to a controller no longer
  configured.
- "Test the connection" button, docs in English and French, cover image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-solarfocus/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-solarfocus/releases/tag/v0.1.1

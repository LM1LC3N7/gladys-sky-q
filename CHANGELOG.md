# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-27

### Changed

- Integration SDK 0.16 (no change for the devices).

## [0.1.1] - 2026-10-26

### Added

- Sky Q boxes on the local network, added by IP address or found by an SSDP
  search, identified by their serial number.
- Read: power state, reachability, channel number and name, playback state,
  title of the recording played, share of the recordings disk in use.
- Commands: wake-up and standby buttons (sent only on a state read just
  before), channel (digits typed), play, pause, stop, record, rewind, fast
  forward, channel up/down, arrows, select, back, Sky, TV guide, info, and a
  dropdown of every remote key.
- "Find the boxes" and "Check the boxes" buttons.
- The User-Agent `SKYPLUS_skyplus`, agreed by the maintainer, sent only to a
  box's own description files after an explicit HTTP refusal of the
  integration's own one.
- A wake-up or standby blocks the next one until the state is seen changed
  (or 30 s), kept in /data across a restart; the power key is not in the remote key dropdown.

[Unreleased]: https://github.com/LM1LC3N7/gladys-sky-q/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-sky-q/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-sky-q/releases/tag/v0.1.1

# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
  box's own description files after they refused the integration's own one.

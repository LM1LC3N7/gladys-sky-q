# TODO — Sky Q v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 22 and 24,
  Docker build, store validator), `npm audit --omit=dev`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-26): boxes by IP address or
      SSDP search, identity by serial number; power, reachability, channel,
      channel name, playback, recording played, disk; wake-up and standby
      buttons, channel digits, 17 buttons and a remote key dropdown; "Find
      the boxes" and "Check the boxes"; docs en/fr. Tested against fake boxes
      (in memory and on the loopback interface) only, never against a real box.
- [ ] **Milestone 2 — real boxes** (testers with a Sky Q): record real
      answers as fixtures, fix what differs. To check first:
  - whether a box answers its description files to the own User-Agent at
    all (and how it refuses: 403, 404, 500, silence), so that the Sky one is
    sent only when needed; whether the description index is stable;
  - the remote handshake on port 49160 (message sizes, a box sending the
    init in several pieces) and whether "home" + "dismiss" wakes every box
    from standby;
  - the REST answers: `serialNumber` present on every model (Mini, Glass),
    `activeStandby` in deep standby (does the REST port still answer?),
    `userQuotaMax`/`userQuotaUsed` units, `pvr/details` of a recording;
  - the channel numbering of Italy and Germany (4 digits?), and whether a
    channel typed needs a "select" after its digits on some firmware;
  - the time a key takes on a real box: the 3.5 s budget and the 300 ms gap
    between digits (the library waits 500 ms).
- [ ] **Milestone 3 — more**: the current application (WebSocket
      `ws://<box>:9006/as/apps/status`), recordings list and management
      (keep, lock, delete behind an option, book), the SSDP `keywords` and
      `countries` of the store once the minimum Gladys version allows them.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- **User-Agent `SKYPLUS_skyplus` (agreement of Louis, 2026-10-25)**: the
  boxes expect it on their UPnP description files (pyskyqremote
  `SOAP_USER_AGENT`). Allowed for this module only, towards the local box
  only, and only when the box really requires it: each description file is
  first asked with the own User-Agent `gladys-sky-q`; `SKYPLUS_skyplus` is
  sent for a file only after an explicit HTTP refusal of that file (an
  answer other than 200 and 404) with the own one, while no file answered the
  own one (review r1: no second pass on plain 404s, no Sky User-Agent on
  silence). One pass at most; a failed search, or a SOAP error, waits 10
  minutes before the next one. Only to the box's own address, on
  its UPnP port 49153, for `/description<N>.xml`: REST, SOAP and remote keys
  never carry it. Once one User-Agent got a file, the other is not tried for
  that box until the client is replaced (restart, new address). An info line
  in the logs says when a box needed it. No other imitation (no signature, no
  TLS fingerprint), and the online EPG (`atlantis.epgsky.com`) and the image
  service of Sky are left out.
- Reuse: pyskyqremote 0.3.26 (MIT, RogerSelwyn) is Python: its REST paths,
  description search (files 0 to 49), SOAP envelope, transport and media
  reading, remote handshake and key codes are ported to JavaScript; the
  wake-up "home" + "dismiss" and the refusal of keys for `IPSETTOPBOX` / `TV`
  come from the Home Assistant integration (MIT). Notices in
  `THIRD_PARTY_NOTICES.md`, copied into the image. No runtime dependency
  besides the SDK.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1 (the template's 1.0.0 was
  someone else's). The first patch release gives 0.1.1.
- SDK `^0.15.0`: the latest published on npm (0.16.0 is tagged on GitHub,
  not published).
- Manifest: `gladys_version` `>=5.1.0`, category `multimedia`, no `keywords`
  nor `countries` (they need a newer minimum version: milestone 3).
- External ids: `gladys.externalIds('box', <serialNumber>)`, never the
  address. A serial is 4 to 40 letters, digits or dashes; a box answering
  without one is not added (status note). Feature keys are frozen: `power`,
  `online`, `wake`, `standby`, `channel`, `channel_name`, `recording`,
  `disk`, `playback`, `key`, and the buttons of `BUTTONS`
  (`src/constants.js`).
- Identity: read at the box's address before every read round and every
  command. Unreadable (no answer, no serial) is not another box: nothing
  concluded, nothing published, no key. Another serial (positive proof):
  the address is taken from the first box (no command until found again),
  given to the other one, and the status says so.
- Power: `online` false when nothing answers the REST port (connection
  refused, no route, never connected); `on` from `activeStandby` (a boolean
  only); a connection accepted then silent, an HTTP error or an unreadable
  answer is unknown: nothing published, no key decided on it.
- No switch: power is read only (`unknown`/`binary`), wake-up and standby
  are push buttons (lesson of gladys-lg-horizon); nothing an "everything
  off" can command. No volume (none on the network), no unit.
- Standby sends the power key (a toggle) only on a box read on within the
  command; wake-up sends "home" + "dismiss" only on a box read in standby
  (not a toggle). A state unknown sends nothing. Never sent again by
  itself: a follow-up read at 5 s and 20 s, and a log line when the state did
  not change. A wake-up or standby sent blocks both until a read shows the
  state changed, or 30 s (review r1: two close standby on a box slow to
  apply sent two toggles). The power key is not in the "Remote key" dropdown
  (review r1). UPnP/SOAP answers with a DOCTYPE, ENTITY, comment, CDATA,
  stylesheet or more than 200 references are refused.
- Commands: serialized per box, never across boxes; 3.5 s from the request
  of Gladys (the queue included), the identity and state read within 1.5 s
  of it; a command still queued at its deadline is dropped, never sent late.
  A sequence (channel digits, wake-up) is not started when its keys cannot
  fit (250 ms per key + 300 ms gaps). Errors say "nothing sent" or "N of M
  key(s) sent, without confirmation" (the remote protocol has no ack).
- Channel: a `television`/`channel` number (1 to 9999), read from
  `GetMediaInfo` (`xsi://<hex sid>`) and the channel list of the box;
  setting it types its digits (no "select", as the Home Assistant
  integration); a number not in a known channel list is refused.
- Playback: `music`/`playback_state` read only (1 playing, 0 paused, 2 idle),
  as gladys-lg-horizon. Recording title, channel name, disk: `text` states,
  `-` when nothing.
- Pace: one timer, `dueAt(mono)` on the monotonic clock, the time of the
  last round written to `/data` before its requests (a restart never reads
  sooner; a date in the future is brought to now). "Check the boxes", a
  reconnection, a device created or a configuration saved never read sooner
  than the interval. Follow-up reads after commands are grouped (2 s).
- The SkyPlay control URL is searched once per client (up to 50 files,
  within the round budget); not found, again after 10 minutes; an HTTP error
  of a SOAP call searches it again at the next round. The control path must
  be a plain absolute path (no scheme, no `//`, no `..`), used on the box's
  own address only.
- Answers: 64 KB, 1 MB for the channel list and recording details; a
  `Content-Length` above the cap is refused before reading. JSON objects
  only; XML read with a linear `tagText`.
- `/data/sky-q.json`: known boxes and the last round time; an existing file
  that cannot be read is never overwritten (status note), invalid JSON moved
  to `.bad`. A device created whose box is missing from `/data` is known
  again from its external id (its IP param is only a hint, used once the box
  answers there with its serial).
- `getConfig()` failing: status note, asked again every 30 s; the boxes of
  `/data` take commands meanwhile. A reconnection clears the deduplication of
  `publishChangedStates` and republishes the status and the Discovery list.
- Invalid addresses are counted in the status, never shown back.

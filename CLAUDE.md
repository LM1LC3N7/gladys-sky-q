# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Sky Q set-top boxes (local
REST 9006, UPnP/SOAP 49153, remote control 49160): a Node.js service (Node
22+, ESM, no build step) that runs in its own sandboxed Docker container and
talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
See `TODO.md` for the status and the decisions.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "standby" # tests whose name matches
npm run cover                             # regenerate cover.png (800×534)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js                          SDK wiring only: src/handlers.js registered before connect()
src/handlers.js                   the SDK handlers -> SkyApp (shared with the tests)
src/app.js                        SkyApp: known boxes, SSDP search, read rounds, commands, status
src/sky/client.js                 one box: REST, description search (User-Agent rules), SOAP, keys
src/sky/remote.js                 one remote key over TCP (RFB-like handshake)
src/sky/parse.js                  REST JSON, UPnP description, SOAP answers (pure)
src/sky/http.js                   node:http exchange, SkyError kinds
src/model.js                      boxes -> Gladys devices and states (pure)
src/store.js                      /data/sky-q.json (known boxes, last round)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js, src/i18n.js     frozen keys, ports, key codes, timings; texts in English and French
scripts/cover.mjs                 cover.png generator (plain Node)
test/                             node --test: fake Gladys of the SDK, fake boxes, loopback servers
```

## Rules

- **External ids are forever**: `gladys.externalIds('box', <serial>)`. Never
  rename a feature key, a manifest key or an action key.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (0.1.0 was set by hand once).
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs kept in sync
  with the code.
- **The User-Agent `SKYPLUS_skyplus`** is allowed for this module only, to
  the box's own description files, after a refusal of the own User-Agent
  (`src/sky/client.js`). Never on another request, never towards another
  host; no other imitation. No online Sky service (EPG, images).
- **Toggles**: the power key is sent only on a state read just before, never
  sent again by itself; no switch feature.
- **Clocks**: decisions on the injected monotonic clock, read once per
  decision; the wall clock only for `/data`.
- Tests never touch the network beyond the loopback interface.

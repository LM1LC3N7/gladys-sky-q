# gladys-sky-q

[Gladys Assistant](https://gladysassistant.com) external integration for
**Sky Q** set-top boxes, on the local network: power state, wake-up and
standby, channel, play, pause, remote keys, the channel or recording played
and the recordings disk, through the local ports of the box (REST 9006,
UPnP/SOAP 49153, remote control 49160), without any cloud and without the
online programme guide. Unofficial, not affiliated with Sky.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against simulated boxes only,
> never against a real Sky Q box.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SkyApp)
                                   ├─ src/sky/client.js   one box: REST, UPnP description search, SOAP, keys
                                   ├─ src/sky/remote.js   one remote key over TCP 49160 (RFB-like handshake)
                                   ├─ src/sky/parse.js    REST JSON, description, SOAP answers (pure)
                                   ├─ src/sky/http.js     node:http, no keep-alive, bounded time and size
                                   ├─ src/model.js        boxes -> Gladys devices and states (pure)
                                   └─ src/store.js        /data/sky-q.json: known boxes, last read
```

- **Boxes** are added by IP address (configuration), or found with
  `gladys.scanNetwork('ssdp')` (search target
  `urn:schemas-nds-com:device:SkyControl:2`). Each box is identified by the
  `serialNumber` of `GET /as/system/deviceinformation` (external id
  `box:<serial>`), read again before every read and every command. The SSDP
  `LOCATION` header is not followed.
- **Reads** (own timer, 5 to 300 s; a round never sooner than the interval,
  the time of the last round kept in `/data`; follow-up reads 5 s and 20 s
  after a command): identity, `GET /as/system/information`
  (`activeStandby`), and when on, `GetTransportInfo` and `GetMediaInfo` on the
  SkyPlay SOAP service, the channel list (`/as/services/<bouquet>/<sub>`),
  the title of a recording played (`/as/pvr/details/<id>`), the disk
  (`/as/pvr/storage`, every 10 minutes).
- **Commands**: serialized per box, 3.5 s each from the request of Gladys.
  Wake-up sends "home" + "dismiss" on a box read in standby; standby sends the
  power toggle on a box read on; a channel is typed digit by digit.
- **User-Agent `SKYPLUS_skyplus`**: agreed by the maintainer for this module
  only, sent to the box's own UPnP port for its description files, and only
  after the same file was refused with the integration's own User-Agent (or
  when no file answered it). Details and rules: [docs/en.md](docs/en.md).
  The online programme guide (`atlantis.epgsky.com`) is not used.

## Development

```bash
npm install
npm test           # node --test, fake Gladys of the SDK, fake boxes, loopback servers
npm run lint
npm run format:check
npm run cover      # regenerate cover.png (800×534)
```

Logic ported from [pyskyqremote](https://github.com/RogerSelwyn/skyq_remote)
(MIT) and the [Home Assistant Sky Q integration](https://github.com/RogerSelwyn/Home_Assistant_SkyQ_MediaPlayer)
(MIT): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). License:
Apache-2.0.

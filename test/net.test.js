// -----------------------------------------------------------------------------
// The real network code on the loopback interface: node:http exchanges
// (kinds of failure, size caps, User-Agent), the remote key handshake on a
// real TCP server, and the search of the SkyPlay control URL against a real
// HTTP server that accepts, or refuses, the own User-Agent.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { SKY_USER_AGENT, SkyClient } from '../src/sky/client.js';
import { ERROR_KINDS, OWN_USER_AGENT, request } from '../src/sky/http.js';
import { keyEvent, sendKey } from '../src/sky/remote.js';
import { CONTROL_PATH, description, deviceInformation } from './fixtures/sky.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

/** A port nothing listens on. */
async function closedPort() {
  const server = createTcpServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('http: the own User-Agent by default; refused, silent and oversized answers', async (t) => {
  const seen = [];
  const server = createHttpServer((req, res) => {
    seen.push(req.headers['user-agent']);
    if (req.url === '/silent') return;
    if (req.url === '/big') {
      res.writeHead(200, { 'content-length': String(100_000) });
      res.write('x'.repeat(1000));
      return;
    }
    if (req.url === '/stream') {
      res.writeHead(200);
      res.write('x'.repeat(70_000));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const ok = await request({ host: '127.0.0.1', port, path: '/' });
  assert.equal(ok.status, 200);
  assert.equal(seen[0], OWN_USER_AGENT);
  await assert.rejects(request({ host: '127.0.0.1', port, path: '/silent', timeoutMs: 200 }), {
    kind: ERROR_KINDS.TIMEOUT,
  });
  await assert.rejects(request({ host: '127.0.0.1', port, path: '/big' }), {
    kind: ERROR_KINDS.PROTOCOL,
    message: 'Answer too large',
  });
  await assert.rejects(request({ host: '127.0.0.1', port, path: '/stream' }), {
    kind: ERROR_KINDS.PROTOCOL,
  });
  await assert.rejects(request({ host: '127.0.0.1', port: await closedPort(), path: '/' }), {
    kind: ERROR_KINDS.UNREACHABLE,
  });
  await assert.rejects(request({ host: '127.0.0.1', port, path: '/x\r\nInjected: 1' }), {
    kind: ERROR_KINDS.PROTOCOL,
  });
});

/** A box remote port playing the handshake pyskyqremote expects. */
async function fakeRemote({ init = Buffer.alloc(24, 1), closeEarly = false } = {}) {
  const remote = { received: [], connections: 0 };
  const server = createTcpServer((socket) => {
    remote.connections += 1;
    const chunks = [];
    let step = 0;
    socket.write('RFB 003.008\n');
    socket.on('data', (data) => {
      chunks.push(data);
      if (step === 0) {
        step = 1;
        if (closeEarly) {
          socket.end();
          return;
        }
        socket.write(Buffer.from([1, 1]));
      } else if (step === 1) {
        step = 2;
        socket.write(Buffer.from([0, 0, 0, 0]));
      } else if (step === 2) {
        step = 3;
        socket.write(init);
      }
    });
    socket.on('end', () => {
      remote.received.push(Buffer.concat(chunks));
      socket.end();
    });
  });
  remote.port = await listen(server);
  remote.close = () => close(server);
  return remote;
}

test('remote: the handshake echoed, then the key pressed and released', async (t) => {
  const remote = await fakeRemote();
  t.after(() => remote.close());
  await sendKey({ host: '127.0.0.1', port: remote.port, code: 64 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const [bytes] = remote.received;
  assert.equal(bytes.subarray(0, 12).toString(), 'RFB 003.008\n');
  assert.deepEqual([...bytes.subarray(12, 14)], [1, 0]);
  assert.deepEqual([...bytes.subarray(14)], [...keyEvent(64, true), ...keyEvent(64, false)]);
});

test('remote: nothing sent when refused, cut during the handshake or silent', async (t) => {
  await assert.rejects(sendKey({ host: '127.0.0.1', port: await closedPort(), code: 0 }), {
    kind: ERROR_KINDS.UNREACHABLE,
    sent: false,
  });
  const cut = await fakeRemote({ closeEarly: true });
  t.after(() => cut.close());
  await assert.rejects(sendKey({ host: '127.0.0.1', port: cut.port, code: 0 }), { sent: false });
  const silent = createTcpServer(() => {});
  const port = await listen(silent);
  t.after(() => close(silent));
  await assert.rejects(sendKey({ host: '127.0.0.1', port, code: 0, timeoutMs: 200 }), {
    kind: ERROR_KINDS.TIMEOUT,
    sent: false,
  });
});

/** A box UPnP port: the SkyControl description at /description2.xml. */
async function fakeUpnp({ refuseOwn }) {
  const upnp = { seen: [] };
  const server = createHttpServer((req, res) => {
    const ua = req.headers['user-agent'];
    upnp.seen.push({ url: req.url, ua, method: req.method });
    if (refuseOwn === 'all404' && ua !== SKY_USER_AGENT) {
      res.writeHead(404).end();
      return;
    }
    if (refuseOwn === '500' && ua !== SKY_USER_AGENT) {
      res.writeHead(500).end();
      return;
    }
    if (req.url === '/description2.xml') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(description());
      return;
    }
    res.writeHead(404).end();
  });
  upnp.port = await listen(server);
  upnp.close = () => close(server);
  return upnp;
}

const clientFor = (port) =>
  new SkyClient({ host: '127.0.0.1', ports: { rest: port, soap: port, remote: port } });

test('control URL: a box serving the own User-Agent never gets the Sky one', async (t) => {
  const upnp = await fakeUpnp({ refuseOwn: false });
  t.after(() => upnp.close());
  const client = clientFor(upnp.port);
  assert.equal(await client.findControlPath(), CONTROL_PATH);
  assert.deepEqual(
    upnp.seen.map((s) => s.url),
    ['/description0.xml', '/description1.xml', '/description2.xml'],
  );
  assert.ok(upnp.seen.every((s) => s.ua === OWN_USER_AGENT));
  assert.equal(client.uaMode, 'own');
});

test('control URL: a box refusing the own User-Agent (500) gets the Sky one on the same file', async (t) => {
  const upnp = await fakeUpnp({ refuseOwn: '500' });
  t.after(() => upnp.close());
  let told = 0;
  const client = new SkyClient({
    host: '127.0.0.1',
    ports: { rest: upnp.port, soap: upnp.port, remote: upnp.port },
    onUserAgent: () => (told += 1),
  });
  assert.equal(await client.findControlPath(), CONTROL_PATH);
  assert.deepEqual(
    upnp.seen.map((s) => `${s.url} ${s.ua}`),
    [
      `/description0.xml ${OWN_USER_AGENT}`,
      `/description0.xml ${SKY_USER_AGENT}`,
      `/description1.xml ${OWN_USER_AGENT}`,
      `/description1.xml ${SKY_USER_AGENT}`,
      `/description2.xml ${OWN_USER_AGENT}`,
      `/description2.xml ${SKY_USER_AGENT}`,
    ],
  );
  assert.equal(told, 1);
  assert.equal(client.uaMode, 'sky');
});

test('control URL: a box answering 404 to the own User-Agent everywhere gets a second pass', async (t) => {
  const upnp = await fakeUpnp({ refuseOwn: 'all404' });
  t.after(() => upnp.close());
  const client = clientFor(upnp.port);
  assert.equal(await client.findControlPath(), CONTROL_PATH);
  const own = upnp.seen.filter((s) => s.ua === OWN_USER_AGENT);
  const sky = upnp.seen.filter((s) => s.ua === SKY_USER_AGENT);
  assert.equal(own.length, 50, 'a full pass with the own User-Agent first');
  assert.deepEqual(
    sky.map((s) => s.url),
    ['/description0.xml', '/description1.xml', '/description2.xml'],
  );
});

test('REST and SOAP requests never carry the Sky User-Agent', async (t) => {
  const seen = [];
  const server = createHttpServer((req, res) => {
    seen.push(req.headers['user-agent']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(deviceInformation()));
  });
  const port = await listen(server);
  t.after(() => close(server));
  const client = clientFor(port);
  client.shared.uaMode = 'sky';
  client.shared.controlPath = CONTROL_PATH;
  await client.deviceInformation();
  await client.soap('GetMediaInfo').catch(() => {});
  assert.deepEqual(seen, [OWN_USER_AGENT, OWN_USER_AGENT]);
});

test('a budgeted view: no request once the deadline is near', async () => {
  let now = 0;
  const client = new SkyClient({
    host: '127.0.0.1',
    request: async () => ({ status: 200, body: '{}' }),
    monotonic: () => now,
  });
  const view = client.withBudget(1000);
  now = 980;
  await assert.rejects(view.deviceInformation(), { kind: ERROR_KINDS.BUDGET });
  await assert.rejects(view.key('play'), { kind: ERROR_KINDS.BUDGET, sent: false });
});

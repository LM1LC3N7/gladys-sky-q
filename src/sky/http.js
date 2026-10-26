// -----------------------------------------------------------------------------
// One plain HTTP/1.1 exchange with a box (node:http, no keep-alive, bounded
// time and size). Every failure becomes a SkyError whose kind tells "nothing
// answers" (the box is off or gone) from "it answered, but not as expected".
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';

/** The default cap of an answer (system information, SOAP answers, descriptions). */
export const MAX_BODY = 64 * 1024;
/** The channel list of a box (hundreds of services) and the recording details. */
export const MAX_LARGE_BODY = 1024 * 1024;

/** The User-Agent of this integration: the default of every request. */
export const OWN_USER_AGENT = 'gladys-sky-q';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection (refused, no route, connection never set up). */
  UNREACHABLE: 'unreachable',
  /** The box accepted the connection, then did not answer in time: state unknown. */
  TIMEOUT: 'timeout',
  /** An HTTP status other than 2xx. */
  HTTP: 'http',
  /** An answer that cannot be read (size, JSON, XML, handshake). */
  PROTOCOL: 'protocol',
  /** The time a command was given ran out before this request. */
  BUDGET: 'budget',
  /** Another box answers at this address. */
  IDENTITY: 'identity',
});

export class SkyError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'SkyError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

/**
 * @param {{ host: string, port: number, method?: string, path: string,
 *   headers?: Record<string, string>, body?: string, timeoutMs?: number,
 *   maxBody?: number }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
export function request({
  host,
  port,
  method = 'GET',
  path,
  headers = {},
  body,
  timeoutMs = 3000,
  maxBody = MAX_BODY,
}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    let settled = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    let req;
    try {
      req = httpRequest(
        {
          host,
          port,
          method,
          path,
          // One request per connection: no pipelining, nothing kept open.
          agent: false,
          headers: {
            Connection: 'close',
            'User-Agent': OWN_USER_AGENT,
            ...(payload ? { 'Content-Length': String(payload.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBody) {
            // Cut before reading: never wait for (nor hold) an oversized body.
            req.destroy();
            finish(reject, new SkyError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBody) {
              req.destroy();
              finish(reject, new SkyError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(resolve, {
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', () =>
            finish(reject, new SkyError(ERROR_KINDS.TIMEOUT, 'Answer cut before its end')),
          );
        },
      );
    } catch (err) {
      reject(new SkyError(ERROR_KINDS.PROTOCOL, `Invalid request: ${err.code ?? err.message}`));
      return;
    }
    // A box that accepted the connection and then says nothing is there, in
    // some state: that is not "off".
    let connected = false;
    req.on('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', () => {
          connected = true;
        });
      } else {
        connected = true;
      }
    });
    const timer = setTimeout(
      () => {
        req.destroy();
        finish(
          reject,
          connected
            ? new SkyError(ERROR_KINDS.TIMEOUT, 'Box connected but silent: timeout')
            : new SkyError(ERROR_KINDS.UNREACHABLE, 'Box unreachable: timeout'),
        );
      },
      Math.max(1, timeoutMs),
    );
    req.on('error', (err) =>
      finish(
        reject,
        connected
          ? new SkyError(ERROR_KINDS.TIMEOUT, `Connection lost: ${err.code ?? err.message}`)
          : new SkyError(ERROR_KINDS.UNREACHABLE, `Box unreachable: ${err.code ?? err.message}`),
      ),
    );
    req.end(payload);
  });
}

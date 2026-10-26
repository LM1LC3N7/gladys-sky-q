// -----------------------------------------------------------------------------
// One remote key on the remote control port of a box (49160), as pyskyqremote
// `DeviceAccess.send_command` does it: an RFB-like handshake (the 12-byte
// version echoed back, then the first byte of each short message), then, once
// the box sent its 24-byte (or longer) init message, the key event pressed and
// released, and the connection closed. One connection per key, never reused.
//
// The protocol has no acknowledgement of the key: a key whose bytes left is
// "sent, without confirmation"; a failure before is "nothing sent"
// (`err.sent === false`).
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { ERROR_KINDS, SkyError } from './http.js';

const VERSION_LENGTH = 12;
const INIT_LENGTH = 24;
/** Short messages echoed before the init message (version, security, result). */
const MAX_STEPS = 4;
/** What the box may send in all before the key leaves. */
const MAX_RECEIVED = 4096;
/** After the key, how long the box is given to close its side. */
const CLOSE_WAIT = 1000;

/** The key event bytes, pressed (`down`) or released. */
export function keyEvent(code, down) {
  return Buffer.from([4, down ? 1 : 0, 0, 0, 0, 0, Math.floor(224 + code / 16), code % 16]);
}

/**
 * Sends the key `code` to `host:port` within `timeoutMs`.
 * @returns {Promise<void>} resolves once the key bytes are written.
 */
export function sendKey({ host, port, code, timeoutMs = 1500 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let written = false;
    let connected = false;
    let pending = Buffer.alloc(0);
    let steps = 0;
    let received = 0;
    const socket = createConnection({ host, port });
    const finish = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve();
      }
    };
    const fail = (kind, message) =>
      finish(new SkyError(kind, `Key not sent: ${message}`, { sent: false }));
    const timer = setTimeout(
      () =>
        connected
          ? fail(ERROR_KINDS.TIMEOUT, 'the box did not finish the handshake in time')
          : fail(ERROR_KINDS.UNREACHABLE, 'remote port unreachable (timeout)'),
      Math.max(1, timeoutMs),
    );
    socket.setNoDelay(true);
    socket.once('connect', () => {
      connected = true;
    });
    socket.on('data', (chunk) => {
      if (settled || written) {
        return;
      }
      received += chunk.length;
      if (received > MAX_RECEIVED) {
        fail(ERROR_KINDS.PROTOCOL, 'unexpected handshake');
        return;
      }
      if (steps === 0) {
        // The version: echoed whole, even when it arrives in pieces.
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < VERSION_LENGTH) {
          return;
        }
        if (pending.length >= INIT_LENGTH) {
          fail(ERROR_KINDS.PROTOCOL, 'unexpected handshake');
          return;
        }
        socket.write(pending.subarray(0, VERSION_LENGTH));
        steps = 1;
        return;
      }
      if (chunk.length < INIT_LENGTH) {
        if (steps >= MAX_STEPS) {
          fail(ERROR_KINDS.PROTOCOL, 'handshake too long');
          return;
        }
        socket.write(chunk.subarray(0, 1));
        steps += 1;
        return;
      }
      // The init message: the key, pressed then released, then the end.
      written = true;
      socket.write(Buffer.concat([keyEvent(code, true), keyEvent(code, false)]), (err) => {
        if (err) {
          finish(
            new SkyError(ERROR_KINDS.TIMEOUT, 'Key sent, without confirmation', { sent: true }),
          );
          return;
        }
        socket.end();
        // The box closes its side; if it does not, the socket is not kept.
        setTimeout(() => socket.destroy(), CLOSE_WAIT).unref();
        finish();
      });
    });
    socket.on('end', () => {
      if (!written) {
        fail(ERROR_KINDS.PROTOCOL, 'the box closed the connection during the handshake');
      }
    });
    socket.on('error', (err) => {
      if (written) {
        finish(new SkyError(ERROR_KINDS.TIMEOUT, 'Key sent, without confirmation', { sent: true }));
      } else {
        fail(
          connected ? ERROR_KINDS.TIMEOUT : ERROR_KINDS.UNREACHABLE,
          `${err.code ?? err.message}`,
        );
      }
    });
    socket.on('close', () => {
      if (!written) {
        fail(ERROR_KINDS.PROTOCOL, 'connection closed during the handshake');
      }
    });
  });
}

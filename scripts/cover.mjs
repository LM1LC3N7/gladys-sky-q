// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-purple gradient, a
// flat set-top box with a ring of light, and a row of remote keys (play,
// pause, power, channel).
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [10, 18, 40];
const BLUE = [92, 40, 150];
const WHITE = [255, 255, 255];
const SCREEN = [20, 40, 80];
const ACCENT = [255, 170, 60];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** The colour of one pixel. */
function pixel(x, y) {
  let color = mix(DARK, BLUE, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // The box: a wide white slab with a dark front, standing on two small feet.
  const body = roundedBox(x, y, 400, 220, 250, 70, 22);
  color = mix(color, WHITE, smooth(0, body));
  const front = roundedBox(x, y, 400, 228, 236, 52, 14);
  color = mix(color, mix(SCREEN, DARK, (x - 164) / 472), smooth(0, front));
  for (const fx of [230, 570]) {
    color = mix(color, WHITE, smooth(0, roundedBox(x, y, fx, 298, 30, 6, 4)));
  }
  // The ring of light in the middle of the front, and a power bar.
  const dx = x - 400;
  const dy = y - 228;
  const r = Math.hypot(dx, dy);
  color = mix(color, ACCENT, smooth(4, Math.abs(r - 30)));
  const angle = Math.atan2(dx, -dy);
  const power = smooth(4, Math.abs(r - 12)) * (Math.abs(angle) > 0.7 ? 1 : 0);
  const bar = smooth(4, Math.abs(dx)) * (dy > -20 && dy < -4 ? 1 : 0);
  color = mix(color, WHITE, Math.max(power, bar));
  // Five remote keys under the box.
  [240, 320, 400, 480, 560].forEach((px, i) => {
    const d = Math.hypot(x - px, y - 430);
    color = mix(color, i === 2 ? ACCENT : WHITE, smooth(24, d) * 0.9);
    color = mix(color, BLUE, smooth(9, d) * (i === 2 ? 0 : 0.8));
  });
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);

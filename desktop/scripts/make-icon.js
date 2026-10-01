/* ==========================================================================
   SecureCom — App-Symbol zeichnen (build/icon.png, 512 × 512)
   Gleiches Motiv wie server/assets/securecom-icon.svg: dunkles Quadrat,
   orangefarbene Eckmarken, Schloss. Ohne Grafikprogramm: Pixel per
   Hand, vierfach überabgetastet (glatte Kanten), PNG mit zlib.
   Aufruf: npm run icon
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const SS = 4;                    // Unterabtastung je Achse
const U = SIZE / 64;             // Einheit des 64er-Rasters aus dem SVG

const BG = [11, 11, 13];
const ORANGE = [249, 115, 22];
const WHITE = [237, 237, 236];

function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inRect(x, y, x0, y0, w, h) {
  return x >= x0 && y >= y0 && x <= x0 + w && y <= y0 + h;
}

/** Farbe am Punkt (x, y) im 64er-Raster – oder null (durchsichtig). */
function shade(x, y) {
  if (!inRoundRect(x, y, 0, 0, 64, 64, 10)) return null;
  const t = 1.5;   // halbe Strichstärke der Eckmarken (3)
  const ticks = [
    [9 - t, 9 - t, 2 * t, 8 + t], [9 - t, 9 - t, 8 + t, 2 * t],
    [55 - t, 9 - t, 2 * t, 8 + t], [47, 9 - t, 8 + t, 2 * t],
    [55 - t, 47, 2 * t, 8 + t], [47, 55 - t, 8 + t, 2 * t],
    [9 - t, 47, 2 * t, 8 + t], [9 - t, 55 - t, 8 + t, 2 * t]
  ];
  for (const r of ticks) if (inRect(x, y, r[0], r[1], r[2], r[3])) return ORANGE;

  // Schlüsselloch
  if (inRect(x, y, 30.4, 35, 3.2, 7)) return ORANGE;

  const s = 1.7;   // halbe Strichstärke des Schlosses (3,4)
  // Körper: Rahmen eines Rechtecks
  const outer = inRoundRect(x, y, 19.5 - s, 29.5 - s, 25 + 2 * s, 18 + 2 * s, 2 + s);
  const inner = inRect(x, y, 19.5 + s, 29.5 + s, 25 - 2 * s, 18 - 2 * s);
  if (outer && !inner) return WHITE;
  // Bügel: Halbkreis um (32, 23.5) mit Radius 7,5, darunter zwei Striche bis 29,5
  const d = Math.hypot(x - 32, y - 23.5);
  if (y <= 23.5 && d >= 7.5 - s && d <= 7.5 + s) return WHITE;
  if (y > 23.5 && y <= 29.5 && (Math.abs(x - 24.5) <= s || Math.abs(x - 39.5) <= s)) return WHITE;

  return BG;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = shade((px + (sx + 0.5) / SS) / U, (py + (sy + 0.5) / SS) / U);
        if (!c) continue;
        r += c[0]; g += c[1]; b += c[2]; a += 1;
      }
    }
    const i = (py * SIZE + px) * 4;
    if (a) {
      rgba[i] = Math.round(r / a);
      rgba[i + 1] = Math.round(g / a);
      rgba[i + 2] = Math.round(b / a);
    }
    rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

/* ---- PNG schreiben ------------------------------------------------------ */
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;   // Filter: keiner
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;    // Bit je Kanal
ihdr[9] = 6;    // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('geschrieben:', out, png.length, 'Bytes');

/* ==========================================================================
   Clavichat — App-Symbol zeichnen
     build/icon.png   512 × 512 (Linux, Vorschau)
     build/icon.ico   16 … 256 (Windows: Programmdatei, Fenster, Taskleiste,
                      Infobereich – Windows nimmt je Stelle die passende Größe)
   Gleiches Motiv wie server/assets/securecom-icon.svg: dunkles Quadrat,
   Funkgerät mit Schlüssel als Antenne (seit 1.6.4 ohne Eckmarken). Ohne Grafikprogramm: Pixel per
   Hand, überabgetastet (glatte Kanten), PNG mit zlib.
   Aufruf: npm run icon
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

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

/** Strich von (x1, y1) nach (x2, y2) mit runden Enden, halbe Breite r. */
function onLine(x, y, x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= r;
}

/** Farbe am Punkt (x, y) im 64er-Raster – oder null (durchsichtig). */
function shade(x, y) {
  if (!inRoundRect(x, y, 0, 0, 64, 64, 10)) return null;

  // Lämpchen
  if (Math.hypot(x - 32, y - 46) <= 2.6) return ORANGE;
  // Schlüsselbart an der Antenne: Block mit Kerbe (zwei Zähne)
  if (inRect(x, y, 28.6, 8, 6.6, 11) && !inRect(x, y, 32.6, 12, 2.6, 3)) return ORANGE;

  const s = 1.7;   // halbe Strichstärke des Funkgeräts (3,4)
  // Antenne (Schlüsselschaft) und Drehknopf
  if (onLine(x, y, 27, 8.5, 27, 26, s) || onLine(x, y, 38, 21.5, 38, 26, s)) return WHITE;
  // Gehäuse: Rahmen eines abgerundeten Rechtecks (24 × 26, Radius 4)
  const outer = inRoundRect(x, y, 20 - s, 26 - s, 24 + 2 * s, 26 + 2 * s, 4 + s);
  const inner = inRoundRect(x, y, 20 + s, 26 + s, 24 - 2 * s, 26 - 2 * s, 4 - s);
  if (outer && !inner) return WHITE;
  // Lautsprecher: zwei Striche
  if (onLine(x, y, 26.5, 33.5, 37.5, 33.5, 1.5) || onLine(x, y, 26.5, 39, 37.5, 39, 1.5)) return WHITE;

  return BG;
}

/** RGBA-Pixel in der Größe size × size. Kleine Größen feiner abtasten. */
function render(size) {
  const u = size / 64;               // Pixel je Einheit des 64er-Rasters
  const ss = size < 64 ? 8 : 4;      // Unterabtastung je Achse
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((px + (sx + 0.5) / ss) / u, (py + (sy + 0.5) / ss) / u);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return rgba;
}

/* ---- PNG ---------------------------------------------------------------- */
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

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // Filter: keiner
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // Bit je Kanal
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---- ICO ----------------------------------------------------------------
   Bis 128 Pixel als Bitmap (32 Bit mit Alpha, dazu die 1-Bit-Maske), 256 als
   PNG – so lesen es alle Windows-Teile, auch der Installer. */
function bmp(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  out.writeUInt32LE(40, 0);            // BITMAPINFOHEADER
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8);       // Farbe + Maske übereinander
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(32, 14);
  out.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  for (let y = 0; y < size; y++) {
    const row = 40 + (size - 1 - y) * size * 4;               // von unten nach oben
    const mask = 40 + size * size * 4 + (size - 1 - y) * maskRow;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      out[row + x * 4] = rgba[i + 2];
      out[row + x * 4 + 1] = rgba[i + 1];
      out[row + x * 4 + 2] = rgba[i];
      out[row + x * 4 + 3] = rgba[i + 3];
      if (!rgba[i + 3]) out[mask + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

function ico(sizes) {
  const images = sizes.map((size) => (size >= 256 ? png(size, render(size)) : bmp(size, render(size))));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);            // Typ: Symbol
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, n) => {
    const e = 6 + 16 * n;
    head[e] = size >= 256 ? 0 : size;  // 0 heißt 256
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);      // Ebenen
    head.writeUInt16LE(32, e + 6);     // Bit je Pixel
    head.writeUInt32LE(images[n].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[n].length;
  });
  return Buffer.concat([head, ...images]);
}

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
for (const [name, data] of [['icon.png', png(512, render(512))], ['icon.ico', ico(ICO_SIZES)]]) {
  fs.writeFileSync(path.join(dir, name), data);
  console.log('geschrieben:', path.join(dir, name), data.length, 'Bytes');
}

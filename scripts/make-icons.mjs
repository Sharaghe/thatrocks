// Generates the app icons (PNG) procedurally: three balanced stones on a dusk
// background. No external assets or image libraries — a tiny PNG encoder.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? 'public/icons');
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// Stones: centre (x, y), radii, colour. Coordinates in [0,1] icon space.
const stones = [
  { cx: 0.5, cy: 0.7, rx: 0.33, ry: 0.095, col: hex('#8f8a84') },
  { cx: 0.485, cy: 0.545, rx: 0.245, ry: 0.08, col: hex('#a9875f') },
  { cx: 0.515, cy: 0.415, rx: 0.17, ry: 0.068, col: hex('#5f656b') },
];

function shade(u, v, maskable) {
  // background: dusk sky to river
  const top = hex('#3b4a40');
  const bottom = hex('#161a15');
  const t = clamp01(v);
  let r = mix(top[0], bottom[0], t);
  let g = mix(top[1], bottom[1], t);
  let b = mix(top[2], bottom[2], t);
  // warm glow behind the cairn
  const glow = Math.exp(-((u - 0.5) ** 2 * 7 + (v - 0.42) ** 2 * 6)) * 0.35;
  r += glow * 0.95;
  g += glow * 0.75;
  b += glow * 0.45;
  // water line
  if (v > 0.74) {
    const w = clamp01((v - 0.74) * 6);
    r = mix(r, 0.12, w * 0.5);
    g = mix(g, 0.17, w * 0.5);
    b = mix(b, 0.16, w * 0.5);
    const ripple = Math.sin((v - 0.74) * 140 + Math.sin(u * 18) * 1.5) * 0.5 + 0.5;
    r += ripple * 0.025 * w;
    g += ripple * 0.03 * w;
    b += ripple * 0.03 * w;
  }
  // contact shadow under the bottom stone
  const sh = Math.exp(-(((u - 0.5) / 0.34) ** 2 + ((v - 0.785) / 0.03) ** 2));
  r *= 1 - sh * 0.55;
  g *= 1 - sh * 0.55;
  b *= 1 - sh * 0.55;
  for (const s of stones) {
    // soft shadow cast by the stone above onto the one below
    const dx = (u - s.cx) / s.rx;
    const dy = (v - s.cy) / s.ry;
    const d2 = dx * dx + dy * dy;
    if (d2 <= 1) {
      const nz = Math.sqrt(1 - d2);
      const nx = dx;
      const ny = dy;
      const L = [-0.45, -0.65, 0.62];
      const ll = Math.hypot(...L);
      let lambert = clamp01((nx * L[0] + ny * L[1] + nz * L[2]) / ll);
      const rim = Math.pow(1 - nz, 3) * 0.25;
      const speck = (hash(Math.floor(u * 260), Math.floor(v * 260)) - 0.5) * 0.08;
      const occl = 1 - clamp01((dy + 0.2) * 0.45) * 0.35;
      lambert = 0.22 + lambert * 0.9;
      r = s.col[0] * lambert * occl + rim * 0.9 + speck;
      g = s.col[1] * lambert * occl + rim * 0.8 + speck;
      b = s.col[2] * lambert * occl + rim * 0.65 + speck;
    }
  }
  if (!maskable) {
    // rounded-rect alpha is applied by the OS on iOS; keep square full-bleed.
  }
  return [clamp01(r), clamp01(g), clamp01(b)];
}

function render(size, maskable = false) {
  const ss = 3;
  const buf = Buffer.alloc(size * size * 4);
  const scale = maskable ? 0.8 : 1; // maskable icons keep content in the safe zone
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          let u = (x + (sx + 0.5) / ss) / size;
          let v = (y + (sy + 0.5) / ss) / size;
          u = 0.5 + (u - 0.5) / scale;
          v = 0.5 + (v - 0.5) / scale;
          const c = shade(u, v, maskable);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(Math.pow(r / n, 1 / 1.05) * 255);
      buf[i + 1] = Math.round(Math.pow(g / n, 1 / 1.05) * 255);
      buf[i + 2] = Math.round(Math.pow(b / n, 1 / 1.05) * 255);
      buf[i + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

for (const [name, size, maskable] of [
  ['apple-touch-icon.png', 180, false],
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  writeFileSync(resolve(outDir, name), render(size, maskable));
  console.log('wrote', name);
}

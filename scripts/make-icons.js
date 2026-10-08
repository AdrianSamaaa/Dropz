// Generates assets/icon.png (256px) and assets/icon.ico (16-256px) for Drops.
// Pure Node: rasterises the logo with supersampling and encodes PNG/ICO by hand.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Logo in a 256x256 design space: a gradient tile holding a "Drop" -
// a header bar with a stack of app rows hanging under it.
function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const lerp = (a, b, t) => a + (b - a) * t;
const TOP = [124, 92, 255];    // violet
const BOTTOM = [56, 140, 255]; // blue

const SHAPES = [
  { rect: [58, 58, 198, 104, 20], alpha: 1 },     // header
  { rect: [72, 120, 184, 146, 13], alpha: 0.88 }, // rows
  { rect: [72, 158, 184, 184, 13], alpha: 0.72 },
  { rect: [72, 196, 184, 210, 7], alpha: 0.5 },
];

function sample(x, y) {
  // returns premultiplied [r,g,b,a] in 0..1
  if (sdRoundRect(x, y, 12, 12, 244, 244, 58) > 0) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (x * 0.35 + y) / (256 * 1.35)));
  let c = TOP.map((v, i) => lerp(v, BOTTOM[i], t) / 255);
  for (const s of SHAPES) {
    if (sdRoundRect(x, y, ...s.rect) <= 0) c = c.map(v => lerp(v, 1, s.alpha));
  }
  return [c[0], c[1], c[2], 1];
}

function render(size) {
  const ss = size <= 32 ? 8 : 4;
  const scale = 256 / size;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const s = sample((x + (sx + 0.5) / ss) * scale, (y + (sy + 0.5) / ss) * scale);
          for (let k = 0; k < 4; k++) acc[k] += s[k] * s[3];
        }
      }
      const n = ss * ss, a = acc[3] / n;
      const i = (y * size + x) * 4;
      px[i] = a ? Math.round((acc[0] / n / a) * 255) : 0;
      px[i + 1] = a ? Math.round((acc[1] / n / a) * 255) : 0;
      px[i + 2] = a ? Math.round((acc[2] / n / a) * 255) : 0;
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map(i => i.data)]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = sizes.map(size => ({ size, data: png(size, render(size)) }));
fs.writeFileSync(path.join(outDir, 'icon.png'), images.find(i => i.size === 256).data);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico(images));
console.log('Wrote assets/icon.png and assets/icon.ico');

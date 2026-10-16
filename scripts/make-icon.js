'use strict';

// Uygulama ikonunu (degrade zemin üzerinde beyaz indirme oku) bağımlılıksız PNG olarak üretir.
// Çalıştırma: npm run icon

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 256'lık tuval koordinatlarında şekiller
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (p1x, p1y, p2x, p2y, p3x, p3y) => (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y);
  const d1 = s(px, py, ax, ay, bx, by);
  const d2 = s(px, py, bx, by, cx, cy);
  const d3 = s(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function sample(x, y) {
  if (!inRoundRect(x, y, 12, 12, 244, 244, 58)) return null;
  const white =
    inRoundRect(x, y, 110, 46, 146, 138, 10) ||
    inTriangle(x, y, [64, 112], [192, 112], [128, 182]) ||
    inRoundRect(x, y, 66, 196, 190, 220, 12);
  if (white) return [255, 255, 255];
  // Sol üst maviden sağ alt mora degrade
  const t = (x + y) / 512;
  return [Math.round(37 + (124 - 37) * t), Math.round(99 + (58 - 99) * t), Math.round(235 + (237 - 235) * t)];
}

function render(size) {
  const ss = 4;
  const out = Buffer.alloc(size * size * 4);
  const scale = 256 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) * scale, (py + (sy + 0.5) / ss) * scale);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
  }
  return encodePng(size, out);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), render(256));
fs.writeFileSync(path.join(root, 'assets', 'tray.png'), render(32));
fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
fs.writeFileSync(path.join(root, 'extension', 'icon128.png'), render(128));
fs.writeFileSync(path.join(root, 'extension', 'icon32.png'), render(32));
console.log('İkonlar oluşturuldu: assets/icon.png, assets/tray.png, extension/icon*.png');

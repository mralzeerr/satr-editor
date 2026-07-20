// مولّد أيقونة التطبيق — ينتج icon.png (256x256) بلا مكتبات خارجية
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 256;
const buf = Buffer.alloc(SIZE * SIZE * 4); // RGBA

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // مزج بسيط فوق ما هو موجود
  const ea = a / 255;
  buf[i]     = Math.round(r * ea + buf[i]     * (1 - ea));
  buf[i + 1] = Math.round(g * ea + buf[i + 1] * (1 - ea));
  buf[i + 2] = Math.round(b * ea + buf[i + 2] * (1 - ea));
  buf[i + 3] = Math.min(255, buf[i + 3] + a);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ---------- الخلفية: مربع بزوايا دائرية وتدرّج بنفسجي ----------
const R = 54; // نصف قطر الزاوية
const c1 = [124, 140, 255]; // #7c8cff
const c2 = [199, 146, 234]; // #c792ea

function insideRounded(x, y) {
  if (x >= R && x < SIZE - R) return y >= 0 && y < SIZE;
  if (y >= R && y < SIZE - R) return x >= 0 && x < SIZE;
  const cx = x < R ? R : SIZE - R - 1;
  const cy = y < R ? R : SIZE - R - 1;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!insideRounded(x, y)) continue;
    const t = (x + y) / (2 * SIZE); // تدرّج قطري
    const r = Math.round(lerp(c1[0], c2[0], t));
    const g = Math.round(lerp(c1[1], c2[1], t));
    const b = Math.round(lerp(c1[2], c2[2], t));
    set(x, y, r, g, b, 255);
  }
}

// ---------- شعار </> باللون الأبيض ----------
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// حواف ناعمة: سماكة مع تلاشٍ عند الأطراف
function stroke(ax, ay, bx, by, half) {
  const minx = Math.max(0, Math.floor(Math.min(ax, bx) - half - 2));
  const maxx = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx) + half + 2));
  const miny = Math.max(0, Math.floor(Math.min(ay, by) - half - 2));
  const maxy = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by) + half + 2));
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      const d = distSeg(x + 0.5, y + 0.5, ax, ay, bx, by);
      if (d <= half) {
        const edge = half - d;
        const a = edge >= 1.2 ? 255 : Math.round((edge / 1.2) * 255);
        set(x, y, 245, 247, 255, a);
      }
    }
  }
}

// شعار «سطر»: أسنان السين + قاعدة ممتدة كسطر كود + مؤشر كتابة (مطابق لـ assets/logo.svg)
const H = 10; // نصف السماكة
// أسنان السين (من اليمين)
stroke(196, 114, 196, 150, H);
stroke(168, 114, 168, 150, H);
stroke(140, 114, 140, 150, H);
// القاعدة الممتدة يسارًا (السطر)
stroke(88, 150, 196, 150, H);
// مؤشر الكتابة
stroke(56, 132, 56, 146, 14);

// ---------- ترميز PNG ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

// بيانات الصورة مع بايت المرشّح (0) لكل سطر
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0;
  const rowStart = y * SIZE * 4;
  buf.copy(raw, p, rowStart, rowStart + SIZE * 4);
  p += SIZE * 4;
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('تم إنشاء الأيقونة:', out, `(${png.length} بايت)`);

// ---------- توليد icon.ico (يحتوي PNG مضمّنًا — مدعوم في ويندوز) ----------
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);   // reserved
dir.writeUInt16LE(1, 2);   // type: icon
dir.writeUInt16LE(1, 4);   // count
const entry = Buffer.alloc(16);
entry[0] = 0;              // width 0 => 256
entry[1] = 0;              // height 0 => 256
entry[2] = 0;             // color palette
entry[3] = 0;             // reserved
entry.writeUInt16LE(1, 4);   // color planes
entry.writeUInt16LE(32, 6);  // bits per pixel
entry.writeUInt32LE(png.length, 8);  // size of image data
entry.writeUInt32LE(6 + 16, 12);     // offset
const ico = Buffer.concat([dir, entry, png]);
const icoOut = path.join(__dirname, 'icon.ico');
fs.writeFileSync(icoOut, ico);
console.log('تم إنشاء أيقونة ويندوز:', icoOut, `(${ico.length} بايت)`);

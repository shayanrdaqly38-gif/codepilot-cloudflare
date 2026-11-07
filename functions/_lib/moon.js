// functions/_lib/moon.js
// مولد PNG شفاف (RGBA) از ماه کامل پیکسلی — بدون هیچ وابستگی خارجی.
// خروجی: Uint8Array حاوی بایت‌های PNG معتبر.
// از RFC 1950 (zlib) با بلوک‌های ذخیره‌شده (stored) استفاده می‌کند؛
// یعنی بدون نیاز به کمپرسور، صرفاً با Web Crypto / TextEncoder قابل اجراست.

const TEXT_ENCODER = new TextEncoder();

// ===== CRC-32 (جدول‌محور) =====
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ===== Adler-32 (برای zlib) =====
function adler32(buf) {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ===== بسته‌بندی دهلت با بلوک‌های stored =====
function deflateStored(raw) {
  const blocks = [];
  let off = 0;
  while (off < raw.length) {
    const n = Math.min(65535, raw.length - off);
    const last = off + n >= raw.length ? 1 : 0;
    const hdr = new Uint8Array(5);
    hdr[0] = last;                 // BFINAL + BTYPE=00 (stored)
    hdr[1] = n & 0xff;             // LEN (little-endian)
    hdr[2] = (n >>> 8) & 0xff;
    hdr[3] = (~n) & 0xff;          // NLEN (یک‌مکمل یک)
    hdr[4] = ((~n) >>> 8) & 0xff;
    blocks.push(hdr, raw.subarray(off, off + n));
    off += n;
  }
  // wrapper zlib: سربرگ 0x78 0x01 (deflate، سطح سریع) + آدلر
  const body = concat([Uint8Array.of(0x78, 0x01), ...blocks]);
  const tail = new Uint8Array(4);
  const dv = new DataView(tail.buffer);
  dv.setUint32(0, adler32(raw));
  return concat([body, tail]);
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(TEXT_ENCODER.encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

// ===== هندسه ماه (منطق ۴۰×۴۰، بزرگنمایی S) =====
const MOON_BASE = [238, 236, 231];      // نقره‌ای روشن
const MOON_SEA = [226, 223, 217];        // لکه‌های کم‌کنتراست
const MOON_CRATER = [203, 199, 193];     // داخل دهانه
const MOON_TRANS = [219, 215, 209];      // ناحیه میانی دهانه
const MOON_RIM = [247, 244, 239];        // لبه روشن دهانه

// لکه‌های تیره ملایم (دریاهای ماه)
const MOON_SEAS = [
  [11.0, 13.0, 4.6],
  [28.0, 17.0, 3.8],
  [19.0, 28.0, 4.2],
  [31.0, 28.5, 2.6],
  [6.5, 27.5, 2.4]
];

// دهانه‌ها (cx, cy, r)
const MOON_CRATERS = [
  [10.5, 9.0, 3.4], [20.0, 7.5, 2.6], [29.0, 11.0, 2.2],
  [26.0, 19.5, 3.0], [13.5, 22.5, 2.4], [7.0, 16.0, 1.8],
  [23.0, 27.5, 2.8], [32.0, 24.0, 2.0], [16.5, 31.0, 1.7],
  [28.5, 31.5, 1.5], [8.5, 29.0, 1.6]
];

function moonColorAt(gx, gy) {
  let col = MOON_BASE;
  for (const [sx, sy, sr] of MOON_SEAS) {
    const dx = gx - sx;
    const dy = gy - sy;
    if (dx * dx + dy * dy < sr * sr) {
      col = MOON_SEA;
      break;
    }
  }
  for (const [cx, cy, cr] of MOON_CRATERS) {
    const dx = gx - cx;
    const dy = gy - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < cr) {
      if (d > cr - 0.8) col = MOON_RIM;
      else if (d < cr - 2.0) col = MOON_CRATER;
      else col = MOON_TRANS;
      break;
    }
  }
  return col;
}

/**
 * ساخت پیکسل‌های RGBA ماه شفاف.
 * @param {number} S بزرگنمایی (۲، ۴، ۸ یا ۱۶) → ابعاد ۸۰/۱۶۰/۳۲۰/۶۴۰
 * @returns {Uint8Array} بافر RGBA (W×W×4)
 */
export function buildMoonRgba(S = 8) {
  const G = 40;
  const W = G * S;
  const R = 17.6;
  const CX = (G - 1) / 2;
  const CY = (G - 1) / 2;
  const rgba = new Uint8Array(W * W * 4); // پیش‌فرض: کاملاً شفاف

  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const dx = gx - CX;
      const dy = gy - CY;
      if (dx * dx + dy * dy > R * R) continue; // خارج از دایره → شفاف
      const [r, g, b] = moonColorAt(gx, gy);
      for (let oy = 0; oy < S; oy++) {
        for (let ox = 0; ox < S; ox++) {
          const px = (gy * S + oy) * W + (gx * S + ox);
          const i = px * 4;
          rgba[i] = r;
          rgba[i + 1] = g;
          rgba[i + 2] = b;
          rgba[i + 3] = 255;
        }
      }
    }
  }
  return rgba;
}

/**
 * ساخت فایل کامل PNG (RGBA، بدون فیلتر) از ماه.
 * @param {number} S بزرگنمایی
 * @returns {Uint8Array} بایت‌های PNG
 */
export function buildMoonPng(S = 8) {
  const G = 40;
  const W = G * S;
  const rgba = buildMoonRgba(S);

  // خطوط اسکن + بایت فیلتر ۰
  const stride = 1 + W * 4;
  const raw = new Uint8Array(W * stride);
  for (let y = 0; y < W; y++) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * W * 4, (y + 1) * W * 4), y * stride + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, W);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // رنگ: RGBA
  ihdr[10] = 0;  // فشرده‌سازی
  ihdr[11] = 0;  // فیلتر
  ihdr[12] = 0;  // بدون interlacing

  const sig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  return concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateStored(raw)),
    chunk('IEND', new Uint8Array(0))
  ]);
}

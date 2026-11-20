'use strict';
// 生成 Windows 任务栏缩略图工具栏图标（上一首 / 播放 / 暂停 / 下一首）
// 纯 Node（zlib + SDF 抗锯齿），无第三方依赖。
// 输出：build/thumbar/{prev,play,pause,next}.png（16px 与 32px 双份，Windows 会按 DPI 挑）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build', 'thumbar');
const SIZES = [16, 32];

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

// 三角形 SDF（顶点顺时针/逆时针均可，内部为正）
function sdTriangle(px, py, v0, v1, v2) {
  const e = [[v0, v1], [v1, v2], [v2, v0]];
  let d = Infinity, s = 1;
  for (const [a, b] of e) {
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const wx = px - a[0], wy = py - a[1];
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = px - (a[0] + t * ex), by = py - (a[1] + t * ey);
    d = Math.min(d, Math.hypot(bx, by));
    if (ey * wx - ex * wy < 0) s = -1;
  }
  return d * s;
}

// 统一成"内部为负"的三角形 SDF（便于与 box 做并集）
function sdTriIn(px, py, v0, v1, v2) { return -sdTriangle(px, py, v0, v1, v2); }

function sdBox(px, py, cx, cy, hw, hh) {
  const qx = Math.abs(px - cx) - hw;
  const qy = Math.abs(py - cy) - hh;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
}

// 每个图标的形状定义（归一化 0..1 坐标）
const SHAPES = {
  play: (u, v) => sdTriIn(u, v, [0.32, 0.20], [0.32, 0.80], [0.76, 0.50]),
  pause: (u, v) => Math.min(sdBox(u, v, 0.36, 0.5, 0.095, 0.30), sdBox(u, v, 0.64, 0.5, 0.095, 0.30)),
  prev: (u, v) => Math.min(
    sdBox(u, v, 0.28, 0.5, 0.055, 0.30),
    sdTriIn(u, v, [0.80, 0.20], [0.80, 0.80], [0.40, 0.50])
  ),
  next: (u, v) => Math.min(
    sdBox(u, v, 0.72, 0.5, 0.055, 0.30),
    sdTriIn(u, v, [0.20, 0.20], [0.20, 0.80], [0.60, 0.50])
  )
};

function render(size, shapeFn) {
  const buf = Buffer.alloc(size * size * 4);
  const px = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * px, v = (y + 0.5) * px;
      const d = shapeFn(u, v);
      const a = smoothstep(px * 0.9, -px * 0.9, d);
      const i = (y * size + x) * 4;
      buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255;
      buf[i + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  return buf;
}

// ---------- PNG 编码 ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, fn] of Object.entries(SHAPES)) {
  for (const size of SIZES) {
    const file = path.join(OUT_DIR, `${name}${size === 16 ? '' : '@2x'}.png`);
    fs.writeFileSync(file, encodePNG(size, render(size, fn)));
  }
}
console.log('thumbar icons →', OUT_DIR);

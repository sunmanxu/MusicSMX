'use strict';
// 生成 MusicBuddy 图标：渐变圆角方块 + 白色播放三角
// 纯 Node（zlib），SDF 抗锯齿，输出多尺寸 PNG-in-ICO。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [256, 48, 32, 16];

// ---------- SDF 工具（坐标归一化 0..1，中心 0.5,0.5） ----------
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

// 圆角方形 SDF
function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

// 三角形 SDF（顶点逆时针）
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

function mix(c1, c2, t) {
  return [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
}

// ---------- 渲染单尺寸 RGBA ----------
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const A = [26, 29, 38];    // 深蓝灰 #1A1D26（与深色主题 --bg-elev 一致，用户指定的logo底色）
  const B = [40, 48, 70];    // 略亮的深蓝，保持对角渐变的立体感
  const W = [255, 255, 255];
  const tri = [[0.355, 0.27], [0.355, 0.73], [0.735, 0.5]];
  const px = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * px, v = (y + 0.5) * px;
      // 背景：圆角方块（占 94%），角半径 ~22%
      const dBg = sdRoundBox(u, v, 0.5, 0.5, 0.47, 0.47, 0.22);
      const bgA = 1 - smoothstep(-px, px, dBg);
      // 对角渐变
      const g = clamp((u + v) / 2, 0, 1);
      let col = mix(A, B, g);
      // 高光：左上角轻提亮
      const hl = smoothstep(0.9, 0.2, Math.hypot(u - 0.3, v - 0.25)) * 0.18;
      col = [col[0] + (255 - col[0]) * hl, col[1] + (255 - col[1]) * hl, col[2] + (255 - col[2]) * hl];
      // 白色三角（本 SDF 内部为正、外部为负，故 tA 直接取 smoothstep）
      const dTri = sdTriangle(u, v, tri[0], tri[1], tri[2]);
      const tA = smoothstep(-px, px, dTri + 0.008);
      if (tA > 0) col = mix(col, W, tA);
      // 阴影边：底部内描边轻微变暗
      const shade = smoothstep(0.40, 0.47, v) * 0.12 * (1 - tA);
      col = [col[0] * (1 - shade), col[1] * (1 - shade), col[2] * (1 - shade)];

      const alpha = Math.round(bgA * 255);
      const i = (y * size + x) * 4;
      buf[i] = Math.round(clamp(col[0], 0, 255));
      buf[i + 1] = Math.round(clamp(col[1], 0, 255));
      buf[i + 2] = Math.round(clamp(col[2], 0, 255));
      buf[i + 3] = alpha;
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
  // 每行前加 filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- ICO 组装 ----------
const pngs = SIZES.map((s) => encodePNG(s, render(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(SIZES.length, 4);
const entries = Buffer.alloc(16 * SIZES.length);
let offset = header.length + entries.length;
SIZES.forEach((s, i) => {
  const e = 16 * i;
  entries.writeUInt8(s >= 256 ? 0 : s, e);
  entries.writeUInt8(s >= 256 ? 0 : s, e + 1);
  entries.writeUInt8(0, e + 2);
  entries.writeUInt8(0, e + 3);
  entries.writeUInt16LE(1, e + 4);   // planes
  entries.writeUInt16LE(32, e + 6);  // bpp
  entries.writeUInt32LE(pngs[i].length, e + 8);
  entries.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, entries, ...pngs]));
console.log('icon.ico 写入完成: ' + out + ' (' + SIZES.join('/') + ' px)');

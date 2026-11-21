// 生成任务栏缩略图工具栏的红心图标（fav-on / fav-off，各 16px + @2x 32px）。
// 一次性脚本：node scripts/gen-thumbar-heart.js
// 纯 zlib PNG 编码，不依赖任何第三方库。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 心形几何：隐式心形 (x²+y²-1)³ - x²y³ ≤ 0 ----------
function heartField(x, y) {
  const x2 = x * x, y2 = y * y;
  return Math.pow(x2 + y2 - 1, 3) - x2 * y * y * y;
}
// 先数值扫描求包围盒，再把心形居中缩放到画布内（留 margin）
function heartBounds(scale) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let x = -2; x <= 2.001; x += 0.004) {
    for (let y = -2; y <= 2.001; y += 0.004) {
      if (heartField(x / scale, y / scale) <= 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}
// scale：1 = 满幅；<1 = 缩小（用于描边内腐蚀）
function makeHeartIcon(size, opts) {
  const { filled, color } = opts; // filled=false 时画描边（外满幅，内 0.72 腐蚀）
  const OUTER = heartBounds(1), INNER = heartBounds(0.72);
  const m = size * 0.06; // 边距
  const w = size - 2 * m, h = size - 2 * m;
  const scaleX = w / (OUTER.maxX - OUTER.minX), scaleY = h / (OUTER.maxY - OUTER.minY);
  const s = Math.min(scaleX, scaleY);
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // 3x3 超采样抗锯齿
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = OUTER.cx + ((px + (sx + 0.5) / SS) - m - w / 2) / s;
          const fy = OUTER.cy - ((py + (sy + 0.5) / SS) - m - h / 2) / s; // y 轴向上
          const out = heartField(fx, fy) <= 0;
          let inside = out;
          if (out && !filled) {
            // 描边：在外形内、但不在缩小版内
            const gx = INNER.cx + (fx - INNER.cx) * (1 / 0.72);
            const gy = INNER.cy + (fy - INNER.cy) * (1 / 0.72);
            inside = heartField(gx, gy) <= 0;
          }
          if (inside) hit++;
        }
      }
      const a = Math.round(255 * hit / (SS * SS));
      const o = (py * size + px) * 4;
      rgba[o] = color[0]; rgba[o + 1] = color[1]; rgba[o + 2] = color[2];
      rgba[o + 3] = a;
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'build', 'thumbar');
fs.mkdirSync(outDir, { recursive: true });
const RED = [255, 82, 82];    // 实心红：已收藏（和主界面红心 #ff5252 一致）
const GRAY = [220, 220, 220]; // 空心白：未收藏
const files = [
  ['fav-on.png', 16, { filled: true, color: RED }],
  ['fav-on@2x.png', 32, { filled: true, color: RED }],
  ['fav-off.png', 16, { filled: false, color: GRAY }],
  ['fav-off@2x.png', 32, { filled: false, color: GRAY }]
];
for (const [name, size, opts] of files) {
  fs.writeFileSync(path.join(outDir, name), makeHeartIcon(size, opts));
  console.log('written', name, size + 'px');
}

'use strict';
// MusicBuddy 元数据解析：ID3v2 (mp3) + FLAC (Vorbis Comment / Picture)
// 纯 Buffer 实现，无原生依赖。

const fs = require('fs');
const fsp = fs.promises;

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus',
  '.m4a', '.aac', '.mp4', '.webm', '.aif', '.aiff'
]);

const MAX_TAG = 8 * 1024 * 1024; // 单个标签块最大 8MB
const MAX_COVER = 4 * 1024 * 1024; // 封面最大 4MB

function isAudioFile(p) {
  const i = p.lastIndexOf('.');
  if (i < 0) return false;
  return AUDIO_EXT.has(p.slice(i).toLowerCase());
}

// ---------- 文本解码（ID3 enc byte） ----------
function decodeText(buf) {
  if (buf.length === 0) return '';
  const enc = buf[0];
  let text;
  if (enc === 1 || enc === 2) {
    // UTF-16，带 BOM 判断端序
    let data = buf.subarray(1);
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
      text = data.subarray(2).toString('utf16le');
    } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
      // UTF-16BE：交换字节
      const swapped = Buffer.alloc(data.length);
      for (let i = 0; i + 1 < data.length; i += 2) {
        swapped[i] = data[i + 1];
        swapped[i + 1] = data[i];
      }
      text = swapped.toString('utf16le');
    } else {
      text = data.toString('utf16le');
    }
  } else if (enc === 3) {
    text = buf.subarray(1).toString('utf8');
  } else {
    // enc 0: 名义 latin1，但中文歌常用 GBK 写入，优先按 GBK 解
    const raw = buf.subarray(1);
    try {
      text = new TextDecoder('gbk').decode(raw);
      // GBK 解出的替换符说明不是 GBK，退回 latin1
      if (text.includes('\uFFFD')) text = raw.toString('latin1');
    } catch (e) {
      text = raw.toString('latin1');
    }
  }
  // 去掉结尾 NUL 与首尾空白
  return text.replace(/\0+$/g, '').replace(/\0/g, ' ').trim();
}

// ---------- ID3v2 ----------
function parseID3(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const ver = buf[3]; // 2/3/4
  const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const end = Math.min(10 + tagSize, buf.length);
  const flags = buf[5];
  let pos = 10;

  // v2.3 全局 unsync：把 FF 00 折叠成 FF
  let body = buf;
  if (ver === 3 && (flags & 0x80)) {
    const out = Buffer.allocUnsafe(end);
    buf.copy(out, 0, 0, end);
    let w = 10;
    for (let r = 10; r < end; r++) {
      out[w++] = buf[r];
      if (buf[r] === 0xff && r + 1 < end && buf[r + 1] === 0x00) r++;
    }
    body = out;
    return parseID3Frames(body, 10, w, ver);
  }
  if (ver === 4 && (flags & 0x40)) pos += 4; // extended header
  if (ver === 3 && (flags & 0x40)) {
    // v2.3 扩展头大小（不含自身 4 字节）
    pos += 4 + buf.readUInt32BE(pos);
  }
  return parseID3Frames(body, pos, end, ver);
}

function parseID3Frames(buf, pos, end, ver) {
  const out = { title: '', artist: '', album: '', cover: null };
  const idLen = ver === 2 ? 3 : 4;
  const sizeLen = ver === 2 ? 3 : 4;
  const map22 = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', PIC: 'APIC' };

  while (pos + idLen + sizeLen <= end) {
    let id = buf.toString('latin1', pos, pos + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fsize;
    if (ver === 2) {
      fsize = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
    } else if (ver === 4) {
      fsize = ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) |
        ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f);
    } else {
      fsize = buf.readUInt32BE(pos + 4);
    }
    if (fsize <= 0 || pos + idLen + sizeLen + fsize > end) break;
    const dataStart = pos + idLen + sizeLen + (ver === 2 ? 0 : 2); // v2.3/2.4 有 flag 两字节
    const data = buf.subarray(dataStart, dataStart + fsize);
    id = map22[id] || id;

    if (id === 'TIT2' && !out.title) out.title = decodeText(data);
    else if (id === 'TPE1' && !out.artist) out.artist = decodeText(data);
    else if (id === 'TALB' && !out.album) out.album = decodeText(data);
    else if (id === 'APIC' && !out.cover && fsize < MAX_COVER + 1024) {
      const cov = parseAPIC(data);
      if (cov) out.cover = cov;
    }
    pos = dataStart + fsize;
  }
  return out;
}

function parseAPIC(data) {
  try {
    const enc = data[0];
    let o = 1;
    let mimeEnd = data.indexOf(0, o);
    if (mimeEnd < 0) return null;
    let mime = data.toString('latin1', o, mimeEnd).trim().toLowerCase();
    if (mime === 'jpg' || mime === 'jpeg') mime = 'image/jpeg';
    if (!mime.startsWith('image/')) mime = mime === '' ? 'image/jpeg' : 'image/' + mime;
    o = mimeEnd + 1;
    o += 1; // picture type
    if (enc === 1 || enc === 2) {
      // UTF-16 描述，找双字节 NUL
      while (o + 1 < data.length && !(data[o] === 0 && data[o + 1] === 0)) o += 2;
      o += 2;
    } else {
      const dEnd = data.indexOf(0, o);
      o = dEnd < 0 ? data.length : dEnd + 1;
    }
    if (o >= data.length) return null;
    const img = data.subarray(o);
    if (img.length < 100 || img.length > MAX_COVER) return null;
    return 'data:' + mime + ';base64,' + img.toString('base64');
  } catch (e) {
    return null;
  }
}

// ---------- FLAC ----------
function parseFLAC(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  const out = { title: '', artist: '', album: '', cover: null };
  let pos = 4;
  for (let i = 0; i < 64 && pos + 4 <= buf.length; i++) {
    const head = buf.readUInt8(pos);
    const type = head & 0x7f;
    const last = (head & 0x80) !== 0;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    if (pos + size > buf.length) break;
    const block = buf.subarray(pos, pos + size);
    if (type === 4) {
      // VORBIS_COMMENT
      try {
        let o = 0;
        const vlen = block.readUInt32LE(o); o += 4 + vlen;
        const count = block.readUInt32LE(o); o += 4;
        for (let c = 0; c < count && o + 4 <= block.length; c++) {
          const l = block.readUInt32LE(o); o += 4;
          if (o + l > block.length) break;
          const s = block.toString('utf8', o, o + l); o += l;
          const eq = s.indexOf('=');
          if (eq > 0) {
            const k = s.slice(0, eq).toUpperCase();
            const v = s.slice(eq + 1);
            if (k === 'TITLE' && !out.title) out.title = v;
            else if (k === 'ARTIST' && !out.artist) out.artist = v;
            else if (k === 'ALBUM' && !out.album) out.album = v;
          }
        }
      } catch (e) { /* 忽略坏块 */ }
    } else if (type === 6 && !out.cover && size < MAX_COVER + 1024) {
      // PICTURE
      try {
        let o = 4; // picture type
        const mimeLen = block.readUInt32BE(o); o += 4;
        const mime = block.toString('latin1', o, o + mimeLen).toLowerCase() || 'image/jpeg';
        o += mimeLen;
        const descLen = block.readUInt32BE(o); o += 4 + descLen;
        o += 16; // width height depth colors
        const dataLen = block.readUInt32BE(o); o += 4;
        const img = block.subarray(o, o + dataLen);
        if (img.length > 100) out.cover = 'data:' + mime + ';base64,' + img.toString('base64');
      } catch (e) { /* 忽略坏块 */ }
    }
    pos += size;
    if (last) break;
  }
  return out;
}

// ---------- MP4 / M4A 元数据解析（Vorbis Comment 风格的 ilst box） ----------

// 在 buffer 中查找指定类型的 box，返回 {offset, size, dataOffset, dataSize}
function findBox(buf, type, start = 0, end = buf.length) {
  let pos = start;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const boxType = buf.toString('latin1', pos + 4, pos + 8);
    if (size < 8 || pos + size > end) break;
    if (boxType === type) {
      return {
        offset: pos,
        size,
        dataOffset: pos + 8,
        dataSize: size - 8
      };
    }
    pos += size;
  }
  return null;
}

// 递归查找嵌套 box（如 moov > udta > meta > ilst）
function findNestedBox(buf, path) {
  let start = 0;
  let end = buf.length;
  for (let i = 0; i < path.length; i++) {
    const box = findBox(buf, path[i], start, end);
    if (!box) return null;
    if (i === path.length - 1) return box;
    // meta box 是 FullBox，有 4 字节版本/标志，数据从 +4 开始
    if (path[i] === 'meta') {
      start = box.dataOffset + 4;
    } else {
      start = box.dataOffset;
    }
    end = start + box.dataSize;
  }
  return null;
}

// 解析 ilst box 里的元数据项
function parseIlst(ilstBuf) {
  const out = {};
  let pos = 0;
  while (pos + 8 <= ilstBuf.length) {
    const size = ilstBuf.readUInt32BE(pos);
    const itemType = ilstBuf.toString('latin1', pos + 4, pos + 8);
    if (size < 8 || pos + size > ilstBuf.length) break;
    const itemData = ilstBuf.subarray(pos + 8, pos + size);
    // 查找 data atom
    const dataBox = findBox(itemData, 'data');
    if (dataBox) {
      // data atom 是 FullBox：4 字节版本/标志（类型指示器）+ 4 字节保留 + 数据
      const typeIndicator = dataBox.dataOffset + 0;
      const dataType = itemData.readUInt32BE(typeIndicator);
      const valueOffset = dataBox.dataOffset + 8; // 跳过 4 字节类型 + 4 字节保留
      const valueSize = dataBox.size - 16; // 8 字节 box 头 + 4 字节类型 + 4 字节保留
      const value = itemData.subarray(valueOffset, valueOffset + valueSize);
      // 根据类型解析
      if (itemType === '©nam' && dataType === 1) {
        out.title = value.toString('utf8').replace(/\0+$/, '').trim();
      } else if (itemType === '©ART' && dataType === 1) {
        out.artist = value.toString('utf8').replace(/\0+$/, '').trim();
      } else if (itemType === '©alb' && dataType === 1) {
        out.album = value.toString('utf8').replace(/\0+$/, '').trim();
      } else if (itemType === 'aART' && dataType === 1 && !out.artist) {
        out.artist = value.toString('utf8').replace(/\0+$/, '').trim();
      } else if (itemType === 'covr' && (dataType === 13 || dataType === 14)) {
        const mime = dataType === 14 ? 'image/png' : 'image/jpeg';
        if (value.length > 100) {
          out.cover = 'data:' + mime + ';base64,' + value.toString('base64');
        }
      }
    }
    pos += size;
  }
  return out;
}

// 解析 MP4 / M4A 文件元数据
function parseMP4(buf) {
  // 查找 moov > udta > meta > ilst
  const ilstBox = findNestedBox(buf, ['moov', 'udta', 'meta', 'ilst']);
  if (!ilstBox) return null;
  const ilstBuf = buf.subarray(ilstBox.dataOffset, ilstBox.dataOffset + ilstBox.dataSize);
  return parseIlst(ilstBuf);
}

// ---------- Ogg (Vorbis / Opus) ----------
// Vorbis Comment 解析：vendorLen(LE32) + vendor + count(LE32) + count×(len(LE32)+UTF8 "KEY=value")
function parseVorbisComment(buf, out) {
  try {
    let o = 0;
    const vendorLen = buf.readUInt32LE(o); o += 4 + vendorLen;
    const count = buf.readUInt32LE(o); o += 4;
    for (let c = 0; c < count && o + 4 <= buf.length; c++) {
      const len = buf.readUInt32LE(o); o += 4;
      if (o + len > buf.length) break;
      const s = buf.toString('utf8', o, o + len); o += len;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      const k = s.slice(0, eq).toUpperCase();
      const v = s.slice(eq + 1);
      if (k === 'TITLE' && !out.title) out.title = v.trim();
      else if (k === 'ARTIST' && !out.artist) out.artist = v.trim();
      else if (k === 'ALBUM' && !out.album) out.album = v.trim();
      else if (k === 'METADATA_BLOCK_PICTURE' && !out.cover) {
        // base64 的 FLAC PICTURE block：type(4BE) mimeLen mime descLen desc w h d c dataLen data
        try {
          const pic = Buffer.from(v.trim(), 'base64');
          let p = 4;
          const mimeLen = pic.readUInt32BE(p); p += 4;
          const mime = pic.toString('latin1', p, p + mimeLen).toLowerCase() || 'image/jpeg';
          p += mimeLen;
          const descLen = pic.readUInt32BE(p); p += 4 + descLen + 16;
          const dataLen = pic.readUInt32BE(p); p += 4;
          const img = pic.subarray(p, p + dataLen);
          if (img.length > 100 && img.length <= MAX_COVER) {
            out.cover = 'data:' + mime + ';base64,' + img.toString('base64');
          }
        } catch (e) { /* 忽略坏图 */ }
      }
    }
  } catch (e) { /* 忽略坏块 */ }
}

// Ogg 页 → 包重组，找出 comment 头（vorbis 第二包 / OpusTags）
function parseOgg(buf) {
  const out = { title: '', artist: '', album: '', cover: null };
  let pos = 0;
  let pkt = [];          // 跨页累积的当前包分片
  let pktLen = 0;
  let packetsSeen = 0;
  while (pos + 27 <= buf.length && packetsSeen < 8) {
    if (buf.toString('latin1', pos, pos + 4) !== 'OggS') break;
    const segCount = buf[pos + 26];
    const segTable = pos + 27;
    if (segTable + segCount > buf.length) break;
    let bodyPos = segTable + segCount;
    for (let s = 0; s < segCount && bodyPos <= buf.length; s++) {
      const lacing = buf[segTable + s];
      const chunk = buf.subarray(bodyPos, Math.min(bodyPos + lacing, buf.length));
      pkt.push(chunk); pktLen += chunk.length;
      bodyPos += lacing;
      if (lacing < 255) {
        // 一个完整包结束
        const full = pktLen ? Buffer.concat(pkt, pktLen) : Buffer.alloc(0);
        pkt = []; pktLen = 0;
        packetsSeen++;
        if (full.length > 8) {
          if (full[0] === 0x03 && full.toString('latin1', 1, 7) === 'vorbis') {
            parseVorbisComment(full.subarray(7), out);
            break;
          }
          if (full.toString('latin1', 0, 8) === 'OpusTags') {
            parseVorbisComment(full.subarray(8), out);
            break;
          }
        }
      }
    }
    pos = bodyPos;
    // 页头对齐：bodyPos 之后是下一页
    if (pos < bodyPos) break;
  }
  return (out.title || out.artist || out.album || out.cover) ? out : null;
}

// ---------- 文件级入口 ----------
async function readMeta(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const head = Buffer.alloc(4);
    const { bytesRead: n } = await fh.read(head, 0, 4, 0);
    if (n < 4) return null;
    if (head.toString('latin1', 0, 3) === 'ID3') {
      const h = Buffer.alloc(10);
      await fh.read(h, 0, 10, 0);
      const tagSize = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) |
        ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
      const total = Math.min(10 + tagSize, MAX_TAG);
      const buf = Buffer.alloc(total);
      await fh.read(buf, 0, total, 0);
      return parseID3(buf);
    }
    if (head.toString('latin1', 0, 4) === 'fLaC') {
      const stat = await fh.stat();
      const total = Math.min(2 * 1024 * 1024, stat.size);
      const buf = Buffer.alloc(total);
      await fh.read(buf, 0, total, 0);
      return parseFLAC(buf);
    }
    if (head.toString('latin1', 0, 4) === 'OggS') {
      // Ogg Vorbis / Opus / FLAC-in-Ogg：comment 头都在文件起始几页里
      const stat = await fh.stat();
      const total = Math.min(512 * 1024, stat.size);
      const buf = Buffer.alloc(total);
      await fh.read(buf, 0, total, 0);
      return parseOgg(buf);
    }
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (ext === '.mp4' || ext === '.m4a' || ext === '.aac') {
      const stat = await fh.stat();
      const fileSize = stat.size;
      const headSize = Math.min(8 * 1024 * 1024, fileSize);
      const buf = Buffer.alloc(headSize);
      await fh.read(buf, 0, headSize, 0);
      let result = parseMP4(buf);
      if (!result && fileSize > headSize) {
        const tailSize = Math.min(8 * 1024 * 1024, fileSize);
        const tailBuf = Buffer.alloc(tailSize);
        await fh.read(tailBuf, 0, tailSize, fileSize - tailSize);
        result = parseMP4(tailBuf);
      }
      return result;
    }
  } catch (e) {
    return null;
  } finally {
    if (fh) { try { await fh.close(); } catch (e) { /* noop */ } }
  }
  return null;
}

// 从文件名猜 "歌手 - 标题"
function guessFromName(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '');
  const m = base.match(/^(.+?)\s*[-－—]\s*(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: base.trim() };
}

// ---------- 递归扫描 ----------
function walkDir(dir, out, depth, recursive = true) {
  if (depth > 12 || out.length > 20000) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const p = require('path').join(dir, e.name);
    if (e.isDirectory()) {
      if (!recursive) continue; // 不递归时跳过子文件夹
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$RECYCLE.BIN') continue;
      walkDir(p, out, depth + 1, recursive);
    } else if (e.isFile() && isAudioFile(e.name)) {
      // 点开头的文件一律跳过：写标签时的临时文件/备份（.xxx.smxtag-* / .xxx.smxbak-*）都是这种命名，
      // 一旦被扫进曲库就会多出看不见名字的"幽灵歌曲"
      if (e.name.startsWith('.')) continue;
      if (/_tmp_\d+|_bak_|\.smxtag-|\.smxbak-/.test(e.name)) continue;
      out.push(p);
    }
  }
}

// paths: 文件或目录混合数组；返回曲目数组（异步分批处理，避免阻塞主进程）
async function scanPaths(paths, sendProgress, recursive = true) {
  const files = [];
  const seen = new Set();
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) {
      const buf = [];
      walkDir(p, buf, 0, recursive);
      for (const f of buf) {
        const k = f.toLowerCase();
        if (!seen.has(k)) { seen.add(k); files.push({ file: f, root: p }); }
      }
    } else if (st.isFile() && isAudioFile(p)) {
      const k = p.toLowerCase();
      if (!seen.has(k)) { seen.add(k); files.push({ file: p, root: require('path').dirname(p) }); }
    }
  }

  const tracks = [];
  const BATCH_SIZE = 20; // 每批处理20个文件
  
  // 异步分批处理，每批之间让出事件循环，避免阻塞主进程导致UI未响应
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const end = Math.min(i + BATCH_SIZE, files.length);
    for (let j = i; j < end; j++) {
      const { file, root } = files[j];
      const name = require('path').basename(file);
      const guess = guessFromName(name);
      const meta = (await readMeta(file)) || {};
      // 真实文件大小/修改时间：音乐库合并选优（信息完整度 > 更新 > 体积）的依据
      let fsize = 0, mtimeMs = 0;
      try {
        const st = fs.statSync(file);
        fsize = st.size;
        mtimeMs = st.mtimeMs;
      } catch (e) { /* 读不到按 0 处理 */ }
      tracks.push({
        path: file,
        root,
        name,
        title: meta.title || guess.title || name,
        artist: meta.artist || guess.artist || '未知歌手',
        album: meta.album || '未知专辑',
        cover: meta.cover || null,
        size: fsize,
        mtimeMs
      });
    }
    // 发送进度
    if (sendProgress) {
      sendProgress(Math.min(end, files.length), files.length);
    }
    // 让出事件循环，让IPC通信和UI响应有机会执行
    await new Promise(resolve => setImmediate(resolve));
  }
  
  return tracks;
}

module.exports = { scanPaths, isAudioFile, readMeta };

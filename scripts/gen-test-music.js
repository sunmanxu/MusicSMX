'use strict';
// 生成测试音频：正弦波 WAV + 带 ID3v2.3 标签的静音 MP3
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '.test-music');
fs.mkdirSync(dir, { recursive: true });

// ---------- WAV：2 秒 440Hz 正弦 ----------
(function genWav() {
  const sr = 44100, sec = 2, ch = 1, bits = 16;
  const n = sr * sec;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * (i / sr)) * 12000);
    data.writeInt16LE(v, i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(ch, 22); hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * ch * bits / 8, 28); hdr.writeUInt16LE(ch * bits / 8, 32);
  hdr.writeUInt16LE(bits, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(dir, '正弦波测试.wav'), Buffer.concat([hdr, data]));
  console.log('WAV ok');
})();

// ---------- MP3：ID3v2.3 标签 + MPEG 静音帧 ----------
(function genMp3() {
  function textFrame(id, text) {
    // v2.3: 4字节ID + 4字节大小 + 2字节flag + 数据（首字节编码 1=UTF-16）
    const content = Buffer.concat([Buffer.from([1]), Buffer.from(text, 'utf16le')]);
    const f = Buffer.alloc(10 + content.length);
    f.write(id, 0, 'ascii');
    f.writeUInt32BE(content.length, 4);
    content.copy(f, 10);
    return f;
  }
  const frames = Buffer.concat([
    textFrame('TIT2', '夜曲·测试'),
    textFrame('TPE1', '测试歌手'),
    textFrame('TALB', '测试专辑')
  ]);
  const tagSize = frames.length;
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = 3; header[4] = 0; header[5] = 0;
  header[6] = (tagSize >> 21) & 0x7f; header[7] = (tagSize >> 14) & 0x7f;
  header[8] = (tagSize >> 7) & 0x7f; header[9] = tagSize & 0x7f;

  // MPEG-1 Layer III 128kbps 44100Hz 帧：0xFF 0xFB 0x90 0x00，帧长 417+1（padding=0 时 417）
  const frameLen = 417;
  const frames_ = 38; // ~1秒
  const audioData = Buffer.alloc(frameLen * frames_);
  for (let i = 0; i < frames_; i++) {
    const o = i * frameLen;
    audioData[o] = 0xff; audioData[o + 1] = 0xfb; audioData[o + 2] = 0x90; audioData[o + 3] = 0x00;
    // 其余全 0（静音帧数据）
  }
  fs.writeFileSync(path.join(dir, '带标签的测试歌曲.mp3'), Buffer.concat([header, frames, audioData]));
  console.log('MP3 ok');
})();

console.log('测试音乐生成完毕: ' + dir);

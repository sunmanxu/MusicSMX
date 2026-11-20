// 验证歌词匹配：王力宏《你的爱》不应命中《谢绝推销你的爱》
'use strict';
const online = require('../src/online.js');

(async () => {
  const artist = '王力宏';
  const title = '你的爱';
  console.log('== searchLyrics 聚合 ==');
  const r = await online.searchLyrics(artist, title);
  if (!r) { console.log('未找到歌词'); }
  else {
    console.log('来源:', r.source, '| 匹配歌名:', JSON.stringify(r.songName), '| 匹配歌手:', JSON.stringify(r.artist));
    console.log('首行:', (r.lrc.split('\n').filter(l => l.trim())[2] || r.lrc.split('\n')[0] || '').slice(0, 60));
  }
  console.log('== 分来源 ==');
  for (const src of ['网易云音乐', 'QQ音乐', '酷狗音乐', '酷我音乐']) {
    try {
      const s = await online.searchLyricsFromSource(src, artist, title);
      if (!s) { console.log(src, ': 无结果'); continue; }
      console.log(src, '→ 匹配歌名:', JSON.stringify(s.songName), '| 匹配歌手:', JSON.stringify(s.artist));
    } catch (e) { console.log(src, '异常:', e.message); }
  }
})();

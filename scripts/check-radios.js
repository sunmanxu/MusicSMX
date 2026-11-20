'use strict';
// 电台探活：直接解析 src/renderer/app.js 里的 RADIO_STATIONS，并发测每个源能不能出流。
// 用法：npm run check:radios            只列失效的
//      npm run check:radios -- -v      连可用的也列出来
// 判据：HTTP 200 + 能读到有效字节；.m3u8 额外要求首包里有 #EXTM3U。
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const TIMEOUT_MS = 10000;
const CONCURRENCY = 10;

function loadStations() {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const head = 'const RADIO_STATIONS = [';
  const start = src.indexOf(head);
  if (start < 0) throw new Error('在 app.js 里没找到 RADIO_STATIONS 定义');
  const end = src.indexOf('];', start);
  // 数组元素是纯对象字面量（name/url/category/...），直接求值最省事
  return eval('[' + src.slice(start + head.length, end) + ']');
}

async function probe(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 MusicSMX/1.0', Accept: '*/*' }
    });
    if (!res.ok) { clearTimeout(timer); return { ok: false, info: 'HTTP ' + res.status }; }

    const ct = (res.headers.get('content-type') || '').split(';')[0];
    const reader = res.body.getReader();
    let got = 0, head = '';
    while (got < 400) {
      const { value, done } = await reader.read();
      if (done) break;
      got += value.length;
      if (head.length < 200) head += Buffer.from(value).toString('utf8');
    }
    try { reader.cancel(); } catch (e) { /* 已结束 */ }
    clearTimeout(timer);

    // 播放列表格式要看到 #EXTM3U 才算真能放
    if (/mpegurl|m3u/i.test(ct)) return { ok: /#EXTM3U/.test(head), info: ct + ' #EXTM3U' };
    return { ok: got > 300, info: ct + ' ' + got + 'B' };
  } catch (e) {
    clearTimeout(timer);
    const why = e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message;
    return { ok: false, info: why };
  }
}

(async () => {
  const verbose = process.argv.includes('-v');
  const stations = loadStations();
  console.log('共 %d 个电台，开始探活…\n', stations.length);

  const results = [];
  for (let i = 0; i < stations.length; i += CONCURRENCY) {
    const batch = stations.slice(i, i + CONCURRENCY);
    const probed = await Promise.all(batch.map(s => probe(s.url)));
    batch.forEach((s, k) => results.push({ name: s.name, cat: s.category, url: s.url, ...probed[k] }));
    process.stdout.write('.');
  }
  process.stdout.write('\n\n');

  const dead = results.filter(r => !r.ok);
  const alive = results.filter(r => r.ok);

  if (verbose) {
    alive.forEach(r => console.log('OK   ' + r.name + '  [' + r.info + ']'));
    if (dead.length) console.log('');
  }
  dead.forEach(r => console.log('DEAD ' + r.name + '  [' + r.info + ']  ' + r.url));

  const byCat = {};
  results.forEach(r => { const k = r.cat || '其它'; byCat[k] = byCat[k] || [0, 0]; byCat[k][r.ok ? 0 : 1]++; });
  console.log('\n分类可用率：');
  Object.entries(byCat).forEach(([k, v]) => console.log('  ' + k + '  ' + v[0] + '/' + (v[0] + v[1])));

  console.log('\n总计 %d，可用 %d，失效 %d', results.length, alive.length, dead.length);
  process.exit(dead.length ? 1 : 0);
})();

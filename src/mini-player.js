'use strict';

const $ = (id) => document.getElementById(id);
const coverEl = $('cover');
const featTextEl = $('feat-text');
const favEl = $('fav');
const modeEl = $('mode');
const volumeEl = $('volume');
const muteBtn = $('vol-mute');
const icVolOn = $('vol-on');
const icVolOff = $('vol-off');
const icPlay = $('ic-play');
const icPause = $('ic-pause');

// 收藏红心：实心（已收藏，参考图里的红心）/ 空心（未收藏）
const HEART_FILLED = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
const HEART_OUTLINE = '<svg viewBox="0 0 24 24" fill="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// 与主界面 MODE_ICONS 保持一致：列表循环 → 单曲循环 → 随机播放
const MODE_ICONS = {
  list: {
    title: '播放模式：列表循环',
    svg: '<svg viewBox="0 0 24 24" fill="none"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  },
  one: {
    title: '播放模式：单曲循环',
    svg: '<svg viewBox="0 0 24 24" fill="none"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="9" y="15.5" font-size="9" fill="currentColor" font-family="sans-serif" font-weight="700">1</text></svg>'
  },
  shuffle: {
    title: '播放模式：随机播放',
    svg: '<svg viewBox="0 0 24 24" fill="none">'
      + '<path d="M3 6.6h3.6c1.5 0 2.9.8 3.7 2l4.1 6.9c.8 1.2 2.2 2 3.7 2h1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M3 17.5h3.6c1.5 0 2.9-.8 3.7-2l4.1-6.9c.8-1.2 2.2-2 3.7-2h1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M17.6 4.1 20.1 6.6 17.6 9.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M17.6 15 20.1 17.5 17.6 20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>'
  }
};
let lastMode = '';
let lastFav = null;

// 主题变量：主界面 applyAccent / applyBgTheme 时会推过来，小窗颜色实时跟随
function applyTheme(t) {
  if (!t || typeof t !== 'object') return;
  const root = document.documentElement.style;
  const set = (name, val) => { if (val) root.setProperty(name, String(val)); };
  set('--accent', t.accent);
  // 海报底色：主界面推来 posterBg/posterElev 时小窗底色跟着海报主色走（压暗过，文字仍可读）
  set('--bg', t.posterBg || t.bg);
  set('--bg-elev', t.posterElev || t.bgElev);
  set('--text', t.text);
  set('--text-dim', t.textDim);
  set('--text-faint', t.textFaint);
  set('--border', t.border);
  set('--hover', t.hover);
}
if (window.mini && typeof window.mini.onTheme === 'function') {
  window.mini.onTheme(applyTheme);
}

function render(state) {
  const s = state || {};
  // 功能行中间文字 = 歌名（悬停 tooltip 给全名）
  featTextEl.textContent = s.title || '未在播放';
  featTextEl.title = s.title ? (s.title + (s.artist ? ' - ' + s.artist : '')) : '';

  // 收藏红心：实心红 / 空心灰
  const faved = !!s.fav;
  if (faved !== lastFav) {
    favEl.innerHTML = faved ? HEART_FILLED : HEART_OUTLINE;
    favEl.title = faved ? '取消收藏' : '收藏';
    favEl.classList.toggle('faved', faved);   // .faved 才有红色，别只换图标
    lastFav = faved;
  }

  // 播放/暂停图标切换
  // 注意：ic-play/ic-pause 是 SVG 元素，SVGElement 没有 .hidden IDL 属性（那是 HTMLElement 的），
  // 用 .hidden= 只会写 JS expando、DOM 属性纹丝不动 —— 图标永远停在播放键。
  // 必须用 toggleAttribute 真正增删 hidden 属性（Element 级，SVG 也生效）。
  const playing = !!s.playing;
  icPlay.toggleAttribute('hidden', playing);
  icPause.toggleAttribute('hidden', !playing);
  $('play').title = playing ? '暂停' : '播放';

  // 播放模式：三态循环，图标与 title 跟随主界面
  const mode = MODE_ICONS[s.mode] ? s.mode : 'list';
  if (mode !== lastMode) {
    modeEl.innerHTML = MODE_ICONS[mode].svg;
    modeEl.title = MODE_ICONS[mode].title;
    lastMode = mode;
  }
  modeEl.classList.toggle('active', mode !== 'list');

  // 歌词开关（桌面/任务栏歌词）：激活=主题色，title 跟随
  if (typeof s.lyric === 'boolean') {
    const lyrBtn = $('lyric-toggle');
    if (lyrBtn) {
      lyrBtn.classList.toggle('active', s.lyric);
      lyrBtn.title = s.lyric ? '关闭歌词' : '开启歌词';
    }
  }

  // 静音：喇叭图标切换 + 滑轨归零；取消静音后滑轨回到真实音量
  const muted = !!s.muted;
  muteBtn.classList.toggle('muted', muted);
  muteBtn.title = muted ? '取消静音' : '静音';
  icVolOn.toggleAttribute('hidden', muted);   // SVG 同样不能用 .hidden=，见上
  icVolOff.toggleAttribute('hidden', !muted);
  $('vol-wave').style.display = (muted || volumeEl.value === '0') ? 'none' : '';

  // 音量：静音时滑轨归零；主界面拖动时也会同步到这里
  const raw = typeof s.volume === 'number' ? s.volume : 0.05;
  const vol = muted ? 0 : Math.max(0, Math.min(1, raw));
  const percent = String(Math.round(vol * 100));
  if (volumeEl.value !== percent) volumeEl.value = percent;

  // 封面
  if (s.cover && /^data:image/.test(s.cover)) {
    let img = coverEl.querySelector('img');
    if (!img) {
      coverEl.textContent = '';
      img = document.createElement('img');
      coverEl.appendChild(img);
    }
    if (img.src !== s.cover) img.src = s.cover;
  } else {
    // 只留一个占位音符：别先塞 textContent 再 append span，否则会显示成两个音符
    coverEl.textContent = '';
    coverEl.className = 'cover';
    const ph = document.createElement('span');
    ph.className = 'ph';
    ph.textContent = '♪';
    coverEl.appendChild(ph);
  }
}

coverEl.addEventListener('click', () => window.mini && window.mini.showMain());
$('quit').addEventListener('click', () => window.mini && window.mini.quit());
$('prev').addEventListener('click', () => window.mini && window.mini.control('prev'));
$('play').addEventListener('click', () => window.mini && window.mini.control('toggle-play'));
$('next').addEventListener('click', () => window.mini && window.mini.control('next'));
modeEl.addEventListener('click', () => window.mini && window.mini.control('cycle-mode'));
// 歌词开关：转发 toggle-lyric → 主界面开/关桌面（或任务栏）歌词
$('lyric-toggle').addEventListener('click', () => window.mini && window.mini.control('toggle-lyric'));
// 收藏红心：切换当前曲收藏状态（主进程转发 tray-control toggle-fav → 主界面 toggleFavorite）
favEl.addEventListener('click', () => window.mini && window.mini.control('toggle-fav'));
// 喇叭按钮：单击静音 / 取消静音（渲染进程 toggle-mute → applyVolume → 状态回报回来刷新图标）
muteBtn.addEventListener('click', () => window.mini && window.mini.control('toggle-mute'));
volumeEl.addEventListener('input', () => {
  const v = Math.max(0, Math.min(1, Number(volumeEl.value) / 100));
  if (window.mini) window.mini.control('volume', v);
});

if (window.mini && typeof window.mini.onState === 'function') {
  window.mini.onState(render);
}

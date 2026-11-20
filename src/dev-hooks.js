'use strict';
// ============================================================================
// 开发期自动化钩子（消费级启动完全不触发，只有设置环境变量才生效）
// 从 main.js 抽出来的原因：这三个块合计 560 行纯测试代码，会把主进程业务淹掉。
// 接手后想看效果 / 验行为，直接跑它们，别靠脑补：
//   PLAYER_SHOT=<dir>    进播放页 → 抓 7 张截图 + diag.json → 退出
//   PLAYER_PROBE=<file>  跑一堆 DOM 断言（播放/歌词/电台/歌单/换肤）→ 写 json → 退出
//   PLAYER_SMOKE=1       冒烟：双击播放后把状态打到 stdout → 退出
// 用法见项目根《交接说明.md》第四节。
// ============================================================================
const fs = require('fs');
const path = require('path');

/**
 * 给窗口挂上开发钩子。三个都只在对应环境变量存在时才注册监听。
 * @param {import('electron').BrowserWindow} win
 * @param {import('electron').App} app
 */
function attach(win, app) {




  // 开发期截图：PLAYER_SHOT=<输出目录> 时自动进播放页，抓「正常态 / 沉浸态 / 真全屏」三张图后退出。
  // 只在设置环境变量时生效，打包后的正常启动完全不受影响。
  if (process.env.PLAYER_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const outDir = process.env.PLAYER_SHOT;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const shot = async (name) => {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, name), img.toPNG());
        };
        let diag = {};
        try {
          fs.mkdirSync(outDir, { recursive: true });
          win.unmaximize();
          win.setContentSize(1440, 900);
          await sleep(600);
          // 播第一首（列表已改成双击播放，这里必须派发 dblclick）
          await win.webContents.executeJavaScript(`(() => {
            const row = document.querySelector('.track-row');
            if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const a = document.getElementById('audio');
            if (a && a.paused) a.play().catch(() => {});
            return !!row;
          })()`);
          await sleep(1800);
          await win.webContents.executeJavaScript(`document.getElementById('cover').click()`);
          await sleep(1500);
          diag.sizeNormal = await win.webContents.executeJavaScript(`[innerWidth, innerHeight, devicePixelRatio]`);
          diag.align = await win.webContents.executeJavaScript(`(() => {
            const box = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), cy: Math.round(b.y + b.height / 2) }; };
            return { coverCol: box('.pf-cover-col'), lyrics: box('.pf-lyrics'), active: box('.pf-lyric-line.active, .pf-lyric-row.active'), wrap: box('.pf-lyrics-wrap') };
          })()`);
          await shot('01-pf-normal.png');
          // 局部放大图：歌词模式按钮 + 封面下方信息（判断截断/错位）
          const rects = await win.webContents.executeJavaScript(`(() => {
            const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
            return { toolbar: r('.pf-lyrics-toolbar'), meta: r('.pf-meta'), fs: r('#pf-fs') };
          })()`);
          for (const [name, rc] of Object.entries(rects)) {
            if (!rc || rc.w < 2 || rc.h < 2) continue;
            const pad = 8;
            const box = {
              x: Math.max(0, Math.round(rc.x - pad)),
              y: Math.max(0, Math.round(rc.y - pad)),
              width: Math.round(rc.w + pad * 2),
              height: Math.round(rc.h + pad * 2)
            };
            const part = await win.webContents.capturePage(box);
            const zoom = Math.min(4, Math.max(1, Math.round(900 / Math.max(1, box.width))));
            fs.writeFileSync(path.join(outDir, 'zoom-' + name + '.png'), part.resize({ width: box.width * zoom }).toPNG());
          }
          diag.probe = await win.webContents.executeJavaScript(`(() => {
            const al = document.getElementById('pf-album');
            const ar = document.getElementById('pf-artist');
            const btn = document.querySelector('.pf-lyrics-mode:not(.active)');
            const cs = btn ? getComputedStyle(btn) : null;
            return {
              albumText: al.textContent, albumW: al.clientWidth, albumScroll: al.scrollWidth,
              artistText: ar.textContent, artistW: ar.clientWidth, artistScroll: ar.scrollWidth,
              metaW: document.querySelector('.pf-meta').clientWidth,
              modeBtn: cs ? { w: btn.clientWidth, h: btn.clientHeight, fs: cs.fontSize, lh: cs.lineHeight, color: cs.color, bg: cs.backgroundColor, pad: cs.padding, display: cs.display } : null
            };
          })()`);
          // 静止 3.2 秒后进入沉浸态
          await sleep(4000);
          await shot('02-pf-idle.png');
          diag.idle = await win.webContents.executeJavaScript(`document.getElementById('player-full').classList.contains('idle')`);
          // 鼠标一动应该立刻唤醒
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 420 });
          await sleep(400);
          diag.wakeByMouse = await win.webContents.executeJavaScript(`!document.getElementById('player-full').classList.contains('idle') && !document.body.classList.contains('pf-idle')`);
          // 用界面上的全屏按钮走一遍 IPC（不是直接调 setFullScreen）
          await win.webContents.executeJavaScript(`document.getElementById('pf-fs').click()`);
          await sleep(1200);
          diag.fsViaButton = win.isFullScreen();
          diag.fsBtnActive = await win.webContents.executeJavaScript(`document.getElementById('pf-fs').classList.contains('active') && document.body.classList.contains('is-fullscreen')`);
          await sleep(800);
          await shot('03-pf-fullscreen.png');
          // Esc：只退全屏，播放页还在
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          await sleep(900);
          diag.afterEsc = { fullscreen: win.isFullScreen(), pfOpen: await win.webContents.executeJavaScript(`!document.getElementById('player-full').hidden`) };
          // 最大化（用户实际使用最可能就是 2560 宽最大化）
          win.maximize();
          await sleep(1200);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 400 });
          await sleep(500);
          await shot('04-pf-max.png');
          diag.sizeMax = await win.webContents.executeJavaScript(`[innerWidth, innerHeight]`);
          diag.geomMax = await win.webContents.executeJavaScript(`(() => {
            const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
            return { cover: r('.pf-cover-ring'), meta: r('.pf-meta'), lyrics: r('.pf-lyrics-wrap'), bottom: r('.pf-bottom'),
                     line: r('.pf-lyric-line'), ctl: r('#pf-play') };
          })()`);
          // 真全屏（先不打扰鼠标，确认全屏下也会自动进入沉浸态）
          win.setFullScreen(true);
          await sleep(1800);
          await shot('05-pf-fullscreen.png');
          diag.fullscreen = win.isFullScreen();
          diag.fsIdle = await win.webContents.executeJavaScript(`document.getElementById('player-full').classList.contains('idle')`);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 420, y: 320 });
          await sleep(600);
          await shot('06-pf-fullscreen-awake.png');
          diag.geom = await win.webContents.executeJavaScript(`(() => {
            const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
            return { cover: r('.pf-cover-ring'), meta: r('.pf-meta'), title: r('#pf-title'), album: r('#pf-album'),
                     lyrics: r('.pf-lyrics-wrap'), bottom: r('.pf-bottom'), fs: r('#pf-fs'),
                     win: [innerWidth, innerHeight], errs: (window.__errs || []).slice(0, 5) };
          })()`);
        } catch (e) {
          diag.error = String(e && e.stack || e);
        }
        // 最小窗口 780×520 兜底检查（控件不能挤在一起、封面不能消失）
        try {
          win.setFullScreen(false);
          await sleep(800);
          win.unmaximize();
          win.setContentSize(780, 520);
          await sleep(900);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 300, y: 300 });
          await sleep(400);
          await shot('07-pf-780.png');
          diag.geom780 = await win.webContents.executeJavaScript(`(() => {
            const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
            return { cover: r('.pf-cover-ring'), meta: r('.pf-meta'), lyrics: r('.pf-lyrics-wrap'), bottom: r('.pf-bottom'),
                     vol: r('.pf-vol-wrap'), play: r('#pf-play'), fs: r('#pf-fs'), win: [innerWidth, innerHeight] };
          })()`);
        } catch (e) {
          diag.error780 = String(e && e.stack || e);
        }
        fs.writeFileSync(path.join(outDir, 'diag.json'), JSON.stringify(diag, null, 2), 'utf8');
        app.exit(0);
      }, 4000);
    });
  }

  // 开发期交互自检：PLAYER_PROBE=<json 输出路径>，跑完一系列 DOM 断言后退出。
  // 只用环境变量控制，打包后正常运行完全不受影响。
  if (process.env.PLAYER_PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const outFile = process.env.PLAYER_PROBE;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const js = (code) => win.webContents.executeJavaScript(code);
        const diag = {};
        try {
          win.unmaximize();
          win.setContentSize(1440, 900);
          await sleep(900);

          // 1) 单击只选中，不播放
          diag.singleClick = await js(`(() => {
            const rows = document.querySelectorAll('.track-row');
            const row = rows[1] || rows[0];
            row.click();
            return {
              selected: row.classList.contains('selected'),
              currentRows: document.querySelectorAll('.track-row.current').length,
              paused: document.getElementById('audio').paused
            };
          })()`);
          await sleep(300);

          // 2) 双击才播放
          await js(`(() => {
            const rows = document.querySelectorAll('.track-row');
            const row = rows[1] || rows[0];
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            return true;
          })()`);
          await sleep(1500);
          diag.doubleClick = await js(`({
            currentRows: document.querySelectorAll('.track-row.current').length,
            paused: document.getElementById('audio').paused,
            playing: !document.getElementById('audio').paused,
            playbackState: navigator.mediaSession ? navigator.mediaSession.playbackState : null,
            title: document.getElementById('now-title').textContent
          })`);

          // 3) 暂停：音量应该渐降而不是瞬间静音，且 playbackState 同步成 paused
          diag.fadeOut = await js(`(async () => {
            const a = document.getElementById('audio');
            const before = a.volume;
            const t0 = performance.now();
            document.getElementById('btn-play').click();
            const samples = [];
            for (const at of [0, 70, 140, 230, 380]) {
              const wait = at - (performance.now() - t0);
              if (wait > 0) await new Promise(r => setTimeout(r, wait));
              samples.push({ at, vol: +a.volume.toFixed(3), paused: a.paused });
            }
            return { before: +before.toFixed(3), samples,
                     paused: a.paused, playbackState: navigator.mediaSession.playbackState };
          })()`);
          await sleep(300);

          // 4) 恢复播放：从 0 拉起，且状态回到 playing（这就是媒体键按不回来的根因）
          diag.fadeIn = await js(`(async () => {
            const a = document.getElementById('audio');
            const t0 = performance.now();
            document.getElementById('btn-play').click();
            const samples = [];
            for (const at of [0, 90, 200, 400]) {
              const wait = at - (performance.now() - t0);
              if (wait > 0) await new Promise(r => setTimeout(r, wait));
              samples.push({ at, vol: +a.volume.toFixed(3), paused: a.paused });
            }
            return { samples, paused: a.paused, playbackState: navigator.mediaSession.playbackState };
          })()`);

          // 5) 右键菜单项
          diag.menuItems = await js(`Array.from(document.querySelectorAll('#context-menu .ctx-item')).map(e => (e.dataset.action || '?') + ' | ' + e.textContent.trim())`);

          // 6) 主题：底色 + 强调色都要真的落到 CSS 变量上
          diag.theme = await js(`(() => {
            const root = document.documentElement;
            const read = () => ({
              bg: getComputedStyle(document.body).backgroundColor,
              accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
              elev: getComputedStyle(root).getPropertyValue('--bg-elev').trim()
            });
            const before = read();
            document.querySelectorAll('#bg-swatches .accent-swatch')[2].click();
            document.querySelectorAll('#accent-swatches .accent-swatch')[1].click();
            const afterPreset = read();
            const bgInp = document.getElementById('bg-custom');
            bgInp.value = '#24252b';
            bgInp.dispatchEvent(new Event('input', { bubbles: true }));
            const afterCustom = read();
            const bgActive = document.querySelectorAll('#bg-swatches .accent-swatch.active').length;
            const customActive = document.getElementById('bg-custom-wrap').classList.contains('active');
            return { before, afterPreset, afterCustom, bgActive, customActive };
          })()`);
          // 换色后截图：自定义灰 + 蓝 / 预设墨蓝 / 浅色底（检查文字反转）
          const shotTheme = async (name) => {
            await sleep(700);
            try {
              const img = await win.webContents.capturePage();
              fs.writeFileSync(path.join(path.dirname(outFile), name), img.toPNG());
            } catch (e) { diag.shotError = String(e); }
          };
          await shotTheme('probe-theme-custom.png');
          await js(`document.querySelectorAll('#bg-swatches .accent-swatch')[2].click()`);
          await shotTheme('probe-theme-navy.png');
          await js(`(() => {
            const i = document.getElementById('bg-custom');
            i.value = '#e9eaee';
            i.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()`);
          diag.lightTheme = await js(`({
            bg: getComputedStyle(document.body).backgroundColor,
            text: getComputedStyle(document.body).color,
            isLight: document.body.classList.contains('theme-light')
          })`);
          await shotTheme('probe-theme-light.png');
          // 复位成默认深海，避免污染后续截图
          await js(`document.querySelectorAll('#bg-swatches .accent-swatch')[0].click()`);

          // 7) 歌词偏移按钮
          diag.lyricOffset = await js(`(() => {
            const btns = document.querySelectorAll('.lyric-offset .lo-btn');
            const vals = () => Array.from(document.querySelectorAll('[data-lo-val]')).map(e => e.textContent);
            const start = vals();
            const plus = document.querySelector('.lyric-offset .lo-btn[data-lo="1"]');
            const minus = document.querySelector('.lyric-offset .lo-btn[data-lo="-1"]');
            for (let i = 0; i < 3; i++) plus.click();
            const afterPlus = vals();
            minus.click();
            const afterMinus = vals();
            // 点击数值归零
            document.querySelector('[data-lo-val]').click();
            const afterReset = vals();
            return { start, afterPlus, afterMinus, afterReset, count: btns.length,
                     activeClass: document.querySelector('[data-lo-val]').classList.contains('active') };
          })()`);

          // 8) 全屏歌词：工具栏位置 / 空翻译不改变行距 / 无逐字数据时的等比补全
          await js(`(() => { if (!pf.open) openPlayerFull(); return true; })()`);
          await sleep(900);
          diag.lyricNoTrans = await js(`(() => {
            const mk = (withTrans) => Array.from({length: 18}, (_, i) => ({
              time: i * 2, text: '测试歌词第' + (i + 1) + '句',
              ttext: withTrans ? 'trans line ' + i : '', rtext: ''
            }));
            const spacing = () => getComputedStyle(document.documentElement).getPropertyValue('--lyric-spacing').trim();
            const cols = () => document.querySelectorAll('.pf-lyric-head').length;
            pf.lyricModes = ['orig'];
            renderPFLyrics(mk(false));
            const s0 = spacing(), c0 = cols();
            document.querySelector('.pf-lyrics-mode[data-mode="trans"]').click();
            const s1 = spacing(), c1 = cols(), m1 = pf.lyricModes.slice();
            pf.lyricModes = ['orig'];
            renderPFLyrics(mk(true));
            const s2 = spacing(), c2 = cols();
            document.querySelector('.pf-lyrics-mode[data-mode="trans"]').click();
            const s3 = spacing(), c3 = cols(), m3 = pf.lyricModes.slice();
            return { noTrans: { spacing: [s0, s1], cols: [c0, c1], modes: m1 },
                     withTrans: { spacing: [s2, s3], cols: [c2, c3], modes: m3 } };
          })()`);

          diag.lyricLayout = await js(`(() => {
            const tb = document.querySelector('.pf-lyrics-toolbar').getBoundingClientRect();
            const wrap = document.querySelector('.pf-lyrics-wrap').getBoundingClientRect();
            const first = document.querySelector('.pf-lyric-line');
            const fr = first ? first.getBoundingClientRect() : null;
            const off = document.querySelector('.pf-spacing-panel .lyric-offset.vertical');
            const or = off ? off.getBoundingClientRect() : null;
            const modes = document.querySelectorAll('.pf-lyrics-mode').length;
            const btn = document.querySelector('.pf-lyrics-mode[data-mode="trans"]');
            const bs = btn ? getComputedStyle(btn) : null;
            return {
              toolbarBottom: Math.round(tb.bottom), wrapTop: Math.round(wrap.top),
              overlap: tb.bottom > wrap.top + 1,
              firstLineTop: fr ? Math.round(fr.top) : null,
              modeButtons: modes,
              btnBox: btn ? { h: Math.round(btn.getBoundingClientRect().height), scroll: btn.scrollHeight,
                              font: bs.fontSize, line: bs.lineHeight, clipped: btn.scrollHeight > btn.clientHeight + 1 } : null,
              offsetVertical: off ? getComputedStyle(off).flexDirection : null,
              offsetRightGap: or ? Math.round(innerWidth - or.right) : null
            };
          })()`);

          // 逐字开关默认关：先看默认态，再打开，后面几项逐字断言才有数据
          diag.wordToggleDefault = await js(`(() => ({
            setting: S.settings.wordLyrics,
            btnOn: document.getElementById('pf-word-toggle').classList.contains('on'),
            wordSpans: document.querySelectorAll('.pf-word').length
          }))()`);
          await js(`(() => { if (!wordLyricsOn()) document.getElementById('pf-word-toggle').click(); return true; })()`);
          await sleep(400);

          diag.wordSynth = await js(`(() => {
            const parsed = parseLyrics({ lrc: '[00:01.00]第一句歌词\\n[00:05.50]第二句歌词更长一点\\n[00:09.00]第三句', tlyric: '', rlyric: '', yrc: '' });
            const l0 = parsed[0];
            renderPFLyrics(parsed);
            const words = l0.words || [];
            return {
              lines: parsed.length,
              wordsOnLine0: words.length,
              joinOk: words.map(w => w.w).join('') === '第一句歌词',
              synthetic: !!words[0].synth,
              tRange: [words[0].t, words[words.length - 1].t],
              nextLine: parsed[1].time,
              domWordSpans: document.querySelectorAll('.pf-word').length
            };
          })()`);

          // 局部 3 倍放大截图（用 nativeImage 自己放大，不依赖 setZoomFactor）
          const shotCrop = async (name, sel, pad) => {
            try {
              const r = await js(`(() => {
                const el = document.querySelector('${sel}');
                if (!el) return null;
                const b = el.getBoundingClientRect();
                return [b.x, b.y, b.width, b.height];
              })()`);
              if (!r) return;
              const p = pad || 6;
              const rect = {
                x: Math.max(0, Math.round(r[0] - p)),
                y: Math.max(0, Math.round(r[1] - p)),
                width: Math.round(r[2] + p * 2),
                height: Math.round(r[3] + p * 2)
              };
              const img = await win.webContents.capturePage(rect);
              const big = img.resize({ width: rect.width * 3, quality: 'best' });
              fs.writeFileSync(path.join(path.dirname(outFile), name), big.toPNG());
            } catch (e) { diag['crop_' + name] = String(e); }
          };

          // 9) 没有真实逐字数据的歌也必须能扫光：把进度挪到第一行中间，读每个字的 --p
          diag.wordFill = await js(`(async () => {
            const a = document.getElementById('audio');
            a.currentTime = 1.9;
            await new Promise(r => setTimeout(r, 500));
            const box = document.querySelector('.pf-lyric-line.active .pf-lyric-text.has-words');
            const ps = box ? Array.from(box.children).map(c => c.style.getPropertyValue('--p') || '0') : [];
            return { activeIdx: pf.activeIdx, hasBox: !!box,
                     text: box ? box.textContent : null, ps };
          })()`);
          await shotCrop('zoom-fill.png', '.pf-lyric-line.active', 10);

          // 让工具栏显示出来再截图（默认是 hover 才现形）
          await js(`document.querySelector('.pf-lyrics-wrap').classList.add('show-tools')`);
          await sleep(500);
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(path.dirname(outFile), 'probe-lyrics.png'), img.toPNG());
          } catch (e) { diag.shotError2 = String(e); }
          // 局部 3 倍放大：右侧竖向轨道 + 歌词上方的模式按钮
          await shotCrop('zoom-rail.png', '.pf-spacing-panel', 8);
          await shotCrop('zoom-tools.png', '.pf-lyrics-toolbar', 8);
          await js(`document.querySelector('.pf-lyrics-wrap').classList.remove('show-tools')`);

          // 小窗口回落排版：工具栏应该回到文档流里，也不能压住歌词
          win.setContentSize(780, 520);
          await sleep(800);
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(path.dirname(outFile), 'probe-lyrics-780.png'), img.toPNG());
          } catch (e) { diag.shotError3 = String(e); }
          diag.lyricSmall = await js(`(() => {
            const tb = document.querySelector('.pf-lyrics-toolbar').getBoundingClientRect();
            const first = document.querySelector('.pf-lyric-line');
            const fr = first ? first.getBoundingClientRect() : null;
            return { toolbarBottom: Math.round(tb.bottom), firstLineTop: fr ? Math.round(fr.top) : null,
                     overlap: fr ? tb.bottom > fr.top + 1 : null,
                     toolbarVisible: getComputedStyle(document.querySelector('.pf-lyrics-toolbar')).visibility };
          })()`);
          win.setContentSize(1440, 900);
          await sleep(500);

          // ===== 本轮新增断言 =====
          // A) 逐字 / 整行 一键切换
          diag.wordToggle = await js(`(() => {
            const btn = document.getElementById('pf-word-toggle');
            const read = () => ({
              on: btn.classList.contains('on'),
              setting: S.settings.wordLyrics,
              wordSpans: document.querySelectorAll('.pf-word').length,
              hasWordsBox: document.querySelectorAll('.pf-lyric-text.has-words').length
            });
            const before = read();
            btn.click();                    // 关 → 整行
            const off = read();
            btn.click();                    // 再开
            const on = read();
            return { before, off, on };
          })()`);

          // B) 每首歌各自记忆歌词偏移：换歌回 0，切回来还是 +0.2s
          diag.offsetPerTrack = await js(`(async () => {
            const vals = () => Array.from(document.querySelectorAll('#player-full [data-lo-val]')).map(e => e.textContent);
            const plus = () => document.querySelector('#player-full .lyric-offset .lo-btn[data-lo="1"]');
            const before = Object.keys(S.settings.lyricOffsets || {}).length;
            playAt(0);
            await new Promise(r => setTimeout(r, 200));
            const t0 = vals();
            plus().click(); plus().click();
            const t1 = vals();
            playAt(1);
            await new Promise(r => setTimeout(r, 200));
            const t2 = vals();
            playAt(0);
            await new Promise(r => setTimeout(r, 200));
            const t3 = vals();
            document.querySelector('#player-full [data-lo-val]').click();   // 归零
            const t4 = vals();
            return { before, t0, t1, t2, t3, t4, after: Object.keys(S.settings.lyricOffsets || {}).length,
                     savedMap: S.settings.lyricOffsets };
          })()`);

          // C) 电台清单：数量、去重、分类、旧失灵源是否清干净
          diag.radio = await js(`(() => {
            const names = RADIO_STATIONS.map(s => s.name);
            const cats = {};
            RADIO_STATIONS.forEach(s => { const k = s.category + '/' + s.subcat; cats[k] = (cats[k] || 0) + 1; });
            const deadUrl = RADIO_STATIONS.filter(s => /radiocaprice|ppm-jazz24|bluegrasscountry|wostreaming\\.net\\/direct\\/ppm/i.test(s.url));
            return {
              total: RADIO_STATIONS.length,
              uniqueNames: new Set(names).size,
              cats,
              deadLeft: deadUrl.map(s => s.name + ' ' + s.url),
              httpCount: RADIO_STATIONS.filter(s => s.url.startsWith('http://')).length,
              m3u8Count: RADIO_STATIONS.filter(s => /\\.m3u8/.test(s.url)).length
            };
          })()`);

          // D) 歌单：没有 × 按钮 / 子歌单缩进 / 右键菜单项齐不齐
          diag.playlistUi = await js(`(() => {
            const before = S.playlists.length;
            const pid = createPlaylist('探针父歌单');
            const cid = createPlaylist('探针子歌单', pid);
            const items = Array.from(document.querySelectorAll('#playlist-list .playlist-item'));
            const parentLi = items.find(li => li.dataset.playlistId === pid);
            const childLi = items.find(li => li.dataset.playlistId === cid);
            const xButtons = document.querySelectorAll('#playlist-list .fdel').length;
            parentLi.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 220, clientY: 220 }));
            const menu = document.querySelector('.playlist-menu');
            const menuItems = menu ? Array.from(menu.querySelectorAll('.ctx-item')).map(e => e.textContent.trim()) : [];
            if (menu) menu.remove();
            const childIndent = childLi ? getComputedStyle(childLi).paddingLeft : null;
            const parentIndent = parentLi ? getComputedStyle(parentLi).paddingLeft : null;
            deletePlaylist(pid);            // 应连带子歌单
            const afterDelete = S.playlists.length;
            return { before, xButtons, childClass: childLi ? childLi.className : null,
                     childIndent, parentIndent, menuItems, afterDelete,
                     hasAddBtn: !!document.getElementById('add-playlist-btn') };
          })()`);

          // E) 单曲循环 / 随机播放不用主题色（按钮有 color 过渡，必须等过渡结束再读）
          await js(`(() => { cycleMode(); return true; })()`);   // list -> one
          await sleep(320);
          diag.modeColor = await js(`(() => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--accent)';
            document.body.appendChild(probe);
            const accentRgb = getComputedStyle(probe).color;
            probe.remove();
            const btn = document.getElementById('btn-mode');
            const pfBtn = document.getElementById('pf-mode');
            const cs = getComputedStyle(btn);
            const pcs = getComputedStyle(pfBtn);
            const res = {
              modeOn: btn.classList.contains('mode-on'),
              color: cs.color, bg: cs.backgroundColor,
              pfColor: pcs.color, pfBg: pcs.backgroundColor,
              accentRgb, usesAccent: cs.color === accentRgb || pcs.color === accentRgb
            };
            return res;
          })()`);
          await js(`(() => { cycleMode(); cycleMode(); return true; })()`);   // 回到 list

          diag.errs = await js(`(window.__errs || []).slice(0, 10)`);
        } catch (e) {
          diag.error = String(e && e.stack || e);
        }
        try { fs.writeFileSync(outFile, JSON.stringify(diag, null, 2), 'utf8'); } catch (e) {}
        app.exit(0);
      }, 4500);
    });
  }



  // 无人值守自检：PLAYER_SMOKE=1 时模拟点击播放，采样渲染层状态后退出
  if (process.env.PLAYER_SMOKE === '1') {
    setTimeout(async () => {
      let base = null, played = null;
      try {
        base = await win.webContents.executeJavaScript(`(async () => {
          const errs = (window.__errs || []).slice(0, 20);
          const rows = document.querySelectorAll('.track-row').length;
          const folders = document.querySelectorAll('.folder-item').length;
          // 双击第一行触发播放（列表已改为双击播放）
          const row = document.querySelector('.track-row');
          if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return { ok: errs.length === 0, errs, rows, folders,
                   api: typeof window.mb === 'object',
                   tracks: (window.__tracks || []).map(t => [t.title, t.artist, t.album]) };
        })()`);
      } catch (e) {
        base = { ok: false, errs: [String(e)] };
      }
      setTimeout(async () => {
        try {
          played = await win.webContents.executeJavaScript(`(() => {
            const a = document.getElementById('audio');
            return { paused: a.paused, t: a.currentTime, dur: a.duration,
                     title: document.getElementById('now-title').textContent,
                     artist: document.getElementById('now-artist').textContent };
          })()`);
        } catch (e) {
          played = { err: String(e) };
        }
        console.log('[SMOKE_RESULT] ' + JSON.stringify({ base, played }));
        app.quit();
      }, 3500);
    }, 5000);
  }


}

module.exports = { attach };

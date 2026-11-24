'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, screen, globalShortcut, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const devHooks = require('./dev-hooks');
const { scanPaths, isAudioFile, readMeta } = require('./metadata');
const online = require('./online');

// Windows 任务栏/窗口图标：必须显式传给 BrowserWindow，否则回落到 electron.exe 自带的
// Electron 原子图标（用户反馈「任务栏图标跟以前不一样」就是这个原因）。
// 打包版 build/ 在 resources 下（package.json extraResources），开发版在项目根。
function appIconPath(ext) {
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.' + ext),
    path.join(process.resourcesPath || '', 'build', 'icon.' + ext),
    path.join(app.getAppPath(), 'build', 'icon.' + ext),
    path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'resources', 'build', 'icon.' + ext)
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) { /* 继续找 */ }
  }
  return null;
}
// 与 scripts/taskbar-pin.js 里的 APP_USER_MODEL_ID 保持一致：
// 任务栏固定项的 AppUserModelID 是这个值，窗口不同步设置就会出现"两个按钮"或图标不生效
app.setAppUserModelId('com.musicsmx.player');

// ---- 便携版首次启动：从同级旧版本目录继承用户数据 ----
// 交付布局是并排的版本文件夹（MusicSMX-v1.1.0/、MusicSMX-v1.1.1/），各自带 userData。
// 换到新文件夹后默认就是空配置，用户看到的是「设置全丢」。这里在首次启动、且当前
// userData 里还没有 config.json 时，把同级另一份版本目录的数据拷过来。
// 严格限制：只在「版本目录」（名字含 MusicSMX 且带 x.y.z）里生效，开发目录不会误触发；
// 只拷一次（写 portable-inherit.json 标记），绝不覆盖已有数据。
let portableInheritInfo = null;

// Chromium 的缓存/锁文件不继承：没意义，还可能被旧实例占着拷坏
const INHERIT_SKIP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'blob_storage', 'Network',
  'Crashpad', 'Crash Reports', 'Dictionaries', 'logs', 'Session Storage',
  'LOCK', 'LOG', 'LOG.old', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
  'portable-inherit.json'
]);

function copyUserDataTree(srcRoot, dstRoot) {
  let files = 0, bytes = 0;
  const walk = (s, d) => {
    let st;
    try { st = fs.statSync(s); } catch (e) { return; }
    if (st.isDirectory()) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (e) { return; }
      let list = [];
      try { list = fs.readdirSync(s, { withFileTypes: true }); } catch (e) { return; }
      for (const en of list) {
        if (INHERIT_SKIP.has(en.name)) continue;
        walk(path.join(s, en.name), path.join(d, en.name));
      }
    } else {
      try { fs.copyFileSync(s, d); files++; bytes += st.size; } catch (e) { /* 单文件失败（被占用等）跳过 */ }
    }
  };
  walk(srcRoot, dstRoot);
  return { files, bytes };
}

function inheritPortableUserData(base, userDataDir) {
  try {
    const baseName = path.basename(base);
    // 只认版本目录，开发目录（20261115-MusicSMX-重置版）不匹配
    if (!/musicsmx/i.test(baseName) || !/\d+\.\d+\.\d+/.test(baseName)) return;
    if (path.resolve(userDataDir) !== path.resolve(path.join(base, 'userData'))) return;

    const markFile = path.join(userDataDir, 'portable-inherit.json');
    if (fs.existsSync(markFile)) return;                              // 继承过（或用户删了配置想重来）
    if (fs.existsSync(path.join(userDataDir, 'config.json'))) return; // 本地已有配置，绝不覆盖

    const parent = path.resolve(base, '..');
    let list = [];
    try { list = fs.readdirSync(parent, { withFileTypes: true }); } catch (e) { return; }

    const parseVer = (n) => {
      const m = n.match(/(\d+)\.(\d+)\.(\d+)/);
      return m ? [+m[1], +m[2], +m[3]] : null;
    };
    const cands = [];
    for (const en of list) {
      if (!en.isDirectory() || en.name === baseName || !/musicsmx/i.test(en.name)) continue;
      const dir = path.join(parent, en.name);
      const cfg = path.join(dir, 'userData', 'config.json');
      if (!fs.existsSync(cfg)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(cfg).mtimeMs; } catch (e) { continue; }
      cands.push({ dir, ver: parseVer(en.name), mtime });
    }
    if (!cands.length) return;
    // 版本号高的优先；版本号相同或都没有时挑 config.json 最新的
    cands.sort((a, b) => {
      if (a.ver && b.ver) {
        for (let i = 0; i < 3; i++) if (a.ver[i] !== b.ver[i]) return b.ver[i] - a.ver[i];
        return b.mtime - a.mtime;
      }
      if (a.ver) return -1;
      if (b.ver) return 1;
      return b.mtime - a.mtime;
    });

    const src = cands[0];
    try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) { return; }
    const res = copyUserDataTree(path.join(src.dir, 'userData'), userDataDir);
    if (!res.files) return; // 一个都没拷到就不留标记，下次再试
    try {
      fs.writeFileSync(markFile, JSON.stringify({
        from: src.dir,
        at: new Date().toISOString(),
        files: res.files,
        bytes: res.bytes
      }, null, 2), 'utf8');
    } catch (e) { /* 标记没写成只影响「下次是否再继承」，无害 */ }
    portableInheritInfo = {
      from: path.basename(src.dir),
      files: res.files,
      mb: Math.round(res.bytes / 1048576 * 10) / 10
    };
    console.log(`[musicbuddy] 便携版首次启动：已从 ${src.dir} 继承 ${res.files} 个文件（${portableInheritInfo.mb}MB）`);
  } catch (e) {
    console.warn('[musicbuddy] 继承旧版本数据失败（不影响启动）:', e.message);
  }
}

// 便携版：userData 放到项目根目录下（所有 release 版本共享，避免更新迭代后数据丢失）
// 兼容两种布局：portable 版 exe 直接在 release-xxx/ 下；nsis 版 exe 在 release-xxx/win-unpacked/ 下
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  const base = process.env.PORTABLE_EXECUTABLE_DIR;
  const candidates = [
    path.join(base, 'userData'),
    path.join(path.resolve(base, '..'), 'userData'),
    path.join(path.resolve(base, '..', '..'), 'userData')
  ];
  // 优先使用已存在的共享 userData；都不存在时默认上一级目录（首次启动新建）
  let chosen = candidates[1];
  // 但「版本目录」（MusicSMX-v1.1.1 这种）必须自包含：哪怕它自己还没建 userData，
  // 也放自己这里，否则会串到父目录去写。这样新版本文件夹首次启动才能触发继承。
  const baseName = path.basename(base);
  const isVersionDir = /musicsmx/i.test(baseName) && /\d+\.\d+\.\d+/.test(baseName);
  if (isVersionDir) {
    chosen = candidates[0];
  } else {
    for (const c of candidates) {
      if (fs.existsSync(c)) { chosen = c; break; }
    }
  }
  app.setPath('userData', chosen);
  // 新版文件夹第一次启动时，自动接上同级旧版本的数据
  inheritPortableUserData(base, chosen);
}

// 开发模式兜底：任务栏固定图标直接拉起 electron.exe 时没有 PORTABLE_EXECUTABLE_DIR，
// 否则会落到 %APPDATA%\musicsmx（近乎空白，曲库/歌单/排序全丢）。
// 判定依据：未打包 + 项目根里有 userData 目录 —— 把 userData 钉到项目根。
if (!app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    const root = fs.realpathSync(app.getAppPath());   // 走 junction 启动时还原成真实路径
    const ud = path.join(root, 'userData');
    if (fs.existsSync(ud)) app.setPath('userData', ud);
  } catch (e) {
    // 取不到真实路径就退回默认 userData，不影响启动
  }
}

// 重新开启GPU硬件加速（模糊半径已降到20px，GPU加速效率更高）
// 启用GPU光栅化，减少CPU光栅化开销
app.commandLine.appendSwitch('enable-gpu-rasterization');
// 启用零拷贝，减少CPU-GPU数据传输
app.commandLine.appendSwitch('enable-zero-copy');
// 忽略GPU黑名单，确保GPU加速生效
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 启用硬件视频解码（为以后MV功能做准备）
// 注意：不要加 NetworkServiceInProcess2 想把网络服务并回主进程——Electron 37 上确实能少一个进程，
// 但 in-process 网络栈走不了系统代理，本机实测所有 HTTPS 请求 SSL handshake 全失败（封面/歌词/在线解析全挂）。
app.commandLine.appendSwitch(
  'enable-features',
  'VaapiVideoDecoder,PlatformHEVCDecoderSupport,HardwareMediaKeyHandling,MediaSessionService'
);
// 使用D3D11后端（Windows上最优）
app.commandLine.appendSwitch('use-angle', 'd3d11');

// 允许恢复上次播放进度时自动续播（不弹手势限制）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 禁用 HTTP 缓存，避免 net::ERR_CACHE_OPERATION_NOT_SUPPORTED
app.commandLine.appendSwitch('disable-http-cache');
// 允许混合内容（HTTP 电台流在 file:// 页面中播放）
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

// 单实例锁：防止重复启动
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 第二个实例启动时，激活已有窗口
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

let win = null;
let tray = null;
let isQuitting = false;
let miniPlayer = null;          // 托盘右键弹出的迷你播放控制窗（无边框、置顶、点外部关闭）
let miniDestroyTimer = null;    // 小窗隐藏后延迟销毁（释放它那个 renderer 进程）
let miniBlurGuardUntil = 0;     // 迷你窗 blur→hide 守卫截止时间戳：小窗内部按钮引发焦点抖动时，短暂豁免自动收起
let miniCollapsed = true;       // 迷你窗是否处于收起态。收起不用 hide()（透明窗口 hide→show 会丢 DWM 缓冲、
let miniFadeTimer = null;       // 迷你窗透明度渐变动画的定时器（渐入/渐出共用，开新动画先清旧的）
                                // 重 show 首帧闪烁），改用 setOpacity(0)+鼠标穿透；所有「小窗是否开着」的
                                // 判断一律用它，别用 isVisible()（opacity 0 时 isVisible 仍为 true）
let latestPlayerState = { title: '', artist: '', cover: '', playing: false, volume: 0.05, muted: false, mode: 'list', fav: false, lyric: false }; // 渲染进程上报的最新状态，供小窗取用
let latestMiniTheme = null; // 渲染进程推来的主题变量（accent/底色/文字色），小窗创建时补发，保证颜色跟主界面一致
let thumbarPlaying = null;   // 上一次同步到任务栏缩略图的播放状态（null 表示还没建过）
let thumbarFav = null;       // 上一次同步到任务栏缩略图的收藏状态（红心图标随它切换）
// 点关闭按钮时是否最小化到托盘（渲染进程通过 settings.closeToTray 同步过来）
let closeToTray = true;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('[musicbuddy] 保存配置失败:', e.message);
  }
}

// 批量改名前的清单落盘：只写纯文本，放在 userData 下，便于误操作后手工还原
ipcMain.handle('write-text-file', (e, { filePath, text }) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(text || ''), 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 780,
    minHeight: 520,
    frame: false,
    icon: appIconPath('ico') || appIconPath('png') || undefined,
    backgroundColor: '#12141a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.removeMenu();
  thumbarPlaying = null;
  thumbarFav = null;
  win.once('ready-to-show', () => {
    win.show();
    updateThumbar(false);
  });
  // 内置页面直接用 file:// 加载最稳（pathToFileURL 正确处理中文路径）
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 输入框 / 可编辑区右键 → 原生编辑菜单。role 提供行为（作用于当前焦点输入框），
  // label 显式中文——Electron 的 role 内建本地化在某些环境不生效，别依赖它。
  // 只拦 isEditable（搜索框、重命名框、标签编辑等所有文本输入）；非可编辑区域不拦，
  // 留给渲染层的自绘右键菜单（歌曲行 / 歌单 / 电台卡 / 歌词来源等，见 app.js 各 contextmenu 处理器）。
  win.webContents.on('context-menu', (e, params) => {
    if (!params.isEditable || !win || win.isDestroyed()) return;
    const hasSel = (params.selectionText || '').length > 0;
    // 空白（无选区）时只显示粘贴；有选区才有剪切/复制/删除/全选
    const menu = Menu.buildFromTemplate([
      { role: 'paste', label: '粘贴' },
      ...(hasSel ? [
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { type: 'separator' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ] : [])
    ]);
    menu.popup({ window: win, x: params.x, y: params.y });
  });

  // 开发期自动化钩子（截图 / 交互断言 / 冒烟），实现见 dev-hooks.js
  devHooks.attach(win, app);

  // 关闭窗口：按用户设置决定「最小化到托盘」还是「退出程序」
  win.on('close', (e) => {
    if (isQuitting) return;
    if (closeToTray) {
      e.preventDefault();
      win.hide();
    } else {
      isQuitting = true;
      app.quit();
    }
  });
  win.on('closed', () => { win = null; });

  // 主窗口失焦 = 用户点了别的应用。若迷你窗还开着且自己也没焦点（典型：刚从小窗
  // 海报键打开主界面，小窗被动失焦、之后外部点击不会再触发它的 blur），一并收起。
  // 必须 150ms 后复判 isFocused：托盘右键开小窗的瞬间 mp.focus() 还没在 OS 层落地，
  // 主窗口 blur 先到，此刻读 isFocused() 是假 false —— 立即收起就是「开小窗闪一下」。
  win.on('blur', () => {
    setTimeout(() => {
      if (!miniPlayer || miniPlayer.isDestroyed() || miniCollapsed) return;
      if (miniPlayer.isFocused()) return;               // 焦点已落到小窗：是正常打开流程
      if (Date.now() < miniBlurGuardUntil) return;
      hideMiniPlayer();
    }, 300);
  });
  hookLyricRestoreOnDeactivate(win);

  // 真全屏状态（含系统手势 / 其它途径触发）同步给渲染进程，用来切 UI 细节
  win.on('enter-full-screen', () => {
    if (win && !win.isDestroyed()) win.webContents.send('fullscreen-changed', true);
  });
  win.on('leave-full-screen', () => {
    if (win && !win.isDestroyed()) win.webContents.send('fullscreen-changed', false);
  });
}

// ================= 桌面悬浮歌词 / 任务栏歌词 =================
// 一个独立的透明置顶 BrowserWindow。主窗口 →(lyric-data)→ 主进程 → 本窗口，
// 主进程不做任何歌词解析，只转发数据 + 管窗口位置，两边永远同一份时间轴。
let lyricWin = null;
let lyricMode = 'off';            // off | desktop | taskbar
// 默认开启鼠标穿透（2026-11-18 要求）：歌词条贴在任务栏/桌面上，
// 如果吃鼠标事件，鼠标划过那一条就等于点了别人的按钮，任务栏被挡住半截。
// 要拖动或右键调样式时，在「词」字按钮的菜单里取消勾选。
let lyricClickThrough = true;
// 字号 / 文字透明度**按模式各存一份**（2026-11-18 要求）。
// 桌面悬浮窗浮在壁纸上、可以随意拉大；任务栏只有 40px 高，字小到看不清，
// 反而需要放大到 140% 才和旁边的时间/图标协调。共用一份值时，调好一边必然
// 弄坏另一边。默认：桌面 70% / 任务栏 140%，两边文字透明度都是 30%。
const LYRIC_SCALE_MIN = 0.3, LYRIC_SCALE_MAX = 1.8;
const LYRIC_OPACITY_MIN = 0.1;
const LYRIC_SCALE_DEFAULTS = { desktop: 0.7, taskbar: 1.4 };
const LYRIC_OPACITY_DEFAULTS = { desktop: 0.3, taskbar: 0.3 };
let lyricScales = Object.assign({}, LYRIC_SCALE_DEFAULTS);
let lyricOpacities = Object.assign({}, LYRIC_OPACITY_DEFAULTS);
let lyricScale = lyricScales.desktop;   // 当前模式下的生效值（窗口尺寸 / 菜单直接读它）
let lastLyricData = null;
let lyricTopTimer = null;
let lyricScreenBound = false;

// 悬浮歌词的外观选项（逐字 / 翻译 / 颜色 / 背景 …）。
// 主进程不解读这些字段，只做「缓存 + 转发」：主窗口菜单和悬浮窗右键菜单
// 都能改，两边都往这里写，新开的窗口不用等主窗口再推一次样式。
let lyricStyle = {
  words: true,          // 逐字点亮（有逐字时间轴时才生效）
  translation: true,    // 副行：翻译
  nextLine: true,       // 副行：下一句（没有翻译时兜底）
  color: '#ffffff',     // 主文字颜色（任意 hex 或 accent = 跟随主题）
  accentWord: false,    // 逐字填充用强调色（默认跟主文字同色：白字逐字最像 QQ 音乐）
  bg: 'none',           // none | soft | dark
  align: 'center',      // center | left
  shadow: true,         // 文字描边（压壁纸 / 压任务栏都要靠它）
  opacity: 0.3,         // 文字透明度 0.1 ~ 1（**当前模式**的生效值，另一模式那份在 lyricOpacities）
  layout: 'dual'        // single 单行 | dual 双行（两行原位交替，不滚动）
};
let lyricFitW = 0;          // 任务栏模式：渲染端实测的「内容该多宽」
let lyricTaskbarX = null;   // 任务栏模式：用户拖到的左上角 x（兼容旧值，实际以 center 为准）
// 任务栏模式的锚点用「文字中心」而不是左上角：窗口宽度跟着歌词长短变，
// 用左边界锚定的话宽度一变、居中显示的文字就整体横移 —— 用户看到的
// 「新唱到的一句突然位移一段距离」有一半是它造成的。
let lyricTaskbarCenter = null;
// 任务栏歌词水平平移（2026-11-21）：默认贴任务栏正中，但 Win11 居中图标 /
// 小组件会占住中间，用户需要手动往左/右挪。单位 DIP px，仅作用在
// 「自动居中」分支上——用户拖过（lyricTaskbarCenter/X 非空）以拖动为准。
let lyricTaskbarOffset = 0;
let lyricDesktopPos = null; // 桌面模式：用户拖到的位置
// 手动拖动（2026-11-21）：歌词窗不再用 -webkit-app-region: drag——那种区域上
// **所有鼠标事件都不进页面**，右键直接被 Windows 拿去弹系统菜单（还原/移动/大小/
// 最小化/最大化/关闭），我们自己的右键菜单永远弹不出来。改为渲染端 pointer 事件
// 流式上报光标坐标、主进程这里 setBounds 跟随：与原生拖动等效，右键/双击全部恢复。
let lyricDragOffset = null; // 拖动中：{x, y} = 光标屏幕坐标 → 窗口左上角的偏移
let lyricProgrammaticMove = 0;  // 程序自己 setBounds 时，抑制 moved 回调里的位置保存
let lyricLastSetBounds = null;  // 程序最近一次 setBounds 的目标值：区分「自己摆的」和「系统改的」resize
let lyricLastForeignResize = null; // 上一次触发重摆的「系统改的」bounds：防止系统持续回弹造成重摆循环
let lyricGeomGuardTimer = null;   // 几何守卫心跳：2s 一次不变量巡检（不依赖任何事件）
let lyricLastForeignMoveAt = 0;   // 最近一次外部移动/拖动的时间：拖动中暂停守卫，防止打断用户
let lyricDisplayId = null;      // 歌词窗当前所在显示器；跨屏时清掉旧 DPI 下量出的宽度/锚点
let lyricDisplayChangeTimer = null; // 切屏事件防抖：等显示器几何稳定后再重摆一次
let lyricLastDisplayGeom = null; // 上次记录的歌词屏几何（宽/高/DPI）：同屏改分辨率（4K↔2K）时
                                 // display id 不变，靠它识别「分辨率变了」并清旧量出的几何
let lyricGeomLogBuf = [];       // 几何诊断日志缓冲：跨屏 bug 在另一台电脑上复现时靠它取证据
let lyricGeomLogAt = 0;         // 缓冲首条入队时间：超过 3 秒强制落盘（低频事件不留证据）

function clampLyricScale(v) {
  const n = Number(v);
  return Math.max(LYRIC_SCALE_MIN, Math.min(LYRIC_SCALE_MAX, isFinite(n) ? n : 1));
}
function clampLyricOpacity(v) {
  const n = Number(v);
  return Math.max(LYRIC_OPACITY_MIN, Math.min(1, isFinite(n) ? n : 1));
}
// desktop | taskbar：字号与透明度的存取键。'off' 期间改动归到 desktop 那一格，
// 这样在「关闭」状态下先调好参数、再开桌面歌词也是合理的。
function lyricMetricKey(mode) {
  return (mode || lyricMode) === 'taskbar' ? 'taskbar' : 'desktop';
}
function lyricOpacityFor(key) {
  return clampLyricOpacity(lyricOpacities[key]);
}
// 把当前模式那份字号/透明度取到「生效值」上。切模式、收到新配置时都要调。
function syncLyricMetricsForMode() {
  const k = lyricMetricKey();
  lyricScale = clampLyricScale(lyricScales[k]);
  lyricStyle.opacity = lyricOpacityFor(k);
}

// 几何诊断日志：只记「何时何地窗口被摆成什么样」，静默追加到 userData，
// 用户再报「超出屏幕/位置乱」时取回这份文件就能还原完整时间线。
// 缓冲批量写 + 200KB 上限（超限丢弃最旧一半），绝不阻塞几何流程。
function lyricGeomLog(tag, detail) {
  try {
    const b = lyricWin && !lyricWin.isDestroyed() ? lyricWin.getBounds() : null;
    const d = (lyricWin && !lyricWin.isDestroyed()) ? currentLyricDisplay() : null;
    const line = `${new Date().toISOString()} [${tag}]` +
      (b ? ` win=${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}` : ' win=null') +
      (d ? ` disp#${d.id} ${d.bounds.width}x${d.bounds.height}@${d.scaleFactor} wa=${d.workArea.width}x${d.workArea.height}+${d.workArea.x}+${d.workArea.y}` : ' disp=null') +
      (detail ? ` | ${detail}` : '');
    lyricGeomLogBuf.push(line);
    if (!lyricGeomLogAt) {
      lyricGeomLogAt = Date.now();
      // 真定时落盘：低频事件（如一次切屏只有 2 条记录）不能等下一条事件才落盘，
      // 否则用户复现后直接关软件，缓冲里的证据就丢了
      setTimeout(lyricGeomFlush, 3100);
    }
    if (lyricGeomLogBuf.length >= 20 || Date.now() - lyricGeomLogAt > 3000) lyricGeomFlush();
  } catch (e) { /* 日志永不连累主流程 */ }
}

function lyricGeomFlush() {
  if (!lyricGeomLogBuf.length) return;
  lyricGeomLogAt = 0;
  try {
    const file = path.join(app.getPath('userData'), 'lyric-geom.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 200 * 1024) {
      const old = fs.readFileSync(file, 'utf8').split('\n');
      fs.writeFileSync(file, old.slice(Math.floor(old.length / 2)).join('\n'), 'utf8');
    }
    fs.appendFileSync(file, lyricGeomLogBuf.join('\n') + '\n', 'utf8');
  } catch (e) { /* 同步盘锁住等场景：丢这批日志也不影响功能 */ }
  lyricGeomLogBuf = [];
}

// 歌词窗当前所在显示器。2K/4K 双屏切换后，taskbar 厚度、workArea、
// 坐标原点都不一样；一律拿 getPrimaryDisplay() 会按另一块屏的几何摆窗
// （表现就是字被挤大、位置横着偏）。窗口还没建好时退回主屏。
function currentLyricDisplay() {
  if (lyricWin && !lyricWin.isDestroyed()) {
    const b = lyricWin.getBounds();
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    return screen.getDisplayMatching(b)
      || screen.getDisplayNearestPoint(center)
      || screen.getPrimaryDisplay();
  }
  return screen.getPrimaryDisplay();
}

// 反推任务栏真实区域：workArea 是「屏幕减去任务栏」后的区域，
// 四个方向的差值里最大者就是任务栏厚度与所在边。
function taskbarRect(display) {
  const d = display || currentLyricDisplay();
  const b = d.bounds;
  const wa = d.workArea;
  const left = wa.x - b.x;
  const right = (b.x + b.width) - (wa.x + wa.width);
  const top = wa.y - b.y;
  const bottom = (b.y + b.height) - (wa.y + wa.height);
  const thick = Math.max(left, right, top, bottom);
  if (thick >= 20) {
    if (bottom >= thick) return { x: b.x, y: wa.y + wa.height, w: b.width, h: bottom };
    if (top >= thick) return { x: b.x, y: b.y, w: b.width, h: top };
    if (left >= thick) return { x: b.x, y: b.y, w: left, h: b.height };
    return { x: wa.x + wa.width, y: b.y, w: right, h: b.height };
  }
  // 任务栏自动隐藏 / 系统没预留 workArea 时，按底部 40px 兜底
  return { x: b.x, y: b.y + b.height - 40, w: b.width, h: 40 };
}

function lyricBounds(mode, display) {
  const d = display || currentLyricDisplay();
  const wa = d.workArea;
  // 无边框透明窗的 Windows 高度地板（2026-11-25 实测定案）：请求 <64px 一律被系统
  // 抬到 64px，而 Chromium 簿记仍记请求值 → OS 窗口与渲染端 viewport 永久脱钩
  // （宽度无地板）。历史上另一台机器表现为「请求 <70 一律 +7」——本质同源，
  // 膨胀量随机器/DPI 变。对策：请求高度一律 ≥72（72 在两台机器上都精确落地），
  // 多出来的高度留给透明区；同时把任务栏条的真实高度发渲染端排版（lyric-geom）。
  const FLOOR_H = 72;
  if (mode === 'taskbar') {
    const tb = taskbarRect(d);
    // 任务栏在屏幕左/右侧（少见）：竖着排一小段
    if (tb.w < tb.h) {
      const h = Math.max(80, Math.min(Math.round(tb.h * 0.5), 600));
      return { width: Math.max(28, Math.round(tb.w)), height: h,
               x: Math.round(tb.x), y: Math.round(tb.y + (tb.h - h) / 2) };
    }
    // 宽度跟着文字实际长度走。以前是固定占任务栏一半宽（1920 屏上就是 960px），
    // 短歌词也横贯一大条，直接把中间那排任务栏图标压在下面 —— 这就是「遮挡任务栏按钮」。
    // 现在由渲染端实测文字宽度回报，窗口只包住文字本身。
    const maxW = Math.max(240, tb.w - 120);
    // 宽度只跟文字实际长度走：窗口只包住文字本身，短句不会横贯一整条任务栏。
    const want = lyricFitW > 0 ? lyricFitW : 420;
    const w = Math.max(150, Math.min(Math.round(want), maxW));
    // 位置以「文字中心」为锚：宽度变化时窗口左右对称扩缩，居中显示的文字原地不动。
    // 手动拖过（center/X 非空）以拖动位置为准；否则自动居中 + 用户设置的平移偏移。
    const manual = lyricTaskbarCenter != null || lyricTaskbarX != null;
    let center;
    if (lyricTaskbarCenter != null) {
      center = lyricTaskbarCenter;
    } else if (lyricTaskbarX != null) {
      center = lyricTaskbarX + w / 2;
    } else {
      // 默认摆在任务栏正中（2026-11-18 要求：以前默认靠右，飘在托盘边上很偏），
      // 再叠加设置里的水平平移偏移（可正可负）。
      center = tb.x + tb.w / 2 + lyricTaskbarOffset;
    }
    const x = Math.round(Math.max(tb.x, Math.min(tb.x + tb.w - w, center - w / 2)));
    // clamp 之后实际中心可能与期望值不同（顶到任务栏边缘），手动位置以实际值为准，
    // 避免反复回弹；自动分支**不能回写**——回写会把 offset 烤进 lyricTaskbarCenter，
    // 之后的重摆（含几何守卫心跳）就再也不会叠加偏移了（偏移只生效一次的 bug）。
    if (manual) {
      lyricTaskbarCenter = x + w / 2;
      lyricTaskbarX = x;
    }
    // 地板高度：条高不足 72 时抬到 72，窗口底边贴屏幕底边（贴顶任务栏则顶边贴顶），
    // 条的真实区域贴着屏幕边——渲染端按 stripH/stripAnchor 把内容锚到条上。
    const stripH = Math.max(28, Math.round(tb.h));
    const h = Math.max(FLOOR_H, stripH);
    const bnd = d.bounds;
    const atTop = Math.abs(tb.y - bnd.y) <= Math.abs((bnd.y + bnd.height) - (tb.y + tb.h));
    const y = atTop ? Math.round(tb.y) : Math.round(tb.y + tb.h - h);
    return { width: w, height: h, x, y, stripH, stripAnchor: atTop ? 'top' : 'bottom' };
  }
  // 桌面模式：一块固定画布承载两行（双行原位交替，不需要更宽的滑道）
  const w = Math.round(760 * lyricScale);
  const h = Math.max(FLOOR_H, Math.round(128 * lyricScale));
  // 桌面模式也记住用户拖到的位置，缩放时保持左上角不动
  let x = lyricDesktopPos ? lyricDesktopPos.x : Math.round(wa.x + (wa.width - w) / 2);
  let y = lyricDesktopPos ? lyricDesktopPos.y : Math.round(wa.y + wa.height - h - 96);
  x = Math.max(wa.x - 20, Math.min(wa.x + wa.width - w + 20, x));
  y = Math.max(wa.y - 20, Math.min(wa.y + wa.height - h + 20, y));
  return { width: w, height: h, x, y };
}

// 统一入口：所有 setBounds 都走这里，并标记「这是程序摆的」，
// 免得 moved 回调把程序算出来的位置当成用户拖动存下来（会互相打架）。
function applyLyricBounds(display) {
  if (!lyricWin || lyricWin.isDestroyed() || lyricMode === 'off') return;
  lyricProgrammaticMove++;
  try {
    const nb = lyricBounds(lyricMode, display);
    // Windows 给这个无边框窗口的高度请求加了一圈隐形 DWM 边框（2026-11-22 实测定案）：
    // 请求 <70px 一律 +7（要 40 给 47、要 38.4 给 45.2），≥70 则精确；宽度不受影响。
    // 这就是历次「任务栏歌词下半截伸出屏幕」的真正根源——窗口永远比任务栏厚 7px，
    // 而 y 贴着任务栏顶，底部必然出屏 7px。之前的守卫心跳/防抖重摆/多级自检全都在
    // 反复调用同一句注定被膨胀的 setBounds，等于原地打转（用户：改了好多次都没解决）。
    // 现在改为自校准：先按目标摆一次，量出系统膨胀了多少，把差值从请求里扣掉再摆，
    // 让最终实际高度精确等于目标。最多两轮，非线性系统下也能收敛到最优；
    // 不同 DPI / 系统版本的边框厚度差异自动适配。
    let req = { x: nb.x, y: nb.y, width: nb.width, height: nb.height };
    // 任务栏条的真实高度/锚点先发给渲染端：窗口高度现在抬到了 72px 地板之上，
    // 渲染端 viewport 比条高，字号与内容锚定必须按条高算，不能用 innerHeight
    //（发两遍：setBounds 前后各一次，保证 resize 回调触发 applyFont 时已收到）
    if (nb.stripH) {
      const geomMsg = { h: nb.stripH, anchor: nb.stripAnchor || 'bottom' };
      try {
        lyricWin.webContents.send('lyric-geom', geomMsg);
      } catch (e) { /* 窗口正在销毁 */ }
    }
    lyricWin.setBounds(req);
    let got = lyricWin.getBounds();
    const dh1 = got.height - nb.height;
    if (Math.abs(dh1) >= 1) {
      req = { x: nb.x, y: nb.y, width: nb.width, height: Math.max(20, nb.height - dh1) };
      lyricWin.setBounds(req);
      got = lyricWin.getBounds();
      const dh2 = got.height - nb.height;
      if (Math.abs(dh2) >= 1) {
        req = { x: nb.x, y: nb.y, width: nb.width, height: Math.max(20, nb.height - dh2) };
        lyricWin.setBounds(req);
      }
    }
    // 回声基准记「系统最终呈现的实际值」而不是我们发出去的请求值——
    // 否则 resize 回调永远认为几何被外部改了，450ms 防抖会无限重跑。
    const fin = lyricWin.getBounds();
    // 硬夹取兜底：自校准在切屏过渡期可能读到异步旧值而收敛到错误高度/位置
    // （比如底部越出屏幕 7px 的老毛病）。校准后窗口任何一边超出目标显示器
    // 就再摆一次，位置/尺寸按显示器 bounds 硬夹——这是绝对不变量，任何 DPI
    // 组合下都不允许窗口裸露在屏幕外。
    const db = (display || currentLyricDisplay()).bounds;
    if (fin.width > 0 && fin.height > 0 &&
        (fin.x < db.x - 1 || fin.y < db.y - 1 ||
         fin.x + fin.width > db.x + db.width + 1 || fin.y + fin.height > db.y + db.height + 1)) {
      const cx = Math.max(db.x, Math.min(fin.x, db.x + db.width - fin.width));
      const cy = Math.max(db.y, Math.min(fin.y, db.y + db.height - fin.height));
      const cw = Math.min(fin.width, db.width);
      const ch = Math.max(20, Math.min(fin.height, db.height));
      lyricWin.setBounds({ x: Math.round(cx), y: Math.round(cy), width: Math.round(cw), height: Math.round(ch) });
      let fin2 = lyricWin.getBounds();
      // 夹完仍越界 = DWM 膨胀把请求尺寸又撑大了（校准两轮都没吃掉）：按残余过冲
      // 直接从请求里扣掉再摆一轮。此时已过过渡期，读数是稳的，一轮必收敛。
      const overB = (fin2.y + fin2.height) - (db.y + db.height);
      const overR = (fin2.x + fin2.width) - (db.x + db.width);
      if (overB > 1 || overR > 1) {
        lyricWin.setBounds({
          x: Math.round(cx), y: Math.round(cy), width: Math.round(cw),
          height: Math.max(20, Math.round(ch - Math.max(0, overB)))
        });
        fin2 = lyricWin.getBounds();
      }
      lyricGeomLog('clamp', `want=${Math.round(cx)},${Math.round(cy)} ${Math.round(cw)}x${Math.round(ch)} got=${fin2.x},${fin2.y} ${fin2.width}x${fin2.height}`);
    }
    lyricLastSetBounds = { x: fin.x, y: fin.y, width: fin.width, height: fin.height };
    if (nb.stripH) {
      try {
        lyricWin.webContents.send('lyric-geom', { h: nb.stripH, anchor: nb.stripAnchor || 'bottom' });
      } catch (e) { /* 窗口正在销毁 */ }
    }
    lyricLastForeignResize = null; // 我们重新掌握了位置，旧的外部改动不再需要去重
  } finally {
    setTimeout(() => { lyricProgrammaticMove = Math.max(0, lyricProgrammaticMove - 1); }, 80);
  }
}

// ---------- 几何守卫心跳 ----------
// 事件驱动的重摆（display-metrics-changed / resize / moved）有一类死角：切屏过渡期
// Windows 分多步改 workArea（实测 1400→1393→1400），若 450ms+120ms 两次重摆都恰好
// 落在过渡值 1393（任务栏被算成 47px），就把 47 烤进了 lyricLastSetBounds——之后
// 窗口与目标一致、再无任何事件，就永远死在越界状态（2026-11-21 二次反馈）。
// 所以这里用低频心跳做不变量巡检：实测 bounds 与「按当前显示器算出的期望几何」
// 不符就静默纠正。拖动中 / 程序重摆中 / 切屏过渡期 / 45s 内的过渡自检期自动让路。
function lyricGeometryGuardTick() {
  if (!lyricWin || lyricWin.isDestroyed() || lyricMode === 'off') return;
  if (lyricProgrammaticMove > 0) return;
  if (lyricDisplayChangeTimer) return;                 // 切屏防抖重摆在排队，交给它
  if (Date.now() - lyricLastForeignMoveAt < 1500) return; // 用户正拖动 / 刚发生外部移动
  const b = lyricWin.getBounds();
  const d = currentLyricDisplay();
  const exp = lyricBounds(lyricMode, d);
  if (Math.abs(b.x - exp.x) > 1 || Math.abs(b.y - exp.y) > 1 ||
      Math.abs(b.width - exp.width) > 1 || Math.abs(b.height - exp.height) > 1) {
    lyricGeomLog('guard-fix', `exp=${exp.x},${exp.y} ${exp.width}x${exp.height}`);
    applyLyricBounds(d);
  }
}
function startLyricGeomGuard() {
  stopLyricGeomGuard();
  if (lyricMode === 'off') return;
  lyricGeomGuardTimer = setInterval(lyricGeometryGuardTick, 2000);
}
function stopLyricGeomGuard() {
  if (lyricGeomGuardTimer) { clearInterval(lyricGeomGuardTimer); lyricGeomGuardTimer = null; }
}

// Windows 任务栏（Shell_TrayWnd）会在鼠标划过、窗口激活、系统通知等时机
// 重新把自己提到 z-order 最顶。只设一次 alwaysOnTop 会被重新盖住 —— 用户看到的
// 「歌词被任务栏压住」就是这个原因。低频把它提回来即可。
// 任务栏歌词必须一直在任务栏之上，所以守卫对所有模式常开：
// 平时由 WM_ACTIVATEAPP 钩子在跨应用切换瞬间兜住（见 hookLyricRestoreOnDeactivate），
// 30ms 心跳兜底覆盖「点任务栏」（收不到任何消息）与「两个外部窗口之间切换」的场景。
function keepLyricOnTop() {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  try {
    // 先查再设：绝大多数心跳周期里 TOPMOST 标志都还在，isAlwaysOnTop() 是读
    // WS_EX_TOPMOST 的廉价 getter，省掉每 tick 的 SetWindowPos 重建带成员。
    if (!lyricWin.isAlwaysOnTop()) lyricWin.setAlwaysOnTop(true, 'screen-saver', 1);
  } catch (e) {
    try { lyricWin.setAlwaysOnTop(true); } catch (e2) { /* 窗口刚销毁，忽略 */ }
  }
  // 迷你窗开着时不动 z 序：迷你窗底边与任务栏歌词有十几像素重叠，moveTop 会把歌词
  // 「翻」到刚打开的迷你窗上面，表现为每次开小窗歌词闪一下（2026-11-20 用户反馈）。
  // 迷你窗收起后守卫恢复，歌词照常被提回任务栏之上。
  if (!miniCollapsed) return;
  if (typeof lyricWin.moveTop === 'function') lyricWin.moveTop();
}
function stopLyricTopGuard() {
  if (lyricTopTimer) { clearInterval(lyricTopTimer); lyricTopTimer = null; }
}
function startLyricTopGuard() {
  stopLyricTopGuard();
  if (lyricMode === 'off') return;
  keepLyricOnTop();
  // 15ms（≈1 帧）：点任务栏（Shell_TrayWnd 重提 z 顶盖住歌词）收不到 WM_ACTIVATEAPP——
  // 它只在「我们的窗口正持有前台」时发给被抢走前台的那个窗口；先点别的软件再点
  // 任务栏的场景全靠心跳兜底。150ms（约 9 帧）肉眼可见「闪一次」，30ms 残留 1~2 帧，
  // 15ms 压到单帧。开销：每 tick 一次廉价 WS_EX_TOPMOST 读取 + 一次 SetWindowPos，
  // 66 次/秒的纯系统调用，不重绘不发 IPC，实测 CPU 远低于 0.1%。
  lyricTopTimer = setInterval(() => {
    if (lyricMode !== 'off') keepLyricOnTop();
  }, 15);
}

// 用户点击其他应用 / 桌面 / 任务栏的瞬间，Windows 会让任务栏重新顶到 z 序最上面，
// 把贴在任务栏上的歌词盖住 —— 表现为「点别处歌词消失一瞬间，半秒后才回来」
// （守卫要等下一个轮询才救回）。WM_ACTIVATEAPP 是系统发给「正被其他应用抢走前台」
// 的窗口的消息，在这里当场把歌词提回最顶，间隙归零。
// 只覆盖「我们的窗口正持有前台」的切换（主窗 / 迷你窗都挂）；两个外部窗口之间
// 互相切换我们收不到任何消息，靠上面的 150ms 轮询兜底。
function hookLyricRestoreOnDeactivate(w) {
  if (!w || w.isDestroyed() || typeof w.hookWindowMessage !== 'function') return;
  try {
    w.hookWindowMessage(0x001C /* WM_ACTIVATEAPP */, () => {
      if (lyricMode !== 'off') keepLyricOnTop();
    });
  } catch (e) { /* 非 Windows 或窗口刚销毁 */ }
}

function ensureLyricWindow(mode) {
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.webContents.send('lyric-mode', mode);
    lyricWin.webContents.send('lyric-scale', lyricScale);
    lyricWin.webContents.send('lyric-style', lyricStyle);
    applyLyricBounds();
    keepLyricOnTop();
    return;
  }
  const b = lyricBounds(mode);
  lyricWin = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // 去掉 WS_THICKFRAME：transparent 窗口默认背后还垫着一层隐形 thickframe 窗
    // （出阴影/系统动画用），前台切换（点其他应用）时它会闪出黑/白一帧 —— 表现为
    // 「点别处歌词闪一下」（2026-11-20 实测 z 序钩子 + 150ms 心跳都救不掉，就是这个）。
    // false 只移除阴影与窗口动画（已有 hasShadow:false），拖动走 app-region 不受影响。
    thickFrame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    // 不设这两个：Chromium 默认最小尺寸会把 40px 的任务栏细条撑成 64px，
    // 内容垂直居中就会偏下、下半截掉出屏幕。
    minWidth: 1,
    minHeight: 1,
    minimizable: false,
    maximizable: false,
    show: false,
    // 不抢焦点（WS_EX_NOACTIVATE）：歌词窗创建/销毁不再引发 Windows 焦点移交，
    // 否则迷你窗会被动 blur（托盘小窗「点歌词键后点外部不收起」的根源）。
    // 拖动走 -webkit-app-region（WM_NCHITTEST），右键菜单是原生 Menu.popup，都不需要焦点。
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lyricWin.setAlwaysOnTop(true, 'screen-saver');
  // 穿透要在 show 之前设好：否则窗口一露脸就会抢一次鼠标（划过任务栏那一下会「卡住」）
  try { lyricWin.setIgnoreMouseEvents(lyricClickThrough, { forward: true }); } catch (e) {}
  lyricWin.loadFile(path.join(__dirname, 'renderer', 'desktop-lyric.html'));
  lyricWin.once('ready-to-show', () => {
    if (!lyricWin || lyricWin.isDestroyed()) return;
    // 构造参数同样会被 Windows 膨胀 +7px，先自校准摆正再露脸
    applyLyricBounds();
    lyricWin.showInactive();
    lyricDisplayId = currentLyricDisplay().id;
    lyricWin.webContents.send('lyric-mode', mode);
    lyricWin.webContents.send('lyric-scale', lyricScale);
    lyricWin.webContents.send('lyric-style', lyricStyle);
    lyricWin.webContents.send('lyric-state', { clickThrough: lyricClickThrough });
    if (lastLyricData) lyricWin.webContents.send('lyric-data', lastLyricData);
    keepLyricOnTop();
  });
  // 被系统 / 其他置顶窗口压下去的那一刻就提回来，不用等下一个心跳。
  // always-on-top-changed 只在自己被「取消置顶」时补一次；true 时什么都不做，
  // 否则会和 keepLyricOnTop 互相递归。
  lyricWin.on('always-on-top-changed', (e, onTop) => {
    if (!onTop && lyricMode !== 'off') keepLyricOnTop();
  });
  lyricWin.on('blur', () => { if (lyricMode !== 'off') keepLyricOnTop(); });
  lyricWin.on('show', () => { if (lyricMode !== 'off') keepLyricOnTop(); });
  // 用户拖动后记住位置：任务栏模式只认 x（y/高度永远贴任务栏），
  // 桌面模式 x/y 都记。程序自己摆位置时（applyLyricBounds）不记录。
  lyricWin.on('moved', () => {
    if (lyricProgrammaticMove > 0) return;
    if (!lyricWin || lyricWin.isDestroyed()) return;
    const nb0 = lyricWin.getBounds();
    // 迟到的程序回声：位置与期望几何一致就不是用户拖的（否则宽度变化时
    // 自动居中位置会被误存成手动位置，之后的重摆全被锁死在旧坐标上）。
    const exp0 = lyricBounds(lyricMode, currentLyricDisplay());
    if (Math.abs(nb0.x - exp0.x) <= 1 && Math.abs(nb0.y - exp0.y) <= 1 &&
        Math.abs(nb0.width - exp0.width) <= 1 && Math.abs(nb0.height - exp0.height) <= 1) {
      return;
    }
    // 外部移动（用户拖动 / 系统挪动）刚发生：守卫心跳让路，避免打断拖拽循环
    lyricLastForeignMoveAt = Date.now();
    const nb = nb0;
    if (lyricMode === 'taskbar') {
      lyricTaskbarX = nb.x;
      lyricTaskbarCenter = nb.x + nb.width / 2;
      const expect = lyricBounds('taskbar', currentLyricDisplay());
      // 拖出任务栏了（x/y/宽/高任何一项偏离任务栏期望几何）→ 拉回来，
      // 任务栏歌词就该长在任务栏上。旧检查只看 y/高度，过渡期系统把窗口
      // 挪到屏幕外时 x/宽度变了却拉不回（2026-11-21 越界修复）。
      if (Math.abs(nb.x - expect.x) > 1 || Math.abs(nb.y - expect.y) > 1 ||
          Math.abs(nb.width - expect.width) > 1 || Math.abs(nb.height - expect.height) > 1) {
        applyLyricBounds();
      }
      notifyLyricState({ taskbarX: lyricTaskbarX });
    } else {
      lyricDesktopPos = { x: nb.x, y: nb.y };
    }
  });
  lyricWin.on('closed', () => {
    lyricWin = null;
    lyricMode = 'off';
    stopLyricTopGuard();
    stopLyricGeomGuard();
    // 歌词没了，迷你控制条也一起收（点叉号关闭歌词的场景）
    hideLyricRemote();
    // 用户直接在悬浮窗点 × 时，让主窗口按钮状态跟着熄灭
    if (win && !win.isDestroyed()) win.webContents.send('lyric-window-state', { closed: true });
  });
  // 系统在 2K↔4K 切换的过渡期会**自己** resize 歌词窗（innerHeight 实测出现过
  // 28/47/64 的中间值），而且这些改动往往**不伴随** display-metrics-changed 事件
  // —— 旧代码只有显示器事件才重摆，高度就停在过渡值上：40px 任务栏被撑成 47px，
  // 任务栏双行文字按 47px 排版，下排下半截掉出屏幕底边（2026-11-21 用户反馈）。
  // 这里把「非我们自己 setBounds 引起的 resize」也纳入同一个 450ms 防抖重摆流程，
  // 几何稳定后按当前显示器重新夹一次。自己摆的（回声 = 与 lyricLastSetBounds 一致）
  // 直接忽略，否则每次换歌词宽度都会白白隐身闪一轮。
  //
  // 2026-11-24 二次修复（用户在另一台电脑上实测：切行时歌词整段消失 0.3~0.4s）：
  // 换行 → 宽度变化 → applyLyricBounds 的 setBounds 是异步落地的，resize 事件
  // 读到的实际值与 applyLyricBounds 里同步 getBounds() 记下的 lyricLastSetBounds
  // 差 1~2px（DPI 取整 / 系统应用时机）→ echo 判定失败 → 被当成「外部改动」→
  // handleLyricDisplayChange() setOpacity(0) 隐身 450ms —— 正是切行闪现的根源。
  // 慢机器上事件落得更晚（超出 programmaticMove 的 80ms 窗口），所以更容易复现。
  // 三道闸：① programmaticMove 期间的 resize 一律视为自己的回声；
  // ② 仍可疑时核对「期望几何」：窗口明明就摆在程序要摆的位置 → 不可能需要切屏流程；
  // ③ 150ms 复核：回声自愈期内不触发隐身。
  let lyricForeignResizeTimer = null;
  lyricWin.on('resize', () => {
    if (lyricMode === 'off') return;
    const b = lyricWin.getBounds();
    const same = (p, q) => p && Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1 &&
      Math.abs(p.width - q.width) <= 1 && Math.abs(p.height - q.height) <= 1;
    if (lyricProgrammaticMove > 0) {
      // 自己 setBounds 的回声（可能晚于 80ms 窗口才到达）：把基线刷成实际值，
      // 后续相同值靠 same() 去重；绝不走「外部改动」隐身流程。
      lyricLastSetBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      return;
    }
    if (same(lyricLastSetBounds, b)) return;           // 我们自己 setBounds 的回声
    // 与「当前显示器期望几何」一致 → 窗口就在程序要摆的位置上，没有外部改动。
    // 切行造成的宽度/位置变化最终都会落到期望几何上，在这里被拦下（2026-11-24）。
    const exp = lyricBounds(lyricMode, currentLyricDisplay());
    if (Math.abs(b.x - exp.x) <= 1 && Math.abs(b.y - exp.y) <= 1 &&
        Math.abs(b.width - exp.width) <= 1 && Math.abs(b.height - exp.height) <= 1) {
      lyricLastSetBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      return;
    }
    if (same(lyricLastForeignResize, b)) return;       // 同一个外部改动只处理一次，防回弹循环
    lyricLastForeignResize = { x: b.x, y: b.y, width: b.width, height: b.height };
    lyricGeomLog('foreign-resize', `lastSet=${JSON.stringify(lyricLastSetBounds)}`);
    // 150ms 后复核还在才算真外部改动：setBounds 中间值/迟到的回声在这个窗口内自愈，
    // 不再一杆子打进 450ms 隐身流程。真·切屏时系统会把窗口挪到错误位置且持续存在，
    // 复核照样通过，行为不受影响。
    clearTimeout(lyricForeignResizeTimer);
    lyricForeignResizeTimer = setTimeout(() => {
      lyricForeignResizeTimer = null;
      if (!lyricWin || lyricWin.isDestroyed() || lyricMode === 'off') return;
      if (lyricProgrammaticMove > 0) return;
      const b2 = lyricWin.getBounds();
      const exp2 = lyricBounds(lyricMode, currentLyricDisplay());
      if (Math.abs(b2.x - exp2.x) <= 1 && Math.abs(b2.y - exp2.y) <= 1 &&
          Math.abs(b2.width - exp2.width) <= 1 && Math.abs(b2.height - exp2.height) <= 1) {
        lyricLastSetBounds = { x: b2.x, y: b2.y, width: b2.width, height: b2.height };
        return;                                        // 自愈：最终落回了期望几何
      }
      handleLyricDisplayChange();
    }, 150);
  });
}

function applyLyricMode(mode) {
  mode = (mode === 'desktop' || mode === 'taskbar') ? mode : 'off';
  lyricMode = mode;
  // 切模式 = 换一套字号 / 透明度。必须在 ensureLyricWindow 之前同步，
  // 否则新窗口会先按上一个模式的字号摆一次，再被纠正，看起来是「开了先跳一下」。
  syncLyricMetricsForMode();
  if (mode === 'off') {
    stopLyricTopGuard();
    stopLyricGeomGuard();
    if (lyricWin && !lyricWin.isDestroyed()) lyricWin.close();
    return;
  }
  ensureLyricWindow(mode);
  keepLyricOnTop();
  startLyricTopGuard();
  startLyricGeomGuard();
}

function notifyLyricState(st) {
  if (win && !win.isDestroyed()) win.webContents.send('lyric-window-state', st);
}

// 缩放变化时：字号 + 窗口尺寸一起动（桌面模式），任务栏模式只动字号和宽度。
// 写入的是**当前模式**那一格，另一个模式的字号不受影响。
function pushLyricScale(v) {
  lyricScale = clampLyricScale(v);
  lyricScales[lyricMetricKey()] = lyricScale;
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.webContents.send('lyric-scale', lyricScale);
    // 字号变了文字宽度跟着变，渲染端会重新上报 fit 宽度；这里先重摆一次，
    // 桌面模式的窗口尺寸也要立刻跟着缩放走。
    applyLyricBounds();
    keepLyricOnTop();
  }
}

// 主窗口 → 悬浮窗（只转发，内容变了才发，渲染端已去重）
ipcMain.on('lyric-data', (e, payload) => {
  lastLyricData = payload;
  if (lyricWin && !lyricWin.isDestroyed()) lyricWin.webContents.send('lyric-data', payload);
});
ipcMain.handle('lyric-get-data', () => lastLyricData);

ipcMain.on('lyric-mode', (e, mode) => { applyLyricMode(mode); });
ipcMain.on('lyric-scale', (e, v) => { pushLyricScale(v); });

// 任务栏歌词水平平移（设置菜单滑块实时调节）：
// 第二个参数 reset=true 表示「用户在主动调」——清掉手动拖动位置，
// 让平移从「自动居中 + 偏移」重新生效；启动同步（reset 缺省）不清。
ipcMain.on('lyric-offset', (e, v, reset) => {
  const n = Number(v);
  if (isFinite(n)) lyricTaskbarOffset = Math.max(-600, Math.min(600, Math.round(n)));
  if (reset) {
    lyricTaskbarCenter = null;
    lyricTaskbarX = null;
  }
  applyLyricBounds();
  keepLyricOnTop();
});

// 歌词窗手动拖动（渲染端 pointer 事件驱动，见 lyricDragOffset 注释）。
// 直接 setBounds（不走 applyLyricBounds）→ moved 事件照常触发、
// lyricProgrammaticMove === 0 → moved 处理器把它当用户拖动记录位置：
// 任务栏模式存 lyricTaskbarCenter/X（y 被拉回贴任务栏），桌面模式存 lyricDesktopPos，
// 与原生 app-region 拖动的行为完全一致。
ipcMain.on('lyric-drag', (e, st) => {
  if (!lyricWin || lyricWin.isDestroyed() || lyricMode === 'off') return;
  if (!st || typeof st !== 'object') return;
  if (st.event === 'start') {
    const b = lyricWin.getBounds();
    const sx = Number(st.screenX), sy = Number(st.screenY);
    if (!isFinite(sx) || !isFinite(sy)) return;
    lyricDragOffset = { x: sx - b.x, y: sy - b.y };
  } else if (st.event === 'move' && lyricDragOffset) {
    const b = lyricWin.getBounds();
    const sx = Number(st.screenX), sy = Number(st.screenY);
    if (!isFinite(sx) || !isFinite(sy)) return;
    let nx = Math.round(sx - lyricDragOffset.x);
    let ny = Math.round(sy - lyricDragOffset.y);
    // 夹在歌词所在显示器范围内：拖不出屏幕、也不会丢到另一块屏上
    const bd = currentLyricDisplay().bounds;
    nx = Math.max(bd.x - 8, Math.min(bd.x + bd.width - b.width + 8, nx));
    ny = Math.max(bd.y - 8, Math.min(bd.y + bd.height - b.height + 8, ny));
    lyricWin.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
  } else if (st.event === 'end') {
    lyricDragOffset = null;
  }
});

// 主窗口启动时把「两套」字号 / 透明度一次性同步过来（配置的唯一真源在主窗口，
// 主进程只负责按当前模式挑一份用）。少发一份的话重启后桌面/任务栏就互相串了。
ipcMain.on('lyric-metrics', (e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const sc = payload.scales || {};
  const op = payload.opacities || {};
  ['desktop', 'taskbar'].forEach(k => {
    if (isFinite(Number(sc[k]))) lyricScales[k] = clampLyricScale(sc[k]);
    if (isFinite(Number(op[k]))) lyricOpacities[k] = clampLyricOpacity(op[k]);
  });
  // 启动时同步任务栏水平平移偏移（reset 不带 true：别清掉可能已恢复的手动位置）
  if (isFinite(Number(payload.taskbarOffset))) {
    lyricTaskbarOffset = Math.max(-600, Math.min(600, Math.round(Number(payload.taskbarOffset))));
  }
  syncLyricMetricsForMode();
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.webContents.send('lyric-scale', lyricScale);
    lyricWin.webContents.send('lyric-style', lyricStyle);
    applyLyricBounds();
    keepLyricOnTop();
  }
  // 这里**不能**再 notify 一次 scale/opacity：主窗口收到后会把值原样写回来，
  // 而那时主进程的模式可能已经切了，等于拿桌面那份把任务栏那份覆盖掉
  // （实测：任务栏 140% 起来后被回写成 70%，字小到看不清）。
});

ipcMain.on('lyric-click-through', (e, on) => {
  lyricClickThrough = !!on;
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.setIgnoreMouseEvents(lyricClickThrough, { forward: true });
    lyricWin.webContents.send('lyric-state', { clickThrough: lyricClickThrough });
  }
  notifyLyricState({ clickThrough: lyricClickThrough });
});

// 外观选项：主窗口菜单 / 悬浮窗右键菜单都往这里写，写完广播给两边。
// 只做浅合并，所以两端都可以只发「改动的那个字段」。
ipcMain.on('lyric-style', (e, patch) => setLyricStyle(patch));
ipcMain.handle('lyric-get-style', () => lyricStyle);

// 任务栏模式：渲染端实测「当前这句文字需要多宽」，主进程据此收窄窗口。
// 以前窗口固定占任务栏一半宽，短歌词也横贯一大条，把中间那排任务栏图标压住了。
ipcMain.on('lyric-fit-width', (e, w) => {
  const n = Math.round(Number(w));
  if (!isFinite(n) || n <= 0) return;
  if (lyricMode !== 'taskbar') return;
  if (Math.abs(n - lyricFitW) < 3) return;   // 别为 1~2px 抖动反复 setBounds
  lyricFitW = n;
  applyLyricBounds();
});

// 任务栏歌词贴边预设：左 / 中 / 右（右键菜单里的快捷位置）
ipcMain.on('lyric-align', (e, where) => requestLyricAlign(where));

// 悬浮窗自己的工具按钮
ipcMain.on('lyric-action', (e, action) => {
  if (action === 'close') { applyLyricMode('off'); return; }
  if (action === 'desktop' || action === 'taskbar') {
    applyLyricMode(action);
    notifyLyricState({ mode: action });
    return;
  }
  if (action === 'lock') {
    lyricClickThrough = !lyricClickThrough;
    if (lyricWin && !lyricWin.isDestroyed()) {
      lyricWin.setIgnoreMouseEvents(lyricClickThrough, { forward: true });
      lyricWin.webContents.send('lyric-state', { clickThrough: lyricClickThrough });
    }
    notifyLyricState({ clickThrough: lyricClickThrough });
    return;
  }
  if (action === 'scale-up' || action === 'scale-down') {
    adjustLyricScale(action === 'scale-up' ? 1 : -1);
    return;
  }
});

// 字号增减：主窗口 A±/菜单、悬浮窗工具条、右键菜单三处共用一份逻辑
function adjustLyricScale(dir, step) {
  const delta = (step || 0.1) * (dir > 0 ? 1 : -1);
  pushLyricScale(Math.round((lyricScale + delta) * 20) / 20);
  notifyLyricState({ mode: lyricMode, scale: lyricScale });
}

function setLyricStyle(patch) {
  if (!patch || typeof patch !== 'object') return;
  const clean = Object.assign({}, patch);
  // 背景透明度已下线（只留文字透明度），旧配置/旧菜单推上来的字段直接丢掉
  delete clean.bgOpacity;
  // 布局只有单行 / 双行：旧配置里的 marquee 一律回落到双行
  if ('layout' in clean) clean.layout = clean.layout === 'single' ? 'single' : 'dual';
  // 文字透明度也按模式存：桌面窗和任务栏条各自记住自己那份
  if ('opacity' in clean) {
    clean.opacity = clampLyricOpacity(clean.opacity);
    lyricOpacities[lyricMetricKey()] = clean.opacity;
  }
  lyricStyle = Object.assign({}, lyricStyle, clean);
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.webContents.send('lyric-style', lyricStyle);
    // 布局会改变窗口该有多大：单行不再需要副行高度。
    // 旧的实测宽度（lyricFitW）是上一套排版量出来的，清掉重新上报。
    if ('layout' in clean) {
      lyricFitW = 0;
      applyLyricBounds();
      keepLyricOnTop();
    }
  }
  // styleMode 只说明「这份透明度属于哪个模式」，不是「请切到该模式」。
  // 用 mode 传的话，主窗口会在切模式途中收到旧模式值，把刚点的新模式又写回去。
  notifyLyricState({ style: lyricStyle, styleMode: lyricMode });
}

// 悬浮歌词右键菜单。用系统原生菜单而不是自绘面板：任务栏模式下窗口只有
// 一条任务栏那么高（约 40px），任何自绘菜单都会被窗口边界裁掉。
const LYRIC_COLORS = [
  { id: '#ffffff', label: '白色' },
  { id: '#ffe9c9', label: '暖白' },
  { id: '#ffd200', label: '亮黄' },
  { id: '#7fe3ff', label: '天青' },
  { id: '#ff9ecd', label: '樱粉' },
  { id: 'accent', label: '跟随主题色' }
];
const LYRIC_BGS = [
  { id: 'none', label: '透明（推荐）' },
  { id: 'soft', label: '轻磨砂' },
  { id: 'dark', label: '深色底' }
];

// ── 歌词迷你控制条（2026-11-21）─────────────────────────────
// 右键任务栏/桌面歌词时弹出：一条复刻任务栏缩略图工具栏观感的
// 深色圆角小条（⏮ ⏯ ⏭ ♥ ✕），替代原生的长右键菜单。
// Windows 的缩略图弹层无法由应用主动弹出，这里用无边框透明小窗实现同款观感。
let lyricRemoteWin = null;

function ensureLyricRemoteWin() {
  if (lyricRemoteWin && !lyricRemoteWin.isDestroyed()) return lyricRemoteWin;
  lyricRemoteWin = new BrowserWindow({
    width: 262,
    height: 56,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'lyric-remote-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  lyricRemoteWin.setMenuBarVisibility(false);
  lyricRemoteWin.removeMenu();
  lyricRemoteWin.loadFile(path.join(__dirname, 'renderer', 'lyric-remote.html'));
  // 要盖过歌词窗（歌词窗本身有 top guard 定时保顶，用更高层级压住）
  lyricRemoteWin.setAlwaysOnTop(true, 'screen-saver');
  // 失焦自动收起：点控制条以外的任何地方（含歌词窗、主窗口）都收起。
  // 点控制条内部按钮焦点仍在本窗不会触发 blur，无-extra 守卫需要。
  lyricRemoteWin.on('blur', () => {
    if (lyricRemoteWin && !lyricRemoteWin.isDestroyed() && lyricRemoteWin.isVisible()) {
      lyricRemoteWin.hide();
    }
  });
  lyricRemoteWin.on('closed', () => { lyricRemoteWin = null; });
  return lyricRemoteWin;
}

function hideLyricRemote() {
  if (lyricRemoteWin && !lyricRemoteWin.isDestroyed() && lyricRemoteWin.isVisible()) {
    lyricRemoteWin.hide();
  }
}

function showLyricRemote() {
  if (!lyricWin || lyricWin.isDestroyed() || lyricMode === 'off') return;
  const rw = ensureLyricRemoteWin();
  // 定位：歌词窗正上方居中；上方放不下（顶部任务栏场景）改放下方
  const lb = lyricWin.getBounds();
  const display = currentLyricDisplay();
  const wa = display.workArea;
  const rb = rw.getBounds();
  const rwW = rb.width, rwH = rb.height;
  let x = Math.round(lb.x + lb.width / 2 - rwW / 2);
  let y = Math.round(lb.y - rwH - 10);
  if (y < wa.y) y = Math.round(lb.y + lb.height + 10);
  x = Math.max(wa.x, Math.min(wa.x + wa.width - rwW, x));
  rw.setBounds({ x, y, width: rwW, height: rwH });
  if (!rw.isVisible()) {
    rw.show();
    rw.focus();
  }
  // 弹出即按最新状态渲染（playing/fav 图标）
  rw.webContents.send('remote-state', latestPlayerState);
}

function showLyricContextMenu() {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  const key = lyricMetricKey();
  const pct = Math.round(lyricScale * 100);
  const opPct = Math.round(lyricStyle.opacity * 100);
  const isTaskbar = lyricMode === 'taskbar';
  const modeName = isTaskbar ? '任务栏' : '桌面';
  try {
  // 播放控制区（2026-11-21）：把任务栏缩略图的四键 + 歌词键搬进右键菜单。
  // 状态读主进程缓存的 latestPlayerState（渲染端每次 reportPlayerState 都会上报），
  // 控制指令走 tray-control 通道（与托盘小窗/缩略图同一条，主窗口收到后真实执行）——
  // 主窗口最小化也能用，不用把它唤到前台。
  const sendTray = (action, value) => {
    if (win && !win.isDestroyed()) win.webContents.send('tray-control', action, value);
  };
  const ps = latestPlayerState || {};
  const template = [
    // 标题里带上模式：这两套字号/透明度是独立的，不写清楚用户会以为「调了没生效」
    { label: `MusicSMX 歌词 · ${modeName} · 字号 ${pct}% · 不透明度 ${opPct}%`, enabled: false },
    { label: '上一首', click: () => sendTray('prev') },
    { label: ps.playing ? '暂停' : '播放', click: () => sendTray('toggle-play') },
    { label: '下一首', click: () => sendTray('next') },
    { label: ps.fav ? '♥ 取消收藏' : '♡ 收藏这首歌', click: () => sendTray('toggle-fav') },
    { label: '歌词（点击关闭）', click: () => sendTray('toggle-lyric') },
    { type: 'separator' },
    {
      label: '字号（仅本模式）',
      submenu: [
        { label: '增大字号', accelerator: 'Ctrl+=', click: () => adjustLyricScale(1) },
        { label: '减小字号', accelerator: 'Ctrl+-', click: () => adjustLyricScale(-1) },
        { type: 'separator' },
        { label: `恢复默认（${Math.round(LYRIC_SCALE_DEFAULTS[key] * 100)}%）`,
          click: () => { pushLyricScale(LYRIC_SCALE_DEFAULTS[key]); notifyLyricState({ mode: lyricMode, scale: lyricScale }); } }
      ]
    },
    { type: 'separator' },
    {
      label: '逐字点亮',
      type: 'checkbox',
      checked: !!lyricStyle.words,
      click: (item) => setLyricStyle({ words: !!item.checked })
    },
    {
      label: '显示翻译',
      type: 'checkbox',
      checked: !!lyricStyle.translation,
      enabled: lyricMode === 'desktop',
      click: (item) => setLyricStyle({ translation: !!item.checked })
    },
    {
      label: '显示下一句',
      type: 'checkbox',
      checked: !!lyricStyle.nextLine,
      enabled: lyricMode === 'desktop',
      click: (item) => setLyricStyle({ nextLine: !!item.checked })
    },
    {
      label: '文字描边（压壁纸更清楚）',
      type: 'checkbox',
      checked: !!lyricStyle.shadow,
      click: (item) => setLyricStyle({ shadow: !!item.checked })
    },
    { type: 'separator' },
    {
      label: '布局',
      submenu: [
        { label: '单行（只显示当前句）', type: 'radio',
          checked: (lyricStyle.layout || 'dual') === 'single',
          click: () => setLyricStyle({ layout: 'single' }) },
        { label: '双行（两行固定，换句不上滚）', type: 'radio',
          checked: (lyricStyle.layout || 'dual') === 'dual',
          click: () => setLyricStyle({ layout: 'dual' }) }
      ]
    },
    {
      label: '文字透明度（仅本模式）',
      submenu: [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1].map(v => ({
        label: Math.round(v * 100) + '%',
        type: 'radio',
        checked: Math.abs((Number(lyricStyle.opacity) || 1) - v) < 0.02,
        click: () => setLyricStyle({ opacity: v })
      }))
    },
    { type: 'separator' },
    {
      // 总「文字颜色」已下线（2026-11-20）：改由已唱/未唱颜色分别控制。
      // 留空（老配置）时歌词窗会回退到 color 字段，所以 checked 用空值回退链判断。
      label: '已唱颜色',
      submenu: LYRIC_COLORS.map(c => ({
        label: c.label,
        type: 'radio',
        checked: (lyricStyle.sungColor || lyricStyle.color || '#ffffff') === c.id,
        click: () => setLyricStyle({ sungColor: c.id })
      }))
    },
    {
      label: '未唱颜色',
      submenu: LYRIC_COLORS.map(c => ({
        label: c.label,
        type: 'radio',
        checked: (lyricStyle.unsungColor || lyricStyle.color || '#ffffff') === c.id,
        click: () => setLyricStyle({ unsungColor: c.id })
      }))
    },
    {
      label: '背景',
      submenu: LYRIC_BGS.map(b => ({
        label: b.label,
        type: 'radio',
        checked: (lyricStyle.bg || 'none') === b.id,
        click: () => setLyricStyle({ bg: b.id })
      }))
    },
    {
      label: '任务栏位置',
      enabled: isTaskbar,
      submenu: [
        { label: '靠左', click: () => requestLyricAlign('left') },
        { label: '居中', click: () => requestLyricAlign('center') },
        { label: '靠右', click: () => requestLyricAlign('right') },
        { type: 'separator' },
        { label: '提示：也可以直接用鼠标拖动歌词', enabled: false }
      ]
    },
    { type: 'separator' },
    {
      label: '显示在任务栏',
      type: 'checkbox',
      checked: isTaskbar,
      click: () => applyLyricMode(isTaskbar ? 'desktop' : 'taskbar')
    },
    {
      label: '鼠标穿透',
      type: 'checkbox',
      checked: lyricClickThrough,
      click: (item) => {
        lyricClickThrough = !!item.checked;
        if (lyricWin && !lyricWin.isDestroyed()) {
          lyricWin.setIgnoreMouseEvents(lyricClickThrough, { forward: true });
          lyricWin.webContents.send('lyric-state', { clickThrough: lyricClickThrough });
        }
        notifyLyricState({ clickThrough: lyricClickThrough });
      }
    },
    { type: 'separator' },
    { label: '关闭歌词', click: () => applyLyricMode('off') }
  ];
  Menu.buildFromTemplate(template).popup({ window: lyricWin });
  } catch (e) {
    // 菜单模板出错不能连累整个主进程（右键无反应比崩溃更难查）
    console.error('[lyric-menu] 构建右键菜单失败:', e);
    notifyLyricState({ menuError: String((e && e.message) || e) });
  }
}

function requestLyricAlign(where) {
  if (lyricMode !== 'taskbar') return;
  const d = currentLyricDisplay();
  const tb = taskbarRect(d);
  const b = lyricBounds('taskbar', d);
  // 对齐也按中心锚点算：左/右贴边时把「文字中心」挪到对应位置
  if (where === 'left') lyricTaskbarCenter = tb.x + 12 + b.width / 2;
  else if (where === 'right') lyricTaskbarCenter = tb.x + tb.w - 12 - b.width / 2;
  else lyricTaskbarCenter = null;
  lyricTaskbarX = null;
  applyLyricBounds();
  notifyLyricState({ taskbarX: lyricTaskbarX });
}

// 右键歌词 → 迷你控制条（2026-11-21 用户要求：不要长菜单，只要缩略图那排小按钮 + 关闭叉）。
// 原生菜单 showLyricContextMenu() 保留未删，需要回退把 handler 换回去即可。
ipcMain.on('lyric-context-menu', () => { showLyricRemote(); });

// 迷你控制条收起（点叉号后自请求 / 歌词窗关闭时主动收）
ipcMain.on('lyric-remote-hide', () => { hideLyricRemote(); });

// 分辨率 / 缩放 / 任务栏位置变了就重算窗口位置（只需绑一次）。
// 注意：screen 模块必须等 app ready 之后才能用，顶层直接 screen.on 会让主进程
// 抛 "The 'screen' module can't be used before the app 'ready' event" 直接崩掉。
if (!lyricScreenBound) {
  lyricScreenBound = true;
  app.whenReady().then(() => {
    ['display-metrics-changed', 'display-added', 'display-removed'].forEach(ev => {
      screen.on(ev, handleLyricDisplayChange);
    });
  });
  app.on('before-quit', stopLyricTopGuard);
}

// 2K ↔ 4K 切换：窗口 DIP 尺寸可能没变，renderer 的 resize 不会触发，
// 所以除了重摆 bounds，还要把 mode/scale/style 重发一遍强制 applyFont()。
// 跨显示器时旧 DPI 下量的 lyricFitW 和旧屏幕的绝对中心都要作废，否则
// 窗口会按旧宽度摆、文字被挤大或整体横移。
function handleLyricDisplayChange() {
  if (!lyricWin || lyricWin.isDestroyed() || lyricMode === 'off') return;
  // Windows 切屏/改缩放会连发多轮 display-metrics-changed，中间的 workArea
  // 是过渡值（真机实测 1400→1360→1400、dpr 1→2→1），系统还会自己 resize /
  // move 歌词窗——渲染端的 resize→applyFont 立刻用错的 innerHeight 重算字号
  // （16.56→11.04/17.41→16.56），窗口还会飞到屏幕正中(535,660)。这些是系统
  // 级行为，主进程防抖拦不住。所以在第一帧就把歌词窗透明化：切屏本身屏幕会
  // 黑一下，这段隐身正好被盖住；等几何稳定、重摆到位后再恢复显示。
  try { lyricWin.setOpacity(0); } catch (e) { /* 窗口正在销毁 */ }
  clearTimeout(lyricDisplayChangeTimer);
  lyricDisplayChangeTimer = setTimeout(() => {
    lyricDisplayChangeTimer = null;
    applyLyricDisplayChange();
  }, 450);
}

function applyLyricDisplayChange() {
  if (!lyricWin || lyricWin.isDestroyed() || lyricMode === 'off') return;
  const d = currentLyricDisplay();
  const changed = lyricDisplayId !== null && lyricDisplayId !== d.id;
  lyricDisplayId = d.id;
  // 同一块屏改分辨率（4K↔2K，display id 不变）也算「换屏」：旧屏量出的 fit 宽度
  // 和拖动锚点是旧几何下的产物，不清就会按旧宽/旧中心摆窗（2026-11-25 用户反馈：
  // 4K 转 2K 后歌词超出屏幕）。分辨率/DPI 任一变了都清，代价只是回到新屏正中。
  const geom = { w: d.bounds.width, h: d.bounds.height, dpr: d.scaleFactor };
  const geomChanged = !!lyricLastDisplayGeom &&
    (lyricLastDisplayGeom.w !== geom.w || lyricLastDisplayGeom.h !== geom.h || lyricLastDisplayGeom.dpr !== geom.dpr);
  const oldGeom = lyricLastDisplayGeom;
  lyricLastDisplayGeom = geom;
  if (changed || geomChanged) {
    lyricGeomLog('display-reset', `${changed ? 'cross-screen' : 'same-screen-res-change'} oldGeom=${JSON.stringify(oldGeom)} newGeom=${JSON.stringify(geom)}`);
    lyricFitW = 0; // 旧显示器 DPI 下量出的宽度在新屏上不作数
    // 跨屏后旧锚点直接作废，不能只在「越界」时才清：主屏中心 1280 在
    // 1920 宽的第二屏里仍是合法值，不清就会停在偏右 246px 的位置。
    // 代价是切屏后回到新屏正中——这正是期望行为（拖过的自定义位置跨屏失效合理）。
    lyricTaskbarCenter = null;
    lyricTaskbarX = null;
    lyricLastForeignResize = null;
  }
  if (lyricDesktopPos) {
    const wa = d.workArea;
    if (lyricDesktopPos.x < wa.x - 20 || lyricDesktopPos.x > wa.x + wa.width ||
        lyricDesktopPos.y < wa.y - 20 || lyricDesktopPos.y > wa.y + wa.height) {
      lyricDesktopPos = null;
    }
  }
  applyLyricBounds(d);
  lyricWin.webContents.send('lyric-mode', lyricMode);
  lyricWin.webContents.send('lyric-scale', lyricScale);
  lyricWin.webContents.send('lyric-style', lyricStyle);
  // setBounds 是异步的：立即重发样式时，渲染端 applyFont() 读到的 innerHeight
  // 还是旧值，会按错的高度夹字号。等窗口几何落地后再补发一次，并恢复显示
  // （此时字号/位置都已稳定，用户看到的就是最终态，过渡帧全程不可见）。
  setTimeout(() => {
    if (lyricWin && !lyricWin.isDestroyed() && lyricMode !== 'off') {
      lyricWin.webContents.send('lyric-scale', lyricScale);
      lyricWin.webContents.send('lyric-style', lyricStyle);
      // 自检兜底：刚才重摆用的若还是过渡期几何（workArea 抖动的中间值），实际
      // bounds 会与稳定后的期望不符 —— 不一致就按当前显示器再夹一次，确保
      // 贴回任务栏、不出屏（2026-11-21 越界修复的最后一道闸）。
      const b = lyricWin.getBounds();
      const exp = lyricBounds(lyricMode, currentLyricDisplay());
      if (Math.abs(b.x - exp.x) > 1 || Math.abs(b.y - exp.y) > 1 ||
          Math.abs(b.width - exp.width) > 1 || Math.abs(b.height - exp.height) > 1) {
        applyLyricBounds(currentLyricDisplay());
      }
      keepLyricOnTop();
      // 若期间又来了新的切屏事件，会让 timer 重新排队；这里只在没有待处理
      // 事件时恢复，避免刚恢复又立刻隐藏造成闪烁。
      if (!lyricDisplayChangeTimer) {
        try { lyricWin.setOpacity(1); } catch (e) { /* 窗口正在销毁 */ }
      }
      // 二次自检：120ms 时 workArea 可能仍是过渡值（两次重摆都烤进过渡几何），
      // 800ms 后系统大多已稳定——不一致再夹一次，比 2s 守卫心跳更快收口。
      setTimeout(() => {
        if (!lyricWin || lyricWin.isDestroyed() || lyricMode === 'off') return;
        if (lyricDisplayChangeTimer || lyricProgrammaticMove > 0) return;
        const b2 = lyricWin.getBounds();
        const exp2 = lyricBounds(lyricMode, currentLyricDisplay());
        if (Math.abs(b2.x - exp2.x) > 1 || Math.abs(b2.y - exp2.y) > 1 ||
            Math.abs(b2.width - exp2.width) > 1 || Math.abs(b2.height - exp2.height) > 1) {
          applyLyricBounds(currentLyricDisplay());
        }
      }, 800);
    }
  }, 120);
  keepLyricOnTop();
}

// ---------- Windows 任务栏缩略图工具栏（上一首 / 播放暂停 / 下一首） ----------
function thumbarIconDir() {
  const candidates = [
    path.join(process.resourcesPath || '', 'build', 'thumbar'),
    path.join(__dirname, '..', 'build', 'thumbar')
  ];
  for (const d of candidates) {
    try { if (fs.existsSync(d)) return d; } catch (e) { /* ignore */ }
  }
  return null;
}

function loadThumbarIcon(name) {
  const dir = thumbarIconDir();
  if (!dir) return nativeImage.createEmpty();
  try {
    const img = nativeImage.createFromPath(path.join(dir, name + '.png'));
    return img.isEmpty() ? nativeImage.createEmpty() : img;
  } catch (e) {
    return nativeImage.createEmpty();
  }
}

function updateThumbar(playing, fav) {
  if (!win || win.isDestroyed()) return;
  playing = !!playing;
  fav = !!fav;
  if (thumbarPlaying === playing && thumbarFav === fav) return;
  thumbarPlaying = playing;
  thumbarFav = fav;
  const send = (action) => {
    if (win && !win.isDestroyed()) win.webContents.send('tray-control', action);
  };
  try {
    win.setThumbarButtons([
      { tooltip: '上一首', icon: loadThumbarIcon('prev'), click: () => send('prev') },
      { tooltip: playing ? '暂停' : '播放', icon: loadThumbarIcon(playing ? 'pause' : 'play'), click: () => send('toggle-play') },
      { tooltip: '下一首', icon: loadThumbarIcon('next'), click: () => send('next') },
      // 红心：和托盘小窗同一个 toggle-fav 通道（渲染端已兜底：电台/无曲目时忽略）
      { tooltip: fav ? '取消收藏' : '收藏', icon: loadThumbarIcon(fav ? 'fav-on' : 'fav-off'), click: () => send('toggle-fav') }
    ]);
  } catch (e) {
    // 窗口没有任务栏按钮（例如隐藏到托盘）时会失败，忽略。
    // 但必须回滚缓存态：否则这次失败后 thumbarPlaying 已翻转，之后真正的
    // 状态变化会被「没变过」的预判挡掉，任务栏按钮图标永远停在旧档。
    console.error('[thumbar] setThumbarButtons 失败:', e && e.message);
    thumbarPlaying = null;
    thumbarFav = null;
  }
}

// 创建系统托盘
function createTray() {
  try {
    // 尝试多个路径加载图标
    const iconPaths = [
      path.join(__dirname, '..', 'build', 'icon.png'),
      path.join(process.resourcesPath, 'build', 'icon.png'),
      path.join(app.getAppPath(), 'build', 'icon.png'),
      path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'resources', 'build', 'icon.png')
    ];
    let trayIcon = null;
    for (const p of iconPaths) {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          trayIcon = img;
          break;
        }
      } catch (e) { /* 继续尝试下一个 */ }
    }
    // 如果都失败了，用空图标创建托盘（至少能右键退出）
    if (!trayIcon || trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty();
    }
    tray = new Tray(trayIcon);
    tray.setToolTip('MusicSMX 音乐播放器');
    // 左键：显示主窗口
    tray.on('click', () => showWindow());
    // 右键：弹出迷你播放控制窗（海报+歌名歌手+播放控制）；已开着 → 再点一次收起（显式关闭途径）
    tray.on('right-click', (e, bounds) => {
      if (miniPlayer && !miniPlayer.isDestroyed() && !miniCollapsed) { hideMiniPlayer(); return; }
      if (!showMiniPlayer(bounds)) showTrayContextMenu();
    });
  } catch (e) {
    console.error('创建托盘失败:', e);
  }
}

// 原生托盘菜单（备选方案）
function showTrayContextMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { type: 'separator' },
    { label: '播放/暂停', click: () => { if (win) win.webContents.send('tray-control', 'toggle-play'); } },
    { label: '上一首', click: () => { if (win) win.webContents.send('tray-control', 'prev'); } },
    { label: '下一首', click: () => { if (win) win.webContents.send('tray-control', 'next'); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.popUpContextMenu(contextMenu);
}

function showWindow() {
  // 主窗口聚焦会让迷你窗失焦 → 走 createMiniPlayer 的 blur→hide 自动收起（点外部收起）
  if (win) {
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

// ---------- 托盘右键迷你播放控制窗 ----------
// 无边框、始终置顶、跳过任务栏；点在托盘图标正上方。点击窗口外部自动隐藏（带内部动作守卫）。
function createMiniPlayer() {
  if (miniPlayer && !miniPlayer.isDestroyed()) return miniPlayer;
  miniPlayer = new BrowserWindow({
    width: 268,
    height: 372,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    // 关掉原生窗口阴影：透明窗口上 DWM 会在整个窗口矩形四周画一圈半透明暗边，
    // 卡片本身是圆角，那圈矩形阴影看起来就是「脏边」。阴影改由 CSS（或无）负责。
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'mini-player-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  miniPlayer.setMenuBarVisibility(false);
  miniPlayer.removeMenu();
  // 初始透明：首次显示从 0 渐入（showMiniPlayer 里统一走 animateMiniOpacity）
  miniPlayer.setOpacity(0);
  miniPlayer.loadFile(path.join(__dirname, 'mini-player.html'));
  // 失焦自动收起（2026-11-20 用户要求：点击浮窗以外的区域就缩起来）。
  // 带守卫：点小窗内部的海报键时主进程会聚焦主界面、被动 blur —— 那是「点了内部按钮」
  // 而非「点了外部」，用 miniBlurGuardUntil 豁免。但 blur 只发一次，守卫期内点外部的那次
  // blur 不能白丢：守卫到点再判一次，焦点在自家主窗口=海报键的正常结果（保留），
  // 焦点在别的应用/没有焦点=用户点了外部（收起）——否则又会复现「小窗常驻收不掉」。
  miniPlayer.on('blur', () => {
    setTimeout(() => {
      if (!miniPlayer || miniPlayer.isDestroyed() || miniCollapsed) return;
      if (miniPlayer.isFocused()) return;               // 焦点又回到自己：不算外部点击
      if (Date.now() < miniBlurGuardUntil) {
        const remain = Math.max(60, miniBlurGuardUntil - Date.now() + 60);
        setTimeout(() => {
          if (!miniPlayer || miniPlayer.isDestroyed() || miniCollapsed) return;
          if (miniPlayer.isFocused()) return;
          const fw = BrowserWindow.getFocusedWindow();
          if (fw === win) return;                        // 内部动作（海报键）把焦点交给主界面：保留
          hideMiniPlayer();                              // 其余情况（点了外部）：收起
        }, remain);
        return;
      }
      hideMiniPlayer();
    }, 180);
  });
  miniPlayer.on('closed', () => { miniPlayer = null; });
  hookLyricRestoreOnDeactivate(miniPlayer);           // 从小窗点别的应用时歌词也要秒回
  return miniPlayer;
}

function showMiniPlayer(bounds) {
  try {
    clearTimeout(miniDestroyTimer); // 刚要销毁又打开了：留着别销毁
    miniDestroyTimer = null;
    const mp = createMiniPlayer();
    const [w, h] = mp.getSize();
    // 定位到托盘图标正上方：水平居中于图标，底边贴图标顶部留 8px
    let x, y;
    if (bounds && typeof bounds.x === 'number' && typeof bounds.y === 'number') {
      x = Math.round(bounds.x + bounds.width / 2 - w / 2);
      y = Math.round(bounds.y - h - 8);
      // 防止超出屏幕：夹到当前显示器工作区内
      const disp = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
      const wa = disp.workArea;
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
      if (y < wa.y) y = Math.round(bounds.y + bounds.height + 8); // 下方空间兜底
      y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
    } else {
      // 拿不到 bounds 时：主显示器右下角、任务栏上方
      const wa = screen.getPrimaryDisplay().workArea;
      x = wa.x + wa.width - w - 12;
      y = wa.y + wa.height - h - 12;
    }
    mp.setPosition(x, y);
    // 把最新播放状态推给小窗（DOM 就绪后再发，避免首帧空白）；主题变量一起补发
    const push = () => {
      if (!mp || mp.isDestroyed()) return;
      if (latestMiniTheme) mp.webContents.send('mini-theme', latestMiniTheme);
      mp.webContents.send('mini-state', latestPlayerState);
    };
    if (mp.webContents.isLoading()) mp.webContents.once('did-finish-load', push);
    else push();
    // 恢复显示：收起态是鼠标穿透的渐隐窗口（不是 hide），先摆好位置再渐入，
    // 复用窗口也不会闪。show() 对已显示窗口是 no-op， focus() 抢前台。
    try {
      mp.setIgnoreMouseEvents(false);
    } catch (e) { /* 窗口刚销毁 */ }
    miniCollapsed = false;
    mp.show();
    mp.focus();
    // 渐入：从当前透明度（首次创建=0，复用=渐出中断处的值）平滑升到 1
    animateMiniOpacity(1, 320);
    return true;
  } catch (e) {
    console.error('显示迷你播放窗失败:', e);
    return false;
  }
}

// 迷你窗透明度渐变（2026-11-20 用户要求渐进渐出）。主进程没有 rAF，用 16ms
// 定时器步进 + ease-out 三次曲线；窗口是 transparent 的，setOpacity 走系统分层
// 合成，动画期间不丢 DWM 缓冲、无闪烁（与「不用 hide()」的既有结论同源）。
// 同一时间只允许一个动画：渐入到一半又点外部 → 渐出从当前值平滑接续，不跳变。
function animateMiniOpacity(target, ms) {
  if (miniFadeTimer) { clearInterval(miniFadeTimer); miniFadeTimer = null; }
  if (!miniPlayer || miniPlayer.isDestroyed()) return;
  let start;
  try { start = miniPlayer.getOpacity(); } catch (e) { return; }
  if (Math.abs(start - target) < 0.005) {
    try { miniPlayer.setOpacity(target); } catch (e) {}
    return;
  }
  const t0 = Date.now();
  miniFadeTimer = setInterval(() => {
    if (!miniPlayer || miniPlayer.isDestroyed()) { clearInterval(miniFadeTimer); miniFadeTimer = null; return; }
    const p = Math.min(1, (Date.now() - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);            // ease-out cubic
    try { miniPlayer.setOpacity(start + (target - start) * eased); } catch (e) {}
    if (p >= 1) { clearInterval(miniFadeTimer); miniFadeTimer = null; }
  }, 16);
}

function hideMiniPlayer() {
  if (miniPlayer && !miniPlayer.isDestroyed() && !miniCollapsed) {
    // 收起不用 hide()：透明窗口 hide→show 时 DWM 会丢合成缓冲，重 show 首帧闪烁
    // （实测：首次打开不闪、复用打开必闪）。改 opacity 渐出 + 鼠标穿透，窗口保持合成。
    miniCollapsed = true;
    try {
      miniPlayer.blur();                    // 别让透明窗口隐持键盘焦点
      miniPlayer.setIgnoreMouseEvents(true); // 立即穿透：动画期间也不挡住下面的点击
      animateMiniOpacity(0, 280);
    } catch (e) { /* 窗口刚销毁 */ }
    // 收起即恢复守卫的 moveTop（迷你窗开着期间歌词让位不提顶），
    // 别等下一个轮询 —— 否则这时任务栏可能正盖着歌词条。
    if (lyricMode !== 'off') keepLyricOnTop();
    scheduleMiniDestroy();
  }
}

// 小窗隐藏后延迟销毁：每个 BrowserWindow 自带一个 renderer 进程（实测 60~100MB），
// 只是 hide 的话进程一直挂着，用户不点托盘就白占一份内存。
// 延迟几秒是为了「关掉又马上打开」时不重复开窗；showMiniPlayer 会取消这个定时。
const MINI_DESTROY_DELAY = 8000;
function scheduleMiniDestroy() {
  clearTimeout(miniDestroyTimer);
  miniDestroyTimer = setTimeout(() => {
    miniDestroyTimer = null;
    if (!miniPlayer || miniPlayer.isDestroyed() || !miniCollapsed) return;
    miniPlayer.destroy();
    miniPlayer = null;
  }, MINI_DESTROY_DELAY);
}

// 媒体键（键盘上的 ⏯ / ⏮ / ⏭ / 耳机线控 / 罗技 G913 这类多媒体按键）
// 两条路并存：
//  1) globalShortcut 抢 MediaPlayPause / MediaNextTrack / MediaPreviousTrack —— 不依赖焦点、
//     不依赖系统「当前媒体会话」归谁，G913 这类键盘实测只有这条路稳。
//  2) MediaSession（渲染进程 setActionHandler）—— 供 Windows 音量浮层、蓝牙耳机等 SMTC 按钮用。
// 为什么不用 Chromium 自带的 HardwareMediaKeyHandling 单独扛：
// Windows 上它靠 mediaSession.playbackState 判断「这一下该发 play 还是 pause」，
// 暂停后这个状态经常没同步回去，于是按键永远只发 pause（用户看到的就是「只能暂停、按不回来」）。
// 两条路会同时收到同一次按键，所以渲染进程入口统一做了 400ms 去重（mediaKeyToggle / mediaKeyStep）。
let mediaKeyRegistered = false;
let mediaKeyRetryTimer = null;
function registerMediaKeys(quiet = false) {
  const forward = (action) => {
    if (win && !win.isDestroyed()) win.webContents.send('tray-control', action);
  };
  const bind = (accelerator, action) => {
    // 已经拿到就跳过（重试时不能重复 register，否则会覆盖自己上一次的注册）
    if (globalShortcut.isRegistered(accelerator)) return true;
    try {
      const ok = globalShortcut.register(accelerator, () => forward(action));
      if (!ok && !quiet) console.warn(`[musicbuddy] 媒体键 ${accelerator} 注册失败（被其它播放器/键盘驱动独占），交给媒体会话兜底`);
      return ok;
    } catch (e) {
      if (!quiet) console.warn(`[musicbuddy] 媒体键 ${accelerator} 注册异常:`, e.message);
      return false;
    }
  };
  // 三个键全抢：只抢播放/暂停的话，上/下一首只能指望系统会话路由（多播放器共存时常常轮不到我们）。
  // 上/下一首发 media-next / media-prev，和托盘小窗的 next/prev 分开，避免小窗连点被去重吞掉。
  mediaKeyRegistered = bind('MediaPlayPause', 'media-toggle');
  const nextOk = bind('MediaNextTrack', 'media-next');
  const prevOk = bind('MediaPreviousTrack', 'media-prev');
  const allOk = mediaKeyRegistered && nextOk && prevOk;
  if (!quiet) console.log(`[musicbuddy] 媒体键注册：play=${mediaKeyRegistered} next=${nextOk} prev=${prevOk}`);
  if (!allOk) scheduleMediaKeyRetry();
  return allOk;
}

// Windows 的全局热键是「独占 + 先到先得」：QQ音乐这类播放器常年占着上一首/下一首，
// 我们启动时就抢不到。做法是每 20 秒试探一次，等它退出/释放（或用户在它设置里关掉全局快捷键）
// 就自动接管，不用重启 MusicSMX。三个键都拿到后定时器自行停止。
function scheduleMediaKeyRetry() {
  if (mediaKeyRetryTimer) return;
  mediaKeyRetryTimer = setInterval(() => {
    if (registerMediaKeys(true)) {
      clearInterval(mediaKeyRetryTimer);
      mediaKeyRetryTimer = null;
      console.log('[musicbuddy] 媒体键已全部接管（先前被独占的上一首/下一首已释放）');
      if (win && !win.isDestroyed()) win.webContents.send('tray-control', 'media-keys-ready');
    }
  }, 20000);
}

app.whenReady().then(() => {
  try {
    const cfg = loadConfig();
    if (cfg && cfg.settings && typeof cfg.settings.closeToTray === 'boolean') {
      closeToTray = cfg.settings.closeToTray;
    }
  } catch (e) { /* ignore */ }
  createWindow();
  createTray();
  registerMediaKeys();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// 窗口全部关闭时不退出（托盘还在运行）
app.on('window-all-closed', (e) => {
  // 不调用 app.quit()，保持托盘运行
});

// 退出时把全局快捷键还回去（进程结束时系统一般也会回收，但显式释放更干净）
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  if (mediaKeyRetryTimer) { clearInterval(mediaKeyRetryTimer); mediaKeyRetryTimer = null; }
  if (miniPlayer && !miniPlayer.isDestroyed()) miniPlayer.destroy();
  miniPlayer = null;
});

// ---------- IPC ----------
// 托盘弹窗控制命令
ipcMain.on('tray-control', (e, action) => {
  // 托盘菜单 / 任务栏缩略图按钮 → 渲染进程执行播放控制
  if (win && !win.isDestroyed()) win.webContents.send('tray-control', action);
});

// 渲染进程同步「关闭按钮行为」
ipcMain.on('set-close-to-tray', (e, enabled) => {
  closeToTray = enabled !== false;
});

// 开机自启：读写系统登录项（注册表 HKCU Run）。打包版注册 MusicSMX.exe 本体；
// 开发版注册的是 electron.exe + 应用路径参数，实测可正常拉起，仅日志提示。
ipcMain.handle('get-autostart', () => {
  try { return app.getLoginItemSettings().openAtLogin === true; }
  catch (err) { return false; }
});
ipcMain.handle('set-autostart', (e, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled !== false, path: process.execPath });
    return { ok: true };
  } catch (err) {
    console.error('设置开机自启失败:', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 渲染进程上报播放状态 → 更新任务栏缩略图工具栏图标 + 托盘迷你窗
ipcMain.on('player-state', (e, state) => {
  if (state && typeof state === 'object') {
    const vol = Number(state.volume);
    const mode = String(state.mode || '');
    latestPlayerState = {
      title: String(state.title || ''),
      artist: String(state.artist || ''),
      cover: String(state.cover || ''),
      playing: !!state.playing,
      volume: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : latestPlayerState.volume,
      muted: !!state.muted,
      mode: ['list', 'one', 'shuffle'].includes(mode) ? mode : latestPlayerState.mode,
      fav: !!state.fav,   // 收藏红心：不缓存的话小窗红心永远点不亮
      lyric: !!state.lyric // 歌词开关（桌面/任务栏歌词）状态，小窗歌词键激活态用
    };
    if (miniPlayer && !miniPlayer.isDestroyed()) {
      // 只要小窗进程活着就推：isVisible() 在透明无边框窗口上有过误报，
      // 导致小窗点播放后收不到新状态、播放键永远是播放图标。
      miniPlayer.webContents.send('mini-state', latestPlayerState);
    }
    // 歌词迷你控制条同步（⏯/♥ 图标实时跟随）
    if (lyricRemoteWin && !lyricRemoteWin.isDestroyed()) {
      lyricRemoteWin.webContents.send('remote-state', latestPlayerState);
    }
  }
  updateThumbar(!!(state && state.playing), !!(state && state.fav));
});

// 迷你窗按钮 → 转发到主窗口的播放控制（复用 tray-control 通道）
// volume 带一个 0~1 的数值，渲染进程直接 set + applyVolume；其余保持原字符串动作。
ipcMain.on('mini-control', (e, action, value) => {
  // 注意：这里不能给 toggle-lyric 设 blur 守卫——blur 事件只发一次，守卫期内用户点外部
  // 的那次 blur 会被豁免掉，之后再也没有 blur 可触发，小窗就永久收不掉（实测踩坑）。
  // 歌词窗已是 focusable:false 不抢焦点（约束 132），正常不会引发小窗失焦。
  if (win && !win.isDestroyed()) win.webContents.send('tray-control', action, value);
});

// 主窗口推送主题变量 → 缓存 + 转发迷你窗（换主题色/底色时小窗实时跟着变）
ipcMain.on('mini-theme', (e, theme) => {
  if (theme && typeof theme === 'object') {
    latestMiniTheme = theme;
    if (miniPlayer && !miniPlayer.isDestroyed()) {
      miniPlayer.webContents.send('mini-theme', theme);
    }
  }
});
ipcMain.on('mini-close', () => hideMiniPlayer());
ipcMain.on('mini-show-main', () => {
  // 点的是小窗内部的海报键（不是外部区域）：主窗口聚焦引发的 blur 不收起小窗
  miniBlurGuardUntil = Date.now() + 1500;
  showWindow();
});
ipcMain.on('mini-quit', () => { isQuitting = true; app.quit(); });

// 窗口控制（无边框窗口用）
ipcMain.on('window-minimize', () => { if (win) win.minimize(); });
ipcMain.on('window-maximize', () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize(); } });
ipcMain.on('window-close', () => { if (win) win.close(); });
ipcMain.handle('window-is-maximized', () => win ? win.isMaximized() : false);

// 沉浸全屏（F11 / 播放页右下角按钮）：真全屏，连标题栏一起隐藏
ipcMain.on('window-fullscreen', (e, on) => {
  if (!win || win.isDestroyed()) return;
  const want = !!on;
  if (win.isFullScreen() !== want) win.setFullScreen(want);
});
ipcMain.handle('window-is-fullscreen', () => (win && !win.isDestroyed()) ? win.isFullScreen() : false);

ipcMain.handle('pick-folders', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择音乐文件夹',
    properties: ['openDirectory', 'multiSelections']
  });
  return r.canceled ? [] : r.filePaths;
});

// 选择本地歌词文件
ipcMain.handle('pick-lyrics-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择歌词文件',
    properties: ['openFile'],
    filters: [
      { name: '歌词文件', extensions: ['lrc', 'txt'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const fs = require('fs');
  const content = fs.readFileSync(r.filePaths[0], 'utf-8');
  return { path: r.filePaths[0], content };
});

ipcMain.handle('scan', async (e, paths, recursive = true) => {
  if (!Array.isArray(paths)) return [];
  const sender = e.sender;
  return await scanPaths(paths, (done, total) => {
    try { sender.send('scan-progress', { done, total }); } catch (err) { /* 窗口可能已关闭 */ }
  }, recursive);
});

ipcMain.handle('get-config', () => loadConfig());
// 便携版首次启动是否继承了旧版本数据（供界面提示一次，平时返回 null）
ipcMain.handle('portable-inherit-info', () => portableInheritInfo);

ipcMain.handle('set-config', (e, cfg) => {
  // 合并写，不是整份替换：渲染进程任何一处「只写几个键」的局部保存
  // 都不该把没提到的键（歌单 / 收藏 / 导入顺序 / 当前排序）从磁盘上抹掉。
  const cur = loadConfig() || {};
  const next = Object.assign({}, cur, cfg || {});
  if (cfg && cfg.settings && typeof cfg.settings === 'object') {
    next.settings = Object.assign({}, cur.settings || {}, cfg.settings);
  }
  saveConfig(next);
  return true;
});

// ---------- 联网元数据 ----------
ipcMain.handle('fetch-cover', async (e, { artist, title }) => {
  const info = await online.searchCover(artist, title);
  if (!info) return { ok: false, error: '未找到封面' };
  // 首选源的图可能挂了（实测 QQ 音乐 600x600 规格 404），下载失败不能就此放弃：
  // 把其它来源都搜一遍，逐个尝试下载，第一个能下的就用。
  let dataUrl = await online.downloadCover(info.url);
  if (dataUrl) return { ok: true, dataUrl, info };
  try {
    const candidates = await online.searchCoverCandidates(artist, title);
    for (const cand of candidates) {
      if (cand.url === info.url) continue;
      dataUrl = await online.downloadCover(cand.url);
      if (dataUrl) return { ok: true, dataUrl, info: cand };
      if (cand.thumbUrl && cand.thumbUrl !== cand.url) {
        dataUrl = await online.downloadCover(cand.thumbUrl);
        if (dataUrl) return { ok: true, dataUrl, info: cand };
      }
    }
  } catch (e) { /* 兜底全挂就返回失败 */ }
  return { ok: false, error: '封面下载失败' };
});

ipcMain.handle('fetch-lyrics', async (e, { artist, title, duration }) => {
  const result = await online.searchLyrics(artist, title, duration);
  if (!result) return { ok: false, error: '未找到歌词' };
  return {
    ok: true,
    lrc: result.lrc,
    tlyric: result.tlyric || '',
    rlyric: result.rlyric || '',
    yrc: result.yrc || '',
    info: result
  };
});

ipcMain.handle('fetch-lyrics-from-source', async (e, { source, artist, title, duration }) => {
  const result = await online.searchLyricsFromSource(source, artist, title, duration);
  if (!result) return { ok: false, error: '该来源未找到歌词' };
  return {
    ok: true,
    lrc: result.lrc,
    tlyric: result.tlyric || '',
    rlyric: result.rlyric || '',
    yrc: result.yrc || '',
    info: result
  };
});

// 抓取歌单顺序（支持QQ音乐和网易云）
ipcMain.handle('fetch-playlist', async (e, { url }) => {
  const result = await online.fetchPlaylistByUrl(url);
  if (!result) return { ok: false, error: '抓取歌单失败' };
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, data: result };
});

// 2026-11-20 缓存目录合并：封面(.jpg/.png/.webp)与歌词(.lrc/.lrc.json)共用一个 cache
// 文件夹，按扩展名区分，不再分开设置两个路径。covers/lyrics 两个旧默认目录仍保留
// 在磁盘上作为迁移源（scan-local-cache 首次扫描时并入 cache）。
function defaultCacheDir() {
  return path.join(app.getPath('userData'), 'cache');
}

// 旧缓存并入：目标目录一个文件都没有时，把 legacyDirs + 旧默认目录里的文件复制进去。
// 只复制不覆盖、不删源（源目录留着当备份，用户想清自己删）；已有内容视为已迁移直接跳过。
function migrateLegacyCache(targetDir, legacyDirs) {
  if (!targetDir) return;
  try {
    let hasFiles = false;
    try { hasFiles = fs.readdirSync(targetDir).some(f => !f.startsWith('.')); } catch (e) {}
    if (hasFiles) return;
    fs.mkdirSync(targetDir, { recursive: true });
    const srcs = new Set(legacyDirs || []);
    srcs.add(path.join(app.getPath('userData'), 'covers'));
    srcs.add(path.join(app.getPath('userData'), 'lyrics'));
    let copied = 0;
    for (const src of srcs) {
      if (!src || src === targetDir || !fs.existsSync(src)) continue;
      let files = [];
      try { files = fs.readdirSync(src).filter(f => { try { return fs.statSync(path.join(src, f)).isFile(); } catch (e) { return false; } }); } catch (e) { continue; }
      for (const f of files) {
        const dst = path.join(targetDir, f);
        if (fs.existsSync(dst)) continue;
        try { fs.copyFileSync(path.join(src, f), dst); copied++; } catch (e) {}
      }
    }
    if (copied) console.log(`[cache-migrate] 已并入 ${copied} 个缓存文件 → ${targetDir}`);
  } catch (e) {
    console.error('缓存目录迁移失败:', e);
  }
}

ipcMain.handle('save-cover', (e, { dataUrl, saveDir, artist, title }) => {
  // 默认保存到软件数据目录的 cache 文件夹（与歌词同目录，按扩展名区分）
  const dir = saveDir || defaultCacheDir();
  const fpath = online.saveCoverFile(dataUrl, dir, artist, title);
  return { ok: !!fpath, path: fpath };
});

ipcMain.handle('save-lyrics', (e, { lrc, saveDir, artist, title, tlyric, rlyric, yrc, meta }) => {
  // 默认保存到软件数据目录的 cache 文件夹（与封面同目录）
  const dir = saveDir || defaultCacheDir();
  // lrc 可能是纯字符串（旧调用），也可能是一个完整对象；统一成对象再落盘
  const payload = (lrc && typeof lrc === 'object')
    ? lrc
    : { lrc, tlyric: tlyric || '', rlyric: rlyric || '', yrc: yrc || '' };
  const fpath = online.saveLyricsFile(payload, dir, artist, title, meta);
  return { ok: !!fpath, path: fpath };
});

// 歌词调速写进歌词缓存边车（.lrc.json 的 offset 字段）：偏移跟着缓存文件走，路径无关
ipcMain.handle('save-lyric-offset', (e, { saveDir, artist, title, offset }) => {
  const dir = saveDir || defaultCacheDir();
  return { ok: online.saveLyricsOffset(dir, artist, title, offset) };
});

// 获取默认的缓存目录（封面+歌词共用）
ipcMain.handle('get-default-dirs', () => {
  return {
    cache: defaultCacheDir(),
    covers: path.join(app.getPath('userData'), 'covers'),
    lyrics: path.join(app.getPath('userData'), 'lyrics'),
    userData: app.getPath('userData')
  };
});

// 扫描本地已保存的封面和歌词缓存（2026-11-20 合并后两个参数通常指向同一个 cache 目录，
// 按扩展名区分；legacyDirs 是旧版分开设置的目录，首次扫描时自动并入）
ipcMain.handle('scan-local-cache', (e, { coverDir, lyricsDir, legacyDirs }) => {
  const result = { covers: [], lyrics: [] };
  try {
    const cDir = coverDir || defaultCacheDir();
    const lDir = lyricsDir || cDir;
    migrateLegacyCache(cDir, legacyDirs);
    // 扫描封面
    if (fs.existsSync(cDir)) {
      const files = fs.readdirSync(cDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      result.covers = files.map(f => ({
        name: f,
        path: path.join(cDir, f),
        key: f.replace(/\.(jpg|jpeg|png|webp)$/i, '').toLowerCase()
      }));
    }
    // 扫描歌词
    if (fs.existsSync(lDir)) {
      const files = fs.readdirSync(lDir).filter(f => /\.lrc$/i.test(f));
      result.lyrics = files.map(f => ({
        name: f,
        path: path.join(lDir, f),
        key: f.replace(/\.lrc$/i, '').toLowerCase()
      }));
    }
  } catch (e) {
    console.error('扫描本地缓存失败:', e);
  }
  return result;
});

// 读取本地封面文件为 dataURL
ipcMain.handle('read-cover-file', (e, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const buf = fs.readFileSync(filePath);
    const dataUrl = `data:${mime};base64,` + buf.toString('base64');
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 读取本地歌词文件
ipcMain.handle('read-lyrics-file', (e, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const lrc = fs.readFileSync(filePath, 'utf8');
    // 旁边如果有 .lrc.json 边车文件，说明这份缓存带翻译/音译/逐字数据，一起返回。
    // 只有老缓存才没有它，此时退回纯 LRC 行为。
    let extra = null;
    const sidecar = filePath + '.json';
    try {
      if (fs.existsSync(sidecar)) {
        const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
        if (parsed && typeof parsed === 'object') extra = parsed;
      }
    } catch (err) { /* 边车损坏就当不存在，不要影响正文读取 */ }
    return {
      ok: true,
      lrc: (extra && extra.lrc) || lrc,
      tlyric: (extra && extra.tlyric) || '',
      rlyric: (extra && extra.rlyric) || '',
      yrc: (extra && extra.yrc) || '',
      // 边车里存过的歌词调速（秒）：文件挪过位置也能取回
      offset: (extra && typeof extra.offset === 'number') ? extra.offset : null
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择文件夹',
    properties: ['openDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('show-item-in-folder', (e, filePath) => {
  try {
    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('open-folder', (e, folderPath) => {
  try {
    const { shell } = require('electron');
    const fs = require('fs');
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    shell.openPath(folderPath);
    return true;
  } catch (e) {
    return false;
  }
});

// 自动修复歌曲信息
ipcMain.handle('search-song-info', async (e, { artist, title }) => {
  return online.searchSongInfo(artist, title);
});
// 歌手在线歌曲搜索（双击歌手筛选时追加灰色网络歌曲行）
ipcMain.handle('search-artist-online', (e, { artist }) => online.searchArtistSongs(artist));
// 专辑在线歌曲搜索（点击专辑筛选时同样联网补齐）
ipcMain.handle('search-album-online', (e, { album }) => online.searchAlbumSongs(album));
// 关键词在线歌曲搜索（主页搜索本地没有时推送网络歌曲）
ipcMain.handle('search-online-songs', (e, { keyword }) => online.searchSongsByKeyword(keyword));
// 免费下载链接：双平台搜索精确匹配后取播放直链；会员歌返回 vip 标记
ipcMain.handle('get-download-link', (e, { artist, title, duration }) => online.getFreeDownloadLink(artist, title, duration));
ipcMain.handle('auto-fix-track', async (e, { artist, title, album, duration }) => {
  return online.autoFixTrackInfo(artist, title, album, duration);
});

// 补全歌曲信息：用「歌名 + 歌手」反查专辑（同时给出候选专辑列表）
ipcMain.handle('complete-track-info', async (e, payload) => {
  try {
    return await online.completeTrackInfo(payload || {});
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// 右键「联网查看」：解析出单曲 / 歌手 / 专辑的平台页面地址（解析不到就返回搜索页）
ipcMain.handle('resolve-online-page', async (e, payload) => {
  try {
    const data = await online.resolveOnlineLinks(payload || {});
    if (!data || !data.url) return { ok: false, error: '没能解析出页面地址' };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// 用系统默认浏览器打开链接（只放行 http/https，杜绝 file:// 之类）
ipcMain.handle('open-external', async (e, url) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只允许打开 http/https 链接' };
  try {
    await shell.openExternal(u);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ---------- 版本号与更新检查 ----------
ipcMain.handle('get-app-version', () => app.getVersion());

// 语义化版本比较：1.2.10 > 1.2.9；忽略 v 前缀
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// 查 GitHub Releases 最新版：仓库里推的是源码，安装包只存在于 Release 的 assets 里。
// 源码推送本身不会产生安装包——发布走 GitHub Actions（见 .github/workflows/release.yml）
// 或手动上传 setup.exe 到 Release。
ipcMain.handle('check-update', async () => {
  const current = app.getVersion();
  const result = { ok: false, current, latest: null, updateAvailable: false, htmlUrl: null, downloadUrl: null, notes: '', error: null };
  const fetchUrl = (url) => new Promise((resolve, reject) => {
    const req = net.request(url);
    req.setHeader('User-Agent', 'MusicSMX-Updater');
    req.setHeader('Accept', 'application/vnd.github+json');
    req.on('response', (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
  try {
    const r = await fetchUrl('https://api.github.com/repos/sunmanxu/MusicSMX/releases/latest');
    if (r.status === 404) { result.error = '仓库还没有发布过 Release'; return result; }
    if (r.status !== 200) { result.error = 'GitHub 返回 ' + r.status; return result; }
    const rel = JSON.parse(r.body);
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    result.ok = true;
    result.latest = latest;
    result.updateAvailable = cmpVer(latest, current) > 0;
    result.htmlUrl = rel.html_url || null;
    result.notes = rel.body || '';
    // 优先找 setup.exe 安装包资产，找不到就退回 Release 页面
    const assets = rel.assets || [];
    const setup = assets.find(a => /setup\.exe$/i.test(a.name)) || assets.find(a => /\.exe$/i.test(a.name));
    result.downloadUrl = setup ? setup.browser_download_url : result.htmlUrl;
    return result;
  } catch (err) {
    result.error = err.message || String(err);
    return result;
  }
});

// ---------- 写入音乐文件元数据（ID3标签） ----------
const { execFile } = require('child_process');

function getFfmpegPath() {
  // 开发环境：项目 bin 目录
  const devPath = path.join(__dirname, '..', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(devPath)) return devPath;
  // 打包后：exe 同级目录的 bin 文件夹
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const portablePath = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'bin', 'ffmpeg.exe');
    if (fs.existsSync(portablePath)) return portablePath;
  }
  // 打包后：resources 目录
  const resPath = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(resPath)) return resPath;
  return null;
}

// 删除临时/备份文件：Windows 上刚 rename 过的文件偶尔会被索引器或杀软短暂占用（EPERM/EBUSY），
// 单次 unlink 失败会留下 .xxx.smxbak-* 垃圾文件，所以重试几次
function unlinkWithRetry(p, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { fs.unlinkSync(p); return true; } catch (e) {
      if (e.code === 'ENOENT') return true;
      if (i === tries - 1) return false;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); } catch (e2) {}
    }
  }
  return false;
}

// 把曲库里的歌名 / 歌手 / 专辑写回音频文件本身的标签（资源管理器"标题/参与创作的艺术家/专辑"列读的就是它）
// 只重写容器里的标签区，音频流原样复制（-c copy）：不转码、不改音质、时长不变。
// 坑：Ogg 系的标签在流级 Vorbis Comment 里，只写 -metadata（容器级）会被复制过来的旧流标签压住
//     （实测：原文件已有 album 时改不动），必须同时写 -metadata:s:0；mp3/flac/wav 只需容器级。
function writeMusicMetadata(filePath, meta) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) { reject(new Error('ffmpeg 未找到，无法写入元数据')); return; }
    if (!filePath || !fs.existsSync(filePath)) { reject(new Error('文件不存在: ' + filePath)); return; }

    const { title, artist, album } = meta || {};
    const fields = [];
    if (title !== undefined) fields.push(['title', String(title)]);
    if (artist !== undefined) fields.push(['artist', String(artist)]);
    if (album !== undefined) fields.push(['album', String(album)]);
    if (!fields.length) { resolve({ ok: true, skipped: true }); return; }

    const ext = path.extname(filePath).toLowerCase();
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, ext);
    const rand = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    // 临时文件用点前缀：万一中途崩溃，音乐库里也不会多出看得见的怪文件
    const tmpPath = path.join(dir, '.' + baseName + '.smxtag-' + rand + ext);
    const bakPath = path.join(dir, '.' + baseName + '.smxbak-' + rand + ext);
    let st = null;
    try { st = fs.statSync(filePath); } catch (e) {}

    const cleanup = () => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
      try { if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath); } catch (e) {}
    };

    const isOgg = ext === '.ogg' || ext === '.oga' || ext === '.opus';
    const isMp3 = ext === '.mp3';

    // -map_metadata 0 先把原标签整体带过来再逐项覆盖，避免丢掉封面/流派/年份/音轨号等其它字段
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-map_metadata', '0', '-c', 'copy'];
    for (const [k, v] of fields) args.push('-metadata', k + '=' + v);
    if (isOgg) {
      for (const [k, v] of fields) args.push('-metadata:s:0', k + '=' + v);
    }
    if (isMp3) args.push('-id3v2_version', '3', '-write_id3v1', '1');
    args.push(tmpPath);

    execFile(ffmpeg, args, { timeout: 180000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        cleanup();
        const last = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).pop();
        reject(new Error('写入失败: ' + (last || error.message)));
        return;
      }
      try {
        if (!fs.existsSync(tmpPath)) { cleanup(); reject(new Error('临时文件未生成')); return; }
        const outSize = fs.statSync(tmpPath).size;
        // 音频流是复制的，体积不该有大变化；差太多说明这次写入有问题，宁可不动原文件
        if (outSize < 1024 || (st && Math.abs(outSize - st.size) > Math.max(1048576, st.size * 0.2))) {
          cleanup();
          reject(new Error('输出文件大小异常（' + outSize + ' 字节），已放弃替换'));
          return;
        }
        // 同目录内两次 rename：先备份，再换成新文件，失败就回滚
        fs.renameSync(filePath, bakPath);
        try {
          fs.renameSync(tmpPath, filePath);
        } catch (e) {
          try { fs.renameSync(bakPath, filePath); } catch (e2) {}
          cleanup();
          reject(new Error('替换文件失败（可能正被其他程序占用）: ' + e.message));
          return;
        }
        try { if (fs.existsSync(bakPath)) unlinkWithRetry(bakPath); } catch (e) {}
        // 保留原文件的修改时间：写标签不该让文件在资源管理器里"变成新的"
        if (st) { try { fs.utimesSync(filePath, st.atime, st.mtime); } catch (e) {} }
        resolve({ ok: true, size: outSize });
      } catch (e) {
        try {
          if (fs.existsSync(bakPath) && !fs.existsSync(filePath)) fs.renameSync(bakPath, filePath);
        } catch (e2) {}
        cleanup();
        reject(e);
      }
    });
  });
}

// 读文件当前标签（批量写入前用来判断"缺哪些字段"，避免把每个文件都重写一遍）
ipcMain.handle('read-file-tags', async (e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const meta = await readMeta(filePath);
    return {
      ok: true,
      title: (meta && meta.title) || '',
      artist: (meta && meta.artist) || '',
      album: (meta && meta.album) || ''
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('write-music-metadata', async (e, { filePath, title, artist, album }) => {
  try {
    await writeMusicMetadata(filePath, { title, artist, album });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 转换为 MP3
function convertToMp3(filePath, bitrate) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) { reject(new Error('ffmpeg 未找到')); return; }
    if (!fs.existsSync(filePath)) { reject(new Error('文件不存在')); return; }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp3') { reject(new Error('已经是 MP3 格式')); return; }
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, ext);
    const outPath = path.join(dir, baseName + '.mp3');
    // 如果输出文件已存在，加后缀
    let finalOutPath = outPath;
    let counter = 1;
    while (fs.existsSync(finalOutPath)) {
      finalOutPath = path.join(dir, baseName + '_' + counter + '.mp3');
      counter++;
    }
    const br = bitrate || '320k';
    const args = [
      '-y', '-i', filePath,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', br,
      '-id3v2_version', '3',
      '-write_id3v1', '1',
      finalOutPath
    ];
    execFile(ffmpeg, args, { timeout: 120000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        try { if (fs.existsSync(finalOutPath)) fs.unlinkSync(finalOutPath); } catch (e) {}
        reject(new Error('转换失败: ' + error.message));
        return;
      }
      if (!fs.existsSync(finalOutPath) || fs.statSync(finalOutPath).size < 1000) {
        reject(new Error('转换后文件无效'));
        return;
      }
      resolve({ ok: true, outputPath: finalOutPath });
    });
  });
}

ipcMain.handle('convert-to-mp3', async (e, { filePath, bitrate }) => {
  try {
    const result = await convertToMp3(filePath, bitrate);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 多格式转换
const FORMAT_CONFIG = {
  mp3: { codec: 'libmp3lame', ext: '.mp3', bitrate: '320k', extra: ['-id3v2_version', '3', '-write_id3v1', '1'] },
  flac: { codec: 'flac', ext: '.flac', bitrate: null, extra: ['-compression_level', '8'] },
  wav: { codec: 'pcm_s16le', ext: '.wav', bitrate: null, extra: [] },
  aac: { codec: 'aac', ext: '.aac', bitrate: '256k', extra: [] },
  m4a: { codec: 'aac', ext: '.m4a', bitrate: '256k', extra: [] },
  ogg: { codec: 'libvorbis', ext: '.ogg', bitrate: '320k', extra: [] },
};
function convertFormat(filePath, format, outputDir, replaceOriginal) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) { reject(new Error('ffmpeg 未找到')); return; }
    if (!fs.existsSync(filePath)) { reject(new Error('文件不存在')); return; }
    const cfg = FORMAT_CONFIG[format];
    if (!cfg) { reject(new Error('不支持的格式: ' + format)); return; }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === cfg.ext) { reject(new Error('已经是 ' + format.toUpperCase() + ' 格式')); return; }
    const dir = outputDir && fs.existsSync(outputDir) ? outputDir : path.dirname(filePath);
    const baseName = path.basename(filePath, ext);
    let outPath = path.join(dir, baseName + cfg.ext);
    let counter = 1;
    while (fs.existsSync(outPath)) {
      outPath = path.join(dir, baseName + '_' + counter + cfg.ext);
      counter++;
    }
    const args = ['-y', '-i', filePath, '-vn', '-c:a', cfg.codec];
    if (cfg.bitrate) args.push('-b:a', cfg.bitrate);
    args.push(...cfg.extra, outPath);
    execFile(ffmpeg, args, { timeout: 180000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
        reject(new Error('转换失败: ' + error.message));
        return;
      }
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
        reject(new Error('转换后文件无效'));
        return;
      }
      // 替换源文件
      if (replaceOriginal && filePath !== outPath) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      resolve({ ok: true, outputPath: outPath });
    });
  });
}
ipcMain.handle('convert-to-format', async (e, { filePath, format, outputDir, replaceOriginal }) => {
  try {
    const result = await convertFormat(filePath, format, outputDir, replaceOriginal);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 重命名文件
ipcMain.handle('rename-file', async (e, { oldPath, newName }) => {
  try {
    if (!fs.existsSync(oldPath)) {
      return { ok: false, error: '文件不存在' };
    }
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);
    // 清理文件名中的非法字符
    let cleanName = newName.replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!cleanName) {
      return { ok: false, error: '新文件名无效' };
    }
    let newPath = path.join(dir, cleanName + ext);
    // 如果重名，加后缀
    let counter = 1;
    while (fs.existsSync(newPath) && newPath.toLowerCase() !== oldPath.toLowerCase()) {
      newPath = path.join(dir, cleanName + '_' + counter + ext);
      counter++;
    }
    fs.renameSync(oldPath, newPath);
    return { ok: true, newPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 删除文件（移动到系统回收站，可恢复）
ipcMain.handle('delete-file', async (e, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: '文件不存在' };
    }
    await shell.trashItem(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 复制文件到目标文件夹（音乐库合并用；重名自动加 " (2)" 后缀，绝不覆盖）
ipcMain.handle('copy-file', async (e, { src, destDir, skipIdentical }) => {
  try {
    if (!src || !fs.existsSync(src)) return { ok: false, error: '源文件不存在' };
    if (!destDir) return { ok: false, error: '未指定目标文件夹' };
    fs.mkdirSync(destDir, { recursive: true });
    const srcDir = path.dirname(fs.realpathSync(src)).toLowerCase();
    const destReal = fs.realpathSync(destDir).toLowerCase();
    // 目标就是源所在目录：无需复制
    if (srcDir === destReal) return { ok: true, destPath: src, same: true };
    const base = path.basename(src);
    let destPath = path.join(destDir, base);
    if (fs.existsSync(destPath)) {
      // 幂等：目标已有同名且同大小的文件（此前已复制过同一份）→ 直接跳过，
      // 不再生成 " (2)" 副本。仅在调用方显式传 skipIdentical 时启用（合并场景）。
      if (skipIdentical) {
        try {
          if (fs.statSync(src).size === fs.statSync(destPath).size) {
            return { ok: true, destPath, skipped: true };
          }
        } catch (_) { /* stat 失败则走重命名复制兜底 */ }
      }
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      for (let n = 2; n < 1000; n++) {
        const cand = path.join(destDir, `${stem} (${n})${ext}`);
        if (!fs.existsSync(cand)) { destPath = cand; break; }
      }
    }
    await fs.promises.copyFile(src, destPath);
    return { ok: true, destPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 查重：先按文件大小分组，同大小的再算 MD5，返回内容完全相同的文件组
// 只对同大小的文件做哈希，几千首歌也不会把全库读一遍
function md5File(p) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('md5');
    const rs = fs.createReadStream(p);
    rs.on('data', (d) => hash.update(d));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', () => resolve(null));
  });
}
ipcMain.handle('find-duplicate-files', async (e, paths) => {
  try {
    const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && fs.existsSync(p));
    const bySize = new Map();
    for (const p of list) {
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        const arr = bySize.get(st.size) || [];
        arr.push(p);
        bySize.set(st.size, arr);
      } catch (err) { /* 读不到的跳过 */ }
    }
    const groups = [];
    for (const [, same] of bySize) {
      if (same.length < 2) continue;
      const byHash = new Map();
      for (const p of same) {
        const h = await md5File(p);
        if (!h) continue;
        const arr = byHash.get(h) || [];
        arr.push(p);
        byHash.set(h, arr);
      }
      for (const [, gp] of byHash) {
        if (gp.length >= 2) groups.push(gp);
      }
    }
    return { ok: true, groups };
  } catch (err) {
    return { ok: false, error: err.message, groups: [] };
  }
});

// 窗口置顶切换
ipcMain.handle('toggle-always-on-top', async () => {
  try {
    if (!win || win.isDestroyed()) return { ok: false, error: '窗口不存在' };
    const current = win.isAlwaysOnTop();
    win.setAlwaysOnTop(!current);
    return { ok: true, alwaysOnTop: !current };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 查询窗口置顶状态
ipcMain.handle('is-always-on-top', async () => {
  try {
    if (!win || win.isDestroyed()) return { ok: false, alwaysOnTop: false };
    return { ok: true, alwaysOnTop: win.isAlwaysOnTop() };
  } catch (e) {
    return { ok: false, alwaysOnTop: false, error: e.message };
  }
});

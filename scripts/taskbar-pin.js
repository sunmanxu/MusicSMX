'use strict';
/**
 * 把 MusicSMX 固定到 Windows 任务栏（自动替换旧的固定项）。
 *
 * 用 Electron 的 shell.writeShortcutLink 生成 .lnk（Chromium 实现，IDList/LinkInfo 都合法），
 * 不走 WScript.Shell / Shell.Application（本机安全策略禁用 COM 实例化）。
 *
 * 为什么还要一层 junction：
 *   项目路径带中文，而 Windows 生成的 .lnk 里 IDList 的短名(8.3)是 ANSI 编码，
 *   中文目录容易出问题。用 %LOCALAPPDATA%\MusicSMX-dev\app 这个纯 ASCII
 *   junction 指到项目根，.lnk 里全是 ASCII；主进程会 realpath 还原回真实路径，
 *   userData 仍然落在项目根的 userData（曲库/歌单/排序都在那儿）。
 *   junction 用 fs.symlinkSync(..., 'junction') 创建，不需要管理员权限。
 *
 * 干什么：在任务栏固定目录 + 桌面各写一个 MusicSMX.lnk（同名覆盖 = 换新），
 *         并删掉多余的 "MusicSMX (2).lnk" 之类副本。
 *         注意：Win11 任务栏固定项本体在注册表 Taskband 二进制 blob 里，没有免交互接口；
 *         脚本只能把固定项背后的 .lnk 更新掉，首次仍要在桌面图标/UAC 上右键「固定到任务栏」。
 *
 * 用法（一律用 固定到任务栏.cmd 跑，或手写 electron 路径）：
 *   electron scripts/taskbar-pin.js                刷新固定项 + 桌面快捷方式（开发版）
 *   electron scripts/taskbar-pin.js --exe <路径>   改成指向打包后的 exe
 */

const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const PROJ = path.resolve(__dirname, '..');
const LINK_NAME = 'MusicSMX.lnk';
const APP_USER_MODEL_ID = 'com.musicsmx.player';
const ASCII_ROOT = path.join(process.env.LOCALAPPDATA || path.join(PROJ, '.tmp'), 'MusicSMX-dev');
const ASCII_APP = path.join(ASCII_ROOT, 'app');                 // -> PROJ 的 junction
const PIN_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer',
  'Quick Launch', 'User Pinned', 'TaskBar');

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

function ensureJunction(linkPath, target) {
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isDirectory()) {
      let cur = null;
      try { cur = fs.readlinkSync(linkPath); } catch (e) { cur = null; }
      if (cur && path.resolve(cur) === path.resolve(target)) return 'kept';
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch (e) { /* 不存在，往下建 */ }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'junction');
  return 'created';
}

function buildOptions() {
  const packagedExe = val('--exe');
  if (packagedExe) {
    const target = path.resolve(packagedExe);
    if (!fs.existsSync(target)) throw new Error('找不到可执行文件: ' + target);
    console.log('[固定目标] 打包版: ' + target);
    return {
      target, args: '', cwd: path.dirname(target),
      icon: fs.existsSync(path.join(PROJ, 'build', 'icon.ico'))
        ? path.join(PROJ, 'build', 'icon.ico') : target,
      iconIndex: 0, description: 'MusicSMX 本地音乐播放器', appUserModelId: APP_USER_MODEL_ID
    };
  }
  const jr = ensureJunction(ASCII_APP, PROJ);
  const target = path.join(ASCII_APP, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(target)) throw new Error('找不到 electron.exe（先 npm install）: ' + target);
  console.log('[ASCII 软链] ' + ASCII_APP + ' -> ' + PROJ + ' (' + jr + ')');
  console.log('[固定目标] 开发版: ' + target);
  return {
    target, args: '"' + ASCII_APP + '"', cwd: ASCII_APP,
    icon: path.join(ASCII_APP, 'build', 'icon.ico'),
    iconIndex: 0, description: 'MusicSMX 本地音乐播放器', appUserModelId: APP_USER_MODEL_ID
  };
}

function writeLink(dest, opts, label) {
  const ok = shell.writeShortcutLink(dest, 'create', opts);
  console.log((ok ? '[写入' + label + '] ' : '[写入失败] ') + dest);
  return ok;
}

function main() {
  const opts = buildOptions();

  // 1) 任务栏固定目录：同名覆盖（Win11 的固定项是注册表 blob，脚本只能更新它背后的 .lnk）
  if (fs.existsSync(PIN_DIR)) {
    // 清掉多余的副本（如 "MusicSMX (2).lnk"），同名那个留着被覆盖
    for (const f of fs.readdirSync(PIN_DIR)) {
      if (!/\.lnk$/i.test(f) || !/music\s*smx/i.test(f)) continue;
      if (f.toLowerCase() === LINK_NAME.toLowerCase()) continue;
      fs.rmSync(path.join(PIN_DIR, f), { force: true });
      console.log('[移除多余固定] ' + f);
    }
    writeLink(path.join(PIN_DIR, LINK_NAME), opts, '固定项');
  } else {
    console.log('[跳过] 任务栏固定目录不存在: ' + PIN_DIR);
  }

  // 2) 桌面：留一个能右键「固定到任务栏」的入口（Win11 没有免交互的固定接口）
  const desk = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null;
  if (desk && fs.existsSync(desk)) writeLink(path.join(desk, LINK_NAME), opts, '桌面');

  // 3) 回读自检
  try {
    const back = shell.readShortcutLink(path.join(PIN_DIR, LINK_NAME));
    console.log('[回读校验] target=' + back.target);
    console.log('            args=' + back.args);
    console.log('            cwd=' + back.cwd);
    console.log('            icon=' + back.icon + ' #' + back.iconIndex);
  } catch (e) {
    console.log('[回读失败] ' + e.message);
  }

  console.log('[说明] 图标指向开发版启动器（ASCII 软链），改完代码点它就是最新版，不用重新固定。');
  console.log('[说明] Win11 不提供免交互固定接口：新机器上把桌面 MusicSMX 右键 → 固定到任务栏 一次即可。');
}

app.whenReady().then(() => {
  let code = 0;
  try {
    main();
  } catch (e) {
    console.error('[失败] ' + e.message);
    code = 1;
  }
  // 给 explorer 的 detached 启动留一点时间
  setTimeout(() => app.exit(code), 300);
});

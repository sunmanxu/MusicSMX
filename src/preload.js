'use strict';

// 注意：Electron preload 脚本默认运行在 sandbox 模式下
// 不能 require('path')、require('fs') 等 Node.js 模块
// 只能使用 electron 模块的 contextBridge、ipcRenderer、webUtils

try {
  const electron = require('electron');
  const { contextBridge, ipcRenderer } = electron;
  const webUtils = electron.webUtils || null;

  // 用字符串处理实现 path.dirname（不依赖 path 模块）
  function dirname(p) {
    if (!p || typeof p !== 'string') return '';
    // 统一处理 Windows 和 Unix 路径
    const normalized = p.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return p;
    let result = normalized.substring(0, idx);
    // 还原 Windows 盘符
    if (/^[A-Za-z]:\//.test(result)) {
      result = result.replace('/', '\\');
    }
    return result;
  }

  const api = {
    pickFolders: () => ipcRenderer.invoke('pick-folders'),
    pickLyricsFile: () => ipcRenderer.invoke('pick-lyrics-file'),
    scan: (paths, recursive) => ipcRenderer.invoke('scan', paths, recursive),
    getConfig: () => ipcRenderer.invoke('get-config'),
    // 便携版首次启动继承旧版本数据后的提示信息（没继承时是 null）
    getInheritInfo: () => ipcRenderer.invoke('portable-inherit-info'),
    setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),
    onScanProgress: (cb) => {
      ipcRenderer.on('scan-progress', (_e, d) => cb(d));
    },
    // Electron 32+ 移除了 File.path，拖拽取路径必须走 webUtils
    pathOf: (file) => {
      try {
        if (webUtils && typeof webUtils.getPathForFile === 'function') {
          return webUtils.getPathForFile(file);
        }
        return file.path || null;
      } catch (e) { return null; }
    },
    isAudioName: (name) => /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|mp4|webm|aif|aiff)$/i.test(name),

    // ---------- 联网元数据 ----------
    fetchCover: (artist, title) => ipcRenderer.invoke('fetch-cover', { artist, title }),
    fetchLyrics: (artist, title, duration) => ipcRenderer.invoke('fetch-lyrics', { artist, title, duration }),
    fetchLyricsFromSource: (source, artist, title, duration) => ipcRenderer.invoke('fetch-lyrics-from-source', { source, artist, title, duration }),
    fetchPlaylist: (url) => ipcRenderer.invoke('fetch-playlist', { url }),
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    // 沉浸全屏（播放页右下角按钮 / F11）
    setFullScreen: (on) => ipcRenderer.send('window-fullscreen', !!on),
    isFullScreen: () => ipcRenderer.invoke('window-is-fullscreen'),
    onFullScreenChange: (cb) => {
      ipcRenderer.on('fullscreen-changed', (_e, on) => cb(!!on));
    },
    saveCover: (dataUrl, saveDir, artist, title) => ipcRenderer.invoke('save-cover', { dataUrl, saveDir, artist, title }),
    saveLyrics: (lrc, saveDir, artist, title, meta) => ipcRenderer.invoke('save-lyrics', { lrc, saveDir, artist, title, meta }),
    saveLyricOffset: (payload) => ipcRenderer.invoke('save-lyric-offset', payload || {}),
    pickDir: () => ipcRenderer.invoke('pick-dir'),
    dirname: dirname,
    showItemInFolder: (p) => ipcRenderer.invoke('show-item-in-folder', p),
    openFolder: (p) => ipcRenderer.invoke('open-folder', p),
    getDefaultDirs: () => ipcRenderer.invoke('get-default-dirs'),
    scanLocalCache: (coverDir, lyricsDir, legacyDirs) => ipcRenderer.invoke('scan-local-cache', { coverDir, lyricsDir, legacyDirs }),
    readCoverFile: (filePath) => ipcRenderer.invoke('read-cover-file', { filePath }),
    readLyricsFile: (filePath) => ipcRenderer.invoke('read-lyrics-file', { filePath }),
    searchSongInfo: (artist, title) => ipcRenderer.invoke('search-song-info', { artist, title }),
    searchArtistOnline: (artist) => ipcRenderer.invoke('search-artist-online', { artist }),
    searchAlbumOnline: (album) => ipcRenderer.invoke('search-album-online', { album }),
    searchSongsOnline: (keyword) => ipcRenderer.invoke('search-online-songs', { keyword }),
    getDownloadLink: (artist, title, duration) => ipcRenderer.invoke('get-download-link', { artist, title, duration }),
    resolveOnlinePage: (payload) => ipcRenderer.invoke('resolve-online-page', payload),
    completeTrackInfo: (payload) => ipcRenderer.invoke('complete-track-info', payload),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    autoFixTrack: (artist, title, album, duration) => ipcRenderer.invoke('auto-fix-track', { artist, title, album, duration }),
    writeMusicMetadata: (filePath, title, artist, album) => ipcRenderer.invoke('write-music-metadata', { filePath, title, artist, album }),
    readFileTags: (filePath) => ipcRenderer.invoke('read-file-tags', filePath),
    convertToMp3: (filePath, bitrate) => ipcRenderer.invoke('convert-to-mp3', { filePath, bitrate }),
    convertFormat: (filePath, format, outputDir, replaceOriginal) => ipcRenderer.invoke('convert-to-format', { filePath, format, outputDir, replaceOriginal }),
    selectDirectory: () => ipcRenderer.invoke('pick-dir'),
    renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', { oldPath, newName }),
    writeTextFile: (filePath, text) => ipcRenderer.invoke('write-text-file', { filePath, text }),
    deleteFile: (filePath) => ipcRenderer.invoke('delete-file', { filePath }),
    // 复制文件到目标文件夹（音乐库合并用）
    copyFile: (src, destDir, opts) => ipcRenderer.invoke('copy-file', { src, destDir, ...(opts || {}) }),
    // 查重：大小 + MD5，返回内容完全相同的文件组
    findDuplicateFiles: (paths) => ipcRenderer.invoke('find-duplicate-files', paths),
    onTrayControl: (cb) => {
      ipcRenderer.on('tray-control', (_e, action, value) => cb(action, value));
    },
    // 同步播放状态到主进程（任务栏缩略图工具栏的播放/暂停图标）
    updatePlayerState: (state) => ipcRenderer.send('player-state', state),
    // 主题变量推给托盘迷你窗（accent/底色/文字色，主进程缓存并转发）
    setMiniTheme: (theme) => ipcRenderer.send('mini-theme', theme),
    // 同步「关闭按钮 → 最小化到托盘 / 直接退出」
    setCloseToTray: (enabled) => ipcRenderer.send('set-close-to-tray', enabled),
    getAutostart: () => ipcRenderer.invoke('get-autostart'),
    setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
    isAlwaysOnTop: () => ipcRenderer.invoke('is-always-on-top'),
    // ---------- 桌面悬浮歌词 / 任务栏歌词 ----------
    // 主窗口把当前行/下一行推给主进程，主进程再转发给独立的透明置顶窗口
    sendLyric: (payload) => ipcRenderer.send('lyric-data', payload),
    setDesktopLyricMode: (mode) => ipcRenderer.send('lyric-mode', mode),
    setLyricClickThrough: (on) => ipcRenderer.send('lyric-click-through', !!on),
    setLyricScale: (v) => ipcRenderer.send('lyric-scale', v),
    // 桌面 / 任务栏两套字号 + 透明度一起同步（切模式时主进程按模式挑一份用）
    setLyricMetrics: (payload) => ipcRenderer.send('lyric-metrics', payload),
    // 任务栏歌词水平平移（px，可负）。reset=true 表示用户在滑块上主动调，
    // 主进程会清掉手动拖动位置让偏移重新生效；启动同步不带 reset。
    setLyricOffset: (v, reset) => ipcRenderer.send('lyric-offset', v, !!reset),
    onLyricWindowState: (cb) => {
      ipcRenderer.on('lyric-window-state', (_e, st) => cb(st));
    },
    // 下面三个给悬浮窗自己用
    onLyricData: (cb) => {
      ipcRenderer.on('lyric-data', (_e, d) => cb(d));
    },
    onLyricMode: (cb) => {
      ipcRenderer.on('lyric-mode', (_e, m) => cb(m));
    },
    onLyricScale: (cb) => {
      ipcRenderer.on('lyric-scale', (_e, v) => cb(v));
    },
    onLyricState: (cb) => {
      ipcRenderer.on('lyric-state', (_e, st) => cb(st));
    },
    lyricAction: (action) => ipcRenderer.send('lyric-action', action),
    lyricGetData: () => ipcRenderer.invoke('lyric-get-data'),
    // 外观选项（字号以外的样式）：逐字/翻译/颜色/背景/对齐，两端共用一份
    sendLyricStyle: (patch) => ipcRenderer.send('lyric-style', patch),
    onLyricStyle: (cb) => {
      ipcRenderer.on('lyric-style', (_e, st) => cb(st));
    },
    lyricGetStyle: () => ipcRenderer.invoke('lyric-get-style'),
    // 任务栏模式：把「文字实际需要多宽」报给主进程，让窗口只包住文字
    lyricFitWidth: (w) => ipcRenderer.send('lyric-fit-width', w),
    lyricAlign: (where) => ipcRenderer.send('lyric-align', where),
    // 右键 → 主进程弹系统原生菜单（任务栏模式的窗口太矮，自绘面板会被裁掉）
    lyricContextMenu: () => ipcRenderer.send('lyric-context-menu'),
    // 手动拖动（替代 -webkit-app-region: drag——那种区域上右键会弹 Windows 系统菜单）
    // st = { event: 'start'|'move'|'end', screenX, screenY }（渲染端光标屏幕坐标）
    lyricDrag: (st) => ipcRenderer.send('lyric-drag', st),
    // 当前应用版本（package.json 的 version，随打包写入 exe）
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    // 查 GitHub Releases 最新版并比较：{ok, current, latest, updateAvailable, downloadUrl, notes, error}
    checkUpdate: () => ipcRenderer.invoke('check-update'),
    version: '1.0.6'
  };

  contextBridge.exposeInMainWorld('mb', api);
  contextBridge.exposeInMainWorld('__preloadOk', true);

} catch (e) {
  // 如果出错，暴露错误信息方便诊断
  try {
    const { contextBridge } = require('electron');
    contextBridge.exposeInMainWorld('__preloadError', String(e && e.stack || e));
    contextBridge.exposeInMainWorld('mb', {
      _error: String(e && e.message || e),
      pickFolders: async () => [],
      scan: async () => [],
      getConfig: async () => ({}),
      getInheritInfo: async () => null,
      setConfig: async () => false,
      onScanProgress: () => {},
      pathOf: () => null,
      isAudioName: () => false,
      fetchCover: async () => ({ ok: false }),
      fetchLyrics: async () => ({ ok: false }),
      saveCover: async () => ({ ok: false }),
      saveLyrics: async () => ({ ok: false }),
      pickDir: async () => null,
      dirname: () => '',
      showItemInFolder: async () => false,
      version: 'error'
    });
  } catch (e2) {
    // 彻底失败
  }
}

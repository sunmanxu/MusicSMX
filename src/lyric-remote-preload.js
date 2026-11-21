'use strict';

// 歌词迷你控制条（右键任务栏/桌面歌词弹出）的 preload：
// 只暴露取状态 / 发控制 / 收起三个能力，与托盘迷你窗同一条控制链路。
try {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('remote', {
    // 订阅主进程推来的最新播放状态（playing/fav 与缩略图工具栏同源）
    onState: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('remote-state', (_e, state) => cb(state));
    },
    // 播放控制：toggle-play / prev / next / toggle-fav / toggle-lyric
    // 走 mini-control 通道 → 主进程转发主窗口 tray-control，主窗口最小化也能用
    control: (action, value) => ipcRenderer.send('mini-control', action, value),
    // 收起自己
    hide: () => ipcRenderer.send('lyric-remote-hide')
  });
} catch (e) {
  console.error('[remote] preload 失败:', e);
}

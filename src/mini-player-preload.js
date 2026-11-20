'use strict';

// 托盘迷你播放窗的 preload：只暴露取状态 / 发控制 / 关闭三个能力。
try {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('mini', {
    // 订阅主进程推来的最新播放状态
    onState: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('mini-state', (_e, state) => cb(state));
    },
    // 订阅主题变量（accent/底色/文字色），让小窗颜色跟随主界面主题
    onTheme: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('mini-theme', (_e, theme) => cb(theme));
    },
    // 播放控制：toggle-play / prev / next / cycle-mode / volume(0~1)
    control: (action, value) => ipcRenderer.send('mini-control', action, value),
    // 打开主界面 / 退出（复用托盘菜单通道）
    showMain: () => ipcRenderer.send('mini-show-main'),
    quit: () => ipcRenderer.send('mini-quit'),
    // 收起小窗
    close: () => ipcRenderer.send('mini-close')
  });
} catch (e) {
  console.error('[mini] preload 失败:', e);
}

# MusicSMX — 本地音乐播放器

一个 Windows 桌面音乐播放器。用 Electron 写外壳，界面是**原生 HTML / CSS / JavaScript**，没有任何前端框架——代码全部可读可改，不需要懂 React/Vue 就能动手改。

- 本地曲库管理（多文件夹、虚拟滚动、标签解析）
- 收藏 / 自定义歌单（支持一层子歌单）/ 回收站
- 全屏沉浸式播放页（网易云风格，封面 + 歌词 + 逐字卡拉OK）
- 在线抓封面、歌词（QQ 音乐 / 网易云 / 酷狗，带 `.lrc.json` 边车保留翻译和逐字）
- 网络电台（60 个实测可播源，国内外音乐台 + 新闻台）
- 主题换肤（强调色 + 底色自定义）
- 系统媒体键、任务栏缩略图按钮、托盘常驻
- 格式转换（内嵌 ffmpeg）

---

## 目录结构

```
20261115-MusicSMX-重置版/
├── src/
│   ├── main.js              主进程：窗口、托盘、IPC、文件读写、转格式
│   ├── preload.js           IPC 桥，把能力暴露成渲染进程的 window.mb
│   ├── metadata.js          音频标签解析 + 目录扫描（异步分批）
│   ├── online.js            联网抓封面 / 歌词 / 歌单
│   ├── dev-hooks.js         开发期自动化钩子（截图 / 断言 / 冒烟，见交接说明）
│   └── renderer/
│       ├── index.html       界面结构
│       ├── style.css        全部样式（主题变量在文件顶部的 :root）
│       ├── app.js           渲染进程主逻辑（播放列表、歌词、电台、歌单…）
│       └── vendor/hls.min.js  HLS 播放（.m3u8 电台用）
├── build/                   图标资源
│   ├── icon.ico / icon.png  应用图标
│   └── thumbar/             任务栏缩略图按钮图标（播放/暂停/上一首/下一首，1x + 2x）
├── bin/ffmpeg.exe           格式转换依赖（84 MB，**不进仓库**，见下方「准备 ffmpeg」）
├── scripts/                 辅助脚本（图标生成、电台探活、测试音频生成）
├── package.json
└── 启动.cmd / 开发启动.cmd / 固定到任务栏.cmd   便携启动 / 开发模式 / 任务栏固定
```

> `node_modules/`、`release*/`、`userData/` 都能随时重建，不进压缩包。

---

## 快速开始

需要 **Node.js 18+**。

```bash
# 1. 安装依赖（首次约 400 MB，主要是在下 Electron）
npm install

# 如果卡住或报网络错误，用国内镜像：
# npm config set registry https://registry.npmmirror.com
# set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

# 2. 跑起来看效果（开发模式，改完代码重启即可）
npm start
```

首次打开是空列表，点左上角 **添加文件夹** 选一个音乐目录，等扫描完成就能播放。

### 准备 ffmpeg（格式转换功能用，可选）

仓库不含 ffmpeg（84 MB 二进制）。需要格式转换功能时，从下面任一下载 Windows 版，
放到项目的 `bin/ffmpeg.exe`（打包安装版无需手动准备，安装包里已内置）：

- https://www.gyan.dev/ffmpeg/builds/ （release essentials）
- https://github.com/BtbN/FFmpeg-Builds/releases （ffmpeg-master-latest-win64-gpl）

不装 ffmpeg 不影响播放等其它功能，只是「转格式」按钮会提示失败。

---

## 开发运行（改代码时用这个，不打包）

双击项目根的 **`开发启动.cmd`**：直接跑 `src/` 里的源码，共用项目的 `userData`（曲库、歌单、偏好都在）。
改完代码存盘 → 关窗口 → 再双击一次就能看到效果，不用等 electron-builder。

命令行等价写法：

```bash
env -u ELECTRON_RUN_AS_NODE PORTABLE_EXECUTABLE_DIR="$PWD" ./node_modules/electron/dist/electron.exe .
```

只有要**出安装包 / 发给别人 / 验证打包产物**时才走下面的打包流程。

### 桌面 / 任务栏图标

双击 **`固定到任务栏.cmd`**：在桌面和任务栏固定目录各生成/刷新一个 `MusicSMX.lnk`。

- 图标指向 `%LOCALAPPDATA%\MusicSMX-dev\app`（指向项目根的 ASCII junction），**改完代码点它就是最新版，不用重新固定**。
- Windows 11 没有免交互的固定接口（固定项存在注册表二进制 blob 里），所以第一次还要在桌面图标上**右键 → 固定到任务栏**一下。
- 以后换了打包的 exe：`固定到任务栏.cmd --exe release-vN\win-unpacked\MusicSMX.exe`，同名覆盖，固定项自动换成新 exe。

---

## 打包成 exe

```bash
# 完整打包（生成安装包 + 免安装目录）
npm run build

# 只想快速产出一个能跑的目录，不要安装包（快很多）
npm run build:dir
```

产物目录由 `package.json` 的 `build.directories.output` 决定（当前 `release-v32`，每次递增）：

- `release-v32/win-unpacked/MusicSMX.exe` —— 免安装，双击即用
- `release-v32/MusicSMX-1.0.0-setup.exe` —— NSIS 安装包

也可以直接双击项目根的 `启动.cmd`，它会自动带上共享 userData 并启动当前构建目录。

**打包前先关掉正在运行的 MusicSMX**，否则文件被占用会失败。

---

## 配置文件在哪

运行时数据（曲库路径、收藏、歌单、设置）存在 `userData/config.json`：

| 情况 | 位置 |
|------|------|
| `npm start` 开发模式 | `%APPDATA%\musicsmx\config.json` |
| 免安装版 + 设了 `PORTABLE_EXECUTABLE_DIR` | 该目录（或其上级）下的 `userData\config.json` |
| 安装版 | `%APPDATA%\musicsmx\config.json` |

想让数据跟着程序目录走（方便整个文件夹拷走），启动前设置环境变量：

```bash
set PORTABLE_EXECUTABLE_DIR=D:\MusicSMX\win-unpacked
```

---

## 常见问题

**双击 exe 没反应 / 只有个后台进程约 40 MB、没有窗口**
这台机器如果设过全局环境变量 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成 Node 解释器。开发时这样启动：

```bash
# Git Bash
env -u ELECTRON_RUN_AS_NODE npm start
# CMD
set "ELECTRON_RUN_AS_NODE="
```

**`npm run build` 报「无法加载文件 npm.ps1，因为在此系统上禁止运行脚本」**
PowerShell 执行策略限制。绕过方式：

```bash
node node_modules/electron-builder/cli.js --win
```

**扫描网络盘（NAS）里的音乐很慢**
扫描是递归读目录，网络盘上会明显变慢。建议只添加音乐子目录，别加整个盘。

**电台点开没声音**
电台源会失联。项目里有探活脚本，跑 `npm run check:radios` 会并发测试全部电台并列出失效的源。

---

## 想继续改功能？

把项目里的 **`交接说明.md`** 整个丢给 AI（Claude / ChatGPT / WorkBuddy 都行），再补一句你的需求，比如：

> 这是 MusicSMX 播放器的源码，`交接说明.md` 里有架构、约束和踩坑记录。请先读它，然后帮我把播放进度条改成 4px 高、已播放部分用主题色。

那份文档里写了：
- 每个功能在哪个函数、哪个文件
- 哪些地方改了就一定会出 bug（30 多条硬性约束，都是实际踩过的坑）
- 怎么用自带的环境变量钩子做截图验证和交互自检，不用靠人眼猜

---

## 许可

MIT

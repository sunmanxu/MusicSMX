@echo off
chcp 65001 >nul
setlocal

rem 开发期启动：直接跑 src/ 源码，不打包。
rem 改完代码存盘 → 关掉窗口 → 再双击本文件即可看到效果（不用等 electron-builder）。
rem 只有要出安装包 / 发给别人 / 验证打包产物时才跑 npm run build。
rem
rem 两个必须项（和 启动.cmd 同理）：
rem   1. 清掉 ELECTRON_RUN_AS_NODE，否则 Electron 退化成 Node 解释器（无窗口）。
rem   2. PORTABLE_EXECUTABLE_DIR 指到项目根，才能用上项目里的 userData
rem      （1300+ 首曲库、歌单、排序偏好都在那里，指错就变成空配置）。

cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

rem 单实例锁是按 userData 判定的：便携版还在跑时，开发版会立刻退出，先清场
taskkill /f /im MusicSMX.exe >nul 2>&1

set "PORTABLE_EXECUTABLE_DIR=%~dp0"
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo.
  echo   electron.exe not found: %ELECTRON%
  echo   Run first:  npm install
  echo.
  pause
  exit /b 1
)

rem 用 start 让控制台立刻返回；关窗口即退出进程
start "" "%ELECTRON%" "%~dp0"
endlocal

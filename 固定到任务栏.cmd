@echo off
chcp 65001 >nul
setlocal

rem 把 MusicSMX 固定到任务栏（旧的同名前固定项会先删掉）。
rem 日常改完代码不用重跑：固定的是开发版启动器，点开就是最新代码。
rem 以后打了新安装包/新 release，用 --exe 指到新的 exe 再跑一次即可换掉旧的。
rem
rem ELECTRON_RUN_AS_NODE 必须清掉，否则 electron.exe 退化成 Node 解释器，脚本跑不起来。

cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo.
  echo   electron.exe not found: %ELECTRON%
  echo   Run first:  npm install
  echo.
  pause
  exit /b 1
)

"%ELECTRON%" "%~dp0scripts\taskbar-pin.js" %*
if errorlevel 1 pause
endlocal

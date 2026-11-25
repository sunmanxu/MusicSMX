@echo off
chcp 65001 >nul
setlocal

rem One-click launcher for the current portable build.
rem Two things that MUST be right:
rem   1. Clear ELECTRON_RUN_AS_NODE, otherwise Electron degrades into a Node REPL (no window).
rem   2. PORTABLE_EXECUTABLE_DIR must point at the folder that holds the shared userData,
rem      otherwise the app falls back to an empty %APPDATA% config and the library is lost.

cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

rem Keep in sync with build.directories.output in package.json
set "EXE=release-v44\win-unpacked\MusicSMX.exe"
if not exist "%EXE%" (
  echo.
  echo   Build not found: %EXE%
  echo   Run first:  npm run build:dir
  echo   If the output folder changed, update EXE above too.
  echo.
  pause
  exit /b 1
)

rem Find the shared userData: this project first, then any sibling folder with config.json.
rem Do not hard-code a folder name, so renaming / moving the project still works.
set "PDIR=%~dp0"
if exist "%~dp0userData\config.json" goto :havepdir
for /d %%D in ("%~dp0..\*") do (
  if exist "%%D\userData\config.json" (
    set "PDIR=%%D"
    goto :havepdir
  )
)
:havepdir
set "PORTABLE_EXECUTABLE_DIR=%PDIR%"

start "" "%EXE%"
endlocal

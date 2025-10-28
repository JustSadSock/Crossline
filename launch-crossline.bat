@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "PORT=%~1"
if not defined PORT set "PORT=3000"

set "PS_SCRIPT=%SCRIPT_DIR%\scripts\launch-crossline.ps1"
if not exist "%PS_SCRIPT%" (
  echo [ERROR] Не найден файл %PS_SCRIPT%
  exit /b 1
)

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -ProjectDir "%SCRIPT_DIR%" -Port %PORT%
exit /b %ERRORLEVEL%

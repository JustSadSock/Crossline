@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ========= CONFIG =========
set "PORT=80"
set "NGROK_EXE=C:\Users\illya\AppData\Local\Microsoft\WinGet\Links\ngrok.exe"

rem ========= PORT CHECK =========
if %PORT% LSS 1024 (
  net session >nul 2>&1
  if errorlevel 1 (
    echo [WARN] Port %PORT% needs admin. Falling back to 3000.
    set "PORT=3000"
  )
)
echo [INFO] Using port %PORT%.

rem ========= NODE / NPM =========
where node >nul 2>&1 || (
  echo [ERROR] Node.js not found in PATH. Install Node LTS.
  pause & exit /b
)
if exist package.json (
  echo [INFO] Installing dependencies with npm ci...
  npm ci
  if errorlevel 1 (
    echo [ERROR] npm ci failed. Check above for errors.
    pause & exit /b 1
  )
)

rem ========= NGROK =========
if exist "%NGROK_EXE%" (
  echo [INFO] Using ngrok at "%NGROK_EXE%"
) else (
  echo [ERROR] ngrok not found at "%NGROK_EXE%"
  echo   Fix: set "NGROK_EXE=C:\Path\to\ngrok.exe"
  pause & exit /b 1
)

rem ========= START SERVER =========
set "SCRIPT_DIR=%cd%"
start "Crossline Server" cmd /k "cd /d "%SCRIPT_DIR%" && set PORT=%PORT% && node server\index.js"

rem ========= START NGROK =========
timeout /t 2 /nobreak >nul
start "ngrok Tunnel" cmd /k "cd /d "%SCRIPT_DIR%" && "%NGROK_EXE%" http %PORT% --log=stdout"

rem ========= START LOG MONITOR =========
timeout /t 1 /nobreak >nul
start "Server Logs Monitor" cmd /k "cd /d "%SCRIPT_DIR%" && set PORT=%PORT% && powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\monitor-server.ps1""

echo [READY] Three windows launched: Server, ngrok tunnel, and log monitor.
echo [INFO] Check the console windows for output.
pause
endlocal

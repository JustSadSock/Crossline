@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ========= CONFIG =========
set "PORT=80"
set "NGROK_EXE=C:\Users\illya\AppData\Local\Microsoft\WinGet\Links\ngrok.exe"

rem ========= LOGS =========
if not exist "logs" mkdir "logs"
for /f %%t in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd_HHmmss')"') do set "TS=%%t"
set "SERVER_LOG=logs\server_%TS%.log"
set "NGROK_LOG=logs\ngrok_%TS%.log"

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
  echo [INFO] npm ci...
  npm ci >>"%SERVER_LOG%" 2>&1
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
start "Crossline Server" cmd /k ^
"cd /d "%SCRIPT_DIR%" && set PORT=%PORT% && node server\index.js 1>>"%SERVER_LOG%" 2>>&1"

rem ========= START NGROK =========
start "ngrok Tunnel" cmd /k ^
"cd /d "%SCRIPT_DIR%" && "%NGROK_EXE%" http %PORT% --log=stdout 1>>"%NGROK_LOG%" 2>>&1"

echo [READY] Server and ngrok launched.
echo [INFO] Logs:
echo   %SERVER_LOG%
echo   %NGROK_LOG%
pause
endlocal

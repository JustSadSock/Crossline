@echo off
setlocal enabledelayedexpansion

rem ===== Crossline: zero-input launcher (server + ngrok + deps) =====
cd /d "%~dp0"

rem -------- Settings (edit once if you want) --------
if not defined PORT set "PORT=3000"
if not defined NGROK_EXE set "NGROK_EXE=ngrok"
rem Optional: hardcode token once and forget:
rem set "NGROK_AUTHTOKEN=PASTE_TOKEN_HERE"

rem -------- Check Node --------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node is not in PATH. Install Node or open Node.js Command Prompt.
  pause
  exit /b 1
)

rem -------- Resolve ngrok command (path or PATH lookup) --------
set "NGROK_CMD=%NGROK_EXE%"
if exist "%NGROK_CMD%" (
  set "HAVE_NGROK=1"
) else (
  where %NGROK_CMD% >nul 2>&1 && set "HAVE_NGROK=1"
)
if not defined HAVE_NGROK (
  echo [ERROR] ngrok not found. Install it and either add to PATH or set NGROK_EXE=full\path\to\ngrok.exe
  echo Example (once):  setx NGROK_EXE "C:\Tools\ngrok\ngrok.exe"
  pause
  exit /b 1
)

rem -------- Auto-find token (no prompts) --------
set "FOUND_TOKEN="
if not "%NGROK_AUTHTOKEN%"=="" set "FOUND_TOKEN=%NGROK_AUTHTOKEN%"

if "%FOUND_TOKEN%"=="" if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%~A"=="NGROK_AUTHTOKEN" set "FOUND_TOKEN=%%~B"
  )
)
if "%FOUND_TOKEN%"=="" if exist "ngrok.token" (
  set /p FOUND_TOKEN=<"ngrok.token"
)

if not "%FOUND_TOKEN%"=="" (
  "%NGROK_CMD%" config add-authtoken "%FOUND_TOKEN%" >nul 2>&1
)

rem -------- Prepare logs --------
if not exist "logs" mkdir "logs"
set "TS=%DATE%_%TIME%"
set "TS=%TS::=-%"
set "TS=%TS:/=-%"
set "TS=%TS: =_%"
set "TS=%TS:.=-%"
set "SERVER_LOG=logs\server_%TS%.log"
set "NGROK_LOG=logs\ngrok_%TS%.log"

rem -------- Ensure deps (no questions) --------
if not exist "package.json" (
  echo [WARN] package.json not found. Creating minimal one.
  call npm init -y >nul 2>&1
)

if not exist "node_modules" (
  if exist "package-lock.json" (
    call npm ci
  ) else (
    call npm install
  )
)

rem Ensure 'ws' present (your server requires it)
node -e "require('ws')" >nul 2>&1
if errorlevel 1 (
  call npm i ws
)

rem -------- Choose server command --------
set "SERVER_CMD="
if exist "server\index.js" set "SERVER_CMD=node server\index.js"
if "%SERVER_CMD%"=="" if exist "package.json" set "SERVER_CMD=npm start"
if "%SERVER_CMD%"=="" (
  echo [ERROR] No server\index.js or package.json. Nothing to run.
  pause
  exit /b 1
)

echo Logs:
echo   %SERVER_LOG%
echo   %NGROK_LOG%
echo Starting server on http://localhost:%PORT%

rem -------- Launch server in its own window (kept open) --------
start "Crossline Server" cmd /k "set PORT=%PORT% && %SERVER_CMD% ^>^> ^"%SERVER_LOG%^" 2^>^&1"

rem -------- Launch ngrok in its own window (kept open) --------
echo Starting ngrok tunnel to localhost:%PORT%
start "ngrok Tunnel" cmd /k ""%NGROK_CMD%" http %PORT% --log=stdout ^>^> ^"%NGROK_LOG%^" 2^>^&1"

echo Ready. Child consoles stay open. You can close this parent window anytime.
pause
endlocal

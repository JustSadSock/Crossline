@echo off
setlocal
cd /d %~dp0

if "%PORT%"=="" (
  set "PORT=3000"
)

if "%NGROK_AUTHTOKEN%"=="" (
  echo [ERROR] NGROK_AUTHTOKEN environment variable is not set.
  echo Please run "setx NGROK_AUTHTOKEN your_token" and restart the terminal.
  exit /b 1
)

where ngrok >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ngrok executable not found in PATH.
  echo Install ngrok from https://ngrok.com/download and ensure it is available in PATH.
  exit /b 1
)

echo Launching Crossline server on port %PORT%...
start "Crossline Server" cmd /k "set PORT=%PORT% && node server/index.js"

ngrok config add-authtoken %NGROK_AUTHTOKEN% >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Failed to configure ngrok auth token.
  exit /b 1
)

echo Starting ngrok tunnel for http://localhost:%PORT% ...
ngrok http %PORT%

endlocal

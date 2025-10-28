@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

set "PORT=%1"
if "%PORT%"=="" set "PORT=3000"

call :requireCmd node "Node.js"
if errorlevel 1 goto :eof
call :requireCmd npm "npm"
if errorlevel 1 goto :eof
call :requireCmd powershell "PowerShell"
if errorlevel 1 goto :eof

call :resolveNgrok
if errorlevel 1 goto :eof

if defined NGROK_AUTHTOKEN (
  echo [INFO] Applying ngrok authtoken...
  "%NGROK_CMD%" config add-authtoken %NGROK_AUTHTOKEN% >nul 2>&1
)

if not exist "%PROJECT_DIR%\node_modules" (
  echo [INFO] Installing dependencies with npm ci...
  pushd "%PROJECT_DIR%" >nul
  call npm ci
  if errorlevel 1 (
    echo [ERROR] npm ci failed.
    popd >nul
    exit /b 1
  )
  popd >nul
)

start "Crossline API" cmd /k "cd /d \"%PROJECT_DIR%\" && set PORT=%PORT% && node server/index.js"
start "Crossline Ngrok" cmd /k "cd /d \"%PROJECT_DIR%\" && \"%NGROK_CMD%\" http %PORT% --host-header=localhost:%PORT%"

echo [INFO] Waiting for ngrok tunnel on http://127.0.0.1:4040 ...
set "TUNNEL_URL="
set "WS_URL="
set "CONFIG_PATH="
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\update-runtime-config.ps1" -ProjectDir "%PROJECT_DIR%" -TimeoutSeconds 120 2^>nul`) do (
  if /I "%%A"=="TUNNEL_URL" set "TUNNEL_URL=%%B"
  if /I "%%A"=="WS_URL" set "WS_URL=%%B"
  if /I "%%A"=="CONFIG_PATH" set "CONFIG_PATH=%%B"
)

if not defined TUNNEL_URL (
  echo [WARN] Не удалось определить публичный адрес ngrok.
  exit /b 1
)

echo [INFO] Найден туннель: %TUNNEL_URL%

if defined CONFIG_PATH (
  echo [INFO] Runtime config updated: %CONFIG_PATH%
)

if defined WS_URL (
  echo [READY] HTTP  -> %TUNNEL_URL%
  echo [READY] WS    -> %WS_URL%
) else (
  echo [WARN] Не удалось вычислить WebSocket URL.
)

echo.
echo Готово. Сервер и туннель запущены в отдельных окнах.
exit /b 0

:requireCmd
where %1 >nul 2>&1
if errorlevel 1 (
  echo [ERROR] %2 (%1) не найден в PATH.
  exit /b 1
)
exit /b 0

:resolveNgrok
if defined NGROK_EXE (
  if exist "%NGROK_EXE%" (
    set "NGROK_CMD=%NGROK_EXE%"
  ) else (
    echo [WARN] NGROK_EXE указывает на несуществующий файл: %NGROK_EXE%
  )
)

if not defined NGROK_CMD (
  for /f "usebackq tokens=*" %%A in (`where ngrok 2^>nul`) do (
    if not defined NGROK_CMD set "NGROK_CMD=%%A"
  )
)

if not defined NGROK_CMD (
  echo [ERROR] ngrok не найден. Установите ngrok и убедитесь, что он в PATH, или задайте NGROK_EXE.
  exit /b 1
)
exit /b 0

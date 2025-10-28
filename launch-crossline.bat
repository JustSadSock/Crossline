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
for /L %%I in (1,30) do (
  for /f "usebackq tokens=* delims=" %%A in (`powershell -NoLogo -NoProfile -Command "try { $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2; $https = $resp.tunnels | Where-Object { $_.proto -eq 'https' } | Select-Object -First 1; if ($https) { $https.public_url } } catch { }" 2^>nul`) do (
    set "TUNNEL_URL=%%A"
  )
  if defined TUNNEL_URL goto GotTunnel
  timeout /t 2 >nul
)

echo [WARN] Не удалось определить публичный адрес ngrok.
exit /b 1

:GotTunnel
echo [INFO] Найден туннель: %TUNNEL_URL%

for /f "usebackq tokens=* delims=" %%A in (`powershell -NoLogo -NoProfile -Command "$origin = '%TUNNEL_URL%'; $uri = [Uri]$origin; $wsScheme = if ($uri.Scheme -eq 'https') { 'wss://' } else { 'ws://' }; $ws = $wsScheme + $uri.Authority; $configPath = [IO.Path]::Combine('%PROJECT_DIR%','scripts','runtime-config.js'); $lines = @('(function setCrosslineConfig() {','  const tunnelOrigin = ''' + $origin + ''';','  if (!tunnelOrigin) return;','  window.CROSSLINE_API_URL = tunnelOrigin;','  try {','    const parsed = new URL(tunnelOrigin);','    const wsProtocol = parsed.protocol === ''https:'' ? ''wss:'' : ''ws:'';','    window.CROSSLINE_WS_URL = `${wsProtocol}//${parsed.host}`;','  } catch (error) {','    console.warn(''WS URL config error'', error);','  }','})();'); [IO.File]::WriteAllLines($configPath, $lines); $ws" 2^>nul`) do (
  set "WS_URL=%%A"
)

if not defined WS_URL (
  echo [WARN] Не удалось вычислить WebSocket URL.
) else (
  echo [INFO] Runtime config updated: %PROJECT_DIR%\scripts\runtime-config.js
  echo [READY] HTTP  -> %TUNNEL_URL%
  echo [READY] WS    -> %WS_URL%
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

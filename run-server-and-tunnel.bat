@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0" || exit /b 1

set "ROOT=%~dp0"
set "MODE=%~1"

if /I "%MODE%"=="server" goto :SERVER
if /I "%MODE%"=="tunnel" goto :TUNNEL

:: Launcher mode
set "PORT=%PORT%"
if "%PORT%"=="" set "PORT=3000"
set "CROSSLINE_API_URL=https://irgri.uk"
set "CROSSLINE_WS_URL=wss://irgri.uk"
set "ENV_FILE=%ROOT%scripts\.crossline-tunnel.env"

if not exist "%ROOT%scripts" mkdir "%ROOT%scripts" >nul 2>&1
(
  echo CROSSLINE_API_URL=%CROSSLINE_API_URL%
  echo CROSSLINE_WS_URL=%CROSSLINE_WS_URL%
) > "%ENV_FILE%"

echo ==============================================
echo   Crossline // launcher
echo ==============================================
echo [INFO] ROOT=%ROOT%
echo [INFO] PORT=%PORT%
echo [INFO] API=%CROSSLINE_API_URL%
echo [INFO] WS=%CROSSLINE_WS_URL%
echo [INFO] ENV FILE=%ENV_FILE%

echo [STEP] Проверяем инструменты...
where node >nul 2>&1 || (echo [ERROR] Node.js (node) не найден. Установите Node.js и перезапустите. & goto FAIL)
where npm >nul 2>&1 || (echo [ERROR] npm не найден. Установите Node.js и перезапустите. & goto FAIL)
where cloudflared >nul 2>&1 || (echo [ERROR] cloudflared не найден. Установите Cloudflare Tunnel и перезапустите. & goto FAIL)

echo [STEP] Устанавливаем зависимости...
if exist "%ROOT%package-lock.json" (
  npm ci || goto FAIL
) else (
  npm install || goto FAIL
)

set "CF_CONFIG_DEFAULT=%USERPROFILE%\.cloudflared\config.yml"
if exist "%CF_CONFIG_DEFAULT%" (
  findstr /c:"service: http://localhost:3000" "%CF_CONFIG_DEFAULT%" >nul 2>&1
  if not errorlevel 1 (
    echo [WARN] В %CF_CONFIG_DEFAULT% обнаружен service: http://localhost:3000
    echo [WARN] На Windows предпочтительнее service: http://127.0.0.1:3000, чтобы избежать IPv6 (::1).
  )
)

echo [STEP] Запускаем сервер...
start "Crossline Server" cmd /k ""%~f0" server"

echo [STEP] Ждем /health на 127.0.0.1:%PORT% ...
powershell -NoLogo -NoProfile -Command " $uri = 'http://127.0.0.1:%PORT%/health'; $deadline = (Get-Date).AddSeconds(30); $ok=$false; while((Get-Date) -lt $deadline){ try { $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $uri; if($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500){ $ok=$true; break } } catch { } Start-Sleep -Seconds 1 } if($ok){ Write-Host '[OK] /health отвечает'; exit 0 } else { Write-Host '[ERROR] /health не ответил за 30 секунд'; exit 1 }" || goto FAIL

echo [STEP] Запускаем tunnel...
start "Crossline Tunnel" cmd /k ""%~f0" tunnel"

echo.
echo [READY] Открыты окна "Crossline Server" и "Crossline Tunnel".
echo [INFO] Клиент ищет сервер по https://irgri.uk

:WAIT
choice /t 3600 /d Y /n >nul
goto WAIT

:SERVER
set "PORT=%PORT%"
if "%PORT%"=="" set "PORT=3000"
set "CROSSLINE_CLUSTER=0"
set "CROSSLINE_CLUSTER_WORKERS=1"
set "NODE_ENV=production"

echo [SERVER] PORT=%PORT%
echo [SERVER] CROSSLINE_CLUSTER=%CROSSLINE_CLUSTER%
echo [SERVER] CROSSLINE_CLUSTER_WORKERS=%CROSSLINE_CLUSTER_WORKERS%
echo [SERVER] NODE_ENV=%NODE_ENV%

echo [SERVER] Запускаем node server/index.js ...
node server\index.js

goto :EOF

:TUNNEL
set "CF_CONFIG_DEFAULT=%USERPROFILE%\.cloudflared\config.yml"
if exist "%CF_CONFIG_DEFAULT%" (
  echo [TUNNEL] Используем конфиг %CF_CONFIG_DEFAULT%
  cloudflared --config "%CF_CONFIG_DEFAULT%" tunnel run irgri-tunnel
) else (
  echo [TUNNEL] %CF_CONFIG_DEFAULT% не найден, запускаем без --config
  cloudflared tunnel run irgri-tunnel
)

goto :EOF

:FAIL
echo.
echo [ERROR] Запуск прерван. Проверьте сообщения выше.
pause
endlocal
exit /b 1

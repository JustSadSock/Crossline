@echo off
chcp 65001 >nul 2>&1
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%" || exit /b 1
set "MODE=%~1"

if /I "%MODE%"=="server" goto :SERVER
if /I "%MODE%"=="tunnel" goto :TUNNEL

:: Launcher mode
set "PORT=%PORT%"
if "%PORT%"=="" set "PORT=3000"
set "ENV_FILE=%ROOT%scripts\.crossline-tunnel.env"
set "CF_CONFIG=%USERPROFILE%\.cloudflared\config.yml"

if not exist "%ROOT%scripts" mkdir "%ROOT%scripts" >nul 2>&1
(
  echo CROSSLINE_API_URL=https://irgri.uk
  echo CROSSLINE_WS_URL=wss://irgri.uk
) > "%ENV_FILE%"

echo ==============================================
echo   Crossline launcher
echo ==============================================
echo [INFO] ROOT=%ROOT%
echo [INFO] PORT=%PORT%
echo [INFO] ENV FILE=%ENV_FILE%
echo [INFO] CF CONFIG=%CF_CONFIG%

echo [STEP] Проверяем инструменты...
where node >nul 2>&1 || (echo [ERROR] Node.js (node) не найден в PATH. Установите Node.js. & goto FAIL)
where npm >nul 2>&1 || (echo [ERROR] npm не найден в PATH. Установите Node.js. & goto FAIL)
where cloudflared >nul 2>&1 || (echo [ERROR] cloudflared не найден в PATH. Установите Cloudflare Tunnel. & goto FAIL)

echo [STEP] Устанавливаем зависимости...
if exist "%ROOT%package-lock.json" (
  npm ci || goto FAIL
) else (
  npm install || goto FAIL
)

if exist "%CF_CONFIG%" (
  findstr /c:"service: http://localhost:3000" "%CF_CONFIG%" >nul 2>&1
  if not errorlevel 1 (
    echo [WARN] В %CF_CONFIG% найден service: http://localhost:3000
    echo [WARN] Для Windows предпочтительнее http://127.0.0.1:3000, чтобы избежать IPv6 (::1).
  )
)

echo [STEP] Запускаем сервер...
start "Crossline Server" cmd /k ""%~f0" server"

echo [STEP] Ждем /health на 127.0.0.1:%PORT% ...
powershell -NoLogo -NoProfile -Command " $uri = 'http://127.0.0.1:%PORT%/health'; $deadline = (Get-Date).AddSeconds(30); $ok = $false; while((Get-Date) -lt $deadline){ try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $uri; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ $ok = $true; break } } catch { } Start-Sleep -Seconds 1 } if($ok){ Write-Host '[OK] /health отвечает'; exit 0 } else { Write-Host '[ERROR] /health не ответил за 30 секунд'; exit 1 }" || goto FAIL

echo [STEP] Запускаем tunnel...
start "Crossline Tunnel" cmd /k ""%~f0" tunnel"

echo.
echo [READY] Открыты окна "Crossline Server" и "Crossline Tunnel". Главное окно останется открытым.
:WAIT
choice /t 3600 /d Y /n >nul
goto WAIT

:SERVER
set "PORT=%PORT%"
if "%PORT%"=="" set "PORT=3000"
set "CROSSLINE_CLUSTER=0"
set "CROSSLINE_CLUSTER_WORKERS=1"
set "NODE_ENV=production"

cd /d "%ROOT%" || exit /b 1

echo [SERVER] ROOT=%ROOT%
echo [SERVER] PORT=%PORT%
echo [SERVER] CROSSLINE_CLUSTER=%CROSSLINE_CLUSTER%
echo [SERVER] CROSSLINE_CLUSTER_WORKERS=%CROSSLINE_CLUSTER_WORKERS%
echo [SERVER] NODE_ENV=%NODE_ENV%

echo [SERVER] Запуск npm run server ...
npm run server
set "EXIT_CODE=%ERRORLEVEL%"
echo [SERVER] Завершено с кодом %EXIT_CODE%
pause
exit /b %EXIT_CODE%

:TUNNEL
set "CF_CONFIG=%USERPROFILE%\.cloudflared\config.yml"
if exist "%CF_CONFIG%" (
  echo [TUNNEL] Используем конфиг %CF_CONFIG%
  cloudflared --config "%CF_CONFIG%" tunnel run irgri-tunnel
) else (
  echo [TUNNEL] %CF_CONFIG% не найден, запускаем без --config
  cloudflared tunnel run irgri-tunnel
)
set "EXIT_CODE=%ERRORLEVEL%"
echo [TUNNEL] Завершено с кодом %EXIT_CODE%
pause
exit /b %EXIT_CODE%

:FAIL
echo.
echo [ERROR] Запуск прерван. Проверьте сообщения выше.
pause
exit /b 1

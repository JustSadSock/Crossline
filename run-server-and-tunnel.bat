@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0" || exit /b 1

setlocal
set "ROOT=%~dp0"
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
start "Crossline Server" cmd /k call "%ROOT%run-server.bat"

timeout /t 2 /nobreak >nul

echo [STEP] Запускаем tunnel...
start "Crossline Tunnel" cmd /k call "%ROOT%run-tunnel.bat"

echo.
echo [READY] Открыты окна "Crossline Server" и "Crossline Tunnel".
echo [INFO] Клиент ищет сервер по https://irgri.uk

:WAIT
choice /t 3600 /d Y /n >nul
goto WAIT

:FAIL
echo.
echo [ERROR] Запуск прерван. Проверьте сообщения выше.
pause
endlocal
exit /b 1

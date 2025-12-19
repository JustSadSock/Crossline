@echo off
setlocal enableextensions
chcp 65001 >nul 2>&1

rem ===== ROOT PATH =====
for %%I in ("%~dp0.") do set "ROOT=%%~fI"
pushd "%ROOT%" || goto :FAIL

rem ===== CONFIGURATION =====
if "%PORT%"=="" set "PORT=3000"
set "CROSSLINE_API_URL=https://irgri.uk"
set "CROSSLINE_WS_URL=wss://irgri.uk"
if "%CLOUDFLARE_CONFIG%"=="" set "CLOUDFLARE_CONFIG=%USERPROFILE%\.cloudflared\config.yml"
set "CROSSLINE_CLUSTER=0"
set "CROSSLINE_CLUSTER_WORKERS=1"

rem ===== HEADER =====
echo ==============================================
echo   Crossline // local server + tunnel
echo ==============================================
echo [INFO] Порт сервера: %PORT%
echo [INFO] Публичный адрес: https://irgri.uk
echo [INFO] Конфиг cloudflared: %CLOUDFLARE_CONFIG%
echo.

rem ===== TOOLCHAIN CHECK =====
call :ensure_tool node "Node.js" || goto :FAIL
call :ensure_tool npm "npm" || goto :FAIL
call :ensure_tool cloudflared "cloudflared" || goto :FAIL

rem ===== CLOUDFLARED CONFIG CHECK =====
if not exist "%CLOUDFLARE_CONFIG%" (
  echo [ERROR] Не найден конфиг cloudflared: %CLOUDFLARE_CONFIG%
  echo         Проверьте путь или укажите его через переменную CLOUDFLARE_CONFIG.
  goto :FAIL
)

rem ===== DEPENDENCIES =====
echo [STEP] Устанавливаем зависимости (npm ci / npm install)...
if exist "%ROOT%\package-lock.json" (
  call npm ci || goto :FAIL
) else (
  call npm install || goto :FAIL
)

echo.
echo [STEP] Запускаем игровой сервер на http://localhost:%PORT% ...
set "SERVER_CMD=pushd ""%ROOT%"" ^&^& set PORT=%PORT% ^&^& set CROSSLINE_CLUSTER=0 ^&^& set CROSSLINE_CLUSTER_WORKERS=1 ^&^& node server\index.js ^|^| (echo [ERROR] Сервер завершился с кодом !errorlevel! ^& pause)"
call :launch_window "Crossline Server" "%SERVER_CMD%" || goto :FAIL

echo [STEP] Запускаем cloudflared tunnel (irgri-tunnel)...
set "TUNNEL_CMD=pushd ""%ROOT%"" ^&^& cloudflared --config ""%CLOUDFLARE_CONFIG%"" tunnel run irgri-tunnel ^|^| (echo [ERROR] Cloudflared завершился с кодом !errorlevel! ^& pause)"
call :launch_window "Crossline Tunnel" "%TUNNEL_CMD%" || goto :FAIL

echo.
echo [READY] Сервер и туннель запущены в отдельных окнах.
echo [INFO] Клиент ищет сервер по https://irgri.uk

echo [HOLD] Это окно не закроется. Нажмите Ctrl+C, когда захотите завершить работу.
:WAIT
timeout /t 3600 /nobreak >nul
goto :WAIT

rem ===== FUNCTIONS =====
:ensure_tool
where %1 >nul 2>&1 && exit /b 0
echo [ERROR] %~2 не найден. Установите его и перезапустите.
exit /b 1

:launch_window
setlocal enabledelayedexpansion
set "WINDOW_TITLE=%~1"
set "RUN_COMMAND=%~2"
echo [INFO] Открываем окно: !WINDOW_TITLE!
start "!WINDOW_TITLE!" cmd /v:on /k "!RUN_COMMAND!"
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%

:FAIL
echo.
echo [ERROR] Не удалось запустить все процессы. Проверьте вывод выше.
pause
endlocal
exit /b 1

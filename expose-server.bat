@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ===== CONFIGURATION =====
if "%PORT%"=="" set "PORT=3000"
set "SCRIPT_DIR=%cd%"
set "CROSSLINE_API_URL=https://irgri.uk"
set "CROSSLINE_WS_URL=wss://irgri.uk"
set "CLOUDFLARE_DEFAULT=C:\Users\SadSock\.cloudflared\cloudflared.exe"

rem ===== HEADER =====
echo ==============================================
echo   Crossline // tunnel launcher
echo ==============================================
echo [INFO] Локальный сервер будет запущен на порту %PORT% и выведен в интернет через Cloudflare Tunnel.
echo.

rem ===== TOOLCHAIN CHECK =====
where node >nul 2>&1 || (
  echo [ERROR] Node.js не найден в PATH. Установите Node LTS и перезапустите окно.
  goto :FAIL
)
where npm >nul 2>&1 || (
  echo [ERROR] npm не найден. Проверьте установку Node.js.
  goto :FAIL
)

if exist "%CLOUDFLARE_DEFAULT%" set "CLOUDFLARED_CMD=\"%CLOUDFLARE_DEFAULT%\""
for /f "delims=" %%I in ('where cloudflared 2^>nul') do if not defined CLOUDFLARED_CMD set "CLOUDFLARED_CMD=\"%%~fI\""
if not defined CLOUDFLARED_CMD (
  echo [ERROR] cloudflared не найден. Укажите путь в %CLOUDFLARE_DEFAULT% или добавьте его в PATH.
  goto :FAIL
)

echo [INFO] Используется cloudflared: %CLOUDFLARED_CMD%

echo.
rem ===== DEPENDENCIES =====
if exist "%SCRIPT_DIR%\node_modules" (
  echo [INFO] node_modules найден. Установка зависимостей пропущена.
) else (
  echo [STEP] Устанавливаем зависимости (npm ci)...
  npm ci
  if errorlevel 1 (
    echo [ERROR] npm ci завершился с ошибкой. Проверьте лог выше.
    goto :FAIL
  )
)

echo.
rem ===== START LOCAL SERVER =====
echo [STEP] Запуск игрового сервера на http://localhost:%PORT% ...
set "SERVER_CMD=cd /d \"%SCRIPT_DIR%\" && set PORT=%PORT% && node server\index.js"
call :launch_window "Crossline Server" "%SERVER_CMD%" "Сервер завершился с ошибкой"
if errorlevel 1 (
  echo [ERROR] Не удалось запустить серверное окно.
  goto :FAIL
)

echo [INFO] Ожидание старта сервера...
timeout /t 3 /nobreak >nul

echo.
rem ===== START CLOUDFLARE TUNNEL =====
echo [STEP] Запуск Cloudflare Tunnel (irgri-tunnel)...
set "TUNNEL_CMD=cd /d \"%SCRIPT_DIR%\" && %CLOUDFLARED_CMD% tunnel run irgri-tunnel"
call :launch_window "Crossline Tunnel" "%TUNNEL_CMD%" "Cloudflared завершился с ошибкой"
if errorlevel 1 (
  echo [ERROR] Не удалось запустить cloudflared.
  goto :FAIL
)

echo [READY] Публичный адрес: https://irgri.uk
echo [HINT] Клиент автоматически стучится в https://irgri.uk/health для проверки сервера.
echo [HINT] Если используете index.html локально, откройте его с параметром ?server=https://irgri.uk

echo.
if exist "%SCRIPT_DIR%\monitor-server.ps1" (
  echo [INFO] Запуск окна мониторинга состояния сервера...
  start "Crossline Monitor" powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\monitor-server.ps1"
)

echo [READY] Все процессы запущены. Закройте это окно после завершения работы.
pause
endlocal

goto :EOF

:launch_window
setlocal
set "WINDOW_TITLE=%~1"
set "RUN_COMMAND=%~2"
set "ERROR_MESSAGE=%~3"
start "%WINDOW_TITLE%" cmd /k "%RUN_COMMAND% ^& if errorlevel 1 echo [ERROR] %ERROR_MESSAGE% (код !errorlevel!) ^& pause"
set "EXIT_CODE=%errorlevel%"
endlocal & exit /b %EXIT_CODE%

:FAIL
echo.
echo Нажмите любую клавишу, чтобы закрыть окно после устранения ошибки.
pause
exit /b 1

@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
set "ROOT=%~dp0"
cd /d "%ROOT%"

rem ===== CONFIGURATION =====
if "%PORT%"=="" set "PORT=3000"
set "CROSSLINE_API_URL=https://irgri.uk"
set "CROSSLINE_WS_URL=wss://irgri.uk"

rem ===== HEADER =====
echo ==============================================
echo   Crossline // local server + tunnel
echo ==============================================
echo [INFO] Порт сервера: %PORT%
echo [INFO] Публичный адрес: https://irgri.uk
echo.

rem ===== TOOLCHAIN CHECK =====
call :ensure_tool node "Node.js"
call :ensure_tool npm "npm"
call :ensure_tool cloudflared "cloudflared"
if errorlevel 1 goto :FAIL

rem ===== DEPENDENCIES =====
if not exist "%ROOT%node_modules" (
  echo [STEP] Устанавливаем зависимости (npm ci)...
  npm ci || goto :FAIL
) else (
  echo [INFO] Зависимости уже установлены.
)

echo.
echo [STEP] Запускаем игровой сервер на http://localhost:%PORT% ...
set "SERVER_CMD=cd /d \"%ROOT%\" && set PORT=%PORT% && node server\index.js"
call :launch_window "Crossline Server" "%SERVER_CMD%" "Сервер завершился"
if errorlevel 1 goto :FAIL

echo [STEP] Запускаем cloudflared tunnel (irgri-tunnel)...
set "TUNNEL_CMD=cd /d \"%ROOT%\" && cloudflared tunnel run irgri-tunnel"
call :launch_window "Crossline Tunnel" "%TUNNEL_CMD%" "Cloudflared завершился"
if errorlevel 1 goto :FAIL

echo.
echo [READY] Сервер и туннель запущены в отдельных окнах.
echo [INFO] Клиент ищет сервер по https://irgri.uk

echo [HOLD] Это окно не закроется. Нажмите Ctrl+C, когда захотите завершить работу.
:WAIT
rem Используем timeout, чтобы окно не закрывалось само по себе
timeout /t 3600 /nobreak >nul
goto :WAIT

:ensure_tool
where %1 >nul 2>&1 && exit /b 0
if "%~2"=="" (
  echo [ERROR] Не найдено: %1
) else (
  echo [ERROR] %~2 не найден. Установите его и перезапустите.
)
exit /b 1

:launch_window
setlocal
set "WINDOW_TITLE=%~1"
set "RUN_COMMAND=%~2"
set "ERROR_MESSAGE=%~3"
start "%WINDOW_TITLE%" cmd /k "%RUN_COMMAND% ^& if errorlevel 1 echo [ERROR] !ERROR_MESSAGE! (код !errorlevel!) ^& pause"
set "EXIT_CODE=%errorlevel%"
endlocal & exit /b %EXIT_CODE%

:FAIL
echo.
echo [ERROR] Не удалось запустить все процессы. Проверьте вывод выше.
pause
endlocal
exit /b 1

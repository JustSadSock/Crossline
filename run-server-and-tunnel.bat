@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

if "%PORT%"=="" set "PORT=3000"
set "CROSSLINE_API_URL=https://irgri.uk"
set "CROSSLINE_WS_URL=wss://irgri.uk"

echo ==============================================
echo   Crossline // local server + tunnel
echo ==============================================
echo [INFO] Порт сервера: %PORT%
echo [INFO] Публичный адрес: https://irgri.uk

echo [STEP] Проверяем Node.js...
where node >nul 2>&1 || (
  echo [ERROR] Node.js не найден. Добавьте его в PATH.
  goto :FAIL
)

echo [STEP] Проверяем cloudflared...
where cloudflared >nul 2>&1 || (
  echo [ERROR] cloudflared не найден. Установите его и добавьте в PATH.
  goto :FAIL
)

if not exist "%cd%\node_modules" (
  echo [STEP] Устанавливаем зависимости (npm ci)...
  npm ci || goto :FAIL
) else (
  echo [INFO] Зависимости уже установлены.
)

echo [STEP] Запускаем игровой сервер на http://localhost:%PORT% ...
start "Crossline Server" cmd /k "cd /d \"%cd%\" && set PORT=%PORT% && node server\index.js"
if errorlevel 1 goto :FAIL

echo [STEP] Запускаем cloudflared tunnel (irgri-tunnel)...
start "Crossline Tunnel" cmd /k "cd /d \"%cd%\" && cloudflared tunnel run irgri-tunnel"
if errorlevel 1 goto :FAIL

echo [READY] Сервер и туннель запущены в отдельных окнах.
echo [INFO] Клиент ищет сервер по https://irgri.uk
echo [INFO] Это окно останется открытым. Закройте его или нажмите Ctrl+C, когда захотите завершить работу.
echo.
:HOLD
timeout /t 86400 /nobreak >nul
goto :HOLD

:FAIL
echo [ERROR] Не удалось запустить все процессы. Проверьте вывод выше.
pause
endlocal
exit /b 1

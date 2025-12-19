@echo off
setlocal
enableextensions
chcp 65001 >nul 2>&1
for %%I in ("%~dp0.") do set "ROOT=%%~fI"
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
call :ensure_tool node "Node.js" || goto :FAIL
call :ensure_tool npm "npm" || goto :FAIL
call :ensure_tool cloudflared "cloudflared" || goto :FAIL

rem ===== DEPENDENCIES =====
if not exist "%ROOT%node_modules" (
  echo [STEP] Устанавливаем зависимости (npm ci)...
  call npm ci || goto :FAIL
) else (
  echo [INFO] Зависимости уже установлены.
)

echo.
echo [STEP] Запускаем игровой сервер на http://localhost:%PORT% ...
set "SERVER_CMD=cd /d \"%ROOT%\" ^&^& set PORT=%PORT% ^&^& node server\\index.js"
call :launch_window "Crossline Server" "%SERVER_CMD%" "Сервер завершился" || goto :FAIL

echo [STEP] Запускаем cloudflared tunnel (irgri-tunnel)...
set "TUNNEL_CMD=cd /d \"%ROOT%\" ^&^& cloudflared tunnel run irgri-tunnel"
call :launch_window "Crossline Tunnel" "%TUNNEL_CMD%" "Cloudflared завершился" || goto :FAIL

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
set "ERROR_MESSAGE=%~3"
set "WRAPPER=%TEMP%\crossline_launch_!RANDOM!.cmd"
(
  echo @echo off
  echo chcp 65001 ^>nul 2^>^&1
  echo title !WINDOW_TITLE!
  echo echo [RUN] !WINDOW_TITLE!
  echo echo -------------------------------
  echo cd /d "%ROOT%"
  echo %RUN_COMMAND%
  echo if errorlevel 1 ^(
  echo   echo.
  echo   echo [ERROR] !ERROR_MESSAGE! ^(код ^!errorlevel^!^)
  echo   pause
  echo ^)
) > "!WRAPPER!"
start "!WINDOW_TITLE!" cmd /k call "!WRAPPER!"
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%

:FAIL
echo.
echo [ERROR] Не удалось запустить все процессы. Проверьте вывод выше.
pause
endlocal
exit /b 1

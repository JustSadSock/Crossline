@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ===== CONFIGURATION =====
if "%PORT%"=="" set "PORT=3000"
set "SCRIPT_DIR=%cd%"

rem ===== HEADER =====
echo ==============================================
echo   Crossline // tunnel launcher
echo ==============================================
echo [INFO] Локальный сервер будет запущен на порту %PORT% и выведен в интернет через ngrok.
echo.

rem ===== TOOLCHAIN CHECK =====
where node >nul 2>&1 || (
  echo [ERROR] Node.js не найден в PATH. Установите Node LTS и перезапустите окно.
  goto :EOF
)
where npm >nul 2>&1 || (
  echo [ERROR] npm не найден. Проверьте установку Node.js.
  goto :EOF
)

set "NGROK_CMD="
if defined NGROK_EXE (
  if exist "%NGROK_EXE%" (
    set "NGROK_CMD=\"%NGROK_EXE%\""
  ) else (
    echo [ERROR] ngrok не найден по пути "%NGROK_EXE%".
    echo        Укажите корректный путь через переменную NGROK_EXE или обновите скрипт.
    goto :EOF
  )
) else (
  for /f "delims=" %%I in ('where ngrok 2^>nul') do if not defined NGROK_CMD set "NGROK_CMD=\"%%~fI\""
  if not defined NGROK_CMD (
    echo [ERROR] ngrok не найден. Добавьте его в PATH или установите NGROK_EXE.
    goto :EOF
  )
)

echo [INFO] Используется ngrok: %NGROK_CMD%
if not "%NGROK_AUTHTOKEN%"=="" (
  echo [INFO] Применяем токен авторизации ngrok...
  powershell -NoProfile -Command "try { %NGROK_CMD% config add-authtoken $Env:NGROK_AUTHTOKEN ^| Out-Null } catch { Write-Host '[WARN] Не удалось применить токен. Продолжаем.' }" >nul
) else (
  echo [WARN] Переменная NGROK_AUTHTOKEN не задана. При первом запуске ngrok запросит авторизацию.
)

echo.
rem ===== DEPENDENCIES =====
if exist "%SCRIPT_DIR%\node_modules" (
  echo [INFO] node_modules найден. Установка зависимостей пропущена.
) else (
  echo [STEP] Устанавливаем зависимости (npm ci)...
  npm ci
  if errorlevel 1 (
    echo [ERROR] npm ci завершился с ошибкой. Проверьте лог выше.
    goto :EOF
  )
)

echo.
rem ===== START LOCAL SERVER =====
echo [STEP] Запуск игрового сервера на http://localhost:%PORT% ...
start "Crossline Server" cmd /k "cd /d \"%SCRIPT_DIR%\" && set PORT=%PORT% && node server\index.js"
if errorlevel 1 (
  echo [ERROR] Не удалось запустить серверное окно.
  goto :EOF
)

echo [INFO] Ожидание старта сервера...
timeout /t 3 /nobreak >nul

echo.
rem ===== START NGROK =====
echo [STEP] Запуск ngrok туннеля (только HTTPS)...
start "Crossline Tunnel" cmd /k "cd /d \"%SCRIPT_DIR%\" && %NGROK_CMD% http %PORT% --scheme=https --log=stdout"
if errorlevel 1 (
  echo [ERROR] Не удалось запустить ngrok.
  goto :EOF
)

echo [INFO] Ожидание публичного адреса...
powershell -NoProfile -ExecutionPolicy Bypass -Command "
  $deadline = (Get-Date).AddSeconds(60);
  $publicUrl = $null;
  while ((Get-Date) -lt $deadline -and -not $publicUrl) {
    try {
      $response = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop;
      $publicUrl = ($response.tunnels | Where-Object { $_.proto -eq 'https' } | Select-Object -First 1).public_url;
      if (-not $publicUrl) {
        $publicUrl = ($response.tunnels | Select-Object -First 1).public_url;
      }
    } catch {
      Start-Sleep -Seconds 2;
    }
  }
  if ($publicUrl) {
    Write-Host "[READY] Публичный адрес: $publicUrl" -ForegroundColor Green;
    Write-Host "[HINT] Передайте этот адрес клиенту через параметр '?server=' или переменные окружения." -ForegroundColor Cyan;
  } else {
    Write-Host "[WARN] Не удалось автоматически получить ссылку. Откройте окно ngrok." -ForegroundColor Yellow;
  }
"

echo.
if exist "%SCRIPT_DIR%\monitor-server.ps1" (
  echo [INFO] Запуск окна мониторинга состояния сервера...
  start "Crossline Monitor" powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\monitor-server.ps1"
)

echo [READY] Все процессы запущены. Закройте это окно после завершения работы.
pause
endlocal

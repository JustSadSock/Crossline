@echo off
chcp 65001 >nul 2>&1

setlocal
where cloudflared >nul 2>&1
if errorlevel 1 (
  echo [ERROR] cloudflared не найден. Установите Cloudflare Tunnel и убедитесь, что cloudflared в PATH.
  pause
  exit /b 1
)

set "CF_ARGS="
if not "%CLOUDFLARE_CONFIG%"=="" (
  set CF_ARGS=--config "%CLOUDFLARE_CONFIG%"
)

echo ==============================================
echo   Crossline // cloudflared tunnel
echo ==============================================

echo [STEP] Запускаем: cloudflared %CF_ARGS% tunnel run irgri-tunnel
cloudflared %CF_ARGS% tunnel run irgri-tunnel
if errorlevel 1 (
  echo [ERROR] Cloudflared завершился с кодом %errorlevel%
  pause
)
endlocal

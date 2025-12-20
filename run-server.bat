@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0" || exit /b 1

echo ==============================================
echo   Crossline // local server
echo ==============================================

setlocal
if "%PORT%"=="" set "PORT=3000"
set "CROSSLINE_CLUSTER=0"
set "CROSSLINE_CLUSTER_WORKERS=1"

echo [INFO] PORT=%PORT%

echo [STEP] Starting server on http://localhost:%PORT% ...
call npm run server
if errorlevel 1 (
  echo [ERROR] Server exited with code %errorlevel%
  pause
)
endlocal

@echo off
setlocal enabledelayedexpansion

set "PORT=%~1"
if "%PORT%"=="" set "PORT=3000"

echo ==============================================
echo   ngrok tunnel monitor - port !PORT!
echo ==============================================

echo.
call :EnsureAuth

:StartTunnel
echo Starting ngrok tunnel for http://localhost:!PORT! ...
ngrok http !PORT!
set "EXITCODE=!ERRORLEVEL!"
echo.
echo ngrok process finished with exit code !EXITCODE!.

if not "!EXITCODE!"=="0" (
  echo Attempting to verify authentication before restarting the tunnel...
  call :EnsureAuth
) else (
  echo Tunnel closed normally.
)

echo.
echo Press any key to relaunch the tunnel or close this window when you are finished.
pause >nul
echo.
goto StartTunnel

:EnsureAuth
if "%NGROK_AUTHTOKEN%"=="" (
  echo [WARN] NGROK_AUTHTOKEN environment variable is not set.
  echo Set it with "setx NGROK_AUTHTOKEN your_token" and restart this script.
  goto :EOF
)

echo Verifying ngrok authentication...

:EnsureAuthRetry
ngrok config add-authtoken %NGROK_AUTHTOKEN% >nul 2>&1
if errorlevel 1 (
  echo.
  echo ngrok reported that authentication is required before the tunnel can start.
  echo A guided login will now run in this window.
  echo Follow the prompts, complete the browser sign-in, and return here when finished.
  echo.
  ngrok account login
  if errorlevel 1 (
    echo.
    echo Login was not completed successfully.
    echo Press any key to try logging in again.
    pause >nul
    echo.
    goto EnsureAuthRetry
  )
  echo.
  echo Login completed. Applying the auth token again...
  goto EnsureAuthRetry
)

echo Authentication confirmed.
echo.
goto :EOF


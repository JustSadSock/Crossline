@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

<<<<<<< Updated upstream
<<<<<<< Updated upstream
rem -------- Settings (edit once if you want) --------
if not defined PORT set "PORT=3000"
if not defined NGROK_EXE set "NGROK_EXE=ngrok"
rem Optional: hardcode token once and forget:
rem set "NGROK_AUTHTOKEN=PASTE_TOKEN_HERE"

rem -------- Check Node --------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node is not in PATH. Install Node or open Node.js Command Prompt.
  pause
  exit /b 1
)

rem -------- Resolve ngrok command (path or PATH lookup) --------
set "NGROK_CMD=%NGROK_EXE%"
if exist "%NGROK_CMD%" (
  set "HAVE_NGROK=1"
) else (
  where %NGROK_CMD% >nul 2>&1 && set "HAVE_NGROK=1"
)
if not defined HAVE_NGROK (
  echo [ERROR] ngrok not found. Install it and either add to PATH or set NGROK_EXE=full\path\to\ngrok.exe
  echo Example (once):  setx NGROK_EXE "C:\Tools\ngrok\ngrok.exe"
  pause
  exit /b 1
)

rem -------- Auto-find token (no prompts) --------
set "FOUND_TOKEN="
if not "%NGROK_AUTHTOKEN%"=="" set "FOUND_TOKEN=%NGROK_AUTHTOKEN%"

if "%FOUND_TOKEN%"=="" if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%~A"=="NGROK_AUTHTOKEN" set "FOUND_TOKEN=%%~B"
  )
)
if "%FOUND_TOKEN%"=="" if exist "ngrok.token" (
  set /p FOUND_TOKEN=<"ngrok.token"
)

if not "%FOUND_TOKEN%"=="" (
  "%NGROK_CMD%" config add-authtoken "%FOUND_TOKEN%" >nul 2>&1
)

rem -------- Prepare logs --------
if not exist "logs" mkdir "logs"
set "TS=%DATE%_%TIME%"
set "TS=%TS::=-%"
set "TS=%TS:/=-%"
set "TS=%TS: =_%"
set "TS=%TS:.=-%"
=======
rem ========= CONFIG =========
set "PORT=80"
set "NGROK_EXE=C:\Users\illya\AppData\Local\Microsoft\WinGet\Links\ngrok.exe"

rem ========= LOGS =========
if not exist "logs" mkdir "logs"
for /f %%t in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd_HHmmss')"') do set "TS=%%t"
>>>>>>> Stashed changes
=======
rem ========= CONFIG =========
set "PORT=80"
set "NGROK_EXE=C:\Users\illya\AppData\Local\Microsoft\WinGet\Links\ngrok.exe"

rem ========= LOGS =========
if not exist "logs" mkdir "logs"
for /f %%t in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd_HHmmss')"') do set "TS=%%t"
>>>>>>> Stashed changes
set "SERVER_LOG=logs\server_%TS%.log"
set "NGROK_LOG=logs\ngrok_%TS%.log"

rem ========= PORT CHECK =========
if %PORT% LSS 1024 (
  net session >nul 2>&1
  if errorlevel 1 (
    echo [WARN] Port %PORT% needs admin. Falling back to 3000.
    set "PORT=3000"
  )
)
echo [INFO] Using port %PORT%.

rem ========= NODE / NPM =========
where node >nul 2>&1 || (
  echo [ERROR] Node.js not found in PATH. Install Node LTS.
  pause & exit /b
)
if exist package.json (
  echo [INFO] npm ci...
  npm ci >>"%SERVER_LOG%" 2>&1
)

rem ========= NGROK =========
if exist "%NGROK_EXE%" (
  echo [INFO] Using ngrok at "%NGROK_EXE%"
) else (
  echo [ERROR] ngrok not found at "%NGROK_EXE%"
  echo   Fix: set "NGROK_EXE=C:\Path\to\ngrok.exe"
  pause & exit /b 1
)

rem ========= START SERVER =========
set "SCRIPT_DIR=%cd%"
start "Crossline Server" cmd /k ^
"cd /d "%SCRIPT_DIR%" && set PORT=%PORT% && node server\index.js 1>>"%SERVER_LOG%" 2>>&1"

rem ========= START NGROK =========
start "ngrok Tunnel" cmd /k ^
"cd /d "%SCRIPT_DIR%" && "%NGROK_EXE%" http %PORT% --log=stdout 1>>"%NGROK_LOG%" 2>>&1"

echo [READY] Server and ngrok launched.
echo [INFO] Logs:
echo   %SERVER_LOG%
echo   %NGROK_LOG%
<<<<<<< Updated upstream
<<<<<<< Updated upstream
echo Starting server on http://localhost:%PORT%

rem -------- Launch server in its own window (kept open) --------
start "Crossline Server" cmd /k "set PORT=%PORT% && %SERVER_CMD% ^>^> ^"%SERVER_LOG%^" 2^>^&1"

rem -------- Launch ngrok in its own window (kept open) --------
echo Starting ngrok tunnel to localhost:%PORT%
start "ngrok Tunnel" cmd /k ""%NGROK_CMD%" http %PORT% --log=stdout ^>^> ^"%NGROK_LOG%^" 2^>^&1"

echo Ready. Child consoles stay open. You can close this parent window anytime.
=======
>>>>>>> Stashed changes
=======
>>>>>>> Stashed changes
pause
endlocal

@echo off
cd /d "%~dp0"
echo Installing Loupedeck radar dependencies...
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found, installing the LTS version with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  set "PATH=%PATH%;C:\Program Files\nodejs"
)
node -v
call npm install --no-fund --no-audit
if not exist config.json (
  copy config.example.json config.json >nul
  echo.
  echo config.json created: edit it with your receiver URL and your location before starting the radar.
)
pause

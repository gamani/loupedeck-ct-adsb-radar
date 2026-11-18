@echo off
cd /d "%~dp0"
title Loupedeck Radar
if not exist config.json (
  echo config.json not found: copy config.example.json to config.json and edit it first.
  pause
  exit /b 1
)
echo Stopping previous radar instances...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*radar.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Closing Loupedeck / Logi Plugin Service (they lock the device)...
taskkill /IM Loupedeck.exe /F >nul 2>&1
taskkill /IM LogiPluginServiceExt.exe /F >nul 2>&1
taskkill /IM LogiPluginService.exe /F >nul 2>&1
timeout /t 3 >nul
rem Older canvas versions leak memory: update the dependencies once if needed
node --input-type=commonjs -e "process.exit(+JSON.parse(require('fs').readFileSync('node_modules/@napi-rs/canvas/package.json')).version.split('.')[0]>=1?0:1)" >nul 2>&1
if errorlevel 1 (
  echo Updating dependencies, one moment...
  call npm install --no-fund --no-audit
)
node --expose-gc radar.js 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath radar-log.txt"
pause

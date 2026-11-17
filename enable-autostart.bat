@echo off
set "DIR=%~dp0"
set "SU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%SU%\Loupedeck Radar.vbs" echo WScript.Sleep 30000
>> "%SU%\Loupedeck Radar.vbs" echo CreateObject("WScript.Shell").Run """%DIR%start-radar.bat""", 7, False
if exist "%SU%\Loupedeck Radar.vbs" (echo Autostart ENABLED: the radar will start 30 s after you log in.) else (echo FAILED: could not write to the Startup folder.)
pause

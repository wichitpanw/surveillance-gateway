@echo off
rem Edge API Gateway uninstaller (Windows x64) - double-click this file.
rem Asks for administrator rights, then runs uninstall-windows.ps1 next to it.
rem Keeps state\ (cameras, global IDs, token) unless run with -RemoveData.

net session >nul 2>&1
if errorlevel 1 (
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-windows.ps1" %*
echo.
pause

@echo off
rem Gateway Edge flash-drive installer (Windows x64) - double-click this file.
rem Asks for administrator rights, then runs install-windows.ps1 next to it.
rem Running it again on an installed machine updates the program and keeps the data.

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
echo.
pause

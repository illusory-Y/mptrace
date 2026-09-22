@echo off
title MPTrace - Web Mode
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1"
echo.
pause

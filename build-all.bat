@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   LocalTransferSuite - Build All  (UTF-8 forced)
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression (Get-Content -Path '.\build-all.ps1' -Raw -Encoding UTF8)"
echo.
pause
